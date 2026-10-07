import { randomUUID } from 'node:crypto';
import { conflicto, noEncontrado, solicitudInvalida } from '../lib/errors.js';
import { siguienteValor } from '../kardex/servicio.js';
import { hoyLima } from '../pos/reglas.js';
import { listarPlan } from './servicio.js';
import { resumenPeriodo } from './asientos.js';

/**
 * Asientos manuales y cierre de período (Fase 3C). Los manuales cubren lo que no nace de una
 * operación del sistema (provisiones, planillas, pagos a proveedores, mermas…). Un período
 * cerrado no admite cambios: lo valida la aplicación y, por si acaso, un trigger en la base.
 */
const r2 = (v) => Math.round(Number(v) * 100) / 100;

export async function periodoCerrado(tx, empresaId, periodo) {
  const p = await tx.periodoContable.findUnique({ where: { empresaId_periodo: { empresaId, periodo } } });
  return Boolean(p?.cerrado);
}
export async function exigirAbierto(tx, empresaId, periodo) {
  if (await periodoCerrado(tx, empresaId, periodo)) throw conflicto(`El período ${periodo.slice(4)}/${periodo.slice(0, 4)} está cerrado: reábralo para hacer cambios`);
}

/** Valida y normaliza las líneas: cuentas que reciben movimientos, un solo lado por línea y que cuadre */
async function validarLineas(tx, empresaId, lineas) {
  if (lineas.length < 2) throw solicitudInvalida('El asiento necesita al menos dos líneas');
  const plan = new Map((await listarPlan(tx, empresaId)).map((c) => [c.codigo, c]));
  const limpias = lineas.map((l, i) => {
    const c = plan.get(l.cuenta);
    const n = `Línea ${i + 1}`;
    if (!c) throw solicitudInvalida(`${n}: la cuenta ${l.cuenta} no existe en el plan`);
    if (!c.imputable) throw solicitudInvalida(`${n}: la cuenta ${l.cuenta} tiene subcuentas; use una de ellas`);
    if (!c.activo) throw solicitudInvalida(`${n}: la cuenta ${l.cuenta} está desactivada`);
    const debe = r2(l.debe || 0);
    const haber = r2(l.haber || 0);
    if (debe < 0 || haber < 0 || (debe > 0) === (haber > 0)) throw solicitudInvalida(`${n}: indique un importe al debe o al haber (solo uno)`);
    return {
      cuenta: l.cuenta, debe, haber, glosa: l.glosa || null,
      terceroTipo: l.terceroDoc ? (/^\d{11}$/.test(l.terceroDoc) ? '6' : /^\d{8}$/.test(l.terceroDoc) ? '1' : '0') : null,
      terceroDoc: l.terceroDoc || null, terceroNombre: l.terceroNombre || null,
      docTipo: l.docTipo || null, docSerie: l.docSerie || null, docNumero: l.docNumero || null,
    };
  });
  const debe = r2(limpias.reduce((s, l) => s + l.debe, 0));
  const haber = r2(limpias.reduce((s, l) => s + l.haber, 0));
  if (debe !== haber) throw solicitudInvalida(`El asiento no cuadra: debe S/ ${debe.toFixed(2)} y haber S/ ${haber.toFixed(2)}`);
  return { lineas: limpias, total: debe };
}

const periodoDeFecha = (fecha) => fecha.slice(0, 7).replace('-', '');

export async function crearManual(tx, { tenantId, empresaId, usuarioId, datos, numero = null }) {
  if (datos.fecha > hoyLima()) throw solicitudInvalida('La fecha no puede ser futura');
  const periodo = periodoDeFecha(datos.fecha);
  await exigirAbierto(tx, empresaId, periodo);
  const { lineas, total } = await validarLineas(tx, empresaId, datos.lineas);
  return tx.asiento.create({
    data: {
      tenantId, empresaId, periodo, numero: numero ?? await siguienteValor(tx, { tenantId, empresaId, clave: `ASIENTO:${periodo}` }),
      fecha: new Date(`${datos.fecha}T00:00:00Z`), glosa: datos.glosa, origen: 'MANUAL', clave: `MANUAL:${randomUUID()}`,
      totalDebe: total, totalHaber: total, usuarioId,
      lineas: { create: lineas.map((l, i) => ({ tenantId, orden: i + 1, ...l })) },
    },
    include: { lineas: true },
  });
}

async function manualDe(tx, empresaId, id) {
  const a = await tx.asiento.findUnique({ where: { id } });
  if (!a || a.empresaId !== empresaId) throw noEncontrado('Asiento no encontrado');
  if (a.origen !== 'MANUAL') throw conflicto('Los asientos automáticos no se editan: corrija la operación de origen o regenere el período');
  await exigirAbierto(tx, empresaId, a.periodo);
  return a;
}

/** Editar = reemplazar (los asientos no se modifican en la base): conserva el número si sigue en el mismo período */
export async function editarManual(tx, { tenantId, empresaId, usuarioId, id, datos }) {
  const antes = await manualDe(tx, empresaId, id);
  await tx.asiento.delete({ where: { id } });
  const mismoPeriodo = periodoDeFecha(datos.fecha) === antes.periodo;
  return { antes, despues: await crearManual(tx, { tenantId, empresaId, usuarioId, datos, numero: mismoPeriodo ? antes.numero : null }) };
}

export async function eliminarManual(tx, { empresaId, id }) {
  const a = await manualDe(tx, empresaId, id);
  await tx.asiento.delete({ where: { id } });
  return a;
}

// ───────────── Cierre ─────────────

/** Cierra el período: todo debe estar contabilizado y sin observaciones */
export async function cerrarPeriodo(tx, { tenantId, empresaId, periodo, usuarioId }) {
  if (await periodoCerrado(tx, empresaId, periodo)) throw conflicto('El período ya está cerrado');
  const r = await resumenPeriodo(tx, { empresaId, periodo });
  if (r.pendientes.length) throw conflicto(`Faltan contabilizar ${r.pendientes.length} operación(es) del período`);
  if (r.errores.length) throw conflicto(`Hay ${r.errores.length} operación(es) con observaciones: resuélvalas antes de cerrar`);
  if (r2(r.totalDebe) !== r2(r.totalHaber)) throw conflicto('El período no cuadra');
  const datos = { cerrado: true, cerradoEn: new Date(), cerradoPorId: usuarioId };
  return tx.periodoContable.upsert({
    where: { empresaId_periodo: { empresaId, periodo } },
    create: { tenantId, empresaId, periodo, ...datos },
    update: datos,
  });
}

export async function reabrirPeriodo(tx, { empresaId, periodo, motivo }) {
  if (!(await periodoCerrado(tx, empresaId, periodo))) throw conflicto('El período no está cerrado');
  return tx.periodoContable.update({
    where: { empresaId_periodo: { empresaId, periodo } },
    data: { cerrado: false, reabiertoEn: new Date(), motivoReapertura: motivo },
  });
}
