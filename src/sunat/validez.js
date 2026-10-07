import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { sha256 } from '../lib/crypto.js';
import { descifrar } from '../services/mfa.js';

/**
 * Consulta integrada de validez de comprobantes de pago (API de SUNAT).
 * Las credenciales (client_id / client_secret) las genera cada empresa en SUNAT Operaciones en
 * Línea → Credenciales de API SUNAT. El token dura 1 hora y se guarda en caché.
 * Referencia: "Manual de Consulta Integrada de Comprobante de Pago por ServicioWeb" (SUNAT).
 */
const URL_TOKEN = (clientId) => `https://api-seguridad.sunat.gob.pe/v1/clientesextranet/${clientId}/oauth2/token/`;
const URL_VALIDAR = (ruc) => `https://api.sunat.gob.pe/v1/contribuyente/contribuyentes/${ruc}/validarcomprobante`;

export const CODIGO_COMPROBANTE_COMPRA = { FACTURA: '01', BOLETA: '03' };
const ESTADO_CP = { 0: 'NO_EXISTE', 1: 'VALIDO', 2: 'ANULADO', 3: 'VALIDO', 4: 'NO_AUTORIZADO' };
export const ESTADO_RUC = {
  '00': 'ACTIVO', '01': 'BAJA PROVISIONAL', '02': 'BAJA PROVISIONAL DE OFICIO', '03': 'SUSPENSIÓN TEMPORAL',
  10: 'BAJA DEFINITIVA', 11: 'BAJA DE OFICIO', 22: 'INHABILITADO - VENTA ÚNICA',
};
export const CONDICION_RUC = { '00': 'HABIDO', '09': 'PENDIENTE', 11: 'POR VERIFICAR', 12: 'NO HABIDO', 20: 'NO HALLADO' };
const MENSAJE = {
  VALIDO: 'El comprobante existe y es válido en SUNAT',
  NO_EXISTE: 'SUNAT no tiene registrado este comprobante: podría ser falso o tener un dato mal digitado',
  ANULADO: 'El comprobante fue dado de baja (anulado) por el emisor',
  NO_AUTORIZADO: 'El emisor no estaba autorizado a emitir este comprobante',
};

/** ¿Se puede validar este documento? (factura o boleta de un proveedor con RUC) */
export const esValidable = (d) => Boolean(CODIGO_COMPROBANTE_COMPRA[d.comprobanteTipo]) && /^\d{11}$/.test(d.terceroDocumento);

async function tokenSunat(clientId, secreto) {
  const clave = `sunat:token:${sha256(clientId)}`;
  const enCache = await redis.get(clave).catch(() => null);
  if (enCache) return enCache;
  const r = await fetch(URL_TOKEN(clientId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials', scope: 'https://api.sunat.gob.pe/v1/contribuyente/contribuyentes',
      client_id: clientId, client_secret: secreto,
    }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(r.status === 401 || r.status === 400 ? 'SUNAT rechazó las credenciales API (client_id / client_secret)' : `SUNAT no entregó el token (${r.status})`);
  await redis.set(clave, j.access_token, 'EX', Math.max(60, (j.expires_in ?? 3600) - 120)).catch(() => {});
  return j.access_token;
}

/**
 * Valida un comprobante de compra. config = ConfigFacturacion de la empresa (o null).
 * Sin credenciales y con el proveedor SIMULADO, responde en modo de prueba (las series que
 * empiezan con "X" se toman como inexistentes, para probar ese caso).
 */
export async function validarComprobante({ config, rucConsultante, documento }) {
  const { comprobanteTipo, terceroDocumento, serie, numero, fechaEmision, total } = documento;
  if (!esValidable(documento)) return { estado: null, mensaje: 'Solo se validan facturas y boletas de proveedores con RUC' };

  if (!config?.sunatClientId) {
    if (config?.proveedor !== 'SIMULADO') throw new Error('Configure las credenciales API de SUNAT de la empresa (Empresas → Facturación electrónica)');
    const estado = /^X/i.test(serie) ? 'NO_EXISTE' : 'VALIDO';
    return { estado, rucEstado: 'ACTIVO', rucCondicion: 'HABIDO', mensaje: `${MENSAJE[estado]} (SIMULADO)` };
  }

  const token = await tokenSunat(config.sunatClientId, descifrar(config.sunatClientSecretCifrado));
  const f = new Date(fechaEmision).toISOString().slice(0, 10).split('-').reverse().join('/');
  const r = await fetch(URL_VALIDAR(rucConsultante), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      numRuc: terceroDocumento, codComp: CODIGO_COMPROBANTE_COMPRA[comprobanteTipo],
      numeroSerie: serie, numero: String(Number(numero)), fechaEmision: f, monto: Number(total).toFixed(2),
    }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.success || !j.data) {
    logger.warn({ status: r.status, j }, 'Consulta de validez SUNAT con error');
    throw new Error(j.message ? `SUNAT: ${j.message}` : `SUNAT no respondió la consulta (${r.status})`);
  }
  const estado = ESTADO_CP[Number(j.data.estadoCp)] ?? 'NO_EXISTE';
  const obs = (j.data.observaciones ?? []).join(' ');
  return {
    estado,
    rucEstado: ESTADO_RUC[j.data.estadoRuc] ?? j.data.estadoRuc ?? null,
    rucCondicion: CONDICION_RUC[j.data.condDomiRuc] ?? j.data.condDomiRuc ?? null,
    mensaje: [MENSAJE[estado], obs].filter(Boolean).join('. '),
  };
}
