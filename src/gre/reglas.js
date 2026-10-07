import { errorDocumento, hoyLima, rucValido } from '../pos/reglas.js';

/**
 * Reglas de la guía de remisión electrónica remitente (puras, sin BD).
 * Catálogo 20 de SUNAT (motivos de traslado): los de uso habitual.
 */
export const MOTIVOS_TRASLADO = {
  '01': 'Venta',
  '02': 'Compra',
  '04': 'Traslado entre establecimientos de la misma empresa',
  '08': 'Importación',
  '09': 'Exportación',
  '13': 'Otros',
  '14': 'Venta sujeta a confirmación del comprador',
  '17': 'Traslado de bienes para transformación',
  '18': 'Traslado emisor itinerante de comprobantes de pago',
  '19': 'Traslado a zona primaria',
};
export const CODIGO_DOC_RELACIONADO = { FACTURA: '01', BOLETA: '03' };

const PLACA = /^[A-Z0-9]{5,8}$/;
const LICENCIA = /^[A-Z0-9]{9,10}$/;

/**
 * Valida una guía antes de emitirla. Devuelve la lista de errores (vacía = válida).
 * empresaRuc: RUC del remitente (para el traslado entre establecimientos).
 */
export function erroresGuia(g, { empresaRuc }) {
  const e = [];
  if (!MOTIVOS_TRASLADO[g.motivo]) e.push('Motivo de traslado no válido');
  if (g.motivo === '13' && !g.motivoDescripcion?.trim()) e.push('Describa el motivo del traslado ("Otros")');
  const errDest = errorDocumento(g.destinatarioTipoDoc, g.destinatarioNumDoc);
  if (errDest) e.push(`Destinatario: ${errDest}`);
  if (['01', '02', '04'].includes(g.motivo) && g.destinatarioTipoDoc === 'SIN_DOCUMENTO') e.push('Indique el documento del destinatario');
  if (g.motivo === '04') {
    if (g.destinatarioNumDoc !== empresaRuc) e.push('En un traslado entre establecimientos el destinatario es la misma empresa (su RUC)');
    if (g.partidaUbigeo === g.llegadaUbigeo && g.partidaDireccion?.trim().toUpperCase() === g.llegadaDireccion?.trim().toUpperCase()) {
      e.push('El punto de partida y el de llegada no pueden ser la misma dirección');
    }
  }
  for (const [campo, nombre] of [['partidaUbigeo', 'partida'], ['llegadaUbigeo', 'llegada']]) {
    if (!/^\d{6}$/.test(g[campo] ?? '')) e.push(`Ubigeo de ${nombre}: 6 dígitos (p. ej. 150101 = Lima)`);
  }
  if (!g.partidaDireccion?.trim()) e.push('Indique la dirección del punto de partida');
  if (!g.llegadaDireccion?.trim()) e.push('Indique la dirección del punto de llegada');
  if (!(Number(g.pesoBruto) > 0)) e.push('El peso bruto total debe ser mayor que cero');
  if (g.fechaTraslado && String(g.fechaTraslado).slice(0, 10) < hoyLima()) e.push('La fecha de inicio del traslado no puede ser anterior a hoy');
  if (g.modalidad === 'PUBLICO') {
    if (!rucValido(g.transportistaRuc ?? '')) e.push('RUC del transportista inválido');
    if (!g.transportistaNombre?.trim()) e.push('Indique la razón social del transportista');
    if (g.transportistaRuc && g.transportistaRuc === empresaRuc) e.push('En transporte público el transportista no puede ser la misma empresa: use transporte privado');
  } else if (g.modalidad === 'PRIVADO') {
    const errCond = errorDocumento(g.conductorTipoDoc ?? 'DNI', g.conductorNumDoc);
    if (errCond) e.push(`Conductor: ${errCond}`);
    if (!g.conductorNombres?.trim() || !g.conductorApellidos?.trim()) e.push('Indique nombres y apellidos del conductor');
    if (!LICENCIA.test((g.conductorLicencia ?? '').toUpperCase())) e.push('Licencia de conducir: 9 o 10 caracteres (p. ej. Q12345678)');
    if (!PLACA.test((g.vehiculoPlaca ?? '').replace(/-/g, '').toUpperCase())) e.push('Placa del vehículo inválida (p. ej. ABC123)');
  } else {
    e.push('Elija la modalidad de transporte');
  }
  if (!g.items?.length) e.push('Agregue al menos un producto');
  return e;
}
