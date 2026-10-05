import fs from 'node:fs';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { Prisma } from '@prisma/client';

/**
 * Escritores en STREAMING para reportes grandes: reciben filas por lotes y las escriben
 * directo al archivo, sin acumularlas en memoria. Los totales (columnas con `sumar`)
 * se calculan sobre la marcha.
 *
 * meta = { titulo, subtitulo[], columnas: [{ clave, titulo, tipo, ancho, sumar? }], totales?: { clave, texto } }
 */

const valor = (fila, clave) => clave.split('.').reduce((o, k) => o?.[k], fila);
const esNumerico = (tipo) => ['cantidad', 'moneda', 'costo'].includes(tipo);

export function texto(v, tipo) {
  if (v === null || v === undefined || v === '') return '';
  if (tipo === 'fecha') {
    const d = new Date(v);
    const soloFecha = !d.getUTCHours() && !d.getUTCMinutes() && !d.getUTCSeconds() && !d.getUTCMilliseconds();
    return d.toLocaleDateString('es-PE', soloFecha ? { timeZone: 'UTC' } : undefined);
  }
  if (tipo === 'fechaHora') return new Date(v).toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'short' });
  if (tipo === 'cantidad') return Number(v).toLocaleString('es-PE', { maximumFractionDigits: 4 });
  if (tipo === 'moneda') return Number(v).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (tipo === 'costo') return Number(v).toLocaleString('es-PE', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  return String(v);
}

/** Acumulador de totales de las columnas marcadas con `sumar`. */
export function crearAcumulador(meta) {
  const sumas = Object.fromEntries(meta.columnas.filter((c) => c.sumar).map((c) => [c.clave, new Prisma.Decimal(0)]));
  let filas = 0;
  return {
    agregar(lote) {
      filas += lote.length;
      for (const f of lote) for (const k of Object.keys(sumas)) if (f[k] != null) sumas[k] = sumas[k].add(f[k]);
    },
    get filas() {
      return filas;
    },
    totales() {
      if (!meta.totales || !Object.keys(sumas).length) return null;
      return { [meta.totales.clave]: `${meta.totales.texto} (${filas} registros)`, ...sumas };
    },
  };
}

// ───────────── Excel ─────────────

const textoSeguro = (s) => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s); // evita inyección de fórmulas
const FORMATO = { cantidad: '#,##0.####', moneda: '#,##0.00', costo: '#,##0.0000##', fecha: 'dd/mm/yyyy', fechaHora: 'dd/mm/yyyy hh:mm' };

export function crearEscritorXlsx(ruta, meta) {
  const libro = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: ruta, useStyles: true });
  const hoja = libro.addWorksheet(meta.titulo.slice(0, 31), { views: [{ state: 'frozen', ySplit: (meta.subtitulo?.length ?? 0) + 3 }] });
  hoja.columns = meta.columnas.map((c) => ({ width: c.ancho ? c.ancho * 1.6 : 16 }));
  hoja.addRow([meta.titulo]).font = { bold: true, size: 14 };
  for (const l of meta.subtitulo ?? []) hoja.addRow([l]).font = { color: { argb: 'FF64748B' } };
  hoja.addRow([]);
  const cab = hoja.addRow(meta.columnas.map((c) => c.titulo));
  cab.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  cab.eachCell((c) => (c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F766E' } }));

  const escribir = (f, negrita = false) => {
    const r = hoja.addRow(
      meta.columnas.map((c) => {
        const v = valor(f, c.clave);
        if (v === null || v === undefined || v === '') return null;
        if (esNumerico(c.tipo)) return Number(v);
        if (c.tipo === 'fecha' || c.tipo === 'fechaHora') return new Date(v);
        return textoSeguro(String(v));
      }),
    );
    meta.columnas.forEach((c, i) => FORMATO[c.tipo] && (r.getCell(i + 1).numFmt = FORMATO[c.tipo]));
    if (negrita) r.font = { bold: true };
    r.commit(); // libera la fila de memoria
  };

  return {
    agregar: (lote) => lote.forEach((f) => escribir(f)),
    async cerrar(totales) {
      if (totales) escribir(totales, true);
      hoja.commit();
      await libro.commit();
    },
  };
}

// ───────────── PDF ─────────────

export function crearEscritorPdf(ruta, meta) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30, info: { Title: meta.titulo } });
  const salida = fs.createWriteStream(ruta);
  doc.pipe(salida);

  const izq = doc.page.margins.left;
  const ancho = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const pesos = meta.columnas.map((c) => c.ancho ?? 10);
  const suma = pesos.reduce((a, b) => a + b, 0);
  const anchos = pesos.map((p) => (p / suma) * ancho);
  const ALTO = 16;
  const generado = new Date().toLocaleString('es-PE');
  let pagina = 1;
  let filaN = 0;

  // Sin buffer de páginas (no cabe en memoria en reportes grandes): pie "Página N" al cerrar cada página
  const pie = () => {
    const margen = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(7).fillColor('#94a3b8')
      .text(`Generado el ${generado} · Página ${pagina}`, izq, doc.page.height - margen + 8, { width: ancho, align: 'right', lineBreak: false });
    doc.page.margins.bottom = margen;
  };
  const celdas = (f, y, fuente, color, crudo = false) => {
    let x = izq;
    doc.font(fuente).fontSize(7.5).fillColor(color);
    meta.columnas.forEach((c, i) => {
      doc.text(crudo ? String(f[c.clave] ?? '') : texto(valor(f, c.clave), c.tipo), x + 3, y + 4, { width: anchos[i] - 6, height: 9, align: esNumerico(c.tipo) ? 'right' : 'left', lineBreak: false, ellipsis: true });
      x += anchos[i];
    });
  };
  const cabecera = () => {
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#0f172a').text(meta.titulo, izq, doc.page.margins.top);
    doc.font('Helvetica').fontSize(8).fillColor('#64748b');
    for (const l of meta.subtitulo ?? []) doc.text(l);
    doc.moveDown(0.5);
    const y = doc.y;
    doc.rect(izq, y, ancho, ALTO).fill('#0f766e');
    // Encabezados: texto tal cual (sin formato numérico)
    celdas(Object.fromEntries(meta.columnas.map((c) => [c.clave, c.titulo])), y, 'Helvetica-Bold', '#ffffff', true);
    doc.y = y + ALTO;
  };
  const fila = (f, negrita = false) => {
    if (doc.y + ALTO > doc.page.height - doc.page.margins.bottom - 20) {
      pie();
      doc.addPage();
      pagina += 1;
      cabecera();
    }
    const y = doc.y;
    if (!negrita && filaN++ % 2) doc.rect(izq, y, ancho, ALTO).fill('#f8fafc');
    celdas(f, y, negrita ? 'Helvetica-Bold' : 'Helvetica', '#1e293b');
    doc.y = y + ALTO;
  };

  cabecera();
  return {
    agregar: (lote) => lote.forEach((f) => fila(f)),
    async cerrar(totales) {
      if (!filaN) doc.font('Helvetica-Oblique').fontSize(9).fillColor('#64748b').text('Sin datos para los filtros seleccionados.', izq, doc.y + 6);
      if (totales) {
        doc.moveTo(izq, doc.y).lineTo(izq + ancho, doc.y).strokeColor('#94a3b8').stroke();
        fila(totales, true);
      }
      pie();
      doc.end();
      await new Promise((ok, mal) => salida.on('finish', ok).on('error', mal));
    },
  };
}
