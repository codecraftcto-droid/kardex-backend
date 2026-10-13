import ExcelJS from 'exceljs';
import { solicitudInvalida } from '../lib/errors.js';

/**
 * Lee la primera hoja de un Excel (.xlsx) o un CSV y devuelve filas como objetos con las claves de
 * columna del tipo de importación. Los encabezados se reconocen sin importar mayúsculas, tildes ni
 * espacios ("Número de documento" = numero_documento).
 */
export const MAX_FILAS = 5000;
export const normalizar = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/** Valor de una celda de ExcelJS como texto (fechas en AAAA-MM-DD, fórmulas por su resultado) */
function texto(v) {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('result' in v) return texto(v.result);
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    if ('text' in v) return String(v.text);
    return '';
  }
  return String(v).trim();
}

/** CSV simple: separador "," o ";" (el que aparezca en el encabezado), comillas dobles y saltos de línea dentro de comillas */
function leerCsv(contenido) {
  const sep = (contenido.split(/\r?\n/)[0].match(/;/g)?.length ?? 0) > (contenido.split(/\r?\n/)[0].match(/,/g)?.length ?? 0) ? ';' : ',';
  const filas = [];
  let fila = [];
  let campo = '';
  let comillas = false;
  for (let i = 0; i < contenido.length; i += 1) {
    const c = contenido[i];
    if (comillas) {
      if (c === '"' && contenido[i + 1] === '"') { campo += '"'; i += 1; } else if (c === '"') comillas = false; else campo += c;
    } else if (c === '"') comillas = true;
    else if (c === sep) { fila.push(campo); campo = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && contenido[i + 1] === '\n') i += 1;
      fila.push(campo);
      filas.push(fila);
      fila = [];
      campo = '';
    } else campo += c;
  }
  if (campo || fila.length) { fila.push(campo); filas.push(fila); }
  return filas.map((f) => f.map((x) => x.trim()));
}

/**
 * columnas: [{ clave, titulo, alias? }]. Devuelve [{ numero, datos }] (falla si falta una columna requerida).
 * `numero` es la fila del archivo (la 1 es el encabezado), para que el usuario la ubique.
 */
export async function leerArchivo(buffer, nombre, columnas) {
  let matriz;
  if (/\.csv$/i.test(nombre)) {
    matriz = leerCsv(buffer.toString('utf8').replace(/^﻿/, ''));
  } else if (/\.xlsx$/i.test(nombre)) {
    const libro = new ExcelJS.Workbook();
    try {
      await libro.xlsx.load(buffer);
    } catch {
      throw solicitudInvalida('No se pudo leer el archivo: ¿es un Excel .xlsx válido?');
    }
    const hoja = libro.worksheets[0];
    if (!hoja) throw solicitudInvalida('El archivo no tiene hojas');
    matriz = [];
    hoja.eachRow({ includeEmpty: false }, (row, n) => {
      const valores = [];
      for (let c = 1; c <= row.cellCount; c += 1) valores.push(texto(row.getCell(c).value));
      matriz[n - 1] = valores;
    });
  } else {
    throw solicitudInvalida('Suba un archivo .xlsx o .csv');
  }

  const encabezado = (matriz[0] ?? []).map(normalizar);
  const indice = {};
  for (const col of columnas) {
    const nombres = [col.clave, col.titulo, ...(col.alias ?? [])].map(normalizar);
    const i = encabezado.findIndex((h) => nombres.includes(h));
    if (i >= 0) indice[col.clave] = i;
  }
  const faltantes = columnas.filter((c) => c.requerido && indice[c.clave] === undefined).map((c) => c.titulo);
  if (faltantes.length) throw solicitudInvalida(`Faltan columnas en el archivo: ${faltantes.join(', ')}. Use la plantilla.`);

  const filas = [];
  for (let n = 1; n < matriz.length; n += 1) {
    const valores = matriz[n];
    if (!valores || valores.every((v) => !v)) continue;
    filas.push({ numero: n + 1, datos: Object.fromEntries(columnas.map((c) => [c.clave, indice[c.clave] === undefined ? '' : (valores[indice[c.clave]] ?? '')])) });
  }
  if (!filas.length) throw solicitudInvalida('El archivo no tiene filas con datos');
  if (filas.length > MAX_FILAS) throw solicitudInvalida(`Máximo ${MAX_FILAS} filas por archivo (tiene ${filas.length}): divídalo en partes`);
  return filas;
}

/** Plantilla .xlsx: hoja "Datos" con encabezados y una fila de ejemplo, y hoja "Instrucciones" */
export async function plantilla({ titulo, columnas, ejemplo, notas = [] }) {
  const libro = new ExcelJS.Workbook();
  const hoja = libro.addWorksheet('Datos');
  hoja.columns = columnas.map((c) => ({ header: c.titulo, key: c.clave, width: Math.max(14, c.titulo.length + 4) }));
  hoja.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  hoja.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F766E' } };
  hoja.views = [{ state: 'frozen', ySplit: 1 }];
  for (const e of ejemplo) hoja.addRow(e);
  // Las columnas de documentos y códigos como texto (para no perder ceros a la izquierda)
  columnas.forEach((c, i) => { if (c.texto) hoja.getColumn(i + 1).numFmt = '@'; });

  const ins = libro.addWorksheet('Instrucciones');
  ins.getColumn(1).width = 28;
  ins.getColumn(2).width = 90;
  ins.addRow([titulo]).font = { bold: true, size: 14 };
  ins.addRow(['Borre la fila de ejemplo de la hoja "Datos" y complete una fila por registro. No cambie los encabezados.']);
  ins.addRow([]);
  ins.addRow(['Columna', 'Qué va']).font = { bold: true };
  for (const c of columnas) ins.addRow([`${c.titulo}${c.requerido ? ' *' : ''}`, c.ayuda ?? '']);
  if (notas.length) {
    ins.addRow([]);
    for (const n of notas) ins.addRow(['', n]);
  }
  return libro.xlsx.writeBuffer();
}
