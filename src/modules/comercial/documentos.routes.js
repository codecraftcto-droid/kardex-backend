import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { autorizar, alcance } from '../../middleware/autorizar.js';
import { validar } from '../../middleware/validar.js';
import { puede, whereAlcance } from '../../rbac/resolver.js';
import { auditar } from '../../services/auditoria.js';
import { emitir } from '../../realtime/socket.js';
import { paginacion, respuestaPaginada } from '../../lib/http.js';
import { textoOpcional } from '../../lib/esquemas.js';
import { noEncontrado } from '../../lib/errors.js';
import * as servicio from '../../comercial/documentos.js';

/**
 * Router de compras o ventas (misma lógica, distinto tipo y permisos):
 *   compras → compras.compra.{ver,crear,aprobar,anular}
 *   ventas  → ventas.venta.{ver,crear,aprobar,anular}
 * El alcance de cada documento es su almacén.
 */
export function crearRouterDocumentos(tipo) {
  const router = Router();
  const p = tipo === 'COMPRA' ? 'compras.compra' : 'ventas.venta';
  const nombre = tipo === 'COMPRA' ? 'compra' : 'venta';
  const modulo = tipo === 'COMPRA' ? 'compras' : 'ventas';

  const decimal = (dec) =>
    z.union([z.string(), z.number()]).transform((v) => String(v).trim())
      .pipe(z.string().regex(new RegExp(`^\\d{1,12}(\\.\\d{1,${dec}})?$`), `Número inválido (máximo ${dec} decimales)`));

  const esquema = z
    .object({
      almacenId: z.uuid(),
      terceroDocumento: z.string().trim().regex(/^(\d{8}|\d{11}|[A-Z0-9-]{4,20})$/i, 'Documento inválido (DNI de 8 o RUC de 11 dígitos)'),
      terceroNombre: z.string().trim().min(2).max(200),
      comprobanteTipo: z.enum(['FACTURA', 'BOLETA', 'NOTA DE VENTA', 'GUÍA DE REMISIÓN', 'OTRO']),
      serie: z.string().trim().min(1).max(10).toUpperCase(),
      numero: z.string().trim().regex(/^\d{1,10}$/, 'Número de comprobante inválido'),
      fechaEmision: z.coerce.date(),
      moneda: z.enum(['PEN', 'USD']).default('PEN'),
      tipoCambio: decimal(4).optional(),
      observacion: textoOpcional(500),
      items: z
        .array(z.object({ productoId: z.uuid(), cantidad: decimal(4), valorUnitario: decimal(6), afectoIgv: z.boolean().default(true) }))
        .min(1, 'Agregue al menos un producto')
        .max(200),
    })
    .refine((v) => v.moneda === 'PEN' || (v.tipoCambio && Number(v.tipoCambio) > 0), {
      message: 'Indique el tipo de cambio para documentos en dólares',
      path: ['tipoCambio'],
    })
    .refine((v) => v.items.every((i) => Number(i.cantidad) > 0), { message: 'Las cantidades deben ser mayores que cero', path: ['items'] });

  const recursoDe = (d) => ({ empresaId: d.empresaId, sedeId: d.sedeId, almacenId: d.almacenId });

  /** Carga el documento validando permiso sobre su almacén (404 si no lo ve). */
  async function cargar(req, codigo) {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id || '')) throw noEncontrado();
    const d = await req.db((tx) => tx.documentoComercial.findUnique({ where: { id: req.params.id } }));
    if (!d || d.tipo !== tipo || !puede(req.permisos, codigo, recursoDe(d))) throw noEncontrado();
    return d;
  }

  const acciones = (perms, d) => ({
    editar: d.estado === 'BORRADOR' && puede(perms, `${p}.crear`, recursoDe(d)),
    eliminar: d.estado === 'BORRADOR' && puede(perms, `${p}.crear`, recursoDe(d)),
    confirmar: d.estado === 'BORRADOR' && puede(perms, `${p}.aprobar`, recursoDe(d)),
    anular: d.estado === 'CONFIRMADO' && puede(perms, `${p}.anular`, recursoDe(d)),
  });

  function notificar(d, movimientos = []) {
    emitir(`${nombre}:cambio`, { almacenId: d.almacenId }, { id: d.id, estado: d.estado });
    for (const { movimiento, alertas } of movimientos) {
      emitir('kardex:movimiento', { almacenId: movimiento.almacenId }, {
        id: movimiento.id, numero: movimiento.numero, tipo: movimiento.tipo, motivo: movimiento.motivo, almacenId: movimiento.almacenId,
      });
      for (const a of alertas) emitir('stock:alerta', { almacenId: a.almacenId }, a);
    }
  }

  router.get(
    '/',
    autorizar(`${p}.ver`),
    validar(
      z.object({
        empresaId: z.uuid(),
        estado: z.enum(['BORRADOR', 'CONFIRMADO', 'ANULADO']).optional(),
        almacenId: z.uuid().optional(),
        q: z.string().trim().max(100).optional(),
        desde: z.coerce.date().optional(),
        hasta: z.coerce.date().optional(),
        pagina: z.string().optional(),
        porPagina: z.string().optional(),
      }),
      'query',
    ),
    async (req, res) => {
      const pag = paginacion(req.validQuery);
      const alcanceWhere = whereAlcance(req.permisos, `${p}.ver`, 'registro');
      if (!alcanceWhere) return res.json(respuestaPaginada([], 0, pag));
      const { empresaId, estado, almacenId, q, desde, hasta } = req.validQuery;
      const where = {
        AND: [
          alcanceWhere,
          { empresaId, tipo },
          estado ? { estado } : {},
          almacenId ? { almacenId } : {},
          desde || hasta ? { fechaEmision: { ...(desde && { gte: desde }), ...(hasta && { lte: hasta }) } } : {},
          q
            ? { OR: [{ terceroNombre: { contains: q, mode: 'insensitive' } }, { terceroDocumento: { contains: q } }, { numero: { contains: q } }, { serie: { contains: q.toUpperCase() } }] }
            : {},
        ],
      };
      const [datos, total] = await req.db((tx) =>
        Promise.all([
          tx.documentoComercial.findMany({
            where,
            include: { almacen: { select: { codigo: true, nombre: true } }, _count: { select: { detalles: true } } },
            orderBy: [{ fechaEmision: 'desc' }, { creadoEn: 'desc' }],
            skip: pag.skip,
            take: pag.take,
          }),
          tx.documentoComercial.count({ where }),
        ]),
      );
      res.json(respuestaPaginada(datos.map((d) => ({ ...d, acciones: acciones(req.permisos, d) })), total, pag));
    },
  );

  router.get('/:id', autorizar(`${p}.ver`), async (req, res) => {
    await cargar(req, `${p}.ver`);
    const d = await req.db(async (tx) => {
      const d = await tx.documentoComercial.findUnique({
        where: { id: req.params.id },
        include: {
          almacen: { select: { id: true, codigo: true, nombre: true, sede: { select: { nombre: true } } } },
          detalles: { include: { producto: { select: { id: true, sku: true, nombre: true, unidad: { select: { codigo: true } } } } } },
          movimiento: { select: { id: true, numero: true, detalles: { select: { productoId: true, costoTotal: true } } } },
        },
      });
      const ids = [d.creadoPorId, d.confirmadoPorId, d.anuladoPorId].filter(Boolean);
      const usuarios = new Map((await tx.usuario.findMany({ where: { id: { in: ids } }, select: { id: true, nombres: true } })).map((u) => [u.id, u.nombres]));
      const anulacion = d.movimientoAnulacionId
        ? await tx.movimiento.findUnique({ where: { id: d.movimientoAnulacionId }, select: { id: true, numero: true } })
        : null;
      return { ...d, anulacion, creadoPor: usuarios.get(d.creadoPorId), confirmadoPor: usuarios.get(d.confirmadoPorId), anuladoPor: usuarios.get(d.anuladoPorId) };
    });

    // Venta confirmada: costo de lo vendido y margen (solo con permiso de costos)
    const verCostos = puede(req.permisos, 'kardex.costos.ver', recursoDe(d));
    let margen = null;
    if (verCostos && tipo === 'VENTA' && d.movimiento) {
      const costo = d.movimiento.detalles.reduce((s, x) => s.add(x.costoTotal), new Prisma.Decimal(0));
      const venta = new Prisma.Decimal(d.subtotal).mul(d.tipoCambio);
      margen = { costoVenta: costo.toDecimalPlaces(2), ventaSoles: venta.toDecimalPlaces(2), utilidad: venta.sub(costo).toDecimalPlaces(2) };
    }
    const { movimiento, ...resto } = d;
    res.json({ ...resto, movimiento: movimiento && { id: movimiento.id, numero: movimiento.numero }, margen, acciones: acciones(req.permisos, d) });
  });

  router.post(
    '/',
    autorizar(`${p}.crear`, { alcance: alcance.almacen('almacenId', 'body') }),
    validar(esquema),
    async (req, res) => {
      const d = await req.db(async (tx) => {
        const creado = await servicio.guardarBorrador(tx, { tenantId: req.tenantId, tipo, usuarioId: req.user.id, datos: req.body });
        await auditar(tx, req, { modulo, accion: `${nombre}.crear`, recurso: nombre, recursoId: creado.id, empresaId: creado.empresaId, despues: req.body });
        return creado;
      });
      notificar(d);
      res.status(201).json({ id: d.id, estado: d.estado, total: d.total });
    },
  );

  router.put('/:id', autorizar(`${p}.crear`), validar(esquema), async (req, res) => {
    const antes = await cargar(req, `${p}.crear`);
    // También debe tener permiso sobre el (posible) nuevo almacén
    const destino = await req.db((tx) => tx.almacen.findUnique({ where: { id: req.body.almacenId }, select: { empresaId: true, sedeId: true, id: true } }));
    if (!destino || !puede(req.permisos, `${p}.crear`, { empresaId: destino.empresaId, sedeId: destino.sedeId, almacenId: destino.id })) throw noEncontrado('Almacén no encontrado');
    const d = await req.db(async (tx) => {
      const actualizado = await servicio.guardarBorrador(tx, { tenantId: req.tenantId, tipo, id: antes.id, usuarioId: req.user.id, datos: req.body });
      await auditar(tx, req, { modulo, accion: `${nombre}.editar`, recurso: nombre, recursoId: antes.id, empresaId: antes.empresaId, antes, despues: req.body });
      return actualizado;
    });
    notificar(d);
    res.json({ id: d.id, estado: d.estado, total: d.total });
  });

  router.delete('/:id', autorizar(`${p}.crear`), async (req, res) => {
    const d = await cargar(req, `${p}.crear`);
    await req.db(async (tx) => {
      const { count } = await tx.documentoComercial.deleteMany({ where: { id: d.id, estado: 'BORRADOR' } });
      if (!count) throw noEncontrado('Solo se pueden eliminar borradores');
      await auditar(tx, req, { modulo, accion: `${nombre}.eliminar`, recurso: nombre, recursoId: d.id, empresaId: d.empresaId, antes: d });
    });
    notificar({ ...d, estado: 'ELIMINADO' });
    res.status(204).end();
  });

  router.post('/:id/confirmar', autorizar(`${p}.aprobar`), async (req, res) => {
    const d = await cargar(req, `${p}.aprobar`);
    const r = await req.db(
      async (tx) => {
        const r = await servicio.confirmar(tx, { tenantId: req.tenantId, id: d.id, usuarioId: req.user.id });
        await auditar(tx, req, {
          modulo, accion: `${nombre}.confirmar`, recurso: nombre, recursoId: d.id, empresaId: d.empresaId,
          antes: { estado: 'BORRADOR' }, despues: { estado: 'CONFIRMADO', movimiento: r.movimiento.numero },
        });
        return r;
      },
      { timeout: 20000 },
    );
    notificar({ ...d, estado: 'CONFIRMADO' }, [r]);
    res.json({ id: d.id, estado: 'CONFIRMADO', movimiento: { id: r.movimiento.id, numero: r.movimiento.numero } });
  });

  router.post(
    '/:id/anular',
    autorizar(`${p}.anular`),
    validar(z.object({ motivo: z.string().trim().min(5, 'Indique el motivo de la anulación').max(500) })),
    async (req, res) => {
      const d = await cargar(req, `${p}.anular`);
      const r = await req.db(
        async (tx) => {
          const r = await servicio.anular(tx, { tenantId: req.tenantId, id: d.id, usuarioId: req.user.id, motivo: req.body.motivo });
          await auditar(tx, req, {
            modulo, accion: `${nombre}.anular`, recurso: nombre, recursoId: d.id, empresaId: d.empresaId,
            antes: { estado: 'CONFIRMADO' }, despues: { estado: 'ANULADO', motivo: req.body.motivo, movimiento: r.movimiento.numero },
          });
          return r;
        },
        { timeout: 20000 },
      );
      notificar({ ...d, estado: 'ANULADO' }, [r]);
      res.json({ id: d.id, estado: 'ANULADO', movimiento: { id: r.movimiento.id, numero: r.movimiento.numero } });
    },
  );

  return router;
}
