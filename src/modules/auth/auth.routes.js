import { Router } from 'express';
import { z } from 'zod';
import { rateLimit } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { env } from '../../config/env.js';
import { prismaSystem } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { sha256, tokenAleatorio } from '../../lib/crypto.js';
import { HttpError, noAutenticado, solicitudInvalida } from '../../lib/errors.js';
import { validar } from '../../middleware/validar.js';
import { email } from '../../lib/esquemas.js';
import { auditar } from '../../services/auditoria.js';
import { hashPassword, verificarPassword, esquemaPassword } from '../../services/password.js';
import { enviarRecuperacion } from '../../services/correo.js';
import * as mfa from '../../services/mfa.js';
import {
  COOKIE_REFRESH,
  crearSesion,
  firmarAccessToken,
  opcionesCookie,
  rotarSesion,
  revocarSesiones,
  revocarSesionesUsuario,
} from '../../services/sesiones.js';

const router = Router();

const limitador = (prefijo, limit, minutos) =>
  rateLimit({
    windowMs: minutos * 60_000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Demasiados intentos, espere unos minutos' },
    store: new RedisStore({ sendCommand: (...args) => redis.call(...args), prefix: `rl:${prefijo}:` }),
  });

const limiteLogin = limitador('login', env.LOGIN_RATE_LIMIT, 15);
const limiteCorreo = limitador('correo', 5, 15);

/** Protección CSRF para endpoints que usan la cookie: exige cabecera personalizada. */
function exigirCabeceraXhr(req, _res, next) {
  if (req.get('x-requested-with') !== 'XMLHttpRequest') throw new HttpError(403, 'Solicitud no permitida');
  next();
}

const perfilPublico = (u) => ({
  id: u.id,
  nombres: u.nombres,
  email: u.email,
  tipo: u.tipo,
  empresaId: u.empresaId,
  cargo: u.cargo,
});

router.post(
  '/login',
  limiteLogin,
  validar(z.object({ email: email(), password: z.string().min(1).max(128) })),
  async (req, res) => {
    const { email, password } = req.body;
    const usuario = await prismaSystem.usuario.findUnique({
      where: { email },
      include: { tenant: { select: { activo: true } } },
    });
    const valido = await verificarPassword(usuario?.passwordHash, password);
    if (!usuario) throw noAutenticado('Credenciales inválidas');

    const ahora = new Date();
    if (usuario.bloqueadoHasta && usuario.bloqueadoHasta > ahora) {
      throw new HttpError(429, 'Cuenta bloqueada temporalmente por intentos fallidos. Intente más tarde');
    }

    const meta = { modulo: 'auth', recurso: 'usuario', recursoId: usuario.id, usuarioId: usuario.id, tenantId: usuario.tenantId };
    if (!valido) {
      const intentos = usuario.intentosFallidos + 1;
      const bloquear = intentos >= env.LOGIN_MAX_INTENTOS;
      await prismaSystem.$transaction([
        prismaSystem.usuario.update({
          where: { id: usuario.id },
          data: {
            intentosFallidos: bloquear ? 0 : intentos,
            bloqueadoHasta: bloquear ? new Date(ahora.getTime() + env.LOGIN_BLOQUEO_MINUTOS * 60_000) : null,
          },
        }),
        auditar(prismaSystem, req, { ...meta, accion: bloquear ? 'login.bloqueo' : 'login.fallido' }),
      ]);
      throw noAutenticado('Credenciales inválidas');
    }
    if (!usuario.tenant.activo) throw noAutenticado('El estudio está suspendido. Comuníquese con soporte');
    if (usuario.estado !== 'activo') {
      throw noAutenticado(usuario.estado === 'suspendido' ? 'Usuario suspendido' : 'Cuenta no activada');
    }

    // Contraseña correcta: si corresponde, se exige el segundo factor ANTES de crear la sesión
    await prismaSystem.usuario.update({ where: { id: usuario.id }, data: { intentosFallidos: 0, bloqueadoHasta: null } });
    if (usuario.mfaActivo) {
      return res.json({ mfa: 'verificar', desafio: await mfa.crearDesafio(usuario.id, 'verificar') });
    }
    if (await mfa.requiereMfa(prismaSystem, usuario.id)) {
      return res.json({ mfa: 'configurar', desafio: await mfa.crearDesafio(usuario.id, 'configurar') });
    }
    return iniciarSesion(req, res, usuario);
  },
);

/** Crea la sesión, registra el acceso y entrega los tokens. */
async function iniciarSesion(req, res, usuario, extra = {}) {
  const { sesionId, refreshToken } = await crearSesion(usuario, req);
  await prismaSystem.$transaction([
    prismaSystem.usuario.update({ where: { id: usuario.id }, data: { ultimoAcceso: new Date() } }),
    auditar(prismaSystem, req, {
      modulo: 'auth', recurso: 'usuario', recursoId: usuario.id, usuarioId: usuario.id, tenantId: usuario.tenantId,
      accion: 'login.exitoso', despues: { sesionId, segundoFactor: extra.segundoFactor ?? null },
    }),
  ]);
  res.cookie(COOKIE_REFRESH, refreshToken, opcionesCookie());
  res.json({ accessToken: firmarAccessToken(usuario, sesionId), usuario: perfilPublico(usuario), ...extra.respuesta });
}

/** Carga el usuario de un desafío 2FA y revalida que siga activo. */
async function usuarioDelDesafio(desafio) {
  const usuario = await prismaSystem.usuario.findUnique({
    where: { id: desafio.usuarioId },
    include: { tenant: { select: { activo: true } } },
  });
  if (!usuario || usuario.estado !== 'activo' || !usuario.tenant.activo) throw noAutenticado('Usuario no activo');
  return usuario;
}

const esquemaDesafio = z.object({ desafio: z.string().min(20).max(100) });
const DESAFIO_INVALIDO = 'La verificación expiró o superó los intentos; inicie sesión nuevamente';

/** Paso 2 del login: código de la app autenticadora o código de recuperación. */
router.post(
  '/mfa/verificar',
  limiteLogin,
  validar(esquemaDesafio.extend({ codigo: z.string().trim().min(6).max(20) })),
  async (req, res) => {
    const desafio = await mfa.usarDesafio(req.body.desafio, 'verificar');
    if (!desafio) throw noAutenticado(DESAFIO_INVALIDO);
    const usuario = await usuarioDelDesafio(desafio);
    const { ok, metodo } = await mfa.verificarSegundoFactor(prismaSystem, usuario, req.body.codigo);
    if (!ok) {
      await auditar(prismaSystem, req, {
        modulo: 'auth', accion: 'login.mfa_fallido', recurso: 'usuario', recursoId: usuario.id, usuarioId: usuario.id, tenantId: usuario.tenantId,
      });
      throw noAutenticado('Código incorrecto');
    }
    await mfa.cerrarDesafio(req.body.desafio);
    return iniciarSesion(req, res, usuario, { segundoFactor: metodo });
  },
);

/** Su rol exige 2FA y aún no lo tiene: genera el QR para configurarlo (sin sesión todavía). */
router.post('/mfa/configurar', limiteLogin, validar(esquemaDesafio), async (req, res) => {
  const desafio = await mfa.usarDesafio(req.body.desafio, 'configurar');
  if (!desafio) throw noAutenticado(DESAFIO_INVALIDO);
  const usuario = await usuarioDelDesafio(desafio);
  res.json(await mfa.iniciarAlta(usuario));
});

/** Confirma la configuración obligatoria con el primer código y entonces sí crea la sesión. */
router.post(
  '/mfa/activar',
  limiteLogin,
  validar(esquemaDesafio.extend({ codigo: z.string().trim().regex(/^\d{6}$/, 'Ingrese el código de 6 dígitos') })),
  async (req, res) => {
    const desafio = await mfa.usarDesafio(req.body.desafio, 'configurar');
    if (!desafio) throw noAutenticado(DESAFIO_INVALIDO);
    const usuario = await usuarioDelDesafio(desafio);
    const secreto = await mfa.confirmarAlta(usuario.id, req.body.codigo);
    if (!secreto) throw noAutenticado('Código incorrecto o QR vencido; vuelva a escanearlo');
    const codigos = await prismaSystem.$transaction(async (tx) => {
      await tx.usuario.update({ where: { id: usuario.id }, data: { mfaActivo: true, mfaSecret: secreto } });
      await auditar(tx, req, { modulo: 'auth', accion: 'mfa.activar', recurso: 'usuario', recursoId: usuario.id, usuarioId: usuario.id, tenantId: usuario.tenantId });
      return mfa.regenerarCodigos(tx, { tenantId: usuario.tenantId, usuarioId: usuario.id });
    });
    await mfa.cerrarDesafio(req.body.desafio);
    return iniciarSesion(req, res, usuario, { segundoFactor: 'totp', respuesta: { codigosRecuperacion: codigos } });
  },
);

router.post('/refresh', exigirCabeceraXhr, async (req, res) => {
  try {
    const { accessToken, refreshToken, usuario } = await rotarSesion(req.cookies?.[COOKIE_REFRESH], req);
    res.cookie(COOKIE_REFRESH, refreshToken, opcionesCookie());
    res.json({ accessToken, usuarioId: usuario.id });
  } catch (err) {
    res.clearCookie(COOKIE_REFRESH, { ...opcionesCookie(), maxAge: undefined });
    throw err;
  }
});

router.post('/logout', exigirCabeceraXhr, async (req, res) => {
  const [id] = String(req.cookies?.[COOKIE_REFRESH] || '').split('.');
  if (/^[0-9a-f-]{36}$/.test(id || '')) await revocarSesiones([id]);
  res.clearCookie(COOKIE_REFRESH, { ...opcionesCookie(), maxAge: undefined });
  res.status(204).end();
});

/** Consume un token de un solo uso (invitación o recuperación) y fija la contraseña. */
async function consumirToken(req, tipo) {
  const { token, password } = req.body;
  const registro = await prismaSystem.tokenUsuario.findUnique({
    where: { tokenHash: sha256(token) },
    include: { usuario: true },
  });
  if (!registro || registro.tipo !== tipo || registro.usadoEn || registro.expiraEn < new Date()) {
    throw solicitudInvalida('El enlace no es válido o ha expirado');
  }
  if (registro.usuario.estado === 'suspendido') throw solicitudInvalida('El usuario está suspendido');

  const passwordHash = await hashPassword(password);
  await prismaSystem.$transaction([
    prismaSystem.tokenUsuario.update({ where: { id: registro.id }, data: { usadoEn: new Date() } }),
    prismaSystem.usuario.update({
      where: { id: registro.usuarioId },
      data: { passwordHash, estado: 'activo', intentosFallidos: 0, bloqueadoHasta: null },
    }),
    auditar(prismaSystem, req, {
      modulo: 'auth',
      accion: tipo === 'invitacion' ? 'cuenta.activada' : 'password.restablecido',
      recurso: 'usuario',
      recursoId: registro.usuarioId,
      usuarioId: registro.usuarioId,
      tenantId: registro.tenantId,
    }),
  ]);
  return registro.usuario;
}

const esquemaToken = z.object({ token: z.string().min(20).max(200), password: esquemaPassword });

router.post('/activar', limiteCorreo, validar(esquemaToken), async (req, res) => {
  await consumirToken(req, 'invitacion');
  res.json({ mensaje: 'Cuenta activada. Ya puede iniciar sesión' });
});

router.post('/restablecer', limiteCorreo, validar(esquemaToken), async (req, res) => {
  const usuario = await consumirToken(req, 'recuperacion');
  await revocarSesionesUsuario(usuario.id);
  res.json({ mensaje: 'Contraseña actualizada. Inicie sesión nuevamente' });
});

router.post(
  '/olvide',
  limiteCorreo,
  validar(z.object({ email: email() })),
  async (req, res) => {
    const usuario = await prismaSystem.usuario.findUnique({ where: { email: req.body.email } });
    if (usuario?.estado === 'activo') {
      const token = tokenAleatorio(32);
      await prismaSystem.tokenUsuario.create({
        data: {
          tenantId: usuario.tenantId,
          usuarioId: usuario.id,
          tipo: 'recuperacion',
          tokenHash: sha256(token),
          expiraEn: new Date(Date.now() + 3600_000),
        },
      });
      await enviarRecuperacion({ email: usuario.email, nombres: usuario.nombres, token });
    }
    // Misma respuesta exista o no la cuenta (no revelar usuarios)
    res.json({ mensaje: 'Si el correo está registrado, recibirá un enlace de recuperación' });
  },
);

export default router;
