import ExcelJS from 'exceljs';

/** Libros Diario y Mayor en Excel (formato de trabajo; el PLE oficial llega en la fase 4). */
const MONEDA = '#,##0.00;-#,##0.00;""';

function encabezado(hoja, titulo, subtitulo, columnas) {
  hoja.mergeCells(1, 1, 1, columnas.length);
  hoja.getCell(1, 1).value = titulo;
  hoja.getCell(1, 1).font = { bold: true, size: 14 };
  hoja.mergeCells(2, 1, 2, columnas.length);
  hoja.getCell(2, 1).value = subtitulo;
  hoja.getCell(2, 1).font = { color: { argb: 'FF475569' } };
  const fila = hoja.getRow(4);
  columnas.forEach((c, i) => {
    hoja.getColumn(i + 1).width = c.ancho;
    if (c.moneda) hoja.getColumn(i + 1).numFmt = MONEDA;
    fila.getCell(i + 1).value = c.titulo;
  });
  fila.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  fila.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F766E' } };
  hoja.views = [{ state: 'frozen', ySplit: 4 }];
}
const filaTotal = (hoja, valores) => {
  const f = hoja.addRow(valores);
  f.font = { bold: true };
  f.border = { top: { style: 'thin' } };
};

export async function excelDiario({ empresa, etiqueta, asientos, totales }) {
  const libro = new ExcelJS.Workbook();
  const hoja = libro.addWorksheet('Libro Diario');
  encabezado(hoja, 'LIBRO DIARIO', `${empresa.razonSocial} · RUC ${empresa.ruc} · ${etiqueta} · Expresado en soles`, [
    { titulo: 'Asiento', ancho: 10 }, { titulo: 'Fecha', ancho: 12 }, { titulo: 'Glosa', ancho: 48 }, { titulo: 'Cuenta', ancho: 10 },
    { titulo: 'Denominación', ancho: 36 }, { titulo: 'Debe', ancho: 14, moneda: true }, { titulo: 'Haber', ancho: 14, moneda: true },
  ]);
  for (const a of asientos) {
    a.lineas.forEach((l, i) => {
      hoja.addRow([i === 0 ? a.numero : null, i === 0 ? new Date(`${a.fecha}T12:00:00Z`) : null, i === 0 ? a.glosa : l.glosa ?? null, l.cuenta, l.cuentaNombre, l.debe || null, l.haber || null]);
    });
    hoja.lastRow.border = { bottom: { style: 'hair', color: { argb: 'FFCBD5E1' } } };
  }
  hoja.getColumn(2).numFmt = 'dd/mm/yyyy';
  filaTotal(hoja, [null, null, 'TOTALES', null, null, totales.debe, totales.haber]);
  return libro.xlsx.writeBuffer();
}

export async function excelMayor({ empresa, etiqueta, resumen, detalles }) {
  const libro = new ExcelJS.Workbook();
  const hoja = libro.addWorksheet('Resumen');
  encabezado(hoja, 'LIBRO MAYOR — RESUMEN POR CUENTA', `${empresa.razonSocial} · RUC ${empresa.ruc} · ${etiqueta} · Expresado en soles`, [
    { titulo: 'Cuenta', ancho: 10 }, { titulo: 'Denominación', ancho: 42 }, { titulo: 'Saldo anterior', ancho: 16, moneda: true },
    { titulo: 'Debe', ancho: 14, moneda: true }, { titulo: 'Haber', ancho: 14, moneda: true }, { titulo: 'Saldo final', ancho: 16, moneda: true },
  ]);
  for (const c of resumen.cuentas) hoja.addRow([c.cuenta, c.nombre, c.anterior, c.debe, c.haber, c.saldo]);
  filaTotal(hoja, [null, 'TOTALES', resumen.totales.anterior, resumen.totales.debe, resumen.totales.haber, resumen.totales.saldo]);

  // Una hoja con el detalle de todas las cuentas, una tras otra
  const det = libro.addWorksheet('Detalle');
  encabezado(det, 'LIBRO MAYOR — DETALLE', `${empresa.razonSocial} · ${etiqueta}`, [
    { titulo: 'Fecha', ancho: 12 }, { titulo: 'Asiento', ancho: 10 }, { titulo: 'Glosa', ancho: 48 }, { titulo: 'Documento', ancho: 16 },
    { titulo: 'Debe', ancho: 14, moneda: true }, { titulo: 'Haber', ancho: 14, moneda: true }, { titulo: 'Saldo', ancho: 16, moneda: true },
  ]);
  det.getColumn(1).numFmt = 'dd/mm/yyyy';
  for (const d of detalles) {
    const t = det.addRow([`${d.cuenta.codigo} ${d.cuenta.nombre ?? ''}`]);
    t.font = { bold: true };
    t.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
    det.addRow([null, null, 'Saldo anterior', null, null, null, d.anterior]);
    for (const m of d.movimientos) det.addRow([new Date(`${m.fecha}T12:00:00Z`), m.numero, m.glosa, m.documento, m.debe || null, m.haber || null, m.saldo]);
    filaTotal(det, [null, null, 'Total de la cuenta', null, d.totales.debe, d.totales.haber, d.totales.saldo]);
    det.addRow([]);
  }
  return libro.xlsx.writeBuffer();
}

/** Estados financieros: situación financiera, resultados (naturaleza y función) y hoja de trabajo */
export async function excelEstados({ empresa, etiqueta, situacion, resultados, hoja }) {
  const libro = new ExcelJS.Workbook();
  const sub = `${empresa.razonSocial} · RUC ${empresa.ruc} · ${etiqueta} · Expresado en soles`;

  const esf = libro.addWorksheet('Situación financiera');
  encabezado(esf, 'ESTADO DE SITUACIÓN FINANCIERA', sub, [{ titulo: 'Rubro', ancho: 52 }, { titulo: 'Importe', ancho: 18, moneda: true }]);
  const bloque = (titulo, partidas, total) => {
    esf.addRow([titulo]).font = { bold: true };
    for (const p of partidas) esf.addRow([`   ${p.texto}`, p.importe]);
    filaTotal(esf, [`Total ${titulo.toLowerCase()}`, total]);
    esf.addRow([]);
  };
  bloque('Activo corriente', situacion.activoCorriente, situacion.totales.activoCorriente);
  bloque('Activo no corriente', situacion.activoNoCorriente, situacion.totales.activoNoCorriente);
  filaTotal(esf, ['TOTAL ACTIVO', situacion.totales.activo]);
  esf.addRow([]);
  bloque('Pasivo corriente', situacion.pasivoCorriente, situacion.totales.pasivoCorriente);
  bloque('Pasivo no corriente', situacion.pasivoNoCorriente, situacion.totales.pasivoNoCorriente);
  bloque('Patrimonio', situacion.patrimonio, situacion.totales.patrimonio);
  filaTotal(esf, ['TOTAL PASIVO Y PATRIMONIO', situacion.totales.pasivoPatrimonio]);

  for (const [nombre, clave] of [['Resultados por función', 'funcion'], ['Resultados por naturaleza', 'naturaleza']]) {
    const h = libro.addWorksheet(nombre);
    encabezado(h, `ESTADO DE RESULTADOS ${clave === 'funcion' ? 'POR FUNCIÓN' : 'POR NATURALEZA'}`, sub, [
      { titulo: 'Concepto', ancho: 48 }, { titulo: 'Del mes', ancho: 16, moneda: true }, { titulo: 'Acumulado del año', ancho: 18, moneda: true },
    ]);
    resultados.acumulado[clave].forEach((l, i) => {
      const f = h.addRow([l.subtotal || l.total ? l.texto : `   ${l.texto}`, resultados.mes[clave][i].importe, l.importe]);
      if (l.subtotal || l.total) f.font = { bold: true };
      if (l.total) f.border = { top: { style: 'thin' }, bottom: { style: 'double' } };
    });
  }

  const hw = libro.addWorksheet('Hoja de trabajo');
  const COLS = [
    ['debe', 'Sumas debe'], ['haber', 'Sumas haber'], ['deudor', 'Saldo deudor'], ['acreedor', 'Saldo acreedor'], ['activo', 'Inventario activo'], ['pasivo', 'Inventario pasivo y patrimonio'],
    ['perdidaNaturaleza', 'Naturaleza pérdidas'], ['gananciaNaturaleza', 'Naturaleza ganancias'], ['perdidaFuncion', 'Función pérdidas'], ['gananciaFuncion', 'Función ganancias'],
  ];
  encabezado(hw, 'HOJA DE TRABAJO (BALANCE DE COMPROBACIÓN)', sub, [{ titulo: 'Cuenta', ancho: 8 }, { titulo: 'Denominación', ancho: 40 }, ...COLS.map(([, t]) => ({ titulo: t, ancho: 15, moneda: true }))]);
  for (const f of hoja.filas) hw.addRow([f.cuenta, f.nombre, ...COLS.map(([k]) => f[k] || null)]);
  filaTotal(hw, [null, 'TOTALES', ...COLS.map(([k]) => hoja.totales[k])]);
  const r = hoja.resultado;
  filaTotal(hw, [null, 'Resultado del ejercicio', null, null, null, null,
    r.inventario < 0 ? -r.inventario : null, r.inventario > 0 ? r.inventario : null,
    r.naturaleza > 0 ? r.naturaleza : null, r.naturaleza < 0 ? -r.naturaleza : null,
    r.funcion > 0 ? r.funcion : null, r.funcion < 0 ? -r.funcion : null]);
  return libro.xlsx.writeBuffer();
}
