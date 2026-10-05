import { Router } from 'express';
import { z } from 'zod';
import { rateLimit } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { prismaSystem } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import { sha256 } from '../lib/crypto.js';
import { HttpError, noAutenticado } from '../lib/errors.js';
import { email } from '../lib/esquemas.js';
import { validar } from '../middleware/validar.js';
import { verificarPassword } from '../services/password.js';
import * as mfa from '../services/mfa.js';
import { COOKIE_PLATAFORMA, crearSesion, firmarToken, opcionesCookie, revocarSesiones, rotarSesion } from './sesiones.js';
import { auditarPlataforma, autenticarPlataforma } from './middleware.js';

/**
 * Login de la plataforma. 2FA SIEMPRE obligatorio: sin segundo factor no hay sesión.
 * Primer ingreso de un administrador nuevo → debe configurar su app autenticadora.
 */
const router = Router();
const limite = rateLimit({
  windowMs: 15 * 60_000,
  limit: env.LOGIN_RATE_LIMIT,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Demasiados intentos, espere unos minutos' },
  store: new RedisStore({ sendCommand: (...a) => redis.call(...a), prefix: 'rl:plataforma:' }),
});

const exigirXhr = (req, _res, next) => {
  if (req.get('x-requested-with') !== 'XMLHttpRequest') throw new HttpError(403, 'Solicitud no permitida');
  next();
};

const perfil = (a) => ({ id: a.id, nombres: a.nombres, email: a.email, rol: a.rol });
const DESAFIO_INVALIDO = 'La verificación expiró o superó los intentos; inicie sesión nuevamente';

async function iniciarSesion(req, res, admin, extra = {}) {
  const { sesionId, refreshToken } = await crearSesion(admin, req);
  await prismaSystem.$transaction([
    prismaSystem.plataformaAdmin.update({ where: { id: admin.id }, data: { ultimoAcceso: new Date(), intentosFallidos: 0, bloqueadoHasta: null } }),
    auditarPlataforma(req, { adminId: admin.id, accion: 'login.exitoso', recurso: 'admin', recursoId: admin.id }),
  ]);
  res.cookie(COOKIE_PLATAFORMA, refreshToken, opcionesCookie());
  res.json({ accessToken: firmarToken(admin, sesionId), admin: perfil(admin), ...extra });
}

async function adminDelDesafio(desafio) {
  const admin = await prismaSystem.plataformaAdmin.findUnique({ where: { id: desafio.usuarioId } });
  if (!admin?.activo) throw noAutenticado('Usuario de plataforma inactivo');
  return admin;
}

async function regenerarCodigos(tx, adminId) {
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const codigos = Array.from({ length: 8 }, () => {
    const c = Array.from(crypto.randomBytes(8), (b) => alfabeto[b % alfabeto.length]).join('');
    return `${c.slice(0, 4)}-${c.slice(4)}`;
  });
  await tx.plataformaCodigoRecuperacion.deleteMany({ where: { adminId } });
  await tx.plataformaCodigoRecuperacion.createMany({ data: codigos.map((c) => ({ adminId, codigoHash: sha256(c.replace('-', '')) })) });
  return codigos;
}

async function verificarSegundoFactor(admin, codigo) {
  const limpio = String(codigo).trim();
  if (/^\d{6}$/.test(limpio)) return mfa.verificarTotp(admin.id, mfa.descifrar(admin.mfaSecret), limpio);
  const { count } = await prismaSystem.plataformaCodigoRecuperacion.updateMany({
    where: { adminId: admin.id, codigoHash: sha256(limpio.toUpperCase().replace(/[^A-Z0-9]/g, '')), usadoEn: null },
    data: { usadoEn: new Date() },
  });
  return count === 1;
}

router.post('/login', limite, validar(z.object({ email: email(), password: z.string().min(1).max(128) })), async (req, res) => {
  const admin = await prismaSystem.plataformaAdmin.findUnique({ where: { email: req.body.email } });
  const valido = await verificarPassword(admin?.passwordHash, req.body.password);
  if (!admin || !admin.activo) throw noAutenticado('Credenciales inválidas');
  if (admin.bloqueadoHasta && admin.bloqueadoHasta > new Date()) throw new HttpError(429, 'Cuenta bloqueada temporalmente. Intente más tarde');
  if (!valido) {
    const intentos = admin.intentosFallidos + 1;
    const bloquear = intentos >= env.LOGIN_MAX_INTENTOS;
    await prismaSystem.$transaction([
      prismaSystem.plataformaAdmin.update({
        where: { id: admin.id },
        data: { intentosFallidos: bloquear ? 0 : intentos, bloqueadoHasta: bloquear ? new Date(Date.now() + env.LOGIN_BLOQUEO_MINUTOS * 60_000) : null },
      }),
      auditarPlataforma(req, { adminId: admin.id, accion: bloquear ? 'login.bloqueo' : 'login.fallido', recurso: 'admin', recursoId: admin.id }),
    ]);
    throw noAutenticado('Credenciales inválidas');
  }
  const tipo = admin.mfaActivo ? 'plataforma-verificar' : 'plataforma-configurar';
  res.json({ mfa: admin.mfaActivo ? 'verificar' : 'configurar', desafio: await mfa.crearDesafio(admin.id, tipo) });
});

const desafio = z.object({ desafio: z.string().min(20).max(100) });

router.post('/mfa/verificar', limite, validar(desafio.extend({ codigo: z.string().trim().min(6).max(20) })), async (req, res) => {
  const d = await mfa.usarDesafio(req.body.desafio, 'plataforma-verificar');
  if (!d) throw noAutenticado(DESAFIO_INVALIDO);
  const admin = await adminDelDesafio(d);
  if (!(await verificarSegundoFactor(admin, req.body.codigo))) {
    await auditarPlataforma(req, { adminId: admin.id, accion: 'login.mfa_fallido', recurso: 'admin', recursoId: admin.id });
    throw noAutenticado('Código incorrecto');
  }
  await mfa.cerrarDesafio(req.body.desafio);
  return iniciarSesion(req, res, admin);
});

router.post('/mfa/configurar', limite, validar(desafio), async (req, res) => {
  const d = await mfa.usarDesafio(req.body.desafio, 'plataforma-configurar');
  if (!d) throw noAutenticado(DESAFIO_INVALIDO);
  const admin = await adminDelDesafio(d);
  res.json(await mfa.iniciarAlta({ id: admin.id, email: `${admin.email} (plataforma)` }));
});

router.post('/mfa/activar', limite, validar(desafio.extend({ codigo: z.string().trim().regex(/^\d{6}$/, 'Ingrese el código de 6 dígitos') })), async (req, res) => {
  const d = await mfa.usarDesafio(req.body.desafio, 'plataforma-configurar');
  if (!d) throw noAutenticado(DESAFIO_INVALIDO);
  const admin = await adminDelDesafio(d);
  const secreto = await mfa.confirmarAlta(admin.id, req.body.codigo);
  if (!secreto) throw noAutenticado('Código incorrecto o QR vencido; vuelva a escanearlo');
  const codigos = await prismaSystem.$transaction(async (tx) => {
    await tx.plataformaAdmin.update({ where: { id: admin.id }, data: { mfaActivo: true, mfaSecret: secreto } });
    await auditarPlataforma(req, { adminId: admin.id, accion: 'mfa.activar', recurso: 'admin', recursoId: admin.id }, tx);
    return regenerarCodigos(tx, admin.id);
  });
  await mfa.cerrarDesafio(req.body.desafio);
  return iniciarSesion(req, res, { ...admin, mfaActivo: true }, { codigosRecuperacion: codigos });
});

router.post('/refresh', exigirXhr, async (req, res) => {
  try {
    const { accessToken, refreshToken, admin } = await rotarSesion(req.cookies?.[COOKIE_PLATAFORMA]);
    res.cookie(COOKIE_PLATAFORMA, refreshToken, opcionesCookie());
    res.json({ accessToken, admin: perfil(admin) });
  } catch (err) {
    res.clearCookie(COOKIE_PLATAFORMA, { ...opcionesCookie(), maxAge: undefined });
    throw err;
  }
});

router.post('/logout', exigirXhr, async (req, res) => {
  const [id] = String(req.cookies?.[COOKIE_PLATAFORMA] || '').split('.');
  if (/^[0-9a-f-]{36}$/.test(id || '')) await revocarSesiones([id]);
  res.clearCookie(COOKIE_PLATAFORMA, { ...opcionesCookie(), maxAge: undefined });
  res.status(204).end();
});

router.get('/me', autenticarPlataforma, async (req, res) => {
  const admin = await prismaSystem.plataformaAdmin.findUnique({ where: { id: req.admin.id } });
  res.json(perfil(admin));
});

export default router;
