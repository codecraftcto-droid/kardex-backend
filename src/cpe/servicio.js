import IORedis from 'ioredis';
import { Emitter } from '@socket.io/redis-emitter';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { withTenant } from '../lib/prisma.js';
import { cifrar, descifrar } from '../services/mfa.js';
import { PROVEEDORES } from './proveedores/index.js';
import { ErrorDocumento, ErrorTransitorio, documentoNeutro } from './documento.js';

/**
 * Facturación electrónica: envía los comprobantes del punto de venta a SUNAT por medio del
 * proveedor configurado en cada empresa, guarda la respuesta (CDR, hash, QR) y gestiona las
 * comunicaciones de baja. Se usa desde la cola (envío automático) y desde la API (reenvío).
 */
export const ELECTRONICOS = ['FACTURA', 'BOLETA', 'NOTA_CREDITO'];
const FINALES = ['ACEPTADO', 'OBSERVADO', 'ANULADO'];

let emisor = null;
function notificar(c) {
  emisor ||= new Emitter(new IORedis(env.REDIS_URL));
  emisor.to(`almacen:${c.almacenId}`).to(`empresa:${c.empresaId}`).emit('pos:comprobante', {
    id: c.id, tipo: c.tipo, serie: c.serie, numero: c.numero, estadoSunat: c.estadoSunat,
  });
}

/** Configuración de la empresa con el token descifrado (solo para uso interno del servidor) */
async function configDe(tx, empresaId) {
  const cfg = await tx.configFacturacion.findUnique({ where: { empresaId } });
  if (!cfg || !cfg.activo) return null;
  return { ...cfg, token: cfg.tokenCifrado ? descifrar(cfg.tokenCifrado) : null };
}

async function cargarComprobante(tx, comprobanteId) {
  return tx.comprobante.findUnique({
    where: { id: comprobanteId },
    include: {
      detalles: { orderBy: { id: 'asc' }, include: { producto: { select: { sku: true } } } },
      cuotas: { orderBy: { numero: 'asc' } },
      referencia: { select: { tipo: true, serie: true, numero: true } },
      empresa: { select: { ruc: true, razonSocial: true, cuentaDetracciones: true } },
    },
  });
}

/**
 * Envía (o reenvía) un comprobante. Devuelve { estado, mensaje }.
 * Lanza ErrorTransitorio si conviene reintentar (la cola lo reintenta con espera creciente).
 */
export async function enviarComprobante({ tenantId, comprobanteId }) {
  const db = (fn) => withTenant(tenantId, fn);
  const { c, cfg } = await db(async (tx) => {
    const c = await cargarComprobante(tx, comprobanteId);
    return { c, cfg: c ? await configDe(tx, c.empresaId) : null };
  });
  if (!c || !ELECTRONICOS.includes(c.tipo)) return { estado: 'NO_APLICA', mensaje: 'No es un comprobante electrónico' };
  if (FINALES.includes(c.estadoSunat)) return { estado: c.estadoSunat, mensaje: 'Ya tiene respuesta de SUNAT' };
  if (c.estado === 'ANULADO' && !c.sunatEnviadoEn) return { estado: c.estadoSunat, mensaje: 'Anulado antes de enviarse: no se envía' };
  if (!cfg) return { estado: c.estadoSunat, mensaje: 'La empresa no tiene configurada la facturación electrónica' };

  const proveedor = PROVEEDORES[cfg.proveedor];
  const doc = documentoNeutro(c, c.empresa);
  let r;
  try {
    r = c.estadoSunat === 'ENVIADO' ? await proveedor.consultar(cfg, doc) : await proveedor.enviar(cfg, doc);
  } catch (e) {
    const transitorio = e instanceof ErrorTransitorio;
    await db((tx) => tx.comprobante.update({
      where: { id: c.id },
      data: { sunatIntentos: { increment: 1 }, sunatUltimoError: e.message.slice(0, 500) },
    }));
    logger.warn({ comprobante: `${c.serie}-${c.numero}`, err: e.message }, 'Envío a SUNAT con error');
    if (transitorio) throw e;
    if (!(e instanceof ErrorDocumento)) throw e;
    return { estado: c.estadoSunat, mensaje: e.message, error: true };
  }
  const actualizado = await db((tx) => tx.comprobante.update({
    where: { id: c.id },
    data: {
      estadoSunat: r.estado,
      sunatCodigo: r.codigo ?? null,
      sunatDescripcion: r.descripcion?.slice(0, 1000) ?? null,
      sunatHash: r.hash ?? c.sunatHash,
      sunatQr: r.qr ?? c.sunatQr,
      sunatPdf: r.pdf ?? c.sunatPdf,
      sunatXml: r.xml ?? c.sunatXml,
      sunatCdr: r.cdr ?? c.sunatCdr,
      sunatIntentos: { increment: 1 },
      sunatUltimoError: null,
      sunatEnviadoEn: c.sunatEnviadoEn ?? new Date(),
    },
  }));
  notificar(actualizado);
  return { estado: r.estado, mensaje: r.descripcion };
}

/** Comunicación de baja de un comprobante ya enviado (al anularlo). */
export async function darDeBaja({ tenantId, comprobanteId, motivo }) {
  const db = (fn) => withTenant(tenantId, fn);
  const { c, cfg } = await db(async (tx) => {
    const c = await cargarComprobante(tx, comprobanteId);
    return { c, cfg: c ? await configDe(tx, c.empresaId) : null };
  });
  if (!c || !cfg || !c.sunatEnviadoEn || c.estadoSunat === 'RECHAZADO' || c.estadoSunat === 'ANULADO') return { estado: c?.bajaEstado ?? null };
  const proveedor = PROVEEDORES[cfg.proveedor];
  const doc = documentoNeutro(c, c.empresa);
  let r;
  try {
    r = c.bajaEstado === 'PENDIENTE' && c.bajaTicket && proveedor.consultarBaja ? await proveedor.consultarBaja(cfg, doc) : await proveedor.anular(cfg, doc, motivo || 'Anulación de la operación');
  } catch (e) {
    await db((tx) => tx.comprobante.update({ where: { id: c.id }, data: { bajaEstado: 'ERROR', bajaMensaje: e.message.slice(0, 500) } }));
    if (e instanceof ErrorTransitorio) throw e;
    return { estado: 'ERROR', mensaje: e.message };
  }
  const actualizado = await db((tx) => tx.comprobante.update({
    where: { id: c.id },
    data: {
      bajaEstado: r.estado, bajaTicket: r.ticket ?? c.bajaTicket, bajaMensaje: r.mensaje,
      ...(r.estado === 'ACEPTADA' && { estadoSunat: 'ANULADO' }),
    },
  }));
  notificar(actualizado);
  return { estado: r.estado, mensaje: r.mensaje };
}

// ───────────── Configuración por empresa ─────────────

/** Configuración visible (el token nunca sale del servidor: solo se indica si existe). */
export function configPublica(cfg) {
  if (!cfg) return null;
  const { tokenCifrado, sunatClientSecretCifrado, ...resto } = cfg;
  return { ...resto, tieneToken: Boolean(tokenCifrado), tieneSunatSecret: Boolean(sunatClientSecretCifrado) };
}

export async function guardarConfig(tx, { tenantId, empresaId, token, sunatClientSecret, ...datos }) {
  // Los secretos solo se reemplazan si llegan; vacío = conservar el actual
  const secretos = {
    ...(token && { tokenCifrado: cifrar(token) }),
    ...(sunatClientSecret && { sunatClientSecretCifrado: cifrar(sunatClientSecret) }),
  };
  return tx.configFacturacion.upsert({
    where: { empresaId },
    create: { tenantId, empresaId, ...datos, ...secretos },
    update: { ...datos, ...secretos },
  });
}

export async function probarConexion(tx, empresaId) {
  const cfg = await configDe(tx, empresaId);
  if (!cfg) return { ok: false, mensaje: 'Primero guarde y active la configuración' };
  return PROVEEDORES[cfg.proveedor].probar(cfg);
}
