import { fechaLima, rangoLima } from '../sire/periodos.js';
import { TIPO_CP } from '../sire/conciliacion.js';
import { LIBROS, lineasDiario, lineasInventario, lineasPlan, nombreArchivo } from './formatos.js';

/**
 * Generación de los libros PLE de una empresa y un período (Fase 4A).
 * Los libros contables (5.1, 5.3, 6.1) salen de la contabilidad; el 13.1, del kardex.
 */
export const PERMISO_LIBRO = {
  '050100': 'contabilidad.asiento.ver', '050300': 'contabilidad.plan.ver', '060100': 'contabilidad.asiento.ver', '130100': 'kardex.costos.ver',
};
const CODIGO_DOC = { FACTURA: '01', BOLETA: '03', NOTA_CREDITO: '07', 'GUÍA DE REMISIÓN': '09' };

async function asientos(tx, empresaId, periodo) {
  const lista = await tx.asiento.findMany({ where: { empresaId, periodo }, orderBy: { numero: 'asc' }, include: { lineas: { orderBy: { orden: 'asc' } } } });
  return lista.map((a) => ({ ...a, fecha: a.fecha.toISOString().slice(0, 10) }));
}

async function movimientosInventario(tx, empresaId, periodo) {
  const movs = await tx.movimiento.findMany({
    where: { empresaId, fecha: rangoLima(periodo) },
    orderBy: [{ fecha: 'asc' }, { numero: 'asc' }],
    include: {
      almacen: { select: { sede: { select: { codigoEstablecimiento: true } } } },
      comprobante: { select: { tipo: true, serie: true, numero: true } },
      documentoComercial: { select: { comprobanteTipo: true, serie: true, numero: true } },
      detalles: { orderBy: { id: 'asc' }, include: { producto: { select: { sku: true, nombre: true, unidad: { select: { codigo: true } } } } } },
    },
  });
  return movs.map((m) => ({
    numero: m.numero, tipo: m.tipo, motivo: m.motivo, metodoValorizacion: m.metodoValorizacion, fecha: fechaLima(m.fecha),
    establecimiento: m.almacen.sede.codigoEstablecimiento,
    // El comprobante que sustenta el movimiento: el de la venta, el de la compra o el que se anotó a mano
    documento: m.comprobante ? { tipo: TIPO_CP[m.comprobante.tipo] ?? '00', serie: m.comprobante.serie, numero: String(m.comprobante.numero) }
      : m.documentoComercial ? { tipo: CODIGO_DOC[m.documentoComercial.comprobanteTipo] ?? '00', serie: m.documentoComercial.serie, numero: m.documentoComercial.numero }
        : m.documentoSerie ? { tipo: CODIGO_DOC[m.documentoTipo] ?? '00', serie: m.documentoSerie, numero: m.documentoNumero } : null,
    detalles: m.detalles.map((d) => ({
      sku: d.producto.sku, nombre: d.producto.nombre, unidad: d.producto.unidad.codigo,
      cantidad: d.cantidad, costoUnitario: d.costoUnitario, costoTotal: d.costoTotal, saldoCantidad: d.saldoCantidad, saldoCostoUnitario: d.saldoCostoUnitario, saldoValor: d.saldoValor,
    })),
  }));
}

/** Genera un libro: { libro, nombre, nombreArchivo, lineas, conInformacion, avisos } */
export async function generarLibro(tx, { empresa, periodo, libro }) {
  const avisos = [];
  let lineas = [];
  if (libro === '050100' || libro === '060100') {
    const lista = await asientos(tx, empresa.id, periodo);
    if (libro === '050100') lineas = lineasDiario(periodo, lista);
    else {
      // Mayor: las mismas líneas, agrupadas por cuenta
      const porCuenta = lista.flatMap((a) => a.lineas.map((l) => ({ a, l }))).sort((x, y) => x.l.cuenta.localeCompare(y.l.cuenta) || x.a.numero - y.a.numero || x.l.orden - y.l.orden);
      lineas = porCuenta.map(({ a, l }) => lineasDiario(periodo, [{ ...a, lineas: [l] }])[0]);
    }
    const cerrado = await tx.periodoContable.findUnique({ where: { empresaId_periodo: { empresaId: empresa.id, periodo } } });
    if (!cerrado?.cerrado) avisos.push('El período contable no está cerrado: el libro puede cambiar si se registran o regeneran asientos.');
    if (!lista.length) avisos.push('No hay asientos en el período: el libro se genera "sin información".');
  } else if (libro === '050300') {
    const cuentas = await tx.cuentaContable.findMany({ where: { empresaId: empresa.id }, orderBy: { codigo: 'asc' } });
    lineas = lineasPlan(periodo, cuentas);
    if (!cuentas.length) avisos.push('La empresa no tiene plan contable.');
  } else if (libro === '130100') {
    const movs = await movimientosInventario(tx, empresa.id, periodo);
    lineas = lineasInventario(periodo, movs);
    const sinEstablecimiento = movs.filter((m) => !m.establecimiento).length;
    if (sinEstablecimiento) avisos.push(`${sinEstablecimiento} movimiento(s) de almacenes cuya sede no tiene código de establecimiento SUNAT (se usa 0000).`);
    const sinDocumento = movs.filter((m) => !m.documento && !['SALDO_INICIAL', 'TRANSFERENCIA_SALIDA', 'TRANSFERENCIA_ENTRADA'].includes(m.motivo)).length;
    if (sinDocumento) avisos.push(`${sinDocumento} movimiento(s) sin comprobante que lo sustente: se informan con el número del kardex.`);
  } else {
    throw new Error(`Libro ${libro} no soportado`);
  }
  return {
    libro, ...LIBROS[libro], lineas, conInformacion: lineas.length > 0, avisos,
    nombreArchivo: nombreArchivo({ ruc: empresa.ruc, periodo, libro, conInformacion: lineas.length > 0 }),
  };
}
