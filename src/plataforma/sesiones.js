import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { prismaSystem } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import { sha256, tokenAleatorio, hashIguales } from '../lib/crypto.js';
import { noAutenticado } from '../lib/errors.js';
import { contextoCliente } from '../lib/http.js';

/**
 * Sesiones de la PLATAFORMA, totalmente separadas de las de los estudios:
 * otro secreto JWT, audiencia propia, otra tabla de sesiones y otra cookie.
 */
const AUDIENCIA = 'kardex-plataforma';
const HORAS_REFRESH = 12;
export const COOKIE_PLATAFORMA = 'kardex_prt';
const CLAVE_REVOCADA = (sid) => `plataforma:sesion:revocada:${sid}`;

export function firmarToken(admin, sesionId) {
  return jwt.sign({ sid: sesionId, rol: admin.rol }, env.JWT_PLATAFORMA_SECRET, {
    subject: admin.id, audience: AUDIENCIA, expiresIn: '15m', algorithm: 'HS256',
  });
}

export function verificarToken(token) {
  try {
    const p = jwt.verify(token, env.JWT_PLATAFORMA_SECRET, { algorithms: ['HS256'], audience: AUDIENCIA });
    return { id: p.sub, sesionId: p.sid, rol: p.rol };
  } catch {
    throw noAutenticado('Token inválido o expirado');
  }
}

export const sesionRevocada = async (sid) => (await redis.exists(CLAVE_REVOCADA(sid))) === 1;

export async function crearSesion(admin, req) {
  const id = crypto.randomUUID();
  const secreto = tokenAleatorio(48);
  const { ip, dispositivo } = contextoCliente(req);
  await prismaSystem.plataformaSesion.create({
    data: { id, adminId: admin.id, refreshTokenHash: sha256(secreto), ip, dispositivo, expiraEn: new Date(Date.now() + HORAS_REFRESH * 3600_000) },
  });
  return { sesionId: id, refreshToken: `${id}.${secreto}` };
}

/** Rotación del refresh token con detección de reutilización (igual que en los estudios). */
export async function rotarSesion(refreshToken) {
  const [id, secreto] = String(refreshToken || '').split('.');
  if (!/^[0-9a-f-]{36}$/.test(id || '') || !secreto) throw noAutenticado();
  const sesion = await prismaSystem.plataformaSesion.findUnique({ where: { id }, include: { admin: true } });
  if (!sesion || sesion.revocada || sesion.expiraEn < new Date()) throw noAutenticado('Sesión expirada');
  if (!hashIguales(sesion.refreshTokenHash, sha256(secreto))) {
    await revocarSesiones([sesion.id]);
    throw noAutenticado('Sesión invalidada por seguridad');
  }
  if (!sesion.admin.activo) throw noAutenticado('Usuario de plataforma inactivo');
  const nuevo = tokenAleatorio(48);
  await prismaSystem.plataformaSesion.update({ where: { id }, data: { refreshTokenHash: sha256(nuevo) } });
  return { admin: sesion.admin, refreshToken: `${id}.${nuevo}`, accessToken: firmarToken(sesion.admin, id) };
}

export async function revocarSesiones(ids) {
  if (!ids.length) return;
  await prismaSystem.plataformaSesion.updateMany({ where: { id: { in: ids } }, data: { revocada: true } });
  const pipe = redis.pipeline();
  for (const id of ids) pipe.set(CLAVE_REVOCADA(id), '1', 'EX', 3600);
  await pipe.exec();
}

export const opcionesCookie = () => ({
  httpOnly: true,
  secure: env.isProd,
  sameSite: 'strict',
  path: '/api/plataforma/auth',
  maxAge: HORAS_REFRESH * 3600_000,
});
