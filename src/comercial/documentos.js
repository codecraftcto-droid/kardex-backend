import { Prisma } from '@prisma/client';
import { env } from '../config/env.js';
import { conflicto, noEncontrado, solicitudInvalida } from '../lib/errors.js';
import { anularMovimiento, registrarMovimiento } from '../kardex/servicio.js';

/**
 * Compras y ventas integradas con el kardex:
 *   BORRADOR ──confirmar──▶ CONFIRMADO (entrada por compra / salida por venta)
 *                              └──anular──▶ ANULADO (movimiento inverso en el kardex)
 * Los importes se guardan en la moneda del documento; el kardex se valoriza en soles
 * (valor unitario × tipo de cambio).
 */
const D = (v) => new Prisma.Decimal(v ?? 0);
const r2 = (d) => d.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

export function calcularTotales(items) {
  let subtotal = D(0);
  let gravado = D(0);
  const lineas = items.map((i) => {
    const st = r2(D(i.cantidad).mul(D(i.valorUnitario)));
    subtotal = subtotal.add(st);
    if (i.afectoIgv !== false) gravado = gravado.add(st);
    return { ...i, subtotal: st };
  });
  const igv = r2(gravado.mul(env.IGV_TASA));
  return { lineas, subtotal, igv, total: subtotal.add(igv) };
}

async function validarItems(tx, empresaId, items) {
  const ids = items.map((i) => i.productoId);
  if (new Set(ids).size !== ids.length) throw solicitudInvalida('Hay productos repetidos en el documento');
  const n = await tx.producto.count({ where: { id: { in: ids }, empresaId, activo: true } });
  if (n !== ids.length) throw solicitudInvalida('Algún producto no existe, está inactivo o es de otra empresa');
}

/** Crea o reemplaza un borrador (cabecera + detalle + totales). */
export async function guardarBorrador(tx, { tenantId, tipo, id = null, usuarioId, datos }) {
  const almacen = await tx.almacen.findUnique({ where: { id: datos.almacenId }, select: { id: true, empresaId: true, sedeId: true, activo: true } });
  if (!almacen) throw noEncontrado('Almacén no encontrado');
  if (!almacen.activo) throw conflicto('El almacén está inactivo');
  await validarItems(tx, almacen.empresaId, datos.items);

  const { lineas, subtotal, igv, total } = calcularTotales(datos.items);
  const cabecera = {
    almacenId: almacen.id,
    sedeId: almacen.sedeId,
    terceroDocumento: datos.terceroDocumento,
    terceroNombre: datos.terceroNombre,
    comprobanteTipo: datos.comprobanteTipo,
    serie: datos.serie,
    numero: datos.numero,
    fechaEmision: datos.fechaEmision,
    moneda: datos.moneda,
    tipoCambio: datos.moneda === 'PEN' ? 1 : datos.tipoCambio,
    observacion: datos.observacion ?? null,
    subtotal,
    igv,
    total,
  };
  const detalles = lineas.map((l) => ({
    tenantId,
    productoId: l.productoId,
    cantidad: l.cantidad,
    valorUnitario: l.valorUnitario,
    afectoIgv: l.afectoIgv !== false,
    subtotal: l.subtotal,
  }));

  if (!id) {
    return tx.documentoComercial.create({
      data: { ...cabecera, tenantId, tipo, empresaId: almacen.empresaId, creadoPorId: usuarioId, detalles: { create: detalles } },
    });
  }
  const actual = await tx.documentoComercial.findUnique({ where: { id } });
  if (!actual || actual.tipo !== tipo) throw noEncontrado();
  if (actual.estado !== 'BORRADOR') throw conflicto('Solo se pueden editar documentos en borrador');
  if (actual.empresaId !== almacen.empresaId) throw solicitudInvalida('El almacén debe ser de la misma empresa');
  await tx.documentoComercialDetalle.deleteMany({ where: { documentoId: id } });
  return tx.documentoComercial.update({ where: { id }, data: { ...cabecera, detalles: { create: detalles } } });
}

/** Cambia de estado solo si sigue en `desde` (evita confirmar/anular dos veces). */
async function reclamar(tx, id, desde, data) {
  const { count } = await tx.documentoComercial.updateMany({ where: { id, estado: desde }, data });
  if (!count) {
    const actual = await tx.documentoComercial.findUnique({ where: { id }, select: { estado: true } });
    if (!actual) throw noEncontrado();
    throw conflicto(`El documento está ${actual.estado.toLowerCase()}; no se puede realizar esta acción`);
  }
  return tx.documentoComercial.findUnique({ where: { id }, include: { detalles: true } });
}

/** Confirma y registra el movimiento de kardex correspondiente. */
export async function confirmar(tx, { tenantId, id, usuarioId }) {
  const doc = await reclamar(tx, id, 'BORRADOR', { estado: 'CONFIRMADO', confirmadoPorId: usuarioId, confirmadoEn: new Date() });
  const esCompra = doc.tipo === 'COMPRA';
  const tc = D(doc.tipoCambio);
  const r = await registrarMovimiento(tx, {
    tenantId,
    almacenId: doc.almacenId,
    tipo: esCompra ? 'ENTRADA' : 'SALIDA',
    motivo: esCompra ? 'COMPRA' : 'VENTA',
    usuarioId,
    fechaDocumento: doc.fechaEmision,
    documentoTipo: doc.comprobanteTipo,
    documentoSerie: doc.serie,
    documentoNumero: doc.numero,
    observacion: `${esCompra ? 'Compra a' : 'Venta a'} ${doc.terceroNombre} (${doc.terceroDocumento})`,
    items: doc.detalles.map((d) => ({
      productoId: d.productoId,
      cantidad: d.cantidad,
      // El costo de la compra entra al kardex en soles; la venta sale al costo de inventario
      ...(esCompra && { costoUnitario: D(d.valorUnitario).mul(tc).toDecimalPlaces(6) }),
    })),
  });
  await tx.documentoComercial.update({ where: { id }, data: { movimientoId: r.movimiento.id } });
  return { documento: doc, ...r };
}

/** Anula un documento confirmado registrando el movimiento inverso en el kardex. */
export async function anular(tx, { tenantId, id, usuarioId, motivo }) {
  const doc = await reclamar(tx, id, 'CONFIRMADO', { estado: 'ANULADO', anuladoPorId: usuarioId, anuladoEn: new Date(), motivoAnulacion: motivo });
  const r = await anularMovimiento(tx, {
    tenantId,
    movimientoId: doc.movimientoId,
    usuarioId,
    observacion: `Anulación de ${doc.tipo === 'COMPRA' ? 'compra' : 'venta'} ${doc.serie}-${doc.numero}: ${motivo}`,
    desdeDocumento: true,
  });
  await tx.documentoComercial.update({ where: { id }, data: { movimientoAnulacionId: r.movimiento.id } });
  return { documento: doc, ...r };
}
