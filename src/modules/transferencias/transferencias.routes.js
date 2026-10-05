import { Router } from 'express';
import { z } from 'zod';
import { autorizar } from '../../middleware/autorizar.js';
import { validar } from '../../middleware/validar.js';
import { puede, whereAlcance } from '../../rbac/resolver.js';
import { auditar } from '../../services/auditoria.js';
import { emitir, emitirAlmacenes } from '../../realtime/socket.js';
import { paginacion, respuestaPaginada } from '../../lib/http.js';
import { textoOpcional } from '../../lib/esquemas.js';
import { noEncontrado, prohibido } from '../../lib/errors.js';
import * as servicio from '../../kardex/transferencias.js';

const router = Router();

const decimal = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .pipe(z.string().regex(/^\d{1,12}(\.\d{1,4})?$/, 'Número inválido (máximo 4 decimales)'));
const cantidadesPorProducto = z.record(z.uuid(), decimal).optional();

const recursoOrigen = (t) => ({ empresaId: t.empresaId, sedeId: t.origenSedeId, almacenId: t.origenAlmacenId });
const recursoDestino = (t) => ({ empresaId: t.empresaId, sedeId: t.destinoSedeId, almacenId: t.destinoAlmacenId });

/** Acciones que el usuario puede ejecutar ahora mismo (el frontend solo muestra estas). */
function acciones(perms, t, usuarioId) {
  const enOrigen = (p) => puede(perms, p, recursoOrigen(t));
  return {
    aprobar: t.estado === 'SOLICITADA' && enOrigen('transferencia.aprobar'),
    rechazar: t.estado === 'SOLICITADA' && enOrigen('transferencia.aprobar'),
    despachar: t.estado === 'APROBADA' && enOrigen('transferencia.despachar'),
    recibir: t.estado === 'DESPACHADA' && puede(perms, 'transferencia.recibir', recursoDestino(t)),
    cancelar:
      (t.estado === 'SOLICITADA' && t.solicitadoPorId === usuarioId) ||
      (['SOLICITADA', 'APROBADA'].includes(t.estado) && enOrigen('transferencia.aprobar')),
  };
}

const puedeVer = (perms, t) =>
  puede(perms, 'transferencia.ver', recursoOrigen(t)) || puede(perms, 'transferencia.ver', recursoDestino(t));

const incluirResumen = {
  origen: { select: { id: true, codigo: true, nombre: true, sede: { select: { nombre: true } } } },
  destino: { select: { id: true, codigo: true, nombre: true, sede: { select: { nombre: true } } } },
  solicitadoPor: { select: { nombres: true } },
};

/** Carga la transferencia y valida que el usuario la pueda ver (si no, 404). */
async function cargar(req) {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id || '')) throw noEncontrado();
  const t = await req.db((tx) => tx.transferencia.findUnique({ where: { id: req.params.id } }));
  if (!t || !puedeVer(req.permisos, t)) throw noEncontrado();
  return t;
}

// ───────────── Consulta ─────────────

router.get(
  '/',
  autorizar('transferencia.ver'),
  validar(
    z.object({
      empresaId: z.uuid(),
      estado: z.enum(['SOLICITADA', 'APROBADA', 'RECHAZADA', 'DESPACHADA', 'RECIBIDA', 'CANCELADA']).optional(),
      almacenId: z.uuid().optional(),
      pendientes: z.enum(['true', 'false']).optional(),
      q: z.string().trim().max(30).optional(),
      pagina: z.string().optional(),
      porPagina: z.string().optional(),
    }),
    'query',
  ),
  async (req, res) => {
    const pag = paginacion(req.validQuery);
    // Visible si el usuario tiene alcance sobre el origen O sobre el destino
    const porOrigen = whereAlcance(req.permisos, 'transferencia.ver', { empresa: 'empresaId', sede: 'origenSedeId', almacen: 'origenAlmacenId' });
    const porDestino = whereAlcance(req.permisos, 'transferencia.ver', { empresa: 'empresaId', sede: 'destinoSedeId', almacen: 'destinoAlmacenId' });
    const alcances = [porOrigen, porDestino].filter(Boolean);
    if (!alcances.length) return res.json(respuestaPaginada([], 0, pag));

    const { empresaId, estado, almacenId, pendientes, q } = req.validQuery;
    const where = {
      AND: [
        { OR: alcances },
        { empresaId },
        estado ? { estado } : {},
        pendientes === 'true' ? { estado: { in: ['SOLICITADA', 'APROBADA', 'DESPACHADA'] } } : {},
        almacenId ? { OR: [{ origenAlmacenId: almacenId }, { destinoAlmacenId: almacenId }] } : {},
        q ? { numero: { contains: q, mode: 'insensitive' } } : {},
      ],
    };
    const [datos, total] = await req.db((tx) =>
      Promise.all([
        tx.transferencia.findMany({
          where,
          include: { ...incluirResumen, _count: { select: { detalles: true } } },
          orderBy: { solicitadoEn: 'desc' },
          skip: pag.skip,
          take: pag.take,
        }),
        tx.transferencia.count({ where }),
      ]),
    );
    res.json(respuestaPaginada(datos.map((t) => ({ ...t, acciones: acciones(req.permisos, t, req.user.id) })), total, pag));
  },
);

router.get('/:id', autorizar('transferencia.ver'), async (req, res) => {
  await cargar(req);
  const t = await req.db(async (tx) => {
    const t = await tx.transferencia.findUnique({
      where: { id: req.params.id },
      include: {
        ...incluirResumen,
        detalles: { include: { producto: { select: { id: true, sku: true, nombre: true, unidad: { select: { codigo: true } } } } } },
        movimientos: { select: { id: true, numero: true, tipo: true, fecha: true }, orderBy: { fecha: 'asc' } },
      },
    });
    // Nombres de quienes intervinieron en cada etapa
    const ids = [t.aprobadoPorId, t.rechazadoPorId, t.despachadoPorId, t.recibidoPorId, t.canceladoPorId].filter(Boolean);
    const usuarios = await tx.usuario.findMany({ where: { id: { in: ids } }, select: { id: true, nombres: true } });
    const nombre = new Map(usuarios.map((u) => [u.id, u.nombres]));
    for (const campo of ['aprobado', 'rechazado', 'despachado', 'recibido', 'cancelado']) {
      t[`${campo}Por`] = t[`${campo}PorId`] ? { nombres: nombre.get(t[`${campo}PorId`]) } : null;
    }
    // Stock disponible en origen (útil para aprobar y despachar)
    const stocks = await tx.stock.findMany({
      where: { almacenId: t.origenAlmacenId, productoId: { in: t.detalles.map((d) => d.productoId) } },
      select: { productoId: true, cantidad: true },
    });
    t.stockOrigen = Object.fromEntries(stocks.map((s) => [s.productoId, s.cantidad]));
    return t;
  });
  const verCostos = puede(req.permisos, 'kardex.costos.ver', recursoOrigen(t));
  if (!verCostos) t.detalles = t.detalles.map(({ costoUnitario, ...d }) => d);
  res.json({ ...t, verCostos, acciones: acciones(req.permisos, t, req.user.id) });
});

// ───────────── Transiciones ─────────────

/** Ejecuta una transición: valida permiso, audita, notifica a ambos almacenes. */
function accion(nombre, { validarPermiso, ejecutar }) {
  return async (req, res) => {
    const t = await cargar(req);
    if (!validarPermiso(req, t)) throw prohibido(`No tiene permiso para ${nombre} esta transferencia`);
    const r = await req.db(
      async (tx) => {
        const r = await ejecutar(tx, req, t);
        await auditar(tx, req, {
          modulo: 'transferencia', accion: `transferencia.${nombre}`, recurso: 'transferencia', recursoId: t.id,
          empresaId: t.empresaId, antes: { estado: t.estado }, despues: { estado: r.transferencia.estado, ...req.body },
        });
        return r;
      },
      { timeout: 20000 },
    );
    notificar(req, r.transferencia, r.movimientos);
    res.json({ id: t.id, numero: t.numero, estado: r.transferencia.estado });
  };
}

function notificar(req, t, movimientos = []) {
  emitirAlmacenes('transferencia:cambio', [t.origenAlmacenId, t.destinoAlmacenId], {
    id: t.id, numero: t.numero, estado: t.estado, actorId: req.user.id,
  });
  for (const { movimiento, alertas } of movimientos) {
    emitir('kardex:movimiento', { almacenId: movimiento.almacenId }, {
      id: movimiento.id, numero: movimiento.numero, tipo: movimiento.tipo, motivo: movimiento.motivo, almacenId: movimiento.almacenId,
    });
    for (const a of alertas) emitir('stock:alerta', { almacenId: a.almacenId }, a);
  }
}

router.post(
  '/',
  autorizar('transferencia.solicitar'),
  validar(
    z.object({
      origenAlmacenId: z.uuid(),
      destinoAlmacenId: z.uuid(),
      observacion: textoOpcional(500),
      items: z.array(z.object({ productoId: z.uuid(), cantidad: decimal })).min(1, 'Agregue al menos un producto').max(200),
    }),
  ),
  async (req, res) => {
    const { origenAlmacenId, destinoAlmacenId } = req.body;
    const t = await req.db(async (tx) => {
      const almacenes = await tx.almacen.findMany({
        where: { id: { in: [origenAlmacenId, destinoAlmacenId] } },
        select: { id: true, empresaId: true, sedeId: true },
      });
      const recurso = (id) => {
        const a = almacenes.find((x) => x.id === id);
        return a && { empresaId: a.empresaId, sedeId: a.sedeId, almacenId: a.id };
      };
      const [ro, rd] = [recurso(origenAlmacenId), recurso(destinoAlmacenId)];
      if (!ro || !rd) throw noEncontrado('Almacén no encontrado');
      // Puede solicitar quien tiene alcance sobre el origen (envía) o sobre el destino (pide)
      if (!puede(req.permisos, 'transferencia.solicitar', ro) && !puede(req.permisos, 'transferencia.solicitar', rd)) {
        throw noEncontrado('Almacén no encontrado');
      }
      const creada = await servicio.solicitar(tx, { ...req.body, tenantId: req.tenantId, usuarioId: req.user.id });
      await auditar(tx, req, {
        modulo: 'transferencia', accion: 'transferencia.solicitar', recurso: 'transferencia', recursoId: creada.id,
        empresaId: creada.empresaId, despues: { numero: creada.numero, ...req.body },
      });
      return creada;
    });
    notificar(req, t);
    res.status(201).json({ id: t.id, numero: t.numero, estado: t.estado });
  },
);

const enOrigen = (codigo) => (req, t) => puede(req.permisos, codigo, recursoOrigen(t));
const motivo = validar(z.object({ motivo: z.string().trim().min(5, 'Indique el motivo').max(500) }));

router.post('/:id/aprobar', autorizar('transferencia.aprobar'), accion('aprobar', {
  validarPermiso: enOrigen('transferencia.aprobar'),
  ejecutar: async (tx, req, t) => ({ transferencia: await servicio.aprobar(tx, { id: t.id, usuarioId: req.user.id }) }),
}));

router.post('/:id/rechazar', autorizar('transferencia.aprobar'), motivo, accion('rechazar', {
  validarPermiso: enOrigen('transferencia.aprobar'),
  ejecutar: async (tx, req, t) => ({ transferencia: await servicio.rechazar(tx, { id: t.id, usuarioId: req.user.id, motivo: req.body.motivo }) }),
}));

router.post('/:id/cancelar', autorizar('transferencia.ver'), motivo, accion('cancelar', {
  validarPermiso: (req, t) => (t.estado === 'SOLICITADA' && t.solicitadoPorId === req.user.id) || enOrigen('transferencia.aprobar')(req, t),
  ejecutar: async (tx, req, t) => ({ transferencia: await servicio.cancelar(tx, { id: t.id, usuarioId: req.user.id, motivo: req.body.motivo }) }),
}));

router.post(
  '/:id/despachar',
  autorizar('transferencia.despachar'),
  validar(z.object({ cantidades: cantidadesPorProducto })),
  accion('despachar', {
    validarPermiso: enOrigen('transferencia.despachar'),
    ejecutar: (tx, req, t) => servicio.despachar(tx, { tenantId: req.tenantId, id: t.id, usuarioId: req.user.id, cantidades: req.body.cantidades }),
  }),
);

router.post(
  '/:id/recibir',
  autorizar('transferencia.recibir'),
  validar(z.object({ cantidades: cantidadesPorProducto, observacion: textoOpcional(500) })),
  accion('recibir', {
    validarPermiso: (req, t) => puede(req.permisos, 'transferencia.recibir', recursoDestino(t)),
    ejecutar: (tx, req, t) =>
      servicio.recibir(tx, { tenantId: req.tenantId, id: t.id, usuarioId: req.user.id, cantidades: req.body.cantidades, observacion: req.body.observacion }),
  }),
);

export default router;
