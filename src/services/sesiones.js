import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { prismaSystem } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import { sha256, tokenAleatorio, hashIguales } from '../lib/crypto.js';
import { noAutenticado } from '../lib/errors.js';
import { contextoCliente } from '../lib/http.js';
import { desconectarSesiones } from '../realtime/socket.js';

const CLAVE_REVOCADA = (sid) => `sesion:revocada:${sid}`;
const TTL_REVOCADA = 24 * 3600; // > duración del access token

export const COOKIE_REFRESH = 'kardex_rt';

export function firmarAccessToken(usuario, sesionId) {
  return jwt.sign({ tid: usuario.tenantId, sid: sesionId, tipo: usuario.tipo }, env.JWT_ACCESS_SECRET, {
    subject: usuario.id,
    expiresIn: env.ACCESS_TOKEN_TTL,
    algorithm: 'HS256',
  });
}

export function verificarAccessToken(token) {
  try {
    const p = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] });
    return { id: p.sub, tenantId: p.tid, sesionId: p.sid, tipo: p.tipo };
  } catch {
    throw noAutenticado('Token inválido o expirado');
  }
}

export async function sesionRevocada(sesionId) {
  return (await redis.exists(CLAVE_REVOCADA(sesionId))) === 1;
}

function expiracion() {
  return new Date(Date.now() + env.REFRESH_TOKEN_DIAS * 86400_000);
}

/** Crea la sesión y devuelve el refresh token en claro (formato `sesionId.secreto`). */
export async function crearSesion(usuario, req) {
  const id = crypto.randomUUID();
  const secreto = tokenAleatorio(48);
  const { ip, dispositivo } = contextoCliente(req);
  await prismaSystem.sesion.create({
    data: {
      id,
      tenantId: usuario.tenantId,
      usuarioId: usuario.id,
      refreshTokenHash: sha256(secreto),
      ip,
      dispositivo,
      expiraEn: expiracion(),
    },
  });
  return { sesionId: id, refreshToken: `${id}.${secreto}` };
}

/**
 * Rotación del refresh token. Si se presenta un token ya rotado (reutilización),
 * se asume robo y se revoca la sesión completa.
 */
export async function rotarSesion(refreshToken, req) {
  const [id, secreto] = String(refreshToken || '').split('.');
  if (!id || !secreto || !/^[0-9a-f-]{36}$/.test(id)) throw noAutenticado();

  const sesion = await prismaSystem.sesion.findUnique({
    where: { id },
    include: { usuario: { select: { id: true, tenantId: true, tipo: true, estado: true } } },
  });
  if (!sesion || sesion.revocada || sesion.expiraEn < new Date()) throw noAutenticado('Sesión expirada');
  if (!hashIguales(sesion.refreshTokenHash, sha256(secreto))) {
    await revocarSesiones([sesion.id]);
    throw noAutenticado('Sesión invalidada por seguridad');
  }
  if (sesion.usuario.estado !== 'activo') throw noAutenticado('Usuario no activo');

  const nuevo = tokenAleatorio(48);
  const { ip } = contextoCliente(req);
  await prismaSystem.sesion.update({
    where: { id },
    data: { refreshTokenHash: sha256(nuevo), ultimoUso: new Date(), ip, expiraEn: expiracion() },
  });
  return {
    usuario: sesion.usuario,
    refreshToken: `${id}.${nuevo}`,
    accessToken: firmarAccessToken(sesion.usuario, id),
  };
}

/** Revoca sesiones: BD + marca en Redis (corta access tokens vigentes) + expulsa sockets. */
export async function revocarSesiones(ids) {
  if (!ids.length) return;
  await prismaSystem.sesion.updateMany({ where: { id: { in: ids } }, data: { revocada: true } });
  const pipe = redis.pipeline();
  for (const id of ids) pipe.set(CLAVE_REVOCADA(id), '1', 'EX', TTL_REVOCADA);
  await pipe.exec();
  await desconectarSesiones(ids);
}

export async function revocarSesionesUsuario(usuarioId, { excepto } = {}) {
  const activas = await prismaSystem.sesion.findMany({
    where: { usuarioId, revocada: false, ...(excepto ? { id: { not: excepto } } : {}) },
    select: { id: true },
  });
  await revocarSesiones(activas.map((s) => s.id));
}

export function opcionesCookie() {
  return {
    httpOnly: true,
    secure: env.isProd,
    sameSite: 'strict',
    path: '/api/auth',
    maxAge: env.REFRESH_TOKEN_DIAS * 86400_000,
  };
}
