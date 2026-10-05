/**
 * Motor de valorización PURO (sin BD). Trabaja con Prisma.Decimal para evitar
 * errores de coma flotante. Cantidades con 4 decimales, costos unitarios con 6.
 *
 * saldo = { cantidad, valor }   (Decimal)
 * capa  = { id, cantidadRestante, costoUnitario }  (PEPS, ordenadas de la más antigua a la más nueva)
 */
import { Prisma } from '@prisma/client';
import { conflicto } from '../lib/errors.js';

export const D = (v) => new Prisma.Decimal(v ?? 0);
const CERO = D(0);
const r4 = (d) => d.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
const r6 = (d) => d.toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP);

export const costoPromedio = ({ cantidad, valor }) => (cantidad.gt(0) ? r6(valor.div(cantidad)) : CERO);

/** Entrada: suma cantidad y valor al saldo (igual en PEPS y Promedio; PEPS además crea una capa). */
export function entrada(saldo, cantidad, costoUnitario) {
  const cu = r6(D(costoUnitario));
  const costoTotal = r4(cantidad.mul(cu));
  const nuevo = { cantidad: saldo.cantidad.add(cantidad), valor: saldo.valor.add(costoTotal) };
  return { costoUnitario: cu, costoTotal, saldo: nuevo };
}

function validarStock(saldo, cantidad) {
  if (cantidad.gt(saldo.cantidad)) {
    throw conflicto(`Stock insuficiente: disponible ${saldo.cantidad.toString()}, solicitado ${cantidad.toString()}`);
  }
}

function cerrarSaldo(saldo, cantidad, costoTotal) {
  const restante = saldo.cantidad.sub(cantidad);
  // Si el stock queda en cero, el valor también (absorbe residuos de redondeo)
  const valor = restante.isZero() ? CERO : saldo.valor.sub(costoTotal);
  if (valor.lt(0)) throw conflicto('La operación dejaría un valor de inventario negativo; registre un ajuste');
  return { cantidad: restante, valor };
}

/** Salida a costo promedio ponderado. */
export function salidaPromedio(saldo, cantidad) {
  validarStock(saldo, cantidad);
  const cu = costoPromedio(saldo);
  const costoTotal = cantidad.eq(saldo.cantidad) ? saldo.valor : r4(cantidad.mul(cu));
  return { costoUnitario: cu, costoTotal, saldo: cerrarSaldo(saldo, cantidad, costoTotal) };
}

/** Salida PEPS: consume capas desde la más antigua. Devuelve los consumos por capa. */
export function salidaPEPS(saldo, capas, cantidad) {
  validarStock(saldo, cantidad);
  let pendiente = cantidad;
  let costoTotal = CERO;
  const consumos = [];
  for (const capa of capas) {
    if (pendiente.isZero()) break;
    const disponible = D(capa.cantidadRestante);
    if (disponible.lte(0)) continue;
    const toma = Prisma.Decimal.min(disponible, pendiente);
    costoTotal = costoTotal.add(toma.mul(D(capa.costoUnitario)));
    consumos.push({ id: capa.id, cantidad: toma, restante: disponible.sub(toma) });
    pendiente = pendiente.sub(toma);
  }
  if (pendiente.gt(0)) throw conflicto('Las capas de costo no cubren la salida; revise la integridad del inventario');
  costoTotal = cantidad.eq(saldo.cantidad) ? saldo.valor : r4(costoTotal);
  return { costoUnitario: r6(costoTotal.div(cantidad)), costoTotal, consumos, saldo: cerrarSaldo(saldo, cantidad, costoTotal) };
}

/** Salida a un costo dado (reversión de una entrada en Promedio ponderado). */
export function salidaACosto(saldo, cantidad, costoUnitario) {
  validarStock(saldo, cantidad);
  const cu = r6(D(costoUnitario));
  const costoTotal = cantidad.eq(saldo.cantidad) ? saldo.valor : r4(cantidad.mul(cu));
  return { costoUnitario: cu, costoTotal, saldo: cerrarSaldo(saldo, cantidad, costoTotal) };
}
