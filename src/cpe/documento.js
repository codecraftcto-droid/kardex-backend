import { Prisma } from '@prisma/client';
import { hoyLima } from '../pos/reglas.js';

/**
 * Documento NEUTRO a partir de un comprobante: lo que cualquier proveedor necesita para
 * generar el XML UBL 2.1 y enviarlo a SUNAT. Cada conector lo traduce a su formato.
 *
 * Los descuentos (por línea o globales) ya están dentro de cada línea: se envían como precio
 * neto (valor y precio unitario efectivos), así los totales cuadran al céntimo con lo impreso.
 */
const D = (v) => new Prisma.Decimal(v ?? 0);
const TIPO_REF = { FACTURA: 'FACTURA', BOLETA: 'BOLETA' };

export class ErrorTransitorio extends Error {} // red, caída del proveedor: se reintenta
export class ErrorDocumento extends Error {} // datos inválidos: no sirve reintentar sin corregir

export function documentoNeutro(c, empresa) {
  return {
    emisor: { ruc: empresa.ruc, razonSocial: empresa.razonSocial },
    tipo: c.tipo, // FACTURA | BOLETA | NOTA_CREDITO
    serie: c.serie,
    numero: c.numero,
    fecha: hoyLima(c.fechaEmision), // AAAA-MM-DD en hora de Perú
    moneda: c.moneda,
    cliente: {
      tipoDocumento: c.clienteTipoDocumento, // DNI | RUC | CARNE_EXTRANJERIA | PASAPORTE | SIN_DOCUMENTO
      numeroDocumento: c.clienteNumeroDocumento,
      nombre: c.clienteNombre,
      direccion: c.clienteDireccion,
    },
    totales: {
      gravada: D(c.opGravada), exonerada: D(c.opExonerada), inafecta: D(c.opInafecta),
      igv: D(c.igv), total: D(c.total), descuentos: D(c.descuentoTotal),
    },
    items: c.detalles.map((d) => {
      const cantidad = D(d.cantidad);
      return {
        codigo: d.producto?.sku ?? '',
        descripcion: d.descripcion,
        unidad: d.unidadCodigo || 'NIU',
        cantidad,
        valorUnitario: D(d.valorVenta).div(cantidad).toDecimalPlaces(10), // sin IGV, neto de descuentos
        precioUnitario: D(d.total).div(cantidad).toDecimalPlaces(10), // con IGV, neto de descuentos
        valorVenta: D(d.valorVenta),
        igv: D(d.igv),
        total: D(d.total),
        afectacion: d.afectacionIgv, // 10 gravado | 20 exonerado | 30 inafecto
      };
    }),
    formaPago: c.formaPago,
    /** SPOT: el cliente deposita la detracción en la cuenta del Banco de la Nación del emisor */
    detraccion: Number(c.detraccionMonto) > 0
      ? { codigo: c.detraccionCodigo, porcentaje: D(c.detraccionPorcentaje), monto: D(c.detraccionMonto), cuenta: empresa.cuentaDetracciones ?? null }
      : null,
    retencion: Number(c.retencionMonto) > 0 ? { porcentaje: D(3), monto: D(c.retencionMonto), base: D(c.total) } : null,
    montoCredito: D(c.montoCredito),
    cuotas: (c.cuotas ?? []).map((q) => ({ numero: q.numero, monto: D(q.monto), fecha: q.fechaVencimiento.toISOString().slice(0, 10) })),
    referencia: c.referencia ? { tipo: TIPO_REF[c.referencia.tipo], serie: c.referencia.serie, numero: c.referencia.numero } : null,
    motivoNotaCredito: c.motivoCodigo ? { codigo: c.motivoCodigo, descripcion: c.motivoDescripcion } : null,
  };
}

/** Texto del QR según SUNAT: RUC|TIPO|SERIE|NUMERO|IGV|TOTAL|FECHA|TIPO DOC|NUM DOC|HASH| */
export function cadenaQr(doc, hash = '') {
  const tipo = { FACTURA: '01', BOLETA: '03', NOTA_CREDITO: '07' }[doc.tipo];
  const docCli = { SIN_DOCUMENTO: '0', DNI: '1', CARNE_EXTRANJERIA: '4', RUC: '6', PASAPORTE: '7' }[doc.cliente.tipoDocumento];
  return [doc.emisor.ruc, tipo, doc.serie, String(doc.numero).padStart(8, '0'), doc.totales.igv.toFixed(2), doc.totales.total.toFixed(2), doc.fecha, docCli,
    doc.cliente.numeroDocumento === '-' ? '' : doc.cliente.numeroDocumento, hash].join('|') + '|';
}
