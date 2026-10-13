/**
 * XML firmado y CDR de los envíos directos a SUNAT. Se guardan en la base (constancia ante una
 * fiscalización) y el comprobante apunta a ellos con "archivo:<id>"; los proveedores externos
 * (Nubefact) siguen guardando enlaces https a sus propios archivos.
 */
export const PREFIJO = 'archivo:';

/** Guarda los archivos devueltos por el conector y devuelve { XML, CDR, … } → "archivo:<id>" */
export async function guardarArchivos(tx, { tenantId, empresaId, comprobanteId = null, guiaId = null, archivos = [] }) {
  const enlaces = {};
  for (const a of archivos) {
    const fila = await tx.archivoSunat.create({
      data: { tenantId, empresaId, comprobanteId, guiaId, tipo: a.tipo, nombre: a.nombre, contenido: Buffer.from(a.base64, 'base64') },
      select: { id: true },
    });
    enlaces[a.tipo] = `${PREFIJO}${fila.id}`;
  }
  return enlaces;
}
