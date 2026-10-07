import { unzipSync } from 'fflate';
import { fila } from './conciliacion.js';

/**
 * Archivos del SIRE. La propuesta del RVIE llega como ZIP con un TXT separado por "|"
 * (estructura del Anexo de la propuesta del RVIE). Columnas por posición, desde 0:
 *  0 RUC · 1 razón social · 2 período · 3 CAR · 4 fecha de emisión · 5 fecha de vencimiento ·
 *  6 tipo CP · 7 serie · 8 número (o inicial del rango) · 9 número final · 10 tipo doc. identidad ·
 * 11 número doc. · 12 nombre · 13 valor exportación · 14 BI gravada · 15 dscto. BI · 16 IGV ·
 * 17 dscto. IGV · 18 exonerado · 19 inafecto · 20 ISC · 21 BI IVAP · 22 IVAP · 23 ICBPER ·
 * 24 otros tributos · 25 total · 26 moneda · 27 tipo de cambio · 28 fecha doc. modificado ·
 * 29 tipo doc. modificado · 30 serie mod. · 31 número mod. · … · 34 estado del comprobante.
 * VERIFICAR con un archivo real de SUNAT antes de producción (posiciones y valores del estado).
 */
const num = (v) => {
  const n = Number(String(v ?? '').replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
};
const fechaIso = (v) => {
  const m = String(v ?? '').trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : String(v ?? '').slice(0, 10);
};
const texto = (v) => String(v ?? '').trim() || null;

/** Lee el TXT de la propuesta del RVIE → filas normalizadas */
export function leerPropuestaRvie(contenido) {
  const filas = [];
  for (const linea of contenido.split(/\r?\n/)) {
    if (!linea.trim()) continue;
    const c = linea.split('|');
    // Encabezado (la primera columna no es un RUC) o línea incompleta
    if (!/^\d{11}$/.test(c[0]?.trim() ?? '') || c.length < 27) continue;
    const base = num(c[14]) - Math.abs(num(c[15]));
    const igv = num(c[16]) - Math.abs(num(c[17]));
    const total = num(c[25]);
    filas.push(fila({
      tipoCp: c[6].trim().padStart(2, '0'), serie: c[7], numero: c[8], fechaEmision: fechaIso(c[4]),
      docTipo: texto(c[10]), docNumero: texto(c[11]), nombre: texto(c[12]),
      baseGravada: base, igv, exonerado: num(c[18]), inafecto: num(c[19]),
      otros: num(c[13]) + num(c[20]) + num(c[22]) + num(c[23]) + num(c[24]),
      total, moneda: texto(c[26]) ?? 'PEN',
      refTipo: texto(c[29]), refSerie: texto(c[30]), refNumero: texto(c[31]),
      // Anulado: estado "2" o comprobante con todo en cero
      anulado: c[34]?.trim() === '2' || (total === 0 && base === 0 && num(c[18]) === 0 && num(c[19]) === 0),
    }));
  }
  return filas;
}

/**
 * Lee el TXT de la propuesta del RCE → filas normalizadas (clave con el RUC del proveedor).
 * Columnas por posición, desde 0:
 *  0 RUC · 1 razón social · 2 período · 3 CAR · 4 fecha de emisión · 5 fecha de vencimiento ·
 *  6 tipo CP · 7 serie · 8 año DUA/DSI · 9 número · 10 número final · 11 tipo doc. proveedor ·
 * 12 número doc. proveedor · 13 nombre del proveedor · 14 BI y 15 IGV destinadas a operaciones
 * gravadas · 16 BI y 17 IGV gravadas y no gravadas · 18 BI y 19 IGV no gravadas ·
 * 20 valor no gravado · 21 ISC · 22 ICBPER · 23 otros tributos · 24 total · 25 moneda ·
 * 26 tipo de cambio · 27 fecha doc. modificado · 28 tipo doc. modificado · 29 serie mod. ·
 * 30 código DAM · 31 número mod.
 * VERIFICAR con un archivo real de SUNAT antes de producción.
 */
export function leerPropuestaRce(contenido) {
  const filas = [];
  for (const linea of contenido.split(/\r?\n/)) {
    if (!linea.trim()) continue;
    const c = linea.split('|');
    if (!/^\d{11}$/.test(c[0]?.trim() ?? '') || c.length < 26) continue;
    const base = num(c[14]) + num(c[16]) + num(c[18]);
    const igv = num(c[15]) + num(c[17]) + num(c[19]);
    const total = num(c[24]);
    const proveedor = texto(c[12]);
    filas.push(fila({
      tipoCp: c[6].trim().padStart(2, '0'), serie: c[7], numero: c[9], emisor: proveedor, fechaEmision: fechaIso(c[4]),
      docTipo: texto(c[11]), docNumero: proveedor, nombre: texto(c[13]),
      baseGravada: base, igv, inafecto: num(c[20]), otros: num(c[21]) + num(c[22]) + num(c[23]),
      total, moneda: texto(c[25]) ?? 'PEN',
      refTipo: texto(c[28]), refSerie: texto(c[29]), refNumero: texto(c[31]),
      anulado: total === 0 && base === 0 && num(c[20]) === 0,
    }));
  }
  return filas;
}

export const LECTORES = { RVIE: leerPropuestaRvie, RCE: leerPropuestaRce };

/** Extrae el primer TXT de un ZIP (o devuelve el texto si ya viene plano) */
export function textoDeArchivo(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8[0] === 0x50 && u8[1] === 0x4b) {
    const archivos = unzipSync(u8);
    const nombre = Object.keys(archivos).find((n) => /\.txt$/i.test(n)) ?? Object.keys(archivos)[0];
    if (!nombre) throw new Error('El archivo de SUNAT llegó vacío');
    return new TextDecoder('utf-8').decode(archivos[nombre]);
  }
  return new TextDecoder('utf-8').decode(u8);
}
