import { conflicto, noEncontrado, solicitudInvalida } from '../lib/errors.js';
import { D } from './valorizacion.js';
import { registrarMovimiento, siguienteNumero } from './servicio.js';

/**
 * Máquina de estados de transferencias entre almacenes de una misma empresa.
 *
 *   SOLICITADA ──aprobar──▶ APROBADA ──despachar──▶ DESPACHADA ──recibir──▶ RECIBIDA
 *       │                      │
 *       ├──rechazar──▶ RECHAZADA
 *       └──cancelar──▶ CANCELADA ◀──cancelar──┘
 *
 * Cada transición se "reclama" con un UPDATE condicionado al estado esperado, de modo
 * que dos usuarios no pueden aprobar/despachar/recibir la misma transferencia a la vez.
 */

/** Cambia de estado solo si sigue en `desde`; si otro usuario se adelantó → 409. */
async function transicion(tx, id, desde, data) {
  const { count } = await tx.transferencia.updateMany({
    where: { id, estado: { in: [].concat(desde) } },
    data,
  });
  if (!count) {
    const actual = await tx.transferencia.findUnique({ where: { id }, select: { estado: true } });
    if (!actual) throw noEncontrado();
    throw conflicto(`La transferencia está ${actual.estado.toLowerCase()}; no se puede realizar esta acción`);
  }
  return tx.transferencia.findUnique({ where: { id }, include: { detalles: true } });
}

export async function solicitar(tx, { tenantId, origenAlmacenId, destinoAlmacenId, items, observacion, usuarioId }) {
  if (origenAlmacenId === destinoAlmacenId) throw solicitudInvalida('El almacén de origen y destino deben ser distintos');
  const [origen, destino] = await Promise.all(
    [origenAlmacenId, destinoAlmacenId].map((id) => tx.almacen.findUnique({ where: { id }, include: { empresa: { select: { activo: true } } } })),
  );
  if (!origen || !destino) throw noEncontrado('Almacén no encontrado');
  if (origen.empresaId !== destino.empresaId) throw solicitudInvalida('Solo se transfiere entre almacenes de la misma empresa');
  if (!origen.activo || !destino.activo || !origen.empresa.activo) throw conflicto('Algún almacén o la empresa están inactivos');

  const ids = items.map((i) => i.productoId);
  if (new Set(ids).size !== ids.length) throw solicitudInvalida('Hay productos repetidos');
  const productos = await tx.producto.count({ where: { id: { in: ids }, empresaId: origen.empresaId, activo: true } });
  if (productos !== ids.length) throw solicitudInvalida('Algún producto no existe, está inactivo o es de otra empresa');

  return tx.transferencia.create({
    data: {
      tenantId,
      empresaId: origen.empresaId,
      numero: await siguienteNumero(tx, { tenantId, empresaId: origen.empresaId, tipo: 'TRANSFERENCIA' }),
      origenAlmacenId,
      origenSedeId: origen.sedeId,
      destinoAlmacenId,
      destinoSedeId: destino.sedeId,
      observacion: observacion ?? null,
      solicitadoPorId: usuarioId,
      detalles: { create: items.map((i) => ({ tenantId, productoId: i.productoId, cantidadSolicitada: i.cantidad })) },
    },
    include: { detalles: true },
  });
}

export const aprobar = (tx, { id, usuarioId }) =>
  transicion(tx, id, 'SOLICITADA', { estado: 'APROBADA', aprobadoPorId: usuarioId, aprobadoEn: new Date() });

export const rechazar = (tx, { id, usuarioId, motivo }) =>
  transicion(tx, id, 'SOLICITADA', { estado: 'RECHAZADA', rechazadoPorId: usuarioId, rechazadoEn: new Date(), motivoCierre: motivo });

export const cancelar = (tx, { id, usuarioId, motivo }) =>
  transicion(tx, id, ['SOLICITADA', 'APROBADA'], { estado: 'CANCELADA', canceladoPorId: usuarioId, canceladoEn: new Date(), motivoCierre: motivo });

/**
 * Despacho: registra la SALIDA del almacén de origen (valorizada con su método) y guarda
 * el costo unitario de cada producto para que la entrada en destino use el mismo costo.
 * `cantidades` permite despachar menos de lo solicitado (incluso 0 en algún producto).
 */
export async function despachar(tx, { tenantId, id, usuarioId, cantidades = {} }) {
  const t = await transicion(tx, id, 'APROBADA', { estado: 'DESPACHADA', despachadoPorId: usuarioId, despachadoEn: new Date() });

  const lineas = t.detalles.map((d) => {
    const cantidad = cantidades[d.productoId] != null ? D(cantidades[d.productoId]) : D(d.cantidadSolicitada);
    if (cantidad.lt(0) || cantidad.gt(d.cantidadSolicitada)) {
      throw solicitudInvalida('La cantidad despachada debe estar entre 0 y lo solicitado');
    }
    return { detalle: d, cantidad };
  });
  const aDespachar = lineas.filter((l) => l.cantidad.gt(0));
  if (!aDespachar.length) throw solicitudInvalida('Debe despachar al menos un producto; si no hay stock, cancele la transferencia');

  const { movimiento, alertas, almacen } = await registrarMovimiento(tx, {
    tenantId,
    almacenId: t.origenAlmacenId,
    tipo: 'SALIDA',
    motivo: 'TRANSFERENCIA_SALIDA',
    usuarioId,
    transferenciaId: t.id,
    documentoTipo: 'TRANSFERENCIA',
    documentoNumero: t.numero,
    observacion: `Despacho de ${t.numero}`,
    items: aDespachar.map((l) => ({ productoId: l.detalle.productoId, cantidad: l.cantidad })),
  });

  const costos = new Map(
    (await tx.movimientoDetalle.findMany({ where: { movimientoId: movimiento.id } })).map((d) => [d.productoId, d.costoUnitario]),
  );
  for (const l of lineas) {
    await tx.transferenciaDetalle.update({
      where: { id: l.detalle.id },
      data: { cantidadDespachada: l.cantidad, costoUnitario: costos.get(l.detalle.productoId) ?? null },
    });
  }
  return { transferencia: t, movimientos: [{ movimiento, alertas, almacen }] };
}

/**
 * Recepción: registra la ENTRADA en el destino al costo del despacho. Se puede recibir
 * menos de lo despachado; la diferencia queda registrada como faltante de la transferencia.
 */
export async function recibir(tx, { tenantId, id, usuarioId, cantidades = {}, observacion }) {
  const t = await transicion(tx, id, 'DESPACHADA', {
    estado: 'RECIBIDA',
    recibidoPorId: usuarioId,
    recibidoEn: new Date(),
    ...(observacion && { motivoCierre: observacion }),
  });

  const lineas = t.detalles
    .filter((d) => d.cantidadDespachada && D(d.cantidadDespachada).gt(0))
    .map((d) => {
      const cantidad = cantidades[d.productoId] != null ? D(cantidades[d.productoId]) : D(d.cantidadDespachada);
      if (cantidad.lt(0) || cantidad.gt(d.cantidadDespachada)) {
        throw solicitudInvalida('La cantidad recibida debe estar entre 0 y lo despachado');
      }
      return { detalle: d, cantidad };
    });
  for (const l of lineas) {
    await tx.transferenciaDetalle.update({ where: { id: l.detalle.id }, data: { cantidadRecibida: l.cantidad } });
  }

  const aRecibir = lineas.filter((l) => l.cantidad.gt(0));
  if (!aRecibir.length) return { transferencia: t, movimientos: [] };
  const r = await registrarMovimiento(tx, {
    tenantId,
    almacenId: t.destinoAlmacenId,
    tipo: 'ENTRADA',
    motivo: 'TRANSFERENCIA_ENTRADA',
    usuarioId,
    transferenciaId: t.id,
    documentoTipo: 'TRANSFERENCIA',
    documentoNumero: t.numero,
    observacion: `Recepción de ${t.numero}`,
    items: aRecibir.map((l) => ({ productoId: l.detalle.productoId, cantidad: l.cantidad, costoUnitario: l.detalle.costoUnitario })),
  });
  return { transferencia: t, movimientos: [r] };
}
