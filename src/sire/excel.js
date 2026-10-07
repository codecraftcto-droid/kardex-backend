import ExcelJS from 'exceljs';

/** Excel del panel SIRE: una fila por empresa y período, y una hoja con las alertas. */
const ESTADO = { PENDIENTE: 'Pendiente', PROPUESTA: 'Propuesta descargada', CON_DIFERENCIAS: 'Con diferencias', CONCILIADO: 'Conciliado', GENERADO: 'Generado' };
const COLOR = { GENERADO: 'FFD1FAE5', CON_DIFERENCIAS: 'FFFEF3C7', CONCILIADO: 'FFE0E7FF' };
const ALERTA = { VENCIDO: 'Vencido', POR_VENCER: 'Por vencer', DIFERENCIAS: 'Con diferencias', CONEXION: 'Conexión' };

function encabezado(hoja) {
  const fila = hoja.getRow(1);
  fila.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  fila.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F766E' } };
  fila.alignment = { vertical: 'middle' };
  fila.height = 20;
  hoja.views = [{ state: 'frozen', ySplit: 1 }];
  hoja.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: hoja.columnCount } };
}

const fecha = (iso) => (iso ? new Date(`${iso}T12:00:00Z`) : null);

export async function excelPanel(panel, { estudio }) {
  const libro = new ExcelJS.Workbook();
  libro.creator = 'Kardex';
  libro.created = new Date();

  const hoja = libro.addWorksheet('Períodos');
  hoja.columns = [
    { header: 'Empresa', key: 'empresa', width: 38 },
    { header: 'RUC', key: 'ruc', width: 14 },
    { header: 'Período', key: 'periodo', width: 16 },
    { header: 'Vencimiento', key: 'vencimiento', width: 13, style: { numFmt: 'dd/mm/yyyy' } },
    { header: 'Días', key: 'dias', width: 8 },
    { header: 'Ventas (RVIE)', key: 'rvie', width: 22 },
    { header: 'Compras (RCE)', key: 'rce', width: 22 },
    { header: 'Conexión SIRE', key: 'conexion', width: 16 },
  ];
  const etiqueta = new Map(panel.periodos.map((p) => [p.periodo, p.etiqueta]));
  for (const e of panel.empresas) {
    for (const p of e.periodos) {
      const fila = hoja.addRow({
        empresa: e.razonSocial, ruc: e.ruc, periodo: etiqueta.get(p.periodo), vencimiento: fecha(p.vencimiento),
        dias: p.RVIE === 'GENERADO' && p.RCE === 'GENERADO' ? null : p.diasParaVencer,
        rvie: ESTADO[p.RVIE], rce: ESTADO[p.RCE],
        conexion: !e.config ? 'Sin configurar' : !e.config.activo ? 'Desactivado' : e.config.modo === 'SIMULADO' ? 'Simulado' : 'SUNAT',
      });
      for (const [col, estado] of [[6, p.RVIE], [7, p.RCE]]) {
        if (COLOR[estado]) fila.getCell(col).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR[estado] } };
      }
      if (p.diasParaVencer != null && p.diasParaVencer < 0 && !p.enCurso && (p.RVIE !== 'GENERADO' || p.RCE !== 'GENERADO')) fila.getCell(5).font = { bold: true, color: { argb: 'FFB91C1C' } };
    }
  }
  encabezado(hoja);

  const hojaA = libro.addWorksheet('Alertas');
  hojaA.columns = [
    { header: 'Tipo', key: 'tipo', width: 16 },
    { header: 'Empresa', key: 'empresa', width: 38 },
    { header: 'Registro', key: 'registro', width: 10 },
    { header: 'Período', key: 'periodo', width: 16 },
    { header: 'Vencimiento', key: 'vencimiento', width: 13, style: { numFmt: 'dd/mm/yyyy' } },
    { header: 'Detalle', key: 'texto', width: 60 },
  ];
  for (const a of panel.alertas) {
    hojaA.addRow({ tipo: ALERTA[a.tipo], empresa: a.empresa, registro: a.registro ?? '', periodo: a.etiqueta ?? '', vencimiento: fecha(a.vencimiento), texto: a.texto });
  }
  encabezado(hojaA);

  libro.title = `Panel SIRE · ${estudio}`;
  return libro.xlsx.writeBuffer();
}
