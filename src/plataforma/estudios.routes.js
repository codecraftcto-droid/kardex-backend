import { Router } from 'express';
import { z } from 'zod';
import { prismaSystem } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import { conflicto, noEncontrado } from '../lib/errors.js';
import { email, textoOpcional } from '../lib/esquemas.js';
import { paginacion, respuestaPaginada } from '../lib/http.js';
import { validar } from '../middleware/validar.js';
import { crearEstudio } from '../services/estudios.js';
import { crearInvitacion } from '../services/invitaciones.js';
import { enviarInvitacion } from '../services/correo.js';
import { revocarSesiones } from '../services/sesiones.js';
import { PERMISO_ADMIN } from '../rbac/catalogo.js';
import { auditarPlataforma, soloAdmin } from './middleware.js';

/**
 * Gestión de estudios desde la plataforma. Usa la conexión dueña (vista entre estudios),
 * por eso cada endpoint filtra explícitamente por el estudio indicado.
 * SOPORTE puede consultar y ejecutar acciones de soporte; los cambios de plan, alta y
 * suspensión son solo de ADMIN. No existe "entrar como el usuario" (suplantación).
 */
const router = Router();
const uuid = z.uuid();
const hace30 = () => new Date(Date.now() - 30 * 86400_000);

async function cargarEstudio(id) {
  if (!uuid.safeParse(id).success) throw noEncontrado();
  const t = await prismaSystem.tenant.findUnique({ where: { id }, include: { plan: true } });
  if (!t) throw noEncontrado();
  return t;
}

/** Administradores del estudio: usuarios con el permiso de gestionar roles a nivel estudio. */
const administradores = (tenantId) =>
  prismaSystem.usuario.findMany({
    where: {
      tenantId,
      tipo: 'interno',
      asignaciones: { some: { alcanceTipo: 'estudio', rol: { permisos: { some: { permiso: { codigo: PERMISO_ADMIN } } } } } },
    },
    select: { id: true, nombres: true, email: true, estado: true, mfaActivo: true, ultimoAcceso: true },
  });

/** Corta el acceso de un estudio: sesiones revocadas, sockets desconectados y caché invalidada. */
async function cerrarSesionesEstudio(tenantId) {
  const sesiones = await prismaSystem.sesion.findMany({ where: { tenantId, revocada: false }, select: { id: true } });
  await revocarSesiones(sesiones.map((s) => s.id));
  return sesiones.length;
}

// ───────────── Consulta ─────────────

router.get(
  '/',
  validar(z.object({ q: z.string().trim().max(100).optional(), estado: z.enum(['activo', 'suspendido']).optional(), planId: z.uuid().optional(), pagina: z.string().optional(), porPagina: z.string().optional() }), 'query'),
  async (req, res) => {
    const { q, estado, planId } = req.validQuery;
    const pag = paginacion(req.validQuery);
    const where = {
      ...(estado && { activo: estado === 'activo' }),
      ...(planId && { planId }),
      ...(q && { OR: [{ nombre: { contains: q, mode: 'insensitive' } }, { ruc: { contains: q } }, { emailContacto: { contains: q, mode: 'insensitive' } }] }),
    };
    const [estudios, total] = await Promise.all([
      prismaSystem.tenant.findMany({
        where,
        include: { plan: { select: { id: true, nombre: true } }, _count: { select: { usuarios: true, empresas: true } } },
        orderBy: { creadoEn: 'desc' },
        skip: pag.skip,
        take: pag.take,
      }),
      prismaSystem.tenant.count({ where }),
    ]);
    const ids = estudios.map((e) => e.id);
    const [accesos, movimientos, almacenes, pendientes] = await Promise.all([
      prismaSystem.usuario.groupBy({ by: ['tenantId'], where: { tenantId: { in: ids } }, _max: { ultimoAcceso: true } }),
      prismaSystem.movimiento.groupBy({ by: ['tenantId'], where: { tenantId: { in: ids }, fecha: { gte: hace30() } }, _count: { _all: true } }),
      prismaSystem.almacen.groupBy({ by: ['tenantId'], where: { tenantId: { in: ids } }, _count: { _all: true } }),
      prismaSystem.facturaPlataforma.groupBy({ by: ['tenantId'], where: { tenantId: { in: ids }, estado: 'PENDIENTE' }, _count: { _all: true } }),
    ]);
    const por = (lista, f) => new Map(lista.map((x) => [x.tenantId, f(x)]));
    const [mA, mM, mAl, mP] = [por(accesos, (x) => x._max.ultimoAcceso), por(movimientos, (x) => x._count._all), por(almacenes, (x) => x._count._all), por(pendientes, (x) => x._count._all)];
    res.json(
      respuestaPaginada(
        estudios.map((e) => ({
          ...e,
          ultimoAcceso: mA.get(e.id) ?? null,
          movimientos30d: mM.get(e.id) ?? 0,
          almacenes: mAl.get(e.id) ?? 0,
          facturasPendientes: mP.get(e.id) ?? 0,
        })),
        total,
        pag,
      ),
    );
  },
);

router.get('/:id', async (req, res) => {
  const t = await cargarEstudio(req.params.id);
  const [admins, uso, facturas, sesionesActivas, movimientos30d] = await Promise.all([
    administradores(t.id),
    Promise.all([
      prismaSystem.empresa.count({ where: { tenantId: t.id } }),
      prismaSystem.usuario.count({ where: { tenantId: t.id, estado: { not: 'suspendido' } } }),
      prismaSystem.almacen.count({ where: { tenantId: t.id } }),
    ]),
    prismaSystem.facturaPlataforma.findMany({ where: { tenantId: t.id }, orderBy: { periodo: 'desc' }, take: 12 }),
    prismaSystem.sesion.count({ where: { tenantId: t.id, revocada: false, expiraEn: { gt: new Date() } } }),
    prismaSystem.movimiento.count({ where: { tenantId: t.id, fecha: { gte: hace30() } } }),
  ]);
  const [empresas, usuarios, almacenes] = uso;
  res.json({
    ...t,
    administradores: admins,
    uso: {
      empresas: { usados: empresas, maximo: t.plan?.maxEmpresas ?? null },
      usuarios: { usados: usuarios, maximo: t.plan?.maxUsuarios ?? null },
      almacenes: { usados: almacenes, maximo: t.plan?.maxAlmacenes ?? null },
    },
    facturas,
    sesionesActivas,
    movimientos30d,
  });
});

// ───────────── Alta y edición (ADMIN) ─────────────

const esquemaEstudio = z.object({
  nombre: z.string().trim().min(2).max(200),
  ruc: z.string().trim().regex(/^\d{11}$/, 'El RUC debe tener 11 dígitos').nullish(),
  emailContacto: email().nullish(),
  telefonoContacto: textoOpcional(30),
  planId: z.uuid().nullish(),
});

router.post(
  '/',
  soloAdmin,
  validar(esquemaEstudio.extend({ administrador: z.object({ nombres: z.string().trim().min(2).max(150), email: email() }) })),
  async (req, res) => {
    const { administrador, ...datos } = req.body;
    if (await prismaSystem.usuario.findUnique({ where: { email: administrador.email } })) {
      throw conflicto('Ya existe un usuario con ese correo');
    }
    const { tenant, admin, token } = await prismaSystem.$transaction(async (tx) => {
      const { tenant, roles } = await crearEstudio(tx, { nombre: datos.nombre, ruc: datos.ruc });
      await tx.tenant.update({
        where: { id: tenant.id },
        data: { emailContacto: datos.emailContacto ?? administrador.email, telefonoContacto: datos.telefonoContacto, planId: datos.planId ?? null },
      });
      const admin = await tx.usuario.create({
        data: {
          tenantId: tenant.id, nombres: administrador.nombres, email: administrador.email, cargo: 'Administrador', estado: 'pendiente',
          asignaciones: { create: { tenantId: tenant.id, rolId: roles.Administrador.id, alcanceTipo: 'estudio' } },
        },
      });
      const token = await crearInvitacion(tx, admin);
      await auditarPlataforma(req, { accion: 'estudio.crear', recurso: 'estudio', recursoId: tenant.id, tenantId: tenant.id, despues: req.body }, tx);
      return { tenant, admin, token };
    });
    await enviarInvitacion({ email: admin.email, nombres: admin.nombres, token });
    res.status(201).json({ id: tenant.id, nombre: tenant.nombre });
  },
);

router.put('/:id', soloAdmin, validar(esquemaEstudio), async (req, res) => {
  const antes = await cargarEstudio(req.params.id);
  if (req.body.planId && !(await prismaSystem.plan.findUnique({ where: { id: req.body.planId } }))) throw noEncontrado('Plan no encontrado');
  const despues = await prismaSystem.$transaction(async (tx) => {
    const d = await tx.tenant.update({ where: { id: antes.id }, data: req.body, include: { plan: true } });
    await auditarPlataforma(req, { accion: 'estudio.editar', recurso: 'estudio', recursoId: antes.id, tenantId: antes.id, antes, despues: d }, tx);
    return d;
  });
  res.json(despues);
});

router.post('/:id/suspender', soloAdmin, validar(z.object({ motivo: z.string().trim().min(5).max(500) })), async (req, res) => {
  const t = await cargarEstudio(req.params.id);
  if (!t.activo) throw conflicto('El estudio ya está suspendido');
  await prismaSystem.$transaction([
    prismaSystem.tenant.update({ where: { id: t.id }, data: { activo: false, suspendidoEn: new Date(), motivoSuspension: req.body.motivo } }),
    auditarPlataforma(req, { accion: 'estudio.suspender', recurso: 'estudio', recursoId: t.id, tenantId: t.id, despues: { motivo: req.body.motivo } }),
  ]);
  // Efecto inmediato: sin caché de "tenant activo", sin sesiones y sin sockets
  await redis.del(`tenant:activo:${t.id}`);
  const cerradas = await cerrarSesionesEstudio(t.id);
  res.json({ estado: 'suspendido', sesionesCerradas: cerradas });
});

router.post('/:id/reactivar', soloAdmin, async (req, res) => {
  const t = await cargarEstudio(req.params.id);
  if (t.activo) throw conflicto('El estudio ya está activo');
  await prismaSystem.$transaction([
    prismaSystem.tenant.update({ where: { id: t.id }, data: { activo: true, suspendidoEn: null, motivoSuspension: null } }),
    auditarPlataforma(req, { accion: 'estudio.reactivar', recurso: 'estudio', recursoId: t.id, tenantId: t.id, antes: { motivo: t.motivoSuspension } }),
  ]);
  await redis.del(`tenant:activo:${t.id}`);
  res.json({ estado: 'activo' });
});

// ───────────── Soporte (ADMIN y SOPORTE) ─────────────

async function usuarioDelEstudio(tenantId, usuarioId) {
  if (!uuid.safeParse(usuarioId).success) throw noEncontrado();
  const u = await prismaSystem.usuario.findFirst({ where: { id: usuarioId, tenantId } });
  if (!u) throw noEncontrado('Usuario no encontrado en este estudio');
  return u;
}

router.post('/:id/usuarios/:usuarioId/reenviar-invitacion', async (req, res) => {
  const t = await cargarEstudio(req.params.id);
  const u = await usuarioDelEstudio(t.id, req.params.usuarioId);
  if (u.estado !== 'pendiente') throw conflicto('El usuario ya activó su cuenta');
  const token = await prismaSystem.$transaction(async (tx) => {
    const tk = await crearInvitacion(tx, u);
    await auditarPlataforma(req, { accion: 'soporte.reenviar_invitacion', recurso: 'usuario', recursoId: u.id, tenantId: t.id }, tx);
    return tk;
  });
  await enviarInvitacion({ email: u.email, nombres: u.nombres, token });
  res.json({ mensaje: `Invitación reenviada a ${u.email}` });
});

router.post('/:id/usuarios/:usuarioId/restablecer-2fa', async (req, res) => {
  const t = await cargarEstudio(req.params.id);
  const u = await usuarioDelEstudio(t.id, req.params.usuarioId);
  await prismaSystem.$transaction([
    prismaSystem.usuario.update({ where: { id: u.id }, data: { mfaActivo: false, mfaSecret: null } }),
    prismaSystem.mfaCodigoRecuperacion.deleteMany({ where: { usuarioId: u.id } }),
    auditarPlataforma(req, { accion: 'soporte.restablecer_2fa', recurso: 'usuario', recursoId: u.id, tenantId: t.id }),
  ]);
  const sesiones = await prismaSystem.sesion.findMany({ where: { usuarioId: u.id, revocada: false }, select: { id: true } });
  await revocarSesiones(sesiones.map((s) => s.id));
  res.json({ mensaje: `2FA restablecido para ${u.email}; deberá configurarlo de nuevo si su rol lo exige` });
});

router.post('/:id/cerrar-sesiones', async (req, res) => {
  const t = await cargarEstudio(req.params.id);
  const cerradas = await cerrarSesionesEstudio(t.id);
  await auditarPlataforma(req, { accion: 'soporte.cerrar_sesiones', recurso: 'estudio', recursoId: t.id, tenantId: t.id, despues: { cerradas } });
  res.json({ sesionesCerradas: cerradas });
});

export default router;
