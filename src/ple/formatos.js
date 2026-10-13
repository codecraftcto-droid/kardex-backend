/**
 * Libros electrónicos PLE (Fase 4A): estructura de los TXT y nombre de archivo de SUNAT.
 * Cada fila es una línea con los campos separados por "|" y terminada en "|".
 * VERIFICAR con el validador PLE de SUNAT antes de presentar (posiciones de campos opcionales).
 *
 * Nombre: LE + RUC + AAAA + MM + 00 + libro (6) + 00 (oportunidad) + operaciones (1: empresa operativa)
 *         + contenido (1 con información / 0 sin información) + moneda (1: soles) + 1 (generado por el PLE) + .txt
 */
export const LIBROS = {
  '050100': { codigo: '5.1', nombre: 'Libro Diario' },
  '050300': { codigo: '5.3', nombre: 'Libro Diario — detalle del plan contable utilizado' },
  '060100': { codigo: '6.1', nombre: 'Libro Mayor' },
  '130100': { codigo: '13.1', nombre: 'Registro de Inventario Permanente Valorizado — detalle' },
};

/** Orden de presentación (las claves numéricas de un objeto no conservan el orden) */
export const ORDEN_LIBROS = ['050100', '050300', '060100', '130100'];

export const nombreArchivo = ({ ruc, periodo, libro, conInformacion }) =>
  `LE${ruc}${periodo}00${libro}001${conInformacion ? 1 : 0}11.txt`;

/** Texto sin "|" ni saltos de línea (romperían la estructura), recortado al largo máximo */
const t = (v, max = 200) => String(v ?? '').replace(/[|\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const m2 = (v) => (Math.round(Number(v ?? 0) * 100) / 100).toFixed(2);
/** Cantidades y costos unitarios: hasta 8 decimales, sin ceros de más */
const m8 = (v) => {
  const [entero, decimales = ''] = Number(v ?? 0).toFixed(8).replace(/0+$/, '').split('.');
  return `${entero}.${decimales.padEnd(2, '0')}`;
};
const fecha = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');
const linea = (campos) => `${campos.join('|')}|`;

/**
 * 5.1 Libro Diario (y 6.1 Libro Mayor, misma estructura). Una línea por cada línea de asiento:
 *  1 período AAAAMM00 · 2 CUO · 3 correlativo (A apertura, M movimiento, C cierre + número) · 4 cuenta ·
 *  5 unidad de operación · 6 centro de costos · 7 moneda · 8 tipo doc. del tercero · 9 número doc. ·
 * 10 tipo de comprobante · 11 serie · 12 número · 13 fecha contable · 14 fecha de vencimiento ·
 * 15 fecha de operación · 16 glosa · 17 glosa referencial · 18 debe · 19 haber · 20 dato estructurado ·
 * 21 estado de la operación (1 = del período)
 */
export function lineasDiario(periodo, asientos) {
  const lineas = [];
  for (const a of asientos) {
    const tipo = a.origen === 'CIERRE' ? 'C' : /^Asiento de apertura/i.test(a.glosa) ? 'A' : 'M';
    const cuo = `${periodo.slice(4)}-${String(a.numero).padStart(4, '0')}`;
    for (const l of a.lineas) {
      lineas.push(linea([
        `${periodo}00`, cuo, `${tipo}${l.orden}`, l.cuenta, '', '', 'PEN',
        l.terceroDoc ? (l.terceroTipo ?? '0') : '', t(l.terceroDoc, 15), l.docSerie ? (l.docTipo ?? '00') : '', t(l.docSerie, 20), t(l.docNumero, 20),
        fecha(a.fecha), '', fecha(a.fecha), t(l.glosa || a.glosa), '', m2(l.debe), m2(l.haber), '', '1',
      ]));
    }
  }
  return lineas;
}

/** 5.3 Plan contable utilizado: 1 período AAAAMMDD · 2 cuenta · 3 descripción · 4 plan (01 = PCGE) · 5 descripción del plan · 6–7 cuenta corporativa · 8 estado */
export const lineasPlan = (periodo, cuentas) =>
  cuentas.map((c) => linea([`${periodo}01`, c.codigo, t(c.nombre, 100), '01', '', '', '', c.activo ? '1' : '8']));

/** Tabla 12 de SUNAT: tipo de operación del movimiento de inventario */
export const TIPO_OPERACION = {
  VENTA: '01', COMPRA: '02', DEVOLUCION_CLIENTE: '05', TRANSFERENCIA_SALIDA: '11', TRANSFERENCIA_ENTRADA: '11',
  MERMA: '13', SALDO_INICIAL: '16', AJUSTE_POSITIVO: '28', AJUSTE_NEGATIVO: '28', ANULACION: '99',
};
/** Tabla 14: método de valuación (1 promedio ponderado, 2 PEPS) */
const METODO = { PROMEDIO: '1', PEPS: '2' };

/**
 * 13.1 Inventario permanente valorizado — una línea por producto movido:
 *  1 período · 2 CUO · 3 correlativo · 4 establecimiento · 5 catálogo (9 otros) · 6 tipo de existencia (01 mercaderías) ·
 *  7 código propio · 8 catálogo (vacío) · 9 código según catálogo · 10 fecha · 11 tipo doc. · 12 serie · 13 número ·
 * 14 tipo de operación (tabla 12) · 15 descripción · 16 unidad (tabla 6) · 17 método (tabla 14) ·
 * 18–20 entradas (cantidad, costo unitario, total) · 21–23 salidas · 24–26 saldo final · 27 estado
 */
export function lineasInventario(periodo, movimientos) {
  const lineas = [];
  for (const m of movimientos) {
    m.detalles.forEach((d, i) => {
      const entrada = m.tipo === 'ENTRADA';
      lineas.push(linea([
        `${periodo}00`, m.numero, `M${i + 1}`, m.establecimiento ?? '0000', '9', '01', t(d.sku, 24), '', '',
        fecha(m.fecha), m.documento?.tipo ?? '00', t(m.documento?.serie ?? '0', 20), t(m.documento?.numero ?? m.numero, 20),
        TIPO_OPERACION[m.motivo] ?? '99', t(d.nombre, 80), d.unidad, METODO[m.metodoValorizacion] ?? '1',
        entrada ? m8(d.cantidad) : '0.00', entrada ? m8(d.costoUnitario) : '0.00', entrada ? m2(d.costoTotal) : '0.00',
        entrada ? '0.00' : m8(d.cantidad), entrada ? '0.00' : m8(d.costoUnitario), entrada ? '0.00' : m2(d.costoTotal),
        m8(d.saldoCantidad), m8(d.saldoCostoUnitario), m2(d.saldoValor), '1',
      ]));
    });
  }
  return lineas;
}
