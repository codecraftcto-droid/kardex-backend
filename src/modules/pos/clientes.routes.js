import { Router } from 'express';
import { z } from 'zod';
import { rateLimit } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { autorizarEnEmpresa } from '../../middleware/autorizar.js';
import { redis } from '../../lib/redis.js';
import { puedeDentroDeEmpresa } from '../../rbac/resolver.js';
import { consultaDisponible, consultarDocumento } from '../../services/consultaDocumento.js';
import { validar } from '../../middleware/validar.js';
import { auditar } from '../../services/auditoria.js';
import { paginacion, respuestaPaginada } from '../../lib/http.js';
import { textoOpcional } from '../../lib/esquemas.js';
import { conflicto, prohibido, solicitudInvalida } from '../../lib/errors.js';
import { errorDocumento, rucValido } from '../../pos/reglas.js';

/** Clientes de cada empresa (a quienes se les vende). Recurso de toda la empresa, como el catálogo. */
const router = Router();
const uuid = /^[0-9a-f-]{36}$/i;
const empresaDeQuery = (req) => (uuid.test(req.query.empresaId || '') ? req.query.empresaId : null);
const empresaDeBody = (req) => (uuid.test(req.body?.empresaId || '') ? req.body.empresaId : null);
const empresaDelCliente = async (req) => {
  if (!uuid.test(req.params.id || '')) return null;
  const c = await req.db((tx) => tx.cliente.findUnique({ where: { id: req.params.id }, select: { empresaId: true } }));
  return c?.empresaId ?? null;
};

const esquema = z
  .object({
    tipoDocumento: z.enum(['DNI', 'RUC', 'CARNE_EXTRANJERIA', 'PASAPORTE']),
    numeroDocumento: z.string().trim().toUpperCase(),
    nombre: z.string().trim().min(2).max(200),
    direccion: textoOpcional(255),
    email: z.union([z.email(), z.literal('')]).nullish().transform((v) => v || null),
    telefono: textoOpcional(30),
    rucAsociado: z.string().trim().nullish().transform((v) => v || null),
    // Crédito: solo lo cambia quien tiene clientes.credito.configurar (se valida en la ruta)
    creditoHabilitado: z.boolean().optional(),
    limiteCredito: z.union([z.string(), z.number()]).nullish().transform((v) => (v === '' || v == null ? null : String(v).trim()))
      .refine((v) => v == null || /^\d{1,12}(\.\d{1,2})?$/.test(v), 'Límite inválido'),
    diasCredito: z.coerce.number().int().min(0).max(365).optional(),
  })
  .superRefine((v, ctx) => {
    const e = errorDocumento(v.tipoDocumento, v.numeroDocumento);
    if (e) ctx.addIssue({ code: 'custom', path: ['numeroDocumento'], message: e });
    if (v.rucAsociado) {
      if (v.tipoDocumento === 'RUC') ctx.addIssue({ code: 'custom', path: ['rucAsociado'], message: 'Un cliente con RUC no lleva RUC asociado' });
      else if (!rucValido(v.rucAsociado) || !v.rucAsociado.startsWith('10')) ctx.addIssue({ code: 'custom', path: ['rucAsociado'], message: 'El RUC asociado debe ser un RUC 10 válido (persona natural)' });
    }
  });

const CAMPOS_CREDITO = ['creditoHabilitado', 'limiteCredito', 'diasCredito'];
const normalCredito = (o) => ({
  creditoHabilitado: Boolean(o?.creditoHabilitado),
  limiteCredito: o?.limiteCredito == null ? null : Number(o.limiteCredito),
  diasCredito: o?.diasCredito == null ? 30 : Number(o.diasCredito),
});
/** Quita los campos de crédito si el usuario no puede configurarlos (y rechaza si intentó cambiarlos). */
function filtrarCredito(req, datos, antes = null) {
  if (puedeDentroDeEmpresa(req.permisos, 'clientes.credito.configurar', req.empresaId)) return datos;
  const previo = normalCredito(antes);
  const pedido = normalCredito({ ...previo, ...Object.fromEntries(CAMPOS_CREDITO.filter((k) => datos[k] !== undefined).map((k) => [k, datos[k]])) });
  if (CAMPOS_CREDITO.some((k) => pedido[k] !== previo[k])) throw prohibido('No tiene permiso para configurar el crédito de clientes');
  return Object.fromEntries(Object.entries(datos).filter(([k]) => !CAMPOS_CREDITO.includes(k)));
}

const limiteConsulta = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => `${req.user.id}`,
  message: { error: 'Demasiadas consultas seguidas, espere un momento' },
  store: new RedisStore({ sendCommand: (...args) => redis.call(...args), prefix: 'rl:consulta-doc:' }),
});

/** ¿Está configurada la consulta a RENIEC/SUNAT? (el formulario muestra u oculta el botón) */
router.get('/consulta/disponible', (_req, res) => res.json({ disponible: consultaDisponible() }));

router.get(
  '/consulta',
  autorizarEnEmpresa('clientes.cliente.crear', empresaDeQuery),
  limiteConsulta,
  validar(z.object({ empresaId: z.uuid(), tipo: z.enum(['DNI', 'RUC']), numero: z.string().trim() }), 'query'),
  async (req, res) => {
    const { tipo, numero } = req.validQuery;
    const e = errorDocumento(tipo, numero);
    if (e) throw solicitudInvalida(e);
    const datos = await consultarDocumento(tipo, numero);
    // Si ya está registrado en esta empresa, se avisa para no duplicarlo
    const existente = await req.db((tx) =>
      tx.cliente.findFirst({ where: { empresaId: req.empresaId, OR: [{ tipoDocumento: tipo, numeroDocumento: numero }, ...(tipo === 'RUC' ? [{ rucAsociado: numero }] : [])] }, select: { id: true, nombre: true } }),
    );
    res.json({ ...datos, existente });
  },
);

router.get(
  '/',
  autorizarEnEmpresa('clientes.cliente.ver', empresaDeQuery),
  validar(z.object({ empresaId: z.uuid(), q: z.string().trim().max(100).optional(), pagina: z.string().optional(), porPagina: z.string().optional() }), 'query'),
  async (req, res) => {
    const { q } = req.validQuery;
    const pag = paginacion(req.validQuery);
    const where = {
      empresaId: req.empresaId,
      ...(q && {
        OR: [{ nombre: { contains: q, mode: 'insensitive' } }, { numeroDocumento: { startsWith: q.toUpperCase() } }, { rucAsociado: { startsWith: q } }],
      }),
    };
    const [datos, total] = await req.db((tx) =>
      Promise.all([
        tx.cliente.findMany({ where, orderBy: { nombre: 'asc' }, skip: pag.skip, take: pag.take, include: { _count: { select: { comprobantes: true } } } }),
        tx.cliente.count({ where }),
      ]),
    );
    res.json(respuestaPaginada(datos, total, pag));
  },
);

router.post('/', autorizarEnEmpresa('clientes.cliente.crear', empresaDeBody), validar(esquema.and(z.object({ empresaId: z.uuid() }))), async (req, res) => {
  const cliente = await req.db(async (tx) => {
    if (!(await tx.empresa.findUnique({ where: { id: req.empresaId } }))) throw solicitudInvalida('Empresa no encontrada');
    const c = await tx.cliente.create({ data: { ...filtrarCredito(req, req.body), tenantId: req.tenantId } });
    await auditar(tx, req, { modulo: 'clientes', accion: 'cliente.crear', recurso: 'cliente', recursoId: c.id, empresaId: c.empresaId, despues: c });
    return c;
  });
  res.status(201).json(cliente);
});

router.put('/:id', autorizarEnEmpresa('clientes.cliente.editar', empresaDelCliente), validar(esquema.and(z.object({ activo: z.boolean().optional() }))), async (req, res) => {
  const cliente = await req.db(async (tx) => {
    const antes = await tx.cliente.findUnique({ where: { id: req.params.id } });
    const despues = await tx.cliente.update({ where: { id: antes.id }, data: filtrarCredito(req, req.body, antes) });
    await auditar(tx, req, { modulo: 'clientes', accion: 'cliente.editar', recurso: 'cliente', recursoId: antes.id, empresaId: antes.empresaId, antes, despues });
    return despues;
  });
  res.json(cliente);
});

router.delete('/:id', autorizarEnEmpresa('clientes.cliente.eliminar', empresaDelCliente), async (req, res) => {
  await req.db(async (tx) => {
    const c = await tx.cliente.findUnique({ where: { id: req.params.id }, include: { _count: { select: { comprobantes: true, cobranzas: true } } } });
    if (c._count.comprobantes || c._count.cobranzas) throw conflicto('El cliente tiene comprobantes emitidos; desactívelo en lugar de eliminarlo');
    await tx.cliente.delete({ where: { id: c.id } });
    await auditar(tx, req, { modulo: 'clientes', accion: 'cliente.eliminar', recurso: 'cliente', recursoId: c.id, empresaId: c.empresaId, antes: c });
  });
  res.status(204).end();
});

export default router;
