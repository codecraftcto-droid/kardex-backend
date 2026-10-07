/**
 * Conciliación de una propuesta del SIRE con lo registrado en el sistema. Sin acceso a BD.
 * Ambos lados llegan normalizados (ver `fila`): montos positivos (también las notas de crédito),
 * número sin ceros a la izquierda y la clave tipo-[RUC del proveedor-]serie-número para cruzarlos.
 */
export const TIPO_CP = { FACTURA: '01', BOLETA: '03', NOTA_CREDITO: '07' };
export const NOMBRE_TIPO_CP = { '01': 'Factura', '03': 'Boleta', '07': 'Nota de crédito', '08': 'Nota de débito' };
/** Catálogo 06 de SUNAT */
export const DOC_IDENTIDAD = { SIN_DOCUMENTO: '0', DNI: '1', CARNE_EXTRANJERIA: '4', RUC: '6', PASAPORTE: '7' };

const r2 = (v) => Math.round(Math.abs(Number(v) || 0) * 100) / 100;
/** En compras (RCE) la clave lleva el RUC del proveedor: dos proveedores pueden tener la misma serie y número */
export const claveCp = (tipoCp, serie, numero, emisor) => `${tipoCp}-${emisor ? `${emisor}-` : ''}${String(serie).trim().toUpperCase()}-${Number(numero)}`;
const TOLERANCIA = 0.01;

/** Normaliza un comprobante (de SUNAT o del sistema) */
export function fila(d) {
  const numero = String(Number(d.numero));
  return {
    ...d,
    serie: String(d.serie).trim().toUpperCase(),
    numero,
    clave: claveCp(d.tipoCp, d.serie, numero, d.emisor),
    baseGravada: r2(d.baseGravada), igv: r2(d.igv), exonerado: r2(d.exonerado), inafecto: r2(d.inafecto), otros: r2(d.otros), total: r2(d.total),
    moneda: d.moneda || 'PEN',
    anulado: Boolean(d.anulado),
  };
}

const difiere = (a, b) => Math.abs(a - b) > TOLERANCIA;

/**
 * Cruza ambos lados. Un comprobante anulado que solo está en uno de ellos no es diferencia
 * (no se registra). Devuelve { coinciden, diferencias: [{ tipo, clave, sunat, sistema }] }.
 */
export function conciliar(sunat, sistema) {
  const delSistema = new Map();
  for (const s of sistema) if (!delSistema.has(s.clave)) delSistema.set(s.clave, s);
  const vistos = new Set();
  const diferencias = [];
  let coinciden = 0;

  for (const p of sunat) {
    if (vistos.has(p.clave)) continue;
    vistos.add(p.clave);
    const s = delSistema.get(p.clave);
    if (!s) {
      if (!p.anulado) diferencias.push({ tipo: 'SOLO_SUNAT', clave: p.clave, sunat: p, sistema: null });
      continue;
    }
    if (p.anulado !== s.anulado) diferencias.push({ tipo: 'ESTADO', clave: p.clave, sunat: p, sistema: s });
    else if (!p.anulado && (difiere(p.total, s.total) || difiere(p.igv, s.igv))) diferencias.push({ tipo: 'MONTO', clave: p.clave, sunat: p, sistema: s });
    else coinciden += 1;
  }
  for (const s of delSistema.values()) {
    if (!vistos.has(s.clave) && !s.anulado) diferencias.push({ tipo: 'SOLO_SISTEMA', clave: s.clave, sunat: null, sistema: s });
  }
  return { coinciden, diferencias };
}

/** Totales de una lista normalizada (las notas de crédito restan) */
export function totales(lista) {
  const t = { cantidad: 0, base: 0, igv: 0, total: 0 };
  for (const x of lista) {
    if (x.anulado) continue;
    const signo = ['07'].includes(x.tipoCp) ? -1 : 1;
    t.cantidad += 1;
    t.base += signo * x.baseGravada;
    t.igv += signo * x.igv;
    t.total += signo * x.total;
  }
  for (const k of ['base', 'igv', 'total']) t[k] = Math.round(t[k] * 100) / 100;
  return t;
}
