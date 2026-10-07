import crypto from 'node:crypto';
import { cadenaQr } from '../documento.js';

/**
 * Proveedor SIMULADO: responde como lo haría SUNAT, sin conexión real. Sirve para
 * capacitar, hacer demostraciones y probar el flujo completo sin una cuenta de proveedor.
 * - Facturas y notas de crédito: aceptadas al instante.
 * - Boletas: quedan "enviadas" (como en el resumen diario) y se aceptan al consultar.
 * - Si el nombre del cliente contiene "RECHAZO", SUNAT rechaza (para probar ese caso).
 */
const hashDe = (doc) => crypto.createHash('sha1').update(`${doc.emisor.ruc}${doc.serie}${doc.numero}${doc.totales.total}`).digest('base64');

export const simulado = {
  nombre: 'Simulado (pruebas)',
  async probar() {
    return { ok: true, mensaje: 'Modo simulado: no se envía nada a SUNAT' };
  },
  async enviar(_config, doc) {
    const hash = hashDe(doc);
    const base = { hash, qr: cadenaQr(doc, hash), pdf: null, xml: null, cdr: null };
    if (/RECHAZO/i.test(doc.cliente.nombre)) {
      return { ...base, estado: 'RECHAZADO', codigo: '2017', descripcion: 'El número de documento de identidad del receptor no existe (SIMULADO)' };
    }
    if (doc.tipo === 'BOLETA') return { ...base, estado: 'ENVIADO', codigo: null, descripcion: 'Boleta incluida en el resumen diario; SUNAT aún no responde (SIMULADO)' };
    return { ...base, estado: 'ACEPTADO', codigo: '0', descripcion: `El comprobante ${doc.serie}-${doc.numero} ha sido aceptado (SIMULADO)` };
  },
  async consultar(_config, doc) {
    const hash = hashDe(doc);
    return { estado: 'ACEPTADO', codigo: '0', descripcion: `El comprobante ${doc.serie}-${doc.numero} ha sido aceptado (SIMULADO)`, hash, qr: cadenaQr(doc, hash) };
  },
  async anular(_config, doc, motivo) {
    return { estado: 'ACEPTADA', ticket: `SIM-${Date.now()}`, mensaje: `Comunicación de baja aceptada: ${motivo} (SIMULADO)` };
  },
  // Guías: SUNAT las procesa de forma asíncrona (ticket) → primero "enviada", luego aceptada
  async enviarGuia(_config, g) {
    return { estado: 'ENVIADO', codigo: null, descripcion: `Guía ${g.serie}-${g.numero} recibida; SUNAT la está procesando (SIMULADO)` };
  },
  async consultarGuia(_config, g) {
    const hash = crypto.createHash('sha1').update(`${g.emisor.ruc}09${g.serie}${g.numero}`).digest('base64');
    return {
      estado: 'ACEPTADO', codigo: '0', descripcion: `La guía ${g.serie}-${g.numero} ha sido aceptada (SIMULADO)`, hash,
      qr: `${g.emisor.ruc}|09|${g.serie}|${String(g.numero).padStart(8, '0')}|${g.fecha}|${hash}|`,
    };
  },
  async consultarBaja() {
    return { estado: 'ACEPTADA', ticket: null, mensaje: 'Comunicación de baja aceptada (SIMULADO)' };
  },
};
