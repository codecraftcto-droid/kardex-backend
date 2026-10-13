import { comprasDelSistema, ventasDelSistema } from '../sire/registros.js';
import { desplazar, finDePeriodo, rangoLima } from '../sire/periodos.js';

/**
 * Apoyo para declaraciones (Fase 4B): hoja de trabajo del PDT 621 (IGV y pago a cuenta de renta)
 * y DAOT anual. Sale de las ventas y compras registradas en el sistema, en soles (las de dólares,
 * al tipo de cambio de cada documento). Es una ayuda para declarar: el contador revisa y presenta.
 *
 * Reglas:
 *  - Crédito fiscal: facturas de proveedores con RUC. Con detracción, el IGV da crédito en el mes del
 *    depósito (si se deposita después, queda "en espera"; si se depositó este mes, entra ahora).
 *  - Boletas de compra: sin crédito fiscal.
 *  - El formulario usa soles enteros: cada casilla se redondea.
 */
export const TASA_RENTA = { GENERAL: 0.015, MYPE: 0.01, ESPECIAL: 0.015, NRUS: null };
const r = (v) => Math.round(Number(v) || 0);
const n2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const soles = (f, campo) => (Number(f[campo]) || 0) * (f.tipoCambio || 1);

/** Ventas del período en soles: gravadas, no gravadas y notas de crédito */
function resumenVentas(ventas) {
  const v = { base: 0, igv: 0, exonerado: 0, inafecto: 0, ncBase: 0, ncIgv: 0, ncNoGravado: 0, comprobantes: 0, enDolares: 0 };
  for (const f of ventas.filter((x) => !x.anulado)) {
    v.comprobantes += 1;
    if (f.moneda === 'USD') v.enDolares += 1;
    if (f.tipoCp === '07') {
      v.ncBase += soles(f, 'baseGravada');
      v.ncIgv += soles(f, 'igv');
      v.ncNoGravado += soles(f, 'exonerado') + soles(f, 'inafecto');
    } else {
      v.base += soles(f, 'baseGravada');
      v.igv += soles(f, 'igv');
      v.exonerado += soles(f, 'exonerado');
      v.inafecto += soles(f, 'inafecto');
    }
  }
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'comprobantes' || k === 'enDolares' ? x : n2(x)]));
}

/** Compras del período: con crédito fiscal, en espera (detracción sin depositar) y sin crédito */
function resumenCompras(compras, periodo) {
  const fin = finDePeriodo(periodo);
  const c = { base: 0, igv: 0, sinCreditoBase: 0, esperaBase: 0, esperaIgv: 0, comprobantes: 0 };
  const enEspera = [];
  for (const f of compras.filter((x) => !x.anulado)) {
    c.comprobantes += 1;
    if (f.tipoCp !== '01') {
      // Boletas y otros: todo es costo, sin crédito fiscal
      c.sinCreditoBase += soles(f, 'total');
      continue;
    }
    const conDetraccion = f.detraccionMonto > 0;
    const depositada = conDetraccion && f.detraccionConstancia && f.detraccionFecha && f.detraccionFecha <= fin;
    if (conDetraccion && !depositada) {
      c.esperaBase += soles(f, 'baseGravada');
      c.esperaIgv += soles(f, 'igv');
      enEspera.push({ documentoId: f.documentoId, comprobante: `${f.serie}-${f.numero}`, proveedor: f.nombre, igv: n2(soles(f, 'igv')), detraccion: f.detraccionMonto });
      continue;
    }
    c.base += soles(f, 'baseGravada');
    c.igv += soles(f, 'igv');
  }
  return { ...Object.fromEntries(Object.entries(c).map(([k, x]) => [k, k === 'comprobantes' ? x : n2(x)])), enEspera };
}

/** Compras de meses anteriores cuya detracción se depositó en este período: su IGV da crédito ahora */
async function creditoDiferido(tx, empresaId, periodo) {
  const inicio = new Date(`${periodo.slice(0, 4)}-${periodo.slice(4)}-01T00:00:00Z`);
  const fin = new Date(`${finDePeriodo(periodo)}T00:00:00Z`);
  const docs = await tx.documentoComercial.findMany({
    where: { empresaId, tipo: 'COMPRA', estado: 'CONFIRMADO', comprobanteTipo: 'FACTURA', detraccionMonto: { gt: 0 }, detraccionConstancia: { not: null }, detraccionFecha: { gte: inicio, lte: fin }, fechaEmision: { lt: inicio } },
    select: { id: true, serie: true, numero: true, terceroNombre: true, subtotal: true, igv: true, tipoCambio: true },
  });
  return docs.map((d) => ({
    documentoId: d.id, comprobante: `${d.serie}-${d.numero}`, proveedor: d.terceroNombre,
    base: n2(Number(d.subtotal) * Number(d.tipoCambio)), igv: n2(Number(d.igv) * Number(d.tipoCambio)),
  }));
}

/**
 * Hoja de trabajo del PDT 621. saldoAnterior y tasaRenta se pueden indicar a mano; si no, el saldo
 * a favor sale del PDT registrado del mes anterior y la tasa, del régimen de la empresa.
 */
export async function calcularPdt621(tx, { empresa, periodo, saldoAnterior = null, tasaRenta = null }) {
  const [ventas, compras, diferido, retenciones, anterior, declarada, periodoSire] = await Promise.all([
    ventasDelSistema(tx, empresa.id, periodo),
    comprasDelSistema(tx, empresa.id, periodo),
    creditoDiferido(tx, empresa.id, periodo),
    tx.comprobante.aggregate({ where: { empresaId: empresa.id, tipo: 'FACTURA', estado: { not: 'ANULADO' }, retencionMonto: { gt: 0 }, fechaEmision: rangoLima(periodo) }, _sum: { retencionMonto: true } }),
    tx.declaracionMensual.findUnique({ where: { empresaId_periodo: { empresaId: empresa.id, periodo: desplazar(periodo, -1) } } }),
    tx.declaracionMensual.findUnique({ where: { empresaId_periodo: { empresaId: empresa.id, periodo } } }),
    tx.periodoSire.findUnique({ where: { empresaId_periodo: { empresaId: empresa.id, periodo } } }),
  ]);
  const v = resumenVentas(ventas);
  const c = resumenCompras(compras, periodo);
  const avisos = [];

  // ── IGV ──
  const creditoDiferidoIgv = n2(diferido.reduce((t, x) => t + x.igv, 0));
  const lineas = [
    { casilla: '100', texto: 'Ventas netas gravadas', base: r(v.base), impuesto: r(v.igv), casillaImpuesto: '101' },
    { casilla: '102', texto: 'Descuentos y devoluciones (notas de crédito)', base: -r(v.ncBase), impuesto: -r(v.ncIgv), casillaImpuesto: '103' },
    { texto: 'Ventas exoneradas', base: r(v.exonerado) },
    { texto: 'Ventas inafectas', base: r(v.inafecto) },
    { casilla: '107', texto: 'Compras gravadas con derecho a crédito fiscal', base: r(c.base + diferido.reduce((t, x) => t + x.base, 0)), impuesto: r(c.igv + creditoDiferidoIgv), casillaImpuesto: '108' },
    { texto: 'Compras sin derecho a crédito fiscal (boletas y otros)', base: r(c.sinCreditoBase) },
  ];
  const debito = r(v.igv) - r(v.ncIgv);
  const credito = r(c.igv + creditoDiferidoIgv);
  const resultado = debito - credito;
  let saldoAnt = saldoAnterior;
  if (saldoAnt == null) {
    saldoAnt = anterior ? r(anterior.saldoFavorSiguiente) : 0;
    if (!anterior && periodo > '200001') avisos.push('No hay PDT registrado del mes anterior: el saldo a favor anterior se toma como 0 (puede indicarlo a mano).');
  }
  const tributo = resultado - r(saldoAnt);
  const retencionesMes = r(retenciones._sum.retencionMonto ?? 0);
  const retencionesAplicadas = tributo > 0 ? Math.min(retencionesMes, tributo) : 0;
  const igv = {
    lineas, debito, credito, resultado, saldoAnterior: r(saldoAnt),
    retenciones: retencionesMes, retencionesAplicadas, retencionesPorAplicar: retencionesMes - retencionesAplicadas,
    aPagar: Math.max(0, tributo - retencionesAplicadas),
    saldoFavorSiguiente: tributo < 0 ? -tributo : 0,
  };

  // ── Renta (pago a cuenta) ──
  const ingresosNetos = r(v.base + v.exonerado + v.inafecto - v.ncBase - v.ncNoGravado);
  const tasa = tasaRenta ?? TASA_RENTA[empresa.regimenTributario];
  const renta = { casilla: '301', ingresosNetos, tasa, pagoCuenta: tasa == null ? null : r(ingresosNetos * tasa), regimen: empresa.regimenTributario };
  if (empresa.regimenTributario === 'NRUS') avisos.push('Empresa en el Nuevo RUS: no presenta el PDT 621 (paga la cuota mensual del NRUS).');
  if (empresa.regimenTributario === 'MYPE') avisos.push('Régimen MYPE: el pago a cuenta es 1% mientras los ingresos netos del año no superen 300 UIT; luego se usa el coeficiente o 1.5%.');
  if (empresa.regimenTributario === 'GENERAL' && tasaRenta == null) avisos.push('Régimen General: se aplica 1.5%; si la empresa tiene coeficiente (renta del año anterior), indíquelo.');

  if (c.enEspera.length) avisos.push(`${c.enEspera.length} compra(s) con detracción sin depositar al cierre del mes: su IGV (S/ ${r(c.esperaIgv)}) queda para el mes del depósito.`);
  if (diferido.length) avisos.push(`Se suma el IGV de ${diferido.length} compra(s) de meses anteriores cuya detracción se depositó en este mes.`);
  if (v.enDolares) avisos.push('Hay ventas en dólares: se convirtieron al tipo de cambio de cada documento.');
  if (periodoSire?.estadoRvie !== 'GENERADO' || periodoSire?.estadoRce !== 'GENERADO') {
    avisos.push('Los registros de ventas y compras del SIRE de este período aún no están generados en SUNAT: lo declarado debe coincidir con ellos.');
  }

  return {
    periodo, regimen: empresa.regimenTributario, igv, renta,
    totales: { ventas: v, compras: { ...c, enEspera: undefined } },
    comprasEnEspera: c.enEspera, creditoDiferido: diferido,
    avisos,
    declarada: declarada && {
      numeroOrden: declarada.numeroOrden, fechaPresentacion: declarada.fechaPresentacion.toISOString().slice(0, 10),
      igvPagado: Number(declarada.igvPagado), rentaPagada: Number(declarada.rentaPagada), saldoFavorSiguiente: Number(declarada.saldoFavorSiguiente), datos: declarada.datos,
    },
  };
}

// ───────────── DAOT ─────────────

/** UIT por año (S/). Si el año no está, se usa la última conocida y se avisa. */
export const UIT = { 2023: 4950, 2024: 5150, 2025: 5350 };

/**
 * DAOT del año: clientes y proveedores (con documento) cuyas operaciones del año superan 2 UIT.
 * Monto = base imponible + operaciones no gravadas (sin IGV), en soles; las notas de crédito restan.
 */
export async function calcularDaot(tx, { empresa, anio, uit = null }) {
  const valorUit = uit ?? UIT[anio] ?? UIT[Math.max(...Object.keys(UIT).map(Number))];
  const avisos = [];
  if (!uit && !UIT[anio]) avisos.push(`No tengo registrada la UIT de ${anio}: se usa S/ ${valorUit}. Confírmela e indíquela si cambió.`);
  const limite = 2 * valorUit;
  const acumular = (mapa, f) => {
    if (f.anulado || !f.docNumero || !/^\d{8}$|^\d{11}$/.test(f.docNumero)) return;
    const monto = (soles(f, 'baseGravada') + soles(f, 'exonerado') + soles(f, 'inafecto')) * (f.tipoCp === '07' ? -1 : 1);
    const x = mapa.get(f.docNumero) ?? { documento: f.docNumero, tipoDocumento: f.docTipo, nombre: f.nombre, monto: 0, comprobantes: 0 };
    x.monto += monto;
    x.comprobantes += 1;
    mapa.set(f.docNumero, x);
  };
  const ventas = new Map();
  const compras = new Map();
  let ingresosAnio = 0;
  for (let m = 1; m <= 12; m += 1) {
    const periodo = `${anio}${String(m).padStart(2, '0')}`;
    const [vs, cs] = await Promise.all([ventasDelSistema(tx, empresa.id, periodo), comprasDelSistema(tx, empresa.id, periodo)]);
    for (const f of vs) {
      acumular(ventas, f);
      if (!f.anulado) ingresosAnio += (soles(f, 'baseGravada') + soles(f, 'exonerado') + soles(f, 'inafecto')) * (f.tipoCp === '07' ? -1 : 1);
    }
    for (const f of cs) acumular(compras, f);
  }
  const lista = (mapa) => [...mapa.values()].map((x) => ({ ...x, monto: n2(x.monto) })).filter((x) => x.monto > limite).sort((a, b) => b.monto - a.monto);
  return { anio: Number(anio), uit: valorUit, limite, ingresosAnio: n2(ingresosAnio), ventas: lista(ventas), compras: lista(compras), avisos };
}
