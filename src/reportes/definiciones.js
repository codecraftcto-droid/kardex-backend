import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { puede, puedeDentroDeEmpresa, tieneAlguno, whereAlcance } from '../rbac/resolver.js';
import { estadoCuotas, hoyLima, tramoAntiguedad } from '../pos/reglas.js';
import { noEncontrado, prohibido } from '../lib/errors.js';
import { texto } from './escritores.js';

/**
 * Definición de cada reporte. `preparar` devuelve { meta, lotes, contar? }:
 *  - meta:  título, subtítulos, columnas (con `sumar` para totales) y nombre de archivo.
 *  - lotes: generador asíncrono que entrega filas en LOTES; cada lote se consulta en su
 *           propia transacción corta (`db`), con RLS, así no se acumula todo en memoria.
 *  - contar: total estimado de filas (para mostrar el avance de la exportación).
 * Lo usan tanto la vista previa (API) como el worker de exportación.
 */
export const TAM_LOTE = 2000;
const D = (v) => new Prisma.Decimal(v ?? 0);
// Mismo criterio que las celdas: las fechas sin hora se muestran en UTC (si no, en Perú salen un día antes)
const fechaCorta = (d) => (d ? texto(d, 'fecha') : '');
const hoyArchivo = () => new Date().toISOString().slice(0, 10);

export const MOTIVOS = {
  COMPRA: 'Compra', DEVOLUCION_CLIENTE: 'Devolución de cliente', AJUSTE_POSITIVO: 'Ajuste positivo', VENTA: 'Venta',
  MERMA: 'Merma', AJUSTE_NEGATIVO: 'Ajuste negativo', ANULACION: 'Anulación',
  TRANSFERENCIA_SALIDA: 'Transferencia (salida)', TRANSFERENCIA_ENTRADA: 'Transferencia (entrada)',
};
const ESTADOS = { SOLICITADA: 'Solicitada', APROBADA: 'Aprobada', RECHAZADA: 'Rechazada', DESPACHADA: 'En tránsito', RECIBIDA: 'Recibida', CANCELADA: 'Cancelada' };

/** Paginación por cursor sobre `id` (estable y eficiente aunque haya millones de filas). */
async function* porCursor(db, consulta) {
  let cursor = null;
  for (;;) {
    const filas = await db((tx) => consulta(tx, cursor ? { cursor: { id: cursor }, skip: 1 } : {}));
    if (!filas.length) return;
    yield filas;
    if (filas.length < TAM_LOTE) return;
    cursor = filas.at(-1).id;
  }
}

/** Paginación por desplazamiento, para órdenes que no siguen un id autoincremental. */
async function* porDesplazamiento(db, consulta) {
  for (let salto = 0; ; salto += TAM_LOTE) {
    const filas = await db((tx) => consulta(tx, { skip: salto, take: TAM_LOTE }));
    if (!filas.length) return;
    yield filas;
    if (filas.length < TAM_LOTE) return;
  }
}

/** Empresa, sede/almacén filtrados y si el usuario puede ver costos sobre ese alcance. */
async function contexto(db, permisos, { empresaId, sedeId, almacenId }) {
  const d = await db(async (tx) => ({
    empresa: await tx.empresa.findUnique({ where: { id: empresaId }, select: { id: true, razonSocial: true, ruc: true, metodoValorizacion: true } }),
    almacen: almacenId ? await tx.almacen.findUnique({ where: { id: almacenId }, select: { id: true, sedeId: true, empresaId: true, codigo: true, nombre: true } }) : null,
    sede: sedeId ? await tx.sede.findUnique({ where: { id: sedeId }, select: { id: true, nombre: true } }) : null,
  }));
  if (!d.empresa || (almacenId && d.almacen?.empresaId !== empresaId)) throw noEncontrado();
  const recurso = d.almacen ? { empresaId, sedeId: d.almacen.sedeId, almacenId: d.almacen.id } : sedeId ? { empresaId, sedeId } : { empresaId };
  return {
    ...d,
    recurso,
    verCostos: puede(permisos, 'kardex.costos.ver', recurso),
    encabezado: (...extra) => [`${d.empresa.razonSocial} — RUC ${d.empresa.ruc}`, ...extra.filter(Boolean)],
  };
}

const metodoTexto = (m) => (m === 'PEPS' ? 'PEPS' : 'Promedio ponderado');
const base = { empresaId: z.uuid() };

// ═════════════ Stock actual ═════════════

const stock = {
  permisos: ['reporte.stock.ver'],
  esquema: z.object({
    ...base,
    nivel: z.enum(['almacen', 'sede', 'empresa']).default('almacen'),
    sedeId: z.uuid().optional(),
    almacenId: z.uuid().optional(),
    categoriaId: z.uuid().optional(),
    incluirCeros: z.enum(['true', 'false']).default('false'),
  }),
  async preparar({ db, permisos, q }) {
    const ctx = await contexto(db, permisos, q);
    const alcanceWhere = whereAlcance(permisos, 'reporte.stock.ver', 'registro') ?? { id: null };
    const where = {
      AND: [
        alcanceWhere,
        { empresaId: q.empresaId },
        q.sedeId ? { sedeId: q.sedeId } : {},
        q.almacenId ? { almacenId: q.almacenId } : {},
        q.categoriaId ? { producto: { categoriaId: q.categoriaId } } : {},
        q.incluirCeros === 'true' ? {} : { cantidad: { gt: 0 } },
      ],
    };
    const c = ctx.verCostos;
    const datosProducto = (p) => ({ sku: p.sku, producto: p.nombre, unidad: p.unidad.codigo, categoria: p.categoria?.nombre ?? '' });
    const selProducto = { select: { sku: true, nombre: true, unidad: { select: { codigo: true } }, categoria: { select: { nombre: true } } } };

    async function* lotes() {
      if (q.nivel === 'almacen') {
        // Orden alfabético por producto: paginación por desplazamiento (el stock es acotado)
        for (let salto = 0; ; salto += TAM_LOTE) {
          const filas = await db((tx) =>
            tx.stock.findMany({
              where,
              include: { producto: selProducto, almacen: { select: { codigo: true, nombre: true, sede: { select: { nombre: true } } } } },
              orderBy: [{ producto: { nombre: 'asc' } }, { almacen: { nombre: 'asc' } }],
              skip: salto,
              take: TAM_LOTE,
            }),
          );
          if (!filas.length) return;
          yield filas.map((s) => ({
            ...datosProducto(s.producto), sede: s.almacen.sede.nombre, almacen: `${s.almacen.codigo} — ${s.almacen.nombre}`,
            cantidad: s.cantidad, ...(c && { costoPromedio: s.costoPromedio, valor: s.valorTotal }),
          }));
          if (filas.length < TAM_LOTE) return;
        }
      }
      // Consolidado por sede o por empresa
      const grupos = await db((tx) =>
        tx.stock.groupBy({ by: q.nivel === 'sede' ? ['sedeId', 'productoId'] : ['productoId'], where, _sum: { cantidad: true, valorTotal: true } }),
      );
      const [productos, sedes] = await db(async (tx) => [
        new Map((await tx.producto.findMany({ where: { id: { in: grupos.map((g) => g.productoId) } }, select: { id: true, ...selProducto.select } })).map((p) => [p.id, p])),
        new Map((await tx.sede.findMany({ where: { empresaId: q.empresaId }, select: { id: true, nombre: true } })).map((s) => [s.id, s.nombre])),
      ]);
      const filas = grupos
        .map((g) => {
          const cantidad = D(g._sum.cantidad);
          const valor = D(g._sum.valorTotal);
          return {
            ...datosProducto(productos.get(g.productoId)),
            ...(q.nivel === 'sede' && { sede: sedes.get(g.sedeId) }),
            cantidad,
            ...(c && { costoPromedio: cantidad.gt(0) ? valor.div(cantidad).toDecimalPlaces(6) : null, valor }),
          };
        })
        .sort((a, b) => a.producto.localeCompare(b.producto) || (a.sede ?? '').localeCompare(b.sede ?? ''));
      for (let i = 0; i < filas.length; i += TAM_LOTE) yield filas.slice(i, i + TAM_LOTE);
    }

    const nivel = { almacen: 'por almacén', sede: 'consolidado por sede', empresa: 'consolidado de la empresa' }[q.nivel];
    return {
      meta: {
        titulo: `Stock actual ${nivel}`,
        subtitulo: ctx.encabezado(ctx.sede && `Sede: ${ctx.sede.nombre}`, ctx.almacen && `Almacén: ${ctx.almacen.codigo} — ${ctx.almacen.nombre}`, `Al ${new Date().toLocaleString('es-PE')}`),
        nombreArchivo: `stock-${q.nivel}-${hoyArchivo()}`,
        verCostos: c,
        columnas: [
          { clave: 'sku', titulo: 'SKU', ancho: 8 },
          { clave: 'producto', titulo: 'Producto', ancho: 22 },
          { clave: 'categoria', titulo: 'Categoría', ancho: 10 },
          { clave: 'unidad', titulo: 'Und.', ancho: 5 },
          ...(q.nivel !== 'empresa' ? [{ clave: 'sede', titulo: 'Sede', ancho: 11 }] : []),
          ...(q.nivel === 'almacen' ? [{ clave: 'almacen', titulo: 'Almacén', ancho: 14 }] : []),
          { clave: 'cantidad', titulo: 'Cantidad', tipo: 'cantidad', ancho: 8 },
          ...(c ? [{ clave: 'costoPromedio', titulo: 'Costo prom.', tipo: 'costo', ancho: 8 }, { clave: 'valor', titulo: 'Valor (S/)', tipo: 'moneda', ancho: 9, sumar: true }] : []),
        ],
        totales: c ? { clave: 'producto', texto: 'Total' } : null,
      },
      lotes,
      contar: () => db((tx) => tx.stock.count({ where })),
    };
  },
};

// ═════════════ Movimientos por fechas ═════════════

const movimientos = {
  permisos: ['reporte.movimientos.ver'],
  esquema: z.object({
    ...base,
    desde: z.coerce.date(),
    hasta: z.coerce.date(),
    almacenId: z.uuid().optional(),
    tipo: z.enum(['ENTRADA', 'SALIDA']).optional(),
    motivo: z.string().max(30).optional(),
    productoId: z.uuid().optional(),
  }),
  async preparar({ db, permisos, q }) {
    const ctx = await contexto(db, permisos, q);
    const c = ctx.verCostos;
    const alcanceWhere = whereAlcance(permisos, 'reporte.movimientos.ver', 'registro') ?? { id: null };
    const where = {
      ...(q.productoId && { productoId: q.productoId }),
      movimiento: {
        AND: [
          alcanceWhere,
          { empresaId: q.empresaId, fecha: { gte: q.desde, lte: q.hasta } },
          q.almacenId ? { almacenId: q.almacenId } : {},
          q.tipo ? { tipo: q.tipo } : {},
          q.motivo ? { motivo: q.motivo } : {},
        ],
      },
    };
    const mapear = (l) => {
      const m = l.movimiento;
      const e = m.tipo === 'ENTRADA';
      return {
        fecha: m.fecha, numero: m.numero, motivo: MOTIVOS[m.motivo],
        documento: m.documentoNumero ? `${m.documentoTipo ?? ''} ${m.documentoSerie ? `${m.documentoSerie}-` : ''}${m.documentoNumero}`.trim() : '',
        almacen: `${m.almacen.codigo} — ${m.almacen.nombre}`, sku: l.producto.sku, producto: l.producto.nombre, unidad: l.producto.unidad.codigo,
        entrada: e ? l.cantidad : null, salida: e ? null : l.cantidad,
        ...(c && { costoUnitario: l.costoUnitario, valorEntrada: e ? l.costoTotal : null, valorSalida: e ? null : l.costoTotal }),
      };
    };
    async function* lotes() {
      for await (const filas of porCursor(db, (tx, cursor) =>
        tx.movimientoDetalle.findMany({
          where,
          include: {
            producto: { select: { sku: true, nombre: true, unidad: { select: { codigo: true } } } },
            movimiento: { select: { numero: true, tipo: true, motivo: true, fecha: true, documentoTipo: true, documentoSerie: true, documentoNumero: true, almacen: { select: { codigo: true, nombre: true } } } },
          },
          orderBy: { id: 'asc' },
          take: TAM_LOTE,
          ...cursor,
        }),
      )) yield filas.map(mapear);
    }
    return {
      meta: {
        titulo: 'Movimientos de inventario',
        subtitulo: ctx.encabezado(`Del ${fechaCorta(q.desde)} al ${fechaCorta(q.hasta)}`, ctx.almacen && `Almacén: ${ctx.almacen.codigo} — ${ctx.almacen.nombre}`),
        nombreArchivo: `movimientos-${hoyArchivo()}`,
        verCostos: c,
        columnas: [
          { clave: 'fecha', titulo: 'Fecha', tipo: 'fechaHora', ancho: 9 },
          { clave: 'numero', titulo: 'Número', ancho: 7 },
          { clave: 'motivo', titulo: 'Motivo', ancho: 11 },
          { clave: 'documento', titulo: 'Documento', ancho: 11 },
          { clave: 'almacen', titulo: 'Almacén', ancho: 12 },
          { clave: 'sku', titulo: 'SKU', ancho: 7 },
          { clave: 'producto', titulo: 'Producto', ancho: 18 },
          { clave: 'unidad', titulo: 'Und.', ancho: 4 },
          { clave: 'entrada', titulo: 'Entrada', tipo: 'cantidad', ancho: 6 },
          { clave: 'salida', titulo: 'Salida', tipo: 'cantidad', ancho: 6 },
          ...(c
            ? [
                { clave: 'costoUnitario', titulo: 'C. unit.', tipo: 'costo', ancho: 7 },
                { clave: 'valorEntrada', titulo: 'Valor entrada', tipo: 'moneda', ancho: 8, sumar: true },
                { clave: 'valorSalida', titulo: 'Valor salida', tipo: 'moneda', ancho: 8, sumar: true },
              ]
            : []),
        ],
        totales: c ? { clave: 'numero', texto: 'Totales' } : null,
      },
      lotes,
      contar: () => db((tx) => tx.movimientoDetalle.count({ where })),
    };
  },
};

// ═════════════ Valorización a fecha de corte ═════════════

const valorizacion = {
  permisos: ['reporte.valorizacion.ver', 'kardex.costos.ver'],
  esquema: z.object({ ...base, corte: z.coerce.date(), sedeId: z.uuid().optional(), almacenId: z.uuid().optional() }),
  async preparar({ db, permisos, q }) {
    const ctx = await contexto(db, permisos, q);
    if (!ctx.verCostos) throw prohibido('La valorización requiere el permiso para ver costos');
    const alcR = whereAlcance(permisos, 'reporte.valorizacion.ver', 'almacen');
    const alcC = whereAlcance(permisos, 'kardex.costos.ver', 'almacen');

    async function* lotes() {
      if (!alcR || !alcC) return;
      const almacenes = await db((tx) =>
        tx.almacen.findMany({
          where: { AND: [alcR, alcC, { empresaId: q.empresaId }, q.sedeId ? { sedeId: q.sedeId } : {}, q.almacenId ? { id: q.almacenId } : {}] },
          select: { id: true, codigo: true, nombre: true, sede: { select: { nombre: true } } },
          orderBy: [{ codigo: 'asc' }],
        }),
      );
      // Un almacén a la vez: último saldo de cada producto hasta la fecha de corte
      for (const a of almacenes) {
        const saldos = await db((tx) => tx.$queryRaw`
          SELECT DISTINCT ON (d.producto_id)
                 d.producto_id AS "productoId", d.saldo_cantidad AS cantidad,
                 d.saldo_costo_unitario AS "costoUnitario", d.saldo_valor AS valor
            FROM movimiento_detalles d
            JOIN movimientos m ON m.id = d.movimiento_id
           WHERE d.almacen_id = ${a.id}::uuid AND m.fecha <= ${q.corte}
           ORDER BY d.producto_id, d.id DESC`);
        const conStock = saldos.filter((s) => D(s.cantidad).gt(0));
        for (let i = 0; i < conStock.length; i += TAM_LOTE) {
          const parte = conStock.slice(i, i + TAM_LOTE);
          const productos = await db(async (tx) =>
            new Map((await tx.producto.findMany({
              where: { id: { in: parte.map((s) => s.productoId) } },
              select: { id: true, sku: true, nombre: true, unidad: { select: { codigo: true } }, categoria: { select: { nombre: true } } },
            })).map((p) => [p.id, p])),
          );
          yield parte
            .map((s) => {
              const p = productos.get(s.productoId);
              return {
                sede: a.sede.nombre, almacen: `${a.codigo} — ${a.nombre}`, sku: p.sku, producto: p.nombre,
                categoria: p.categoria?.nombre ?? '', unidad: p.unidad.codigo, cantidad: s.cantidad, costoUnitario: s.costoUnitario, valor: s.valor,
              };
            })
            .sort((x, y) => x.producto.localeCompare(y.producto));
        }
      }
    }
    return {
      meta: {
        titulo: 'Valorización de inventario',
        subtitulo: ctx.encabezado(`Fecha de corte: ${fechaCorta(q.corte)} · Método: ${metodoTexto(ctx.empresa.metodoValorizacion)}`, ctx.sede && `Sede: ${ctx.sede.nombre}`, ctx.almacen && `Almacén: ${ctx.almacen.codigo} — ${ctx.almacen.nombre}`),
        nombreArchivo: `valorizacion-${q.corte.toISOString().slice(0, 10)}`,
        verCostos: true,
        columnas: [
          { clave: 'sede', titulo: 'Sede', ancho: 10 },
          { clave: 'almacen', titulo: 'Almacén', ancho: 14 },
          { clave: 'sku', titulo: 'SKU', ancho: 8 },
          { clave: 'producto', titulo: 'Producto', ancho: 22 },
          { clave: 'categoria', titulo: 'Categoría', ancho: 10 },
          { clave: 'unidad', titulo: 'Und.', ancho: 5 },
          { clave: 'cantidad', titulo: 'Cantidad', tipo: 'cantidad', ancho: 8 },
          { clave: 'costoUnitario', titulo: 'Costo unit.', tipo: 'costo', ancho: 8 },
          { clave: 'valor', titulo: 'Valor (S/)', tipo: 'moneda', ancho: 9, sumar: true },
        ],
        totales: { clave: 'producto', texto: 'Total valorizado' },
      },
      lotes,
    };
  },
};

// ═════════════ Transferencias ═════════════

const transferencias = {
  permisos: ['transferencia.ver'],
  esquema: z.object({ ...base, desde: z.coerce.date(), hasta: z.coerce.date(), estado: z.enum(Object.keys(ESTADOS)).optional(), almacenId: z.uuid().optional() }),
  async preparar({ db, permisos, q }) {
    const ctx = await contexto(db, permisos, { empresaId: q.empresaId });
    const c = ctx.verCostos;
    const alcances = [
      whereAlcance(permisos, 'transferencia.ver', { empresa: 'empresaId', sede: 'origenSedeId', almacen: 'origenAlmacenId' }),
      whereAlcance(permisos, 'transferencia.ver', { empresa: 'empresaId', sede: 'destinoSedeId', almacen: 'destinoAlmacenId' }),
    ].filter(Boolean);
    const where = {
      AND: [
        alcances.length ? { OR: alcances } : { id: null },
        { empresaId: q.empresaId, solicitadoEn: { gte: q.desde, lte: q.hasta } },
        q.estado ? { estado: q.estado } : {},
        q.almacenId ? { OR: [{ origenAlmacenId: q.almacenId }, { destinoAlmacenId: q.almacenId }] } : {},
      ],
    };
    async function* lotes() {
      // Orden cronológico (el id es UUID): paginación por desplazamiento
      for await (const ts of porDesplazamiento(db, (tx, pagina) =>
        tx.transferencia.findMany({
          where,
          include: {
            origen: { select: { codigo: true, nombre: true } },
            destino: { select: { codigo: true, nombre: true } },
            detalles: { include: { producto: { select: { sku: true, nombre: true, unidad: { select: { codigo: true } } } } } },
          },
          orderBy: [{ solicitadoEn: 'asc' }, { id: 'asc' }],
          ...pagina,
        }),
      )) {
        yield ts.flatMap((t) =>
          t.detalles.map((d) => {
            const faltante = d.cantidadRecibida != null ? D(d.cantidadDespachada).sub(d.cantidadRecibida) : null;
            return {
              numero: t.numero, estado: ESTADOS[t.estado], fecha: t.solicitadoEn,
              origen: `${t.origen.codigo} — ${t.origen.nombre}`, destino: `${t.destino.codigo} — ${t.destino.nombre}`,
              producto: d.producto.nombre, unidad: d.producto.unidad.codigo,
              solicitada: d.cantidadSolicitada, despachada: d.cantidadDespachada, recibida: d.cantidadRecibida,
              faltante: faltante?.gt(0) ? faltante : null,
              ...(c && { costoUnitario: d.costoUnitario, valor: d.costoUnitario ? D(d.cantidadDespachada).mul(d.costoUnitario).toDecimalPlaces(2) : null }),
            };
          }),
        );
      }
    }
    return {
      meta: {
        titulo: 'Transferencias entre almacenes',
        subtitulo: ctx.encabezado(`Del ${fechaCorta(q.desde)} al ${fechaCorta(q.hasta)}`, q.estado && `Estado: ${ESTADOS[q.estado]}`),
        nombreArchivo: `transferencias-${hoyArchivo()}`,
        verCostos: c,
        columnas: [
          { clave: 'numero', titulo: 'Número', ancho: 7 },
          { clave: 'estado', titulo: 'Estado', ancho: 7 },
          { clave: 'fecha', titulo: 'Solicitada', tipo: 'fecha', ancho: 7 },
          { clave: 'origen', titulo: 'Origen', ancho: 13 },
          { clave: 'destino', titulo: 'Destino', ancho: 13 },
          { clave: 'producto', titulo: 'Producto', ancho: 18 },
          { clave: 'unidad', titulo: 'Und.', ancho: 4 },
          { clave: 'solicitada', titulo: 'Solicitado', tipo: 'cantidad', ancho: 6 },
          { clave: 'despachada', titulo: 'Despachado', tipo: 'cantidad', ancho: 6 },
          { clave: 'recibida', titulo: 'Recibido', tipo: 'cantidad', ancho: 6 },
          { clave: 'faltante', titulo: 'Faltante', tipo: 'cantidad', ancho: 6 },
          ...(c ? [{ clave: 'costoUnitario', titulo: 'C. unit.', tipo: 'costo', ancho: 7 }, { clave: 'valor', titulo: 'Valor desp.', tipo: 'moneda', ancho: 8, sumar: true }] : []),
        ],
        totales: c ? { clave: 'numero', texto: 'Total' } : null,
      },
      lotes,
      contar: () => db((tx) => tx.transferencia.count({ where })),
    };
  },
};

// ═════════════ Kardex por producto ═════════════

const kardex = {
  permisos: ['kardex.stock.ver'],
  esquema: z.object({ ...base, productoId: z.uuid(), almacenId: z.uuid(), desde: z.coerce.date().optional(), hasta: z.coerce.date().optional() }),
  async preparar({ db, permisos, q }) {
    const ctx = await contexto(db, permisos, q);
    // El kardex exige alcance sobre ESE almacén (no basta tener el permiso en otro)
    if (!puede(permisos, 'kardex.stock.ver', ctx.recurso)) throw noEncontrado();
    const producto = await db((tx) =>
      tx.producto.findUnique({ where: { id: q.productoId }, select: { empresaId: true, sku: true, nombre: true, unidad: { select: { codigo: true, nombre: true } } } }),
    );
    if (!producto || producto.empresaId !== q.empresaId) throw noEncontrado();
    const c = ctx.verCostos;
    const where = {
      almacenId: q.almacenId,
      productoId: q.productoId,
      ...((q.desde || q.hasta) && { movimiento: { fecha: { ...(q.desde && { gte: q.desde }), ...(q.hasta && { lte: q.hasta }) } } }),
    };
    async function* lotes() {
      for await (const ls of porCursor(db, (tx, cursor) =>
        tx.movimientoDetalle.findMany({
          where,
          include: { movimiento: { select: { numero: true, tipo: true, motivo: true, fecha: true, documentoSerie: true, documentoNumero: true } } },
          orderBy: { id: 'asc' },
          take: TAM_LOTE,
          ...cursor,
        }),
      )) {
        yield ls.map((l) => {
          const m = l.movimiento;
          const e = m.tipo === 'ENTRADA';
          return {
            fecha: m.fecha, numero: m.numero, motivo: MOTIVOS[m.motivo],
            documento: m.documentoNumero ? `${m.documentoSerie ? `${m.documentoSerie}-` : ''}${m.documentoNumero}` : '',
            entCant: e ? l.cantidad : null, salCant: e ? null : l.cantidad, saldoCant: l.saldoCantidad,
            ...(c && {
              entCu: e ? l.costoUnitario : null, entTotal: e ? l.costoTotal : null,
              salCu: e ? null : l.costoUnitario, salTotal: e ? null : l.costoTotal,
              saldoCu: l.saldoCostoUnitario, saldoValor: l.saldoValor,
            }),
          };
        });
      }
    }
    return {
      meta: {
        titulo: `Kardex${c ? ' valorizado' : ''} — ${producto.nombre}`,
        subtitulo: ctx.encabezado(
          `Almacén: ${ctx.almacen.codigo} — ${ctx.almacen.nombre} · Código: ${producto.sku} · Unidad: ${producto.unidad.nombre} (${producto.unidad.codigo})`,
          `Método de valuación: ${metodoTexto(ctx.empresa.metodoValorizacion)}${q.desde || q.hasta ? ` · Periodo: ${fechaCorta(q.desde) || 'inicio'} al ${fechaCorta(q.hasta) || 'hoy'}` : ''}`,
        ),
        nombreArchivo: `kardex-${producto.sku}-${hoyArchivo()}`,
        verCostos: c,
        columnas: [
          { clave: 'fecha', titulo: 'Fecha', tipo: 'fecha', ancho: 7 },
          { clave: 'numero', titulo: 'Número', ancho: 7 },
          { clave: 'motivo', titulo: 'Tipo de operación', ancho: 12 },
          { clave: 'documento', titulo: 'Documento', ancho: 9 },
          { clave: 'entCant', titulo: 'Ent. cant.', tipo: 'cantidad', ancho: 6 },
          ...(c ? [{ clave: 'entCu', titulo: 'Ent. C.U.', tipo: 'costo', ancho: 6 }, { clave: 'entTotal', titulo: 'Ent. total', tipo: 'moneda', ancho: 7 }] : []),
          { clave: 'salCant', titulo: 'Sal. cant.', tipo: 'cantidad', ancho: 6 },
          ...(c ? [{ clave: 'salCu', titulo: 'Sal. C.U.', tipo: 'costo', ancho: 6 }, { clave: 'salTotal', titulo: 'Sal. total', tipo: 'moneda', ancho: 7 }] : []),
          { clave: 'saldoCant', titulo: 'Saldo cant.', tipo: 'cantidad', ancho: 6 },
          ...(c ? [{ clave: 'saldoCu', titulo: 'Saldo C.U.', tipo: 'costo', ancho: 6 }, { clave: 'saldoValor', titulo: 'Saldo valor', tipo: 'moneda', ancho: 7 }] : []),
        ],
        totales: null,
      },
      lotes,
      contar: () => db((tx) => tx.movimientoDetalle.count({ where })),
    };
  },
};

// ═════════════ Registro de Ventas (columnas del formato 14.1) ═════════════

const COD_DOC = { SIN_DOCUMENTO: '0', DNI: '1', CARNE_EXTRANJERIA: '4', RUC: '6', PASAPORTE: '7' };
const COD_CPE = { FACTURA: '01', BOLETA: '03', NOTA_CREDITO: '07', NOTA_VENTA: '00' };

const ventas = {
  permisos: ['reporte.ventas.ver'],
  esquema: z.object({
    ...base,
    desde: z.coerce.date(),
    hasta: z.coerce.date(),
    incluirNotasVenta: z.enum(['true', 'false']).default('false'),
  }),
  async preparar({ db, permisos, q }) {
    const ctx = await contexto(db, permisos, { empresaId: q.empresaId });
    const alcance = whereAlcance(permisos, 'reporte.ventas.ver', 'registro') ?? { id: null };
    const tipos = ['FACTURA', 'BOLETA', 'NOTA_CREDITO', ...(q.incluirNotasVenta === 'true' ? ['NOTA_VENTA'] : [])];
    const whereCpe = { AND: [alcance, { empresaId: q.empresaId, tipo: { in: tipos }, fechaEmision: { gte: q.desde, lte: q.hasta } }] };
    const whereDoc = { AND: [alcance, { empresaId: q.empresaId, tipo: 'VENTA', estado: { in: ['CONFIRMADO', 'ANULADO'] }, fechaEmision: { gte: q.desde, lte: q.hasta } }] };
    const signo = (v, neg) => (v == null ? null : neg ? D(v).neg() : D(v));

    async function* lotes() {
      // 1) Comprobantes emitidos en caja
      for await (const cs of porDesplazamiento(db, (tx, pagina) =>
        tx.comprobante.findMany({
          where: whereCpe,
          include: { referencia: { select: { tipo: true, serie: true, numero: true, fechaEmision: true } } },
          orderBy: [{ fechaEmision: 'asc' }, { serie: 'asc' }, { numero: 'asc' }],
          ...pagina,
        }),
      )) {
        yield cs.map((c) => {
          const anulado = c.estado === 'ANULADO';
          const nc = c.tipo === 'NOTA_CREDITO';
          const monto = (v) => (anulado ? D(0) : signo(v, nc));
          return {
            fecha: c.fechaEmision, tipo: COD_CPE[c.tipo], serie: c.serie, numero: String(c.numero).padStart(8, '0'),
            tipoDoc: COD_DOC[c.clienteTipoDocumento], numDoc: c.clienteNumeroDocumento === '-' ? '' : c.clienteNumeroDocumento,
            cliente: anulado ? 'ANULADO' : c.clienteNombre,
            gravada: monto(c.opGravada), exonerada: monto(c.opExonerada), inafecta: monto(c.opInafecta), igv: monto(c.igv), total: monto(c.total),
            moneda: c.moneda, estado: anulado ? 'Anulado' : 'Emitido',
            referencia: c.referencia ? `${COD_CPE[c.referencia.tipo]} ${c.referencia.serie}-${String(c.referencia.numero).padStart(8, '0')}` : '',
            origen: 'Caja',
          };
        });
      }
      // 2) Ventas registradas manualmente (comprobantes emitidos en otro sistema), convertidas a soles
      for await (const ds of porDesplazamiento(db, (tx, pagina) =>
        tx.documentoComercial.findMany({ where: whereDoc, include: { detalles: true }, orderBy: [{ fechaEmision: 'asc' }, { serie: 'asc' }], ...pagina }),
      )) {
        yield ds.map((d) => {
          const anulado = d.estado === 'ANULADO';
          const tc = D(d.tipoCambio);
          const enSoles = (v) => (anulado ? D(0) : D(v).mul(tc).toDecimalPlaces(2));
          const gravada = d.detalles.filter((x) => x.afectoIgv).reduce((s, x) => s.add(x.subtotal), D(0));
          const exonerada = d.detalles.filter((x) => !x.afectoIgv).reduce((s, x) => s.add(x.subtotal), D(0));
          return {
            fecha: d.fechaEmision, tipo: COD_CPE[d.comprobanteTipo] ?? '00', serie: d.serie, numero: d.numero.padStart(8, '0'),
            tipoDoc: d.terceroDocumento.length === 11 ? '6' : d.terceroDocumento.length === 8 ? '1' : '0', numDoc: d.terceroDocumento,
            cliente: anulado ? 'ANULADO' : d.terceroNombre,
            gravada: enSoles(gravada), exonerada: enSoles(exonerada), inafecta: D(0), igv: enSoles(d.igv), total: enSoles(d.total),
            moneda: d.moneda, estado: anulado ? 'Anulado' : 'Emitido', referencia: '', origen: 'Registro manual',
          };
        });
      }
    }
    return {
      meta: {
        titulo: 'Registro de Ventas e Ingresos',
        subtitulo: ctx.encabezado(`Del ${fechaCorta(q.desde)} al ${fechaCorta(q.hasta)} · Importes en soles (las notas de crédito restan)`),
        nombreArchivo: `registro-ventas-${hoyArchivo()}`,
        verCostos: false,
        columnas: [
          { clave: 'fecha', titulo: 'Fecha emisión', tipo: 'fecha', ancho: 7 },
          { clave: 'tipo', titulo: 'Tipo', ancho: 3 },
          { clave: 'serie', titulo: 'Serie', ancho: 4 },
          { clave: 'numero', titulo: 'Número', ancho: 6 },
          { clave: 'tipoDoc', titulo: 'T. doc.', ancho: 3 },
          { clave: 'numDoc', titulo: 'Nº documento', ancho: 7 },
          { clave: 'cliente', titulo: 'Cliente', ancho: 16 },
          { clave: 'gravada', titulo: 'Base gravada', tipo: 'moneda', ancho: 7, sumar: true },
          { clave: 'exonerada', titulo: 'Exonerada', tipo: 'moneda', ancho: 6, sumar: true },
          { clave: 'inafecta', titulo: 'Inafecta', tipo: 'moneda', ancho: 6, sumar: true },
          { clave: 'igv', titulo: 'IGV', tipo: 'moneda', ancho: 6, sumar: true },
          { clave: 'total', titulo: 'Total', tipo: 'moneda', ancho: 7, sumar: true },
          { clave: 'estado', titulo: 'Estado', ancho: 5 },
          { clave: 'referencia', titulo: 'Doc. modificado', ancho: 8 },
          { clave: 'origen', titulo: 'Origen', ancho: 6 },
        ],
        totales: { clave: 'cliente', texto: 'Totales' },
      },
      lotes,
      contar: async () => (await db((tx) => tx.comprobante.count({ where: whereCpe }))) + (await db((tx) => tx.documentoComercial.count({ where: whereDoc }))),
    };
  },
};

// ═════════════ Turnos de caja (arqueos) ═════════════

const MEDIOS = ['EFECTIVO', 'TARJETA', 'YAPE', 'PLIN', 'TRANSFERENCIA', 'OTRO'];
const caja = {
  permisos: ['reporte.ventas.ver'],
  esquema: z.object({ ...base, desde: z.coerce.date(), hasta: z.coerce.date() }),
  async preparar({ db, permisos, q }) {
    const ctx = await contexto(db, permisos, { empresaId: q.empresaId });
    const alcance = whereAlcance(permisos, 'reporte.ventas.ver', 'registro') ?? { id: null };
    const where = { estado: 'CERRADA', abiertaEn: { gte: q.desde, lte: q.hasta }, caja: { AND: [alcance, { empresaId: q.empresaId }] } };
    async function* lotes() {
      for await (const ss of porDesplazamiento(db, (tx, pagina) =>
        tx.sesionCaja.findMany({ where, include: { caja: { select: { nombre: true } } }, orderBy: { abiertaEn: 'asc' }, ...pagina }),
      )) {
        const usuarios = new Map(
          (await db((tx) => tx.usuario.findMany({ where: { id: { in: ss.map((s) => s.usuarioId) } }, select: { id: true, nombres: true } }))).map((u) => [u.id, u.nombres]),
        );
        yield ss.map((s) => {
          const r = s.resumen ?? {};
          const comprobantes = Object.values(r.porTipo ?? {}).reduce((n, t) => n + t.cantidad, 0);
          return {
            caja: s.caja.nombre, cajero: usuarios.get(s.usuarioId), apertura: s.abiertaEn, cierre: s.cerradaEn, comprobantes,
            ventas: D(r.ventasNetas), credito: r.ventasCredito != null ? D(r.ventasCredito) : null,
            cobranzas: r.cobranzas ? D(r.cobranzas.total) : null, ...Object.fromEntries(MEDIOS.map((m) => [m.toLowerCase(), r.porMedio?.[m] != null ? D(r.porMedio[m]) : null])),
            esperado: s.efectivoEsperado, declarado: s.efectivoDeclarado, diferencia: s.diferencia,
          };
        });
      }
    }
    return {
      meta: {
        titulo: 'Turnos de caja y arqueos',
        subtitulo: ctx.encabezado(`Turnos cerrados del ${fechaCorta(q.desde)} al ${fechaCorta(q.hasta)}`),
        nombreArchivo: `turnos-caja-${hoyArchivo()}`,
        verCostos: false,
        columnas: [
          { clave: 'caja', titulo: 'Caja', ancho: 8 },
          { clave: 'cajero', titulo: 'Cajero', ancho: 11 },
          { clave: 'apertura', titulo: 'Apertura', tipo: 'fechaHora', ancho: 8 },
          { clave: 'cierre', titulo: 'Cierre', tipo: 'fechaHora', ancho: 8 },
          { clave: 'comprobantes', titulo: 'Comp.', ancho: 4 },
          { clave: 'ventas', titulo: 'Ventas netas', tipo: 'moneda', ancho: 7, sumar: true },
          { clave: 'credito', titulo: 'Al crédito', tipo: 'moneda', ancho: 6, sumar: true },
          { clave: 'cobranzas', titulo: 'Cobranzas', tipo: 'moneda', ancho: 6, sumar: true },
          { clave: 'efectivo', titulo: 'Efectivo', tipo: 'moneda', ancho: 6, sumar: true },
          { clave: 'tarjeta', titulo: 'Tarjeta', tipo: 'moneda', ancho: 6, sumar: true },
          { clave: 'yape', titulo: 'Yape', tipo: 'moneda', ancho: 6, sumar: true },
          { clave: 'plin', titulo: 'Plin', tipo: 'moneda', ancho: 6, sumar: true },
          { clave: 'transferencia', titulo: 'Transf.', tipo: 'moneda', ancho: 6, sumar: true },
          { clave: 'esperado', titulo: 'Efectivo esperado', tipo: 'moneda', ancho: 7 },
          { clave: 'declarado', titulo: 'Declarado', tipo: 'moneda', ancho: 7 },
          { clave: 'diferencia', titulo: 'Diferencia', tipo: 'moneda', ancho: 6, sumar: true },
        ],
        totales: { clave: 'cajero', texto: 'Totales' },
      },
      lotes,
      contar: () => db((tx) => tx.sesionCaja.count({ where })),
    };
  },
};

// ═════════════ Cuentas por cobrar (antigüedad de saldos) ═════════════

const MEDIO_TEXTO = { EFECTIVO: 'Efectivo', TARJETA: 'Tarjeta', YAPE: 'Yape', PLIN: 'Plin', TRANSFERENCIA: 'Transferencia', OTRO: 'Otro' };
const numeroCpe = (c) => `${c.serie}-${String(c.numero).padStart(8, '0')}`;

const cxc = {
  permisos: ['reporte.cxc.ver'],
  esquema: z.object({ ...base, soloVencidos: z.enum(['true', 'false']).default('false') }),
  async preparar({ db, permisos, q }) {
    // Las cuentas por cobrar son de toda la empresa (un cliente puede pagar en cualquier tienda)
    if (!puedeDentroDeEmpresa(permisos, 'reporte.cxc.ver', q.empresaId)) throw noEncontrado();
    const ctx = await contexto(db, permisos, { empresaId: q.empresaId });
    const hoy = hoyLima();
    const where = { empresaId: q.empresaId, estado: 'EMITIDO', formaPago: 'CREDITO', saldoPendiente: { gt: 0 } };
    async function* lotes() {
      for await (const cs of porDesplazamiento(db, (tx, pagina) =>
        tx.comprobante.findMany({
          where,
          include: { cuotas: true, cliente: { select: { nombre: true, tipoDocumento: true, numeroDocumento: true } } },
          orderBy: [{ cliente: { nombre: 'asc' } }, { fechaEmision: 'asc' }],
          ...pagina,
        }),
      )) {
        const filas = cs.map((c) => {
          const cuotas = estadoCuotas(c.cuotas, c.montoCredito, c.saldoPendiente, hoy).filter((k) => k.pendiente.gt(0));
          const tramos = { porVencer: D(0), d1_30: D(0), d31_60: D(0), d61_90: D(0), d90: D(0) };
          for (const k of cuotas) tramos[tramoAntiguedad(k.diasVencido)] = tramos[tramoAntiguedad(k.diasVencido)].add(k.pendiente);
          const dias = Math.max(0, ...cuotas.map((k) => k.diasVencido));
          return {
            cliente: c.cliente.nombre, documento: c.cliente.numeroDocumento, comprobante: numeroCpe(c), emision: c.fechaEmision,
            vencimiento: cuotas.at(0)?.fechaVencimiento ? new Date(`${cuotas.at(0).fechaVencimiento}T00:00:00Z`) : null,
            dias: dias || null, total: D(c.total), saldo: D(c.saldoPendiente), ...tramos,
          };
        });
        yield q.soloVencidos === 'true' ? filas.filter((f) => f.dias) : filas;
      }
    }
    return {
      meta: {
        titulo: 'Cuentas por cobrar — antigüedad de saldos',
        subtitulo: ctx.encabezado(`Saldos al ${fechaCorta(new Date(`${hoy}T00:00:00Z`))}${q.soloVencidos === 'true' ? ' · solo documentos con cuotas vencidas' : ''}`),
        nombreArchivo: `cuentas-por-cobrar-${hoyArchivo()}`,
        verCostos: false,
        columnas: [
          { clave: 'cliente', titulo: 'Cliente', ancho: 14 },
          { clave: 'documento', titulo: 'Documento', ancho: 7 },
          { clave: 'comprobante', titulo: 'Comprobante', ancho: 8 },
          { clave: 'emision', titulo: 'Emisión', tipo: 'fechaHora', ancho: 8 },
          { clave: 'vencimiento', titulo: 'Vence', tipo: 'fecha', ancho: 6 },
          { clave: 'dias', titulo: 'Días venc.', ancho: 4 },
          { clave: 'total', titulo: 'Total', tipo: 'moneda', ancho: 6 },
          { clave: 'saldo', titulo: 'Saldo', tipo: 'moneda', ancho: 6, sumar: true },
          { clave: 'porVencer', titulo: 'Por vencer', tipo: 'moneda', ancho: 6, sumar: true },
          { clave: 'd1_30', titulo: '1-30 días', tipo: 'moneda', ancho: 6, sumar: true },
          { clave: 'd31_60', titulo: '31-60 días', tipo: 'moneda', ancho: 6, sumar: true },
          { clave: 'd61_90', titulo: '61-90 días', tipo: 'moneda', ancho: 6, sumar: true },
          { clave: 'd90', titulo: '+90 días', tipo: 'moneda', ancho: 6, sumar: true },
        ],
        totales: { clave: 'cliente', texto: 'Totales' },
      },
      lotes,
      contar: () => db((tx) => tx.comprobante.count({ where })),
    };
  },
};

// ═════════════ Cobranzas ═════════════

const cobranzas = {
  permisos: ['reporte.cxc.ver'],
  esquema: z.object({ ...base, desde: z.coerce.date(), hasta: z.coerce.date() }),
  async preparar({ db, permisos, q }) {
    if (!puedeDentroDeEmpresa(permisos, 'reporte.cxc.ver', q.empresaId)) throw noEncontrado();
    const ctx = await contexto(db, permisos, { empresaId: q.empresaId });
    const where = { empresaId: q.empresaId, fecha: { gte: q.desde, lte: q.hasta } };
    async function* lotes() {
      for await (const ks of porDesplazamiento(db, (tx, pagina) =>
        tx.cobranza.findMany({
          where,
          include: {
            cliente: { select: { nombre: true } },
            comprobante: { select: { serie: true, numero: true } },
            sesion: { select: { caja: { select: { nombre: true } } } },
          },
          orderBy: { numero: 'asc' },
          ...pagina,
        }),
      )) {
        const usuarios = new Map(
          (await db((tx) => tx.usuario.findMany({ where: { id: { in: ks.map((k) => k.usuarioId) } }, select: { id: true, nombres: true } }))).map((u) => [u.id, u.nombres]),
        );
        yield ks.map((k) => ({
          numero: k.numero, fecha: k.fecha, cliente: k.cliente.nombre, comprobante: numeroCpe(k.comprobante), medio: MEDIO_TEXTO[k.medio],
          referencia: k.referencia ?? '', caja: k.sesion?.caja.nombre ?? 'Sin caja', usuario: usuarios.get(k.usuarioId),
          monto: k.estado === 'ANULADA' ? D(0) : D(k.monto), estado: k.estado === 'ANULADA' ? 'Anulada' : 'Vigente',
        }));
      }
    }
    return {
      meta: {
        titulo: 'Cobranzas de ventas al crédito',
        subtitulo: ctx.encabezado(`Del ${fechaCorta(q.desde)} al ${fechaCorta(q.hasta)} · las anuladas figuran en cero`),
        nombreArchivo: `cobranzas-${hoyArchivo()}`,
        verCostos: false,
        columnas: [
          { clave: 'numero', titulo: 'Nº', ancho: 4 },
          { clave: 'fecha', titulo: 'Fecha', tipo: 'fechaHora', ancho: 8 },
          { clave: 'cliente', titulo: 'Cliente', ancho: 14 },
          { clave: 'comprobante', titulo: 'Comprobante', ancho: 8 },
          { clave: 'medio', titulo: 'Medio', ancho: 6 },
          { clave: 'referencia', titulo: 'Referencia', ancho: 6 },
          { clave: 'caja', titulo: 'Caja', ancho: 6 },
          { clave: 'usuario', titulo: 'Registró', ancho: 9 },
          { clave: 'monto', titulo: 'Monto', tipo: 'moneda', ancho: 6, sumar: true },
          { clave: 'estado', titulo: 'Estado', ancho: 5 },
        ],
        totales: { clave: 'cliente', texto: 'Totales' },
      },
      lotes,
      contar: () => db((tx) => tx.cobranza.count({ where })),
    };
  },
};

export const REPORTES = { stock, movimientos, valorizacion, transferencias, kardex, ventas, caja, cxc, cobranzas };

/** Permisos mínimos del reporte (en algún alcance); el alcance fino se aplica al filtrar filas. */
export function validarPermisos(permisos, def) {
  if (!def.permisos.every((p) => tieneAlguno(permisos, p))) throw prohibido();
}
