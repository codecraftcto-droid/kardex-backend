import crypto from 'node:crypto';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { env } from '../config/env.js';
import { redis } from '../lib/redis.js';
import { sha256, tokenAleatorio } from '../lib/crypto.js';

/**
 * Segundo factor TOTP (RFC 6238, apps tipo Google Authenticator / Authy / Microsoft Authenticator).
 * - El secreto se guarda CIFRADO (AES-256-GCM) con MFA_ENCRYPTION_KEY.
 * - Un mismo código no se acepta dos veces (protección contra repetición).
 * - Códigos de recuperación de un solo uso, guardados como hash.
 */
authenticator.options = { window: 1, step: 30 };
const EMISOR = 'Kardex';
const CLAVE = Buffer.from(env.MFA_ENCRYPTION_KEY, 'hex');

export function cifrar(texto) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', CLAVE, iv);
  const datos = Buffer.concat([c.update(texto, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), datos].map((b) => b.toString('base64')).join('.');
}

export function descifrar(cifrado) {
  const [iv, tag, datos] = cifrado.split('.').map((b) => Buffer.from(b, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', CLAVE, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(datos), d.final()]).toString('utf8');
}

// ───────────── Alta del segundo factor ─────────────

const CLAVE_PENDIENTE = (usuarioId) => `mfa:pendiente:${usuarioId}`;

/** Genera un secreto nuevo (pendiente de confirmar durante 10 minutos) y su código QR. */
export async function iniciarAlta(usuario) {
  const secreto = authenticator.generateSecret(20);
  await redis.set(CLAVE_PENDIENTE(usuario.id), cifrar(secreto), 'EX', 600);
  const otpauth = authenticator.keyuri(usuario.email, EMISOR, secreto);
  return { otpauth, qr: await QRCode.toDataURL(otpauth, { margin: 1, width: 240 }), secreto };
}

/** Confirma el alta con un código válido. Devuelve el secreto cifrado para guardar, o null. */
export async function confirmarAlta(usuarioId, codigo) {
  const pendiente = await redis.get(CLAVE_PENDIENTE(usuarioId));
  if (!pendiente) return null;
  if (!(await verificarTotp(usuarioId, descifrar(pendiente), codigo))) return null;
  await redis.del(CLAVE_PENDIENTE(usuarioId));
  return pendiente;
}

// ───────────── Verificación ─────────────

/** Verifica el código TOTP y rechaza reutilizar el mismo paso de 30 s (o uno anterior). */
export async function verificarTotp(usuarioId, secreto, codigo) {
  if (!/^\d{6}$/.test(String(codigo))) return false;
  const delta = authenticator.checkDelta(String(codigo), secreto);
  if (delta === null) return false;
  const paso = Math.floor(Date.now() / 30000) + delta;
  const clave = `mfa:ultimo-paso:${usuarioId}`;
  const ultimo = Number(await redis.get(clave)) || 0;
  if (paso <= ultimo) return false;
  await redis.set(clave, String(paso), 'EX', 120);
  return true;
}

const normalizar = (c) => String(c).toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Genera 8 códigos de recuperación nuevos (invalida los anteriores). Devuelve los códigos en claro UNA vez. */
export async function regenerarCodigos(tx, { tenantId, usuarioId }) {
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const codigos = Array.from({ length: 8 }, () => {
    const c = Array.from(crypto.randomBytes(8), (b) => alfabeto[b % alfabeto.length]).join('');
    return `${c.slice(0, 4)}-${c.slice(4)}`;
  });
  await tx.mfaCodigoRecuperacion.deleteMany({ where: { usuarioId } });
  await tx.mfaCodigoRecuperacion.createMany({
    data: codigos.map((c) => ({ tenantId, usuarioId, codigoHash: sha256(normalizar(c)) })),
  });
  return codigos;
}

/** Valida el segundo factor: código de 6 dígitos de la app o un código de recuperación. */
export async function verificarSegundoFactor(tx, usuario, codigo) {
  if (/^\d{6}$/.test(String(codigo).trim())) {
    return { ok: await verificarTotp(usuario.id, descifrar(usuario.mfaSecret), String(codigo).trim()), metodo: 'totp' };
  }
  const { count } = await tx.mfaCodigoRecuperacion.updateMany({
    where: { usuarioId: usuario.id, codigoHash: sha256(normalizar(codigo)), usadoEn: null },
    data: { usadoEn: new Date() },
  });
  return { ok: count === 1, metodo: 'recuperacion' };
}

/** ¿Algún rol activo del usuario exige 2FA? */
export async function requiereMfa(tx, usuarioId) {
  return (await tx.usuarioRol.count({ where: { usuarioId, rol: { activo: true, requiereMfa: true } } })) > 0;
}

// ───────────── Desafíos de login (entre la contraseña y el segundo factor) ─────────────

const CLAVE_DESAFIO = (token) => `mfa:desafio:${sha256(token)}`;
const MAX_INTENTOS = 5;

/** tipo: 'verificar' (ya tiene 2FA) | 'configurar' (su rol lo exige y aún no lo tiene) */
export async function crearDesafio(usuarioId, tipo) {
  const token = tokenAleatorio(32);
  await redis.set(CLAVE_DESAFIO(token), JSON.stringify({ usuarioId, tipo, intentos: 0 }), 'EX', 300);
  return token;
}

/** Lee el desafío y cuenta un intento; tras 5 fallos se invalida. */
export async function usarDesafio(token, tipo) {
  const clave = CLAVE_DESAFIO(String(token || ''));
  const raw = await redis.get(clave);
  if (!raw) return null;
  const d = JSON.parse(raw);
  if (d.tipo !== tipo) return null;
  d.intentos += 1;
  if (d.intentos > MAX_INTENTOS) {
    await redis.del(clave);
    return null;
  }
  await redis.set(clave, JSON.stringify(d), 'KEEPTTL');
  return d;
}

export const cerrarDesafio = (token) => redis.del(CLAVE_DESAFIO(String(token || '')));
