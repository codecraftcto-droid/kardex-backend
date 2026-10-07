import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prismaSystem } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import { conflicto, noEncontrado } from '../lib/errors.js';
import { textoOpcional } from '../lib/esquemas.js';
import { paginacion, respuestaPaginada } from '../lib/http.js';
import { validar } from '../middleware/validar.js';
import { contarConexiones } from '../realtime/socket.js';
import { auditarPlataforma, soloAdmin } from './middleware.js';
import { CODIGOS_MODULO, MODULOS } from '../rbac/modulos.js';
import { invalidarPermisosEstudio } from '../rbac/servicio.js';
import { GRUPOS_CRONOGRAMA, desplazar, esPeriodo } from '../sire/periodos.js';

const router = Router();
const uuid = z.uuid();
const limite = z.coerce.number().int().min(1).max(100000).nullish().transform((v) => v ?? null);

// ───────────── Planes ─────────────

const esquemaPlan = z.object({
  codigo: z.string().trim().min(2).max(30).toUpperCase(),
  nombre: z.string().trim().min(2).max(80),
  descripcion: textoOpcional(300),
  precioMensual: z.coerce.number().min(0).max(1_000_000),
  maxEmpresas: limite,
  maxUsuarios: limite,
  maxAlmacenes: limite,
  modulos: z.array(z.enum(CODIGOS_MODULO)).min(1, 'El plan debe incluir al menos un módulo').transform((m) => [...new Set(m)]),
  activo: z.boolean().default(true),
});

/** Catálogo de módulos vendibles (para armar planes y contratos) */
router.get('/modulos', (_req, res) => res.json(Object.entries(MODULOS).map(([codigo, m]) => ({ codigo, ...m }))));

router.get('/planes', async (_req, res) => {
  res.json(await prismaSystem.plan.findMany({ orderBy: { precioMensual: 'asc' }, include: { _count: { select: { estudios: true } } } }));
});

router.post('/planes', soloAdmin, validar(esquemaPlan), async (req, res) => {
  const plan = await prismaSystem.$transaction(async (tx) => {
    const p = await tx.plan.create({ data: req.body });
    await auditarPlataforma(req, { accion: 'plan.crear', recurso: 'plan', recursoId: p.id, despues: p }, tx);
    return p;
  });
  res.status(201).json(plan);
});

router.put('/planes/:id', soloAdmin, validar(esquemaPlan), async (req, res) => {
  if (!uuid.safeParse(req.params.id).success) throw noEncontrado();
  const plan = await prismaSystem.$transaction(async (tx) => {
    const antes = await tx.plan.findUnique({ where: { id: req.params.id } });
    if (!antes) throw noEncontrado();
    const p = await tx.plan.update({ where: { id: antes.id }, data: req.body });
    await auditarPlataforma(req, { accion: 'plan.editar', recurso: 'plan', recursoId: p.id, antes, despues: p }, tx);
    return p;
  });
  // Los estudios de este plan ganan o pierden módulos al instante
  const estudios = await prismaSystem.tenant.findMany({ where: { planId: plan.id }, select: { id: true } });
  await invalidarPermisosEstudio(estudios.map((e) => e.id));
  res.json(plan);
});

// ───────────── Facturación ─────────────

const periodo = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Periodo inválido (AAAA-MM)');

router.get(
  '/facturas',
  validar(z.object({ estado: z.enum(['PENDIENTE', 'PAGADA', 'ANULADA', 'VENCIDA']).optional(), periodo: periodo.optional(), tenantId: z.uuid().optional(), pagina: z.string().optional(), porPagina: z.string().optional() }), 'query'),
  async (req, res) => {
    const { estado, periodo: per, tenantId } = req.validQuery;
    const pag = paginacion(req.validQuery);
    const hoy = new Date(new Date().toISOString().slice(0, 10));
    const where = {
      ...(per && { periodo: per }),
      ...(tenantId && { tenantId }),
      ...(estado === 'VENCIDA' ? { estado: 'PENDIENTE', venceEn: { lt: hoy } } : estado ? { estado } : {}),
    };
    const [datos, total, resumen] = await Promise.all([
      prismaSystem.facturaPlataforma.findMany({
        where,
        include: { tenant: { select: { id: true, nombre: true, ruc: true } }, plan: { select: { nombre: true } } },
        orderBy: [{ periodo: 'desc' }, { emitidaEn: 'desc' }],
        skip: pag.skip,
        take: pag.take,
      }),
      prismaSystem.facturaPlataforma.count({ where }),
      prismaSystem.facturaPlataforma.groupBy({ by: ['estado'], where: per ? { periodo: per } : {}, _sum: { monto: true }, _count: { _all: true } }),
    ]);
    res.json({
      ...respuestaPaginada(datos.map((f) => ({ ...f, vencida: f.estado === 'PENDIENTE' && f.venceEn < hoy })), total, pag),
      resumen: Object.fromEntries(resumen.map((r) => [r.estado, { cantidad: r._count._all, monto: r._sum.monto }])),
    });
  },
);

/** Emite la factura del periodo a cada estudio activo con plan. Idempotente (una por estudio y periodo). */
router.post('/facturas/generar', soloAdmin, validar(z.object({ periodo, diasParaPagar: z.coerce.number().int().min(1).max(60).default(15) })), async (req, res) => {
  const [anio, mes] = req.body.periodo.split('-').map(Number);
  const venceEn = new Date(Date.UTC(anio, mes, req.body.diasParaPagar)); // N días después de fin de mes
  const estudios = await prismaSystem.tenant.findMany({ where: { activo: true, planId: { not: null } }, include: { plan: true } });
  const { count } = await prismaSystem.facturaPlataforma.createMany({
    data: estudios.map((t) => ({ tenantId: t.id, planId: t.planId, periodo: req.body.periodo, monto: t.plan.precioMensual, venceEn })),
    skipDuplicates: true,
  });
  await auditarPlataforma(req, { accion: 'facturacion.generar', recurso: 'facturacion', recursoId: req.body.periodo, despues: { emitidas: count } });
  res.json({ emitidas: count, omitidas: estudios.length - count });
});

async function cambiarFactura(req, desde, data, accion) {
  if (!uuid.safeParse(req.params.id).success) throw noEncontrado();
  const { count } = await prismaSystem.facturaPlataforma.updateMany({ where: { id: req.params.id, estado: desde }, data });
  if (!count) {
    const f = await prismaSystem.facturaPlataforma.findUnique({ where: { id: req.params.id } });
    if (!f) throw noEncontrado();
    throw conflicto(`La factura está ${f.estado.toLowerCase()}`);
  }
  const f = await prismaSystem.facturaPlataforma.findUnique({ where: { id: req.params.id } });
  await auditarPlataforma(req, { accion, recurso: 'factura', recursoId: f.id, tenantId: f.tenantId, despues: req.body });
  return f;
}

router.post('/facturas/:id/pagar', soloAdmin, validar(z.object({ referencia: z.string().trim().min(3).max(100) })), async (req, res) => {
  res.json(await cambiarFactura(req, 'PENDIENTE', { estado: 'PAGADA', pagadaEn: new Date(), referenciaPago: req.body.referencia }, 'factura.pagar'));
});

router.post('/facturas/:id/anular', soloAdmin, validar(z.object({ motivo: z.string().trim().min(5).max(300) })), async (req, res) => {
  res.json(await cambiarFactura(req, 'PENDIENTE', { estado: 'ANULADA', motivoAnulacion: req.body.motivo }, 'factura.anular'));
});

// ───────────── Monitoreo ─────────────

async function medir(fn) {
  const t = performance.now();
  try {
    await fn();
    return { ok: true, ms: Math.round(performance.now() - t) };
  } catch {
    return { ok: false, ms: null };
  }
}

router.get('/monitoreo', async (_req, res) => {
  const hace30 = new Date(Date.now() - 30 * 86400_000);
  const hace1 = new Date(Date.now() - 86400_000);
  const [bd, cache, sockets, estudios, usuarios, sesiones, movimientos30d, movimientos24h, porDia] = await Promise.all([
    medir(() => prismaSystem.$queryRaw`SELECT 1`),
    medir(() => redis.ping()),
    contarConexiones().catch(() => null),
    prismaSystem.tenant.groupBy({ by: ['activo'], _count: { _all: true } }),
    prismaSystem.usuario.count({ where: { estado: 'activo' } }),
    prismaSystem.sesion.count({ where: { revocada: false, expiraEn: { gt: new Date() } } }),
    prismaSystem.movimiento.count({ where: { fecha: { gte: hace30 } } }),
    prismaSystem.movimiento.count({ where: { fecha: { gte: hace1 } } }),
    prismaSystem.$queryRaw`
      SELECT to_char(date_trunc('day', fecha), 'YYYY-MM-DD') AS dia, count(*)::int AS movimientos
        FROM movimientos WHERE fecha >= ${hace30} GROUP BY 1 ORDER BY 1`,
  ]);
  const mem = process.memoryUsage();
  res.json({
    servicios: { baseDatos: bd, redis: cache, tiempoReal: { ok: sockets !== null, conexiones: sockets } },
    proceso: { uptimeSegundos: Math.round(process.uptime()), memoriaMb: Math.round(mem.rss / 1048576), node: process.version },
    estudios: {
      activos: estudios.find((e) => e.activo)?._count._all ?? 0,
      suspendidos: estudios.find((e) => !e.activo)?._count._all ?? 0,
    },
    usuariosActivos: usuarios,
    sesionesActivas: sesiones,
    movimientos: { ultimas24h: movimientos24h, ultimos30d: movimientos30d, porDia },
  });
});

// ───────────── Auditoría de plataforma ─────────────

router.get(
  '/auditoria',
  validar(z.object({ tenantId: z.uuid().optional(), accion: z.string().max(60).optional(), pagina: z.string().optional(), porPagina: z.string().optional() }), 'query'),
  async (req, res) => {
    const { tenantId, accion } = req.validQuery;
    const pag = paginacion(req.validQuery);
    const where = { ...(tenantId && { tenantId }), ...(accion && { accion: { contains: accion } }) };
    const [filas, total] = await Promise.all([
      prismaSystem.plataformaAuditoria.findMany({ where, orderBy: { fecha: 'desc' }, skip: pag.skip, take: pag.take }),
      prismaSystem.plataformaAuditoria.count({ where }),
    ]);
    const [admins, estudios] = await Promise.all([
      prismaSystem.plataformaAdmin.findMany({ where: { id: { in: filas.map((f) => f.adminId).filter(Boolean) } }, select: { id: true, nombres: true } }),
      prismaSystem.tenant.findMany({ where: { id: { in: filas.map((f) => f.tenantId).filter(Boolean) } }, select: { id: true, nombre: true } }),
    ]);
    const nA = new Map(admins.map((a) => [a.id, a.nombres]));
    const nE = new Map(estudios.map((e) => [e.id, e.nombre]));
    res.json(respuestaPaginada(filas.map((f) => ({ ...f, admin: nA.get(f.adminId) ?? null, estudio: nE.get(f.tenantId) ?? null })), total, pag));
  },
);

// ───────────── Cronograma de vencimientos SUNAT (global) ─────────────

/** Cronograma de un año: [{ periodo, fechas: { '0': 'AAAA-MM-DD', …, '9', 'BC' } }] */
router.get('/cronograma', async (req, res) => {
  const anio = Number(req.query.anio) || new Date().getFullYear();
  const filas = await prismaSystem.cronogramaSunat.findMany({ where: { periodo: { startsWith: String(anio) } }, orderBy: [{ periodo: 'asc' }, { grupo: 'asc' }] });
  const porPeriodo = new Map();
  for (const f of filas) {
    if (!porPeriodo.has(f.periodo)) porPeriodo.set(f.periodo, {});
    porPeriodo.get(f.periodo)[f.grupo] = f.vencimiento.toISOString().slice(0, 10);
  }
  res.json({ anio, grupos: GRUPOS_CRONOGRAMA, periodos: [...porPeriodo].map(([periodo, fechas]) => ({ periodo, fechas })) });
});

const fechaIso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha AAAA-MM-DD');
const esquemaCronograma = z.object({
  anio: z.coerce.number().int().min(2020).max(2100),
  periodos: z.array(z.object({
    periodo: z.string().refine(esPeriodo, 'Período AAAAMM'),
    fechas: z.record(z.enum(GRUPOS_CRONOGRAMA), fechaIso),
  })).max(12),
}).superRefine((d, ctx) => {
  d.periodos.forEach((p, i) => {
    if (!p.periodo.startsWith(String(d.anio))) ctx.addIssue({ code: 'custom', path: ['periodos', i], message: `El período ${p.periodo} no es del ${d.anio}` });
    // El vencimiento cae en el mes siguiente al período (o después)
    const minimo = `${desplazar(p.periodo, 1).slice(0, 4)}-${desplazar(p.periodo, 1).slice(4)}-01`;
    for (const [g, f] of Object.entries(p.fechas)) {
      if (f < minimo) ctx.addIssue({ code: 'custom', path: ['periodos', i, g], message: `${p.periodo}, grupo ${g}: el vencimiento debe ser desde ${minimo}` });
    }
  });
});

/** Reemplaza el cronograma del año (lo publica SUNAT cada fin de año por resolución). */
router.put('/cronograma', soloAdmin, validar(esquemaCronograma), async (req, res) => {
  const { anio, periodos } = req.body;
  const datos = periodos.flatMap((p) => Object.entries(p.fechas).map(([grupo, f]) => ({ periodo: p.periodo, grupo, vencimiento: new Date(`${f}T00:00:00Z`) })));
  await prismaSystem.$transaction(async (tx) => {
    await tx.cronogramaSunat.deleteMany({ where: { periodo: { startsWith: String(anio) } } });
    await tx.cronogramaSunat.createMany({ data: datos });
    await auditarPlataforma(req, { accion: 'cronograma.editar', recurso: 'cronograma', recursoId: String(anio), despues: { anio, fechas: datos.length } }, tx);
  });
  res.json({ anio, fechas: datos.length });
});

export default router;
