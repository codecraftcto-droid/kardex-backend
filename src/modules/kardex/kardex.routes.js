import { Router } from 'express';
import { z } from 'zod';
import { autorizar, alcance } from '../../middleware/autorizar.js';
import { validar } from '../../middleware/validar.js';
import { puede, whereAlcance } from '../../rbac/resolver.js';
import { auditar } from '../../services/auditoria.js';
import { emitir } from '../../realtime/socket.js';
import { prismaApp } from '../../lib/prisma.js';
import { paginacion, respuestaPaginada } from '../../lib/http.js';
import { textoOpcional } from '../../lib/esquemas.js';
import { noEncontrado, solicitudInvalida } from '../../lib/errors.js';
import { MOTIVOS, anularMovimiento, registrarMovimiento, sinCostos } from '../../kardex/servicio.js';

const router = Router();

/** Decimal como texto (evita coma flotante): hasta `dec` decimales. */
const decimal = (dec) =>
  z
    .union([z.string(), z.number()])
    .transform((v) => String(v).trim())
    .pipe(z.string().regex(new RegExp(`^\\d{1,12}(\\.\\d{1,${dec}})?$`), `Número inválido (máximo ${dec} decimales)`));

const verCostos = (perms, r) =>
  puede(perms, 'kardex.costos.ver', { empresaId: r.empresaId, sedeId: r.sedeId, almacenId: r.almacenId });
const filtrarCostos = (perms, r) => (verCostos(perms, r) ? r : sinCostos(r));

/** Alcance de un movimiento existente (su almacén). */
const porMovimiento = async (req) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.movimientoId || '')) return null;
  const m = await req.db((tx) =>
    tx.movimiento.findUnique({ where: { id: req.params.movimientoId }, select: { empresaId: true, sedeId: true, almacenId: true } }),
  );
  return m;
};

// ───────────── Stock ─────────────

router.get(
  '/stock',
  autorizar('kardex.stock.ver'),
  validar(
    z.object({
      empresaId: z.uuid(),
      sedeId: z.uuid().optional(),
      almacenId: z.uuid().optional(),
      q: z.string().trim().max(100).optional(),
      bajoMinimo: z.enum(['true', 'false']).optional(),
      pagina: z.string().optional(),
      porPagina: z.string().optional(),
    }),
    'query',
  ),
  async (req, res) => {
    const pag = paginacion(req.validQuery, { maxPorPagina: 200 });
    const alcanceWhere = whereAlcance(req.permisos, 'kardex.stock.ver', 'registro');
    if (!alcanceWhere) return res.json({ ...respuestaPaginada([], 0, pag), resumen: null });
    const { empresaId, sedeId, almacenId, q, bajoMinimo } = req.validQuery;
    const where = {
      AND: [
        alcanceWhere,
        { empresaId },
        sedeId ? { sedeId } : {},
        almacenId ? { almacenId } : {},
        bajoMinimo === 'true' ? { stockMinimo: { not: null }, cantidad: { lt: prismaApp.stock.fields.stockMinimo } } : {},
        q
          ? { producto: { OR: [{ nombre: { contains: q, mode: 'insensitive' } }, { sku: { contains: q, mode: 'insensitive' } }, { codigoBarras: q }] } }
          : {},
      ],
    };
    // Valor total solo de los almacenes donde puede ver costos
    const alcanceCostos = whereAlcance(req.permisos, 'kardex.costos.ver', 'registro');
    const [filas, total, valor] = await req.db((tx) =>
      Promise.all([
        tx.stock.findMany({
          where,
          include: {
            producto: { select: { id: true, sku: true, nombre: true, codigoBarras: true, unidad: { select: { codigo: true } } } },
            almacen: { select: { id: true, codigo: true, nombre: true } },
          },
          orderBy: [{ producto: { nombre: 'asc' } }, { almacen: { nombre: 'asc' } }],
          skip: pag.skip,
          take: pag.take,
        }),
        tx.stock.count({ where }),
        alcanceCostos ? tx.stock.aggregate({ where: { AND: [where, alcanceCostos] }, _sum: { valorTotal: true } }) : null,
      ]),
    );
    res.json({
      ...respuestaPaginada(filas.map((f) => filtrarCostos(req.permisos, f)), total, pag),
      resumen: { valorTotal: valor?._sum.valorTotal ?? null },
    });
  },
);

router.put(
  '/stock/limites',
  autorizar('almacenes.almacen.editar', { alcance: alcance.almacen('almacenId', 'body') }),
  validar(
    z
      .object({
        almacenId: z.uuid(),
        productoId: z.uuid(),
        stockMinimo: decimal(4).nullable(),
        stockMaximo: decimal(4).nullable(),
      })
      .refine((v) => v.stockMinimo == null || v.stockMaximo == null || Number(v.stockMinimo) <= Number(v.stockMaximo), {
        message: 'El mínimo no puede superar al máximo',
        path: ['stockMinimo'],
      }),
  ),
  async (req, res) => {
    const { almacenId, productoId, stockMinimo, stockMaximo } = req.body;
    const stock = await req.db(async (tx) => {
      const producto = await tx.producto.findUnique({ where: { id: productoId }, select: { empresaId: true } });
      if (!producto || producto.empresaId !== req.recurso.empresaId) throw noEncontrado('Producto no encontrado');
      const s = await tx.stock.upsert({
        where: { almacenId_productoId: { almacenId, productoId } },
        create: { tenantId: req.tenantId, empresaId: req.recurso.empresaId, sedeId: req.recurso.sedeId, almacenId, productoId, stockMinimo, stockMaximo },
        update: { stockMinimo, stockMaximo },
      });
      await auditar(tx, req, {
        modulo: 'kardex', accion: 'stock.limites', recurso: 'stock', recursoId: s.id, empresaId: s.empresaId,
        despues: { almacenId, productoId, stockMinimo, stockMaximo },
      });
      return s;
    });
    emitir('stock:cambio', { almacenId }, { almacenId, productoId });
    res.json(filtrarCostos(req.permisos, stock));
  },
);

// ───────────── Movimientos ─────────────

router.get(
  '/movimientos',
  autorizar('kardex.stock.ver'),
  validar(
    z.object({
      empresaId: z.uuid(),
      almacenId: z.uuid().optional(),
      tipo: z.enum(['ENTRADA', 'SALIDA']).optional(),
      motivo: z.string().max(30).optional(),
      desde: z.coerce.date().optional(),
      hasta: z.coerce.date().optional(),
      q: z.string().trim().max(50).optional(),
      pagina: z.string().optional(),
      porPagina: z.string().optional(),
    }),
    'query',
  ),
  async (req, res) => {
    const pag = paginacion(req.validQuery);
    const alcanceWhere = whereAlcance(req.permisos, 'kardex.stock.ver', 'registro');
    if (!alcanceWhere) return res.json(respuestaPaginada([], 0, pag));
    const { empresaId, almacenId, tipo, motivo, desde, hasta, q } = req.validQuery;
    const where = {
      AND: [
        alcanceWhere,
        { empresaId },
        almacenId ? { almacenId } : {},
        tipo ? { tipo } : {},
        motivo ? { motivo } : {},
        desde || hasta ? { fecha: { ...(desde && { gte: desde }), ...(hasta && { lte: hasta }) } } : {},
        q ? { OR: [{ numero: { contains: q, mode: 'insensitive' } }, { documentoNumero: { contains: q } }] } : {},
      ],
    };
    const [datos, total] = await req.db((tx) =>
      Promise.all([
        tx.movimiento.findMany({
          where,
          include: {
            almacen: { select: { codigo: true, nombre: true } },
            usuario: { select: { nombres: true } },
            anula: { select: { id: true, numero: true } },
            anuladoPor: { select: { id: true, numero: true } },
            _count: { select: { detalles: true } },
          },
          orderBy: { fecha: 'desc' },
          skip: pag.skip,
          take: pag.take,
        }),
        tx.movimiento.count({ where }),
      ]),
    );
    res.json(respuestaPaginada(datos, total, pag));
  },
);

router.get('/movimientos/:movimientoId', autorizar('kardex.stock.ver', { alcance: porMovimiento }), async (req, res) => {
  const m = await req.db((tx) =>
    tx.movimiento.findUnique({
      where: { id: req.params.movimientoId },
      include: {
        almacen: { select: { id: true, codigo: true, nombre: true, sede: { select: { nombre: true } } } },
        usuario: { select: { nombres: true } },
        anula: { select: { id: true, numero: true } },
        anuladoPor: { select: { id: true, numero: true, fecha: true } },
        documentoComercial: { select: { id: true, tipo: true, serie: true, numero: true } },
        // Venta o nota de crédito del punto de venta que generó el movimiento
        comprobante: { select: { id: true, tipo: true, serie: true, numero: true } },
        transferencia: { select: { id: true, numero: true } },
        detalles: {
          orderBy: { id: 'asc' },
          include: { producto: { select: { id: true, sku: true, nombre: true, unidad: { select: { codigo: true } } } } },
        },
      },
    }),
  );
  const costos = verCostos(req.permisos, m);
  res.json({ ...m, verCostos: costos, detalles: costos ? m.detalles : m.detalles.map(sinCostos) });
});

const esquemaMovimiento = (motivos) =>
  z.object({
    almacenId: z.uuid(),
    motivo: z.enum(motivos),
    fechaDocumento: z.coerce.date().optional(),
    documentoTipo: textoOpcional(30),
    documentoSerie: textoOpcional(10),
    documentoNumero: textoOpcional(20),
    observacion: textoOpcional(500),
    items: z
      .array(z.object({ productoId: z.uuid(), cantidad: decimal(4), costoUnitario: decimal(6).optional() }))
      .min(1, 'Agregue al menos un producto')
      .max(200),
  });

/** Registra el movimiento, audita y notifica en tiempo real. */
function crearMovimiento(tipo) {
  return async (req, res) => {
    const { items, ...cabecera } = req.body;
    if (tipo === 'ENTRADA' && cabecera.motivo === 'COMPRA' && items.some((i) => i.costoUnitario == null)) {
      throw solicitudInvalida('Las compras requieren el costo unitario de cada producto');
    }
    const { movimiento, alertas } = await req.db(
      async (tx) => {
        const r = await registrarMovimiento(tx, {
          ...cabecera,
          tipo,
          items: tipo === 'SALIDA' ? items.map(({ costoUnitario, ...i }) => i) : items,
          tenantId: req.tenantId,
          usuarioId: req.user.id,
        });
        await auditar(tx, req, {
          modulo: 'kardex', accion: `${tipo.toLowerCase()}.crear`, recurso: 'movimiento', recursoId: r.movimiento.id,
          empresaId: r.movimiento.empresaId, despues: { ...r.movimiento, items },
        });
        return r;
      },
      { timeout: 20000 },
    );
    notificar(movimiento, alertas);
    res.status(201).json({ id: movimiento.id, numero: movimiento.numero, alertas });
  };
}

function notificar(movimiento, alertas) {
  emitir('kardex:movimiento', { almacenId: movimiento.almacenId }, {
    id: movimiento.id, numero: movimiento.numero, tipo: movimiento.tipo, motivo: movimiento.motivo, almacenId: movimiento.almacenId,
  });
  for (const a of alertas) emitir('stock:alerta', { almacenId: a.almacenId }, a);
}

router.post(
  '/entradas',
  autorizar('kardex.entrada.crear', { alcance: alcance.almacen('almacenId', 'body') }),
  validar(esquemaMovimiento(MOTIVOS.ENTRADA)),
  crearMovimiento('ENTRADA'),
);

router.post(
  '/salidas',
  autorizar('kardex.salida.crear', { alcance: alcance.almacen('almacenId', 'body') }),
  validar(esquemaMovimiento(MOTIVOS.SALIDA)),
  crearMovimiento('SALIDA'),
);

router.post(
  '/movimientos/:movimientoId/anular',
  autorizar('kardex.movimiento.anular', { alcance: porMovimiento }),
  validar(z.object({ observacion: z.string().trim().min(5, 'Indique el motivo de la anulación').max(500) })),
  async (req, res) => {
    const { movimiento, alertas } = await req.db(
      async (tx) => {
        const r = await anularMovimiento(tx, {
          tenantId: req.tenantId,
          movimientoId: req.params.movimientoId,
          usuarioId: req.user.id,
          observacion: req.body.observacion,
        });
        await auditar(tx, req, {
          modulo: 'kardex', accion: 'movimiento.anular', recurso: 'movimiento', recursoId: req.params.movimientoId,
          empresaId: r.movimiento.empresaId, despues: { anulacion: r.movimiento.numero, observacion: req.body.observacion },
        });
        return r;
      },
      { timeout: 20000 },
    );
    notificar(movimiento, alertas);
    res.status(201).json({ id: movimiento.id, numero: movimiento.numero, alertas });
  },
);

// ───────────── Kardex por producto ─────────────

router.get(
  '/producto/:productoId',
  autorizar('kardex.stock.ver', { alcance: alcance.almacen('almacenId', 'query') }),
  validar(
    z.object({
      almacenId: z.uuid(),
      desde: z.coerce.date().optional(),
      hasta: z.coerce.date().optional(),
      pagina: z.string().optional(),
      porPagina: z.string().optional(),
    }),
    'query',
  ),
  async (req, res) => {
    const { almacenId, desde, hasta } = req.validQuery;
    const pag = paginacion(req.validQuery, { maxPorPagina: 500 });
    const resultado = await req.db(async (tx) => {
      const producto = await tx.producto.findUnique({
        where: { id: req.params.productoId },
        select: { id: true, sku: true, nombre: true, empresaId: true, unidad: { select: { codigo: true, nombre: true } } },
      });
      if (!producto || producto.empresaId !== req.recurso.empresaId) throw noEncontrado();

      const rangoFecha = desde || hasta ? { fecha: { ...(desde && { gte: desde }), ...(hasta && { lte: hasta }) } } : null;
      const where = { almacenId, productoId: producto.id, ...(rangoFecha && { movimiento: rangoFecha }) };
      const [lineas, total, previa, stock] = await Promise.all([
        tx.movimientoDetalle.findMany({
          where,
          orderBy: { id: 'asc' },
          skip: pag.skip,
          take: pag.take,
          include: {
            movimiento: {
              select: {
                id: true, numero: true, tipo: true, motivo: true, fecha: true,
                documentoTipo: true, documentoSerie: true, documentoNumero: true, usuario: { select: { nombres: true } },
              },
            },
          },
        }),
        tx.movimientoDetalle.count({ where }),
        // Saldo inicial: última línea antes del rango
        desde
          ? tx.movimientoDetalle.findFirst({
              where: { almacenId, productoId: producto.id, movimiento: { fecha: { lt: desde } } },
              orderBy: { id: 'desc' },
            })
          : null,
        tx.stock.findUnique({ where: { almacenId_productoId: { almacenId, productoId: producto.id } } }),
      ]);
      return { producto, lineas, total, previa, stock };
    });

    const costos = verCostos(req.permisos, req.recurso);
    const limpiar = (x) => (x && !costos ? sinCostos(x) : x);
    res.json({
      producto: resultado.producto,
      verCostos: costos,
      saldoInicial: resultado.previa
        ? limpiar({ cantidad: resultado.previa.saldoCantidad, saldoCostoUnitario: resultado.previa.saldoCostoUnitario, saldoValor: resultado.previa.saldoValor })
        : null,
      stock: limpiar(resultado.stock),
      ...respuestaPaginada(resultado.lineas.map(limpiar), resultado.total, pag),
    });
  },
);

export default router;
