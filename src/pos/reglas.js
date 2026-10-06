import { Prisma } from '@prisma/client';
import { env } from '../config/env.js';

/**
 * Reglas del punto de venta, PURAS (sin BD): documentos de identidad, reglas SUNAT de
 * emisión, cálculo de importes con IGV y monto en letras.
 */
const D = (v) => new Prisma.Decimal(v ?? 0);
const r2 = (d) => d.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
const r6 = (d) => d.toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP);

/** Catálogo 06 SUNAT (tipo de documento de identidad) y 01 (tipo de comprobante). */
export const CODIGO_DOC = { SIN_DOCUMENTO: '0', DNI: '1', CARNE_EXTRANJERIA: '4', RUC: '6', PASAPORTE: '7' };
export const CODIGO_COMPROBANTE = { FACTURA: '01', BOLETA: '03', NOTA_CREDITO: '07' };
export const NOMBRE_COMPROBANTE = { FACTURA: 'Factura', BOLETA: 'Boleta de venta', NOTA_VENTA: 'Nota de venta', NOTA_CREDITO: 'Nota de crédito' };
export const CLIENTES_VARIOS = { tipoDocumento: 'SIN_DOCUMENTO', numeroDocumento: '-', nombre: 'CLIENTES VARIOS', direccion: null };

/** Boletas desde este monto exigen identificar al comprador (S/ 700 por defecto). */
export const UMBRAL_BOLETA = () => D(env.BOLETA_UMBRAL_IDENTIFICACION);

/** RUC: 11 dígitos, prefijo válido y dígito verificador (módulo 11). */
export function rucValido(ruc) {
  if (!/^(10|15|16|17|20)\d{9}$/.test(ruc)) return false;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = pesos.reduce((s, p, i) => s + p * Number(ruc[i]), 0);
  const resto = 11 - (suma % 11);
  const verificador = resto === 10 ? 0 : resto === 11 ? 1 : resto;
  return verificador === Number(ruc[10]);
}

/**
 * Datos del cliente con los que se emite: a una persona con DNI y RUC 10 asociado se le
 * factura con su RUC, sin registrarla dos veces.
 */
export function identidadParaEmitir(tipoComprobante, cliente) {
  if (tipoComprobante === 'FACTURA' && cliente.tipoDocumento !== 'RUC' && cliente.rucAsociado) {
    return { ...cliente, tipoDocumento: 'RUC', numeroDocumento: cliente.rucAsociado };
  }
  return cliente;
}

/** RUC de persona natural (10 + DNI + dígito verificador) que corresponde a un DNI. */
export function rucDesdeDni(dni) {
  if (!/^\d{8}$/.test(dni)) return null;
  for (let d = 0; d <= 9; d += 1) if (rucValido(`10${dni}${d}`)) return `10${dni}${d}`;
  return null;
}

/** Valida el número según el tipo de documento. Devuelve un mensaje de error o null. */
export function errorDocumento(tipo, numero) {
  const n = String(numero ?? '').trim();
  switch (tipo) {
    case 'DNI':
      return /^\d{8}$/.test(n) ? null : 'El DNI debe tener 8 dígitos';
    case 'RUC':
      return rucValido(n) ? null : 'RUC inválido (revise los 11 dígitos)';
    case 'CARNE_EXTRANJERIA':
      return /^[A-Z0-9]{8,12}$/i.test(n) ? null : 'El carné de extranjería debe tener entre 8 y 12 caracteres';
    case 'PASAPORTE':
      return /^[A-Z0-9]{6,12}$/i.test(n) ? null : 'El pasaporte debe tener entre 6 y 12 caracteres';
    case 'SIN_DOCUMENTO':
      return null;
    default:
      return 'Tipo de documento no válido';
  }
}

/**
 * Reglas SUNAT para identificar al comprador:
 *  - Factura: siempre con RUC.
 *  - Boleta: desde el umbral (S/ 700) exige documento; debajo admite "Clientes varios".
 *  - Nota de venta (interna): sin restricción.
 */
export function errorCliente(tipoComprobante, cliente, total) {
  if (tipoComprobante === 'FACTURA' && cliente.tipoDocumento !== 'RUC') {
    return 'La factura exige un cliente con RUC (o con RUC asociado)';
  }
  if (tipoComprobante === 'BOLETA' && cliente.tipoDocumento === 'SIN_DOCUMENTO' && D(total).gte(UMBRAL_BOLETA())) {
    return `Las boletas desde S/ ${UMBRAL_BOLETA().toFixed(2)} deben identificar al comprador (DNI u otro documento)`;
  }
  return null;
}

/**
 * Importes de una venta con precios CON IGV (lo habitual en caja).
 * linea = { cantidad, precioUnitario (con IGV), descuento (monto, con IGV), afectacionIgv }
 */
export function calcularLineas(lineas) {
  const tasa = D(env.IGV_TASA);
  const res = { opGravada: D(0), opExonerada: D(0), opInafecta: D(0), igv: D(0), descuentoTotal: D(0), total: D(0) };
  const calculadas = lineas.map((l) => {
    const cantidad = D(l.cantidad);
    const precio = D(l.precioUnitario);
    const descuento = r2(D(l.descuento));
    const bruto = r2(cantidad.mul(precio));
    if (descuento.gt(bruto)) throw new Error('El descuento no puede superar el importe de la línea');
    const total = bruto.sub(descuento);
    const gravado = l.afectacionIgv === '10';
    const valorVenta = gravado ? r2(total.div(tasa.add(1))) : total;
    const igv = total.sub(valorVenta);
    if (gravado) res.opGravada = res.opGravada.add(valorVenta);
    else if (l.afectacionIgv === '20') res.opExonerada = res.opExonerada.add(valorVenta);
    else res.opInafecta = res.opInafecta.add(valorVenta);
    res.igv = res.igv.add(igv);
    res.descuentoTotal = res.descuentoTotal.add(descuento);
    res.total = res.total.add(total);
    return { ...l, cantidad, precioUnitario: precio, descuento, valorUnitario: gravado ? r6(precio.div(tasa.add(1))) : r6(precio), valorVenta, igv, total };
  });
  return { lineas: calculadas, ...res };
}

/**
 * Descuentos de la venta, antes de calcular el IGV:
 *  - por línea, en monto (`descuento`) o en porcentaje (`descuentoPorcentaje`);
 *  - global (`{ tipo: 'MONTO' | 'PORCENTAJE', valor }`), prorrateado entre las líneas según
 *    su importe, para que cada línea lleve su descuento y el IGV cuadre.
 * También mide la REBAJA de cada línea frente al precio de lista (`precioReferencial`):
 * bajar el precio a mano es un descuento, y cuenta para el tope de la caja.
 * Devuelve { lineas (con `descuento` final), descuentoGlobal, rebajaMaxima (%) }.
 */
export function aplicarDescuentos(lineas, global = null) {
  const conLinea = lineas.map((l) => {
    const bruto = r2(D(l.cantidad).mul(D(l.precioUnitario)));
    const pct = l.descuentoPorcentaje != null ? D(l.descuentoPorcentaje) : null;
    if (pct && (pct.lt(0) || pct.gt(100))) throw new Error('El porcentaje de descuento debe estar entre 0 y 100');
    const descuento = pct ? r2(bruto.mul(pct).div(100)) : r2(D(l.descuento));
    if (descuento.gt(bruto)) throw new Error('El descuento no puede superar el importe de la línea');
    return { ...l, bruto, descuento };
  });

  let descuentoGlobal = D(0);
  if (global && D(global.valor).gt(0)) {
    const neto = conLinea.reduce((s, l) => s.add(l.bruto.sub(l.descuento)), D(0));
    if (global.tipo === 'PORCENTAJE' && D(global.valor).gt(100)) throw new Error('El porcentaje de descuento debe estar entre 0 y 100');
    descuentoGlobal = global.tipo === 'PORCENTAJE' ? r2(neto.mul(D(global.valor)).div(100)) : r2(D(global.valor));
    if (descuentoGlobal.gt(neto)) throw new Error('El descuento global no puede superar el total');
    if (neto.gt(0)) {
      let repartido = D(0);
      const partes = conLinea.map((l) => {
        const parte = r2(descuentoGlobal.mul(l.bruto.sub(l.descuento)).div(neto));
        repartido = repartido.add(parte);
        return parte;
      });
      // El redondeo sobrante va a la línea de mayor importe (que siempre puede absorberlo)
      const mayor = conLinea.reduce((m, l, i) => (l.bruto.sub(l.descuento).gt(conLinea[m].bruto.sub(conLinea[m].descuento)) ? i : m), 0);
      partes[mayor] = partes[mayor].add(descuentoGlobal.sub(repartido));
      conLinea.forEach((l, i) => (l.descuento = l.descuento.add(partes[i])));
    }
  }

  let rebajaMaxima = D(0);
  for (const l of conLinea) {
    const lista = r2(D(l.cantidad).mul(D(l.precioReferencial ?? l.precioUnitario)));
    if (lista.lte(0)) continue;
    const rebaja = lista.sub(l.bruto.sub(l.descuento)).mul(100).div(lista);
    if (rebaja.gt(rebajaMaxima)) rebajaMaxima = rebaja;
  }
  return {
    lineas: conLinea.map(({ bruto, descuentoPorcentaje, precioReferencial, ...l }) => l),
    descuentoGlobal,
    rebajaMaxima: rebajaMaxima.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
  };
}

/**
 * Pagos de una venta. El efectivo puede exceder (vuelto); los demás medios no.
 * Devuelve los pagos APLICADOS (lo que realmente cubre la venta), el efectivo recibido y el vuelto.
 */
export function aplicarPagos(total, pagos) {
  const t = D(total);
  const noEfectivo = pagos.filter((p) => p.medio !== 'EFECTIVO').reduce((s, p) => s.add(D(p.monto)), D(0));
  const efectivoRecibido = pagos.filter((p) => p.medio === 'EFECTIVO').reduce((s, p) => s.add(D(p.monto)), D(0));
  if (noEfectivo.gt(t)) return { error: 'Los pagos con tarjeta, Yape, Plin o transferencia superan el total' };
  const efectivoNecesario = t.sub(noEfectivo);
  if (efectivoRecibido.lt(efectivoNecesario)) {
    return { error: `Pago incompleto: faltan S/ ${efectivoNecesario.sub(efectivoRecibido).toFixed(2)}` };
  }
  const aplicados = pagos
    .filter((p) => p.medio !== 'EFECTIVO' && D(p.monto).gt(0))
    .map((p) => ({ medio: p.medio, monto: r2(D(p.monto)), referencia: p.referencia ?? null }));
  if (efectivoNecesario.gt(0)) aplicados.push({ medio: 'EFECTIVO', monto: r2(efectivoNecesario), referencia: null });
  return {
    pagos: aplicados,
    montoRecibido: efectivoRecibido.gt(0) ? r2(efectivoRecibido) : null,
    vuelto: r2(efectivoRecibido.sub(efectivoNecesario)),
  };
}

/**
 * Pagos de una venta AL CRÉDITO: lo pagado es la cuota inicial (puede ser cero) y debe
 * quedar algo por financiar. No hay vuelto: si el cliente paga todo, es una venta al contado.
 */
export function aplicarPagosCredito(total, pagos = []) {
  const t = D(total);
  const aplicados = pagos.filter((p) => D(p.monto).gt(0)).map((p) => ({ medio: p.medio, monto: r2(D(p.monto)), referencia: p.referencia ?? null }));
  const inicial = aplicados.reduce((s, p) => s.add(p.monto), D(0));
  if (inicial.gte(t)) return { error: 'El pago inicial cubre todo el total: registre la venta al contado' };
  return { pagos: aplicados, inicial, montoCredito: t.sub(inicial), montoRecibido: null, vuelto: D(0) };
}

// ───────────── Crédito: fechas y cuotas ─────────────

/** Fecha de hoy en Perú (YYYY-MM-DD): el vencimiento no depende de la zona del servidor. */
export const hoyLima = (fecha = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(fecha);
export const sumarDias = (iso, dias) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
};
const diasEntre = (desde, hasta) => Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000);
const isoDe = (f) => (typeof f === 'string' ? f.slice(0, 10) : f.toISOString().slice(0, 10));

/** Cuotas iguales cada `dias` días (la última absorbe el redondeo). */
export function cuotasIguales(montoCredito, cantidad, dias, hoy = hoyLima()) {
  const m = D(montoCredito);
  const n = Math.max(1, cantidad);
  const base = m.div(n).toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN);
  return Array.from({ length: n }, (_, i) => ({
    numero: i + 1,
    monto: i === n - 1 ? m.sub(base.mul(n - 1)) : base,
    fechaVencimiento: sumarDias(hoy, dias * (i + 1)),
  }));
}

/** Valida las cuotas indicadas: suman el monto financiado, fechas futuras y en orden. Devuelve error o null. */
export function errorCuotas(cuotas, montoCredito, hoy = hoyLima()) {
  if (!cuotas.length) return 'Indique al menos una cuota';
  if (cuotas.length > 36) return 'Máximo 36 cuotas';
  let anterior = hoy;
  for (const c of cuotas) {
    if (D(c.monto).lte(0)) return 'Cada cuota debe ser mayor que cero';
    const f = isoDe(c.fechaVencimiento);
    if (f <= anterior) return 'Las fechas de las cuotas deben ser posteriores a hoy y estar en orden';
    anterior = f;
  }
  const suma = cuotas.reduce((s, c) => s.add(D(c.monto)), D(0));
  if (!r2(suma).eq(r2(D(montoCredito)))) return `Las cuotas suman S/ ${r2(suma).toFixed(2)} y deben sumar S/ ${r2(D(montoCredito)).toFixed(2)}`;
  return null;
}

/**
 * Estado de las cuotas: lo ya pagado (monto financiado − saldo) se aplica a las cuotas en
 * orden de vencimiento. Devuelve cada cuota con su pendiente, si está vencida y hace cuántos días.
 */
export function estadoCuotas(cuotas, montoCredito, saldoPendiente, hoy = hoyLima()) {
  let pagado = D(montoCredito).sub(D(saldoPendiente));
  return [...cuotas]
    .sort((a, b) => a.numero - b.numero)
    .map((c) => {
      const monto = D(c.monto);
      const aplicado = Prisma.Decimal.min(monto, Prisma.Decimal.max(pagado, 0));
      pagado = pagado.sub(aplicado);
      const pendiente = monto.sub(aplicado);
      const fecha = isoDe(c.fechaVencimiento);
      const diasVencido = pendiente.gt(0) ? Math.max(0, diasEntre(fecha, hoy)) : 0;
      return { numero: c.numero, monto, fechaVencimiento: fecha, pagado: aplicado, pendiente, vencida: diasVencido > 0, diasVencido };
    });
}

/** Tramo de antigüedad de una deuda según los días de atraso. */
export const tramoAntiguedad = (dias) => (dias <= 0 ? 'porVencer' : dias <= 30 ? 'd1_30' : dias <= 60 ? 'd31_60' : dias <= 90 ? 'd61_90' : 'd90');

// ───────────── Monto en letras ─────────────

const UNIDADES = ['', 'UNO', 'DOS', 'TRES', 'CUATRO', 'CINCO', 'SEIS', 'SIETE', 'OCHO', 'NUEVE', 'DIEZ', 'ONCE', 'DOCE', 'TRECE', 'CATORCE', 'QUINCE', 'DIECISÉIS', 'DIECISIETE', 'DIECIOCHO', 'DIECINUEVE', 'VEINTE', 'VEINTIUNO', 'VEINTIDÓS', 'VEINTITRÉS', 'VEINTICUATRO', 'VEINTICINCO', 'VEINTISÉIS', 'VEINTISIETE', 'VEINTIOCHO', 'VEINTINUEVE'];
const DECENAS = ['', '', '', 'TREINTA', 'CUARENTA', 'CINCUENTA', 'SESENTA', 'SETENTA', 'OCHENTA', 'NOVENTA'];
const CENTENAS = ['', 'CIENTO', 'DOSCIENTOS', 'TRESCIENTOS', 'CUATROCIENTOS', 'QUINIENTOS', 'SEISCIENTOS', 'SETECIENTOS', 'OCHOCIENTOS', 'NOVECIENTOS'];

function hasta999(n) {
  if (n === 0) return '';
  if (n === 100) return 'CIEN';
  const c = Math.floor(n / 100);
  const r = n % 100;
  let txt = CENTENAS.at(c);
  if (r) {
    const dec = r < 30 ? UNIDADES.at(r) : `${DECENAS.at(Math.floor(r / 10))}${r % 10 ? ` Y ${UNIDADES.at(r % 10)}` : ''}`;
    txt = `${txt} ${dec}`;
  }
  return txt.trim();
}

/** "UNO" → "UN" delante de MIL/MILLONES (VEINTIÚN MIL, TREINTA Y UN MIL...). */
const apocope = (txt) => txt.replace(/VEINTIUNO$/, 'VEINTIÚN').replace(/UNO$/, 'UN');

export function enteroEnLetras(n) {
  if (n === 0) return 'CERO';
  const millones = Math.floor(n / 1e6);
  const miles = Math.floor((n % 1e6) / 1000);
  const resto = n % 1000;
  const partes = [];
  if (millones) partes.push(millones === 1 ? 'UN MILLÓN' : `${apocope(enteroEnLetras(millones))} MILLONES`);
  if (miles) partes.push(miles === 1 ? 'MIL' : `${apocope(hasta999(miles))} MIL`);
  if (resto) partes.push(hasta999(resto));
  return partes.join(' ');
}

/** 1250.5 → "SON: MIL DOSCIENTOS CINCUENTA CON 50/100 SOLES" */
export function montoEnLetras(monto, moneda = 'PEN') {
  const total = r2(D(monto));
  const entero = Number(total.trunc());
  const centimos = total.sub(entero).mul(100).toFixed(0).padStart(2, '0');
  const nombre = moneda === 'USD' ? 'DÓLARES AMERICANOS' : 'SOLES';
  // Tras el número va "CON": sin apócope (VEINTIUNO CON…, MIL UNO CON…); la apócope solo ante MIL/MILLONES
  return `SON: ${enteroEnLetras(entero)} CON ${centimos}/100 ${nombre}`;
}
