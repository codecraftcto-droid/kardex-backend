import { Router } from 'express';
import { z } from 'zod';
import { validar } from '../../middleware/validar.js';
import { obtenerPermisos } from '../../rbac/servicio.js';
import { empresasConAcceso } from '../../rbac/resolver.js';
import { noAutenticado, noEncontrado } from '../../lib/errors.js';
import { auditar } from '../../services/auditoria.js';
import { hashPassword, verificarPassword, esquemaPassword } from '../../services/password.js';
import { revocarSesiones, revocarSesionesUsuario } from '../../services/sesiones.js';
import * as mfa from '../../services/mfa.js';
import { usoDelPlan } from '../../services/limites.js';
import { modulosEfectivos } from '../../rbac/modulos.js';
import { conflicto } from '../../lib/errors.js';

const router = Router();

router.get('/', async (req, res) => {
  const usuario = await req.db((tx) =>
    tx.usuario.findUnique({
      where: { id: req.user.id },
      select: {
        id: true, nombres: true, email: true, documento: true, cargo: true, telefono: true,
        tipo: true, empresaId: true, mfaActivo: true, ultimoAcceso: true,
        tenant: { select: { id: true, nombre: true, modulosAdicionales: true, plan: { select: { modulos: true, nombre: true } } } },
      },
    }),
  );
  // Módulos contratados por el estudio (los permisos ya vienen filtrados por ellos)
  const { tenant, ...resto } = usuario;
  res.json({ ...resto, tenant: { id: tenant.id, nombre: tenant.nombre, plan: tenant.plan?.nombre ?? null }, modulos: [...modulosEfectivos(tenant)] });
});

/** Permisos efectivos y alcances (el frontend los usa para menús, rutas y botones). */
router.get('/permisos', async (req, res) => {
  const perms = await obtenerPermisos(req.user);
  res.json(perms);
});

/** Empresas que el usuario puede seleccionar como contexto activo. */
router.get('/contexto', async (req, res) => {
  const perms = await obtenerPermisos(req.user);
  const acceso = empresasConAcceso(perms);
  const empresas = await req.db((tx) =>
    tx.empresa.findMany({
      where: { activo: true, ...(acceso === 'todas' ? {} : { id: { in: acceso } }) },
      select: { id: true, razonSocial: true, ruc: true, metodoValorizacion: true },
      orderBy: { razonSocial: 'asc' },
    }),
  );
  res.json({ empresas });
});

router.patch(
  '/',
  validar(
    z.object({
      nombres: z.string().trim().min(2).max(150).optional(),
      telefono: z.string().trim().max(30).nullish(),
      cargo: z.string().trim().max(100).nullish(),
    }),
  ),
  async (req, res) => {
    const actualizado = await req.db(async (tx) => {
      const antes = await tx.usuario.findUnique({ where: { id: req.user.id } });
      const despues = await tx.usuario.update({ where: { id: req.user.id }, data: req.body });
      await auditar(tx, req, { modulo: 'usuarios', accion: 'perfil.editar', recurso: 'usuario', recursoId: req.user.id, antes, despues });
      return despues;
    });
    res.json({ id: actualizado.id, nombres: actualizado.nombres, telefono: actualizado.telefono, cargo: actualizado.cargo });
  },
);

router.post(
  '/password',
  validar(z.object({ actual: z.string().min(1), nueva: esquemaPassword })),
  async (req, res) => {
    const usuario = await req.db((tx) => tx.usuario.findUnique({ where: { id: req.user.id } }));
    if (!(await verificarPassword(usuario.passwordHash, req.body.actual))) throw noAutenticado('Contraseña actual incorrecta');
    const passwordHash = await hashPassword(req.body.nueva);
    await req.db(async (tx) => {
      await tx.usuario.update({ where: { id: usuario.id }, data: { passwordHash } });
      await auditar(tx, req, { modulo: 'auth', accion: 'password.cambiado', recurso: 'usuario', recursoId: usuario.id });
    });
    // Cierra las demás sesiones por seguridad
    await revocarSesionesUsuario(usuario.id, { excepto: req.user.sesionId });
    res.json({ mensaje: 'Contraseña actualizada' });
  },
);

router.get('/sesiones', async (req, res) => {
  const sesiones = await req.db((tx) =>
    tx.sesion.findMany({
      where: { usuarioId: req.user.id, revocada: false, expiraEn: { gt: new Date() } },
      select: { id: true, dispositivo: true, ip: true, creadaEn: true, ultimoUso: true },
      orderBy: { ultimoUso: 'desc' },
    }),
  );
  res.json(sesiones.map((s) => ({ ...s, actual: s.id === req.user.sesionId })));
});

router.delete('/sesiones/:id', async (req, res) => {
  const sesion = await req.db((tx) =>
    tx.sesion.findFirst({ where: { id: req.params.id, usuarioId: req.user.id }, select: { id: true } }),
  );
  if (!sesion) throw noEncontrado();
  await revocarSesiones([sesion.id]);
  res.status(204).end();
});

/** Plan contratado y consumo (para los administradores del estudio). */
router.get('/plan', async (req, res) => {
  res.json(await req.db((tx) => usoDelPlan(tx, req.tenantId)));
});

// ───────────── Verificación en dos pasos (2FA) ─────────────

const cargarUsuario = (req) => req.db((tx) => tx.usuario.findUnique({ where: { id: req.user.id } }));

router.get('/mfa', async (req, res) => {
  const r = await req.db(async (tx) => ({
    usuario: await tx.usuario.findUnique({ where: { id: req.user.id }, select: { mfaActivo: true } }),
    requerido: await mfa.requiereMfa(tx, req.user.id),
    codigosRestantes: await tx.mfaCodigoRecuperacion.count({ where: { usuarioId: req.user.id, usadoEn: null } }),
  }));
  res.json({ activo: r.usuario.mfaActivo, requerido: r.requerido, codigosRestantes: r.codigosRestantes });
});

router.post('/mfa/iniciar', async (req, res) => {
  const usuario = await cargarUsuario(req);
  if (usuario.mfaActivo) throw conflicto('La verificación en dos pasos ya está activa');
  res.json(await mfa.iniciarAlta(usuario));
});

router.post('/mfa/activar', validar(z.object({ codigo: z.string().trim().regex(/^\d{6}$/, 'Ingrese el código de 6 dígitos') })), async (req, res) => {
  const secreto = await mfa.confirmarAlta(req.user.id, req.body.codigo);
  if (!secreto) throw noAutenticado('Código incorrecto o QR vencido; vuelva a escanearlo');
  const codigos = await req.db(async (tx) => {
    await tx.usuario.update({ where: { id: req.user.id }, data: { mfaActivo: true, mfaSecret: secreto } });
    await auditar(tx, req, { modulo: 'auth', accion: 'mfa.activar', recurso: 'usuario', recursoId: req.user.id });
    return mfa.regenerarCodigos(tx, { tenantId: req.tenantId, usuarioId: req.user.id });
  });
  res.json({ codigosRecuperacion: codigos });
});

router.post(
  '/mfa/desactivar',
  validar(z.object({ password: z.string().min(1).max(128), codigo: z.string().trim().min(6).max(20) })),
  async (req, res) => {
    const usuario = await cargarUsuario(req);
    if (!usuario.mfaActivo) throw conflicto('La verificación en dos pasos no está activa');
    if (await req.db((tx) => mfa.requiereMfa(tx, usuario.id))) throw conflicto('Uno de sus roles exige la verificación en dos pasos');
    if (!(await verificarPassword(usuario.passwordHash, req.body.password))) throw noAutenticado('Contraseña incorrecta');
    await req.db(async (tx) => {
      if (!(await mfa.verificarSegundoFactor(tx, usuario, req.body.codigo)).ok) throw noAutenticado('Código incorrecto');
      await tx.usuario.update({ where: { id: usuario.id }, data: { mfaActivo: false, mfaSecret: null } });
      await tx.mfaCodigoRecuperacion.deleteMany({ where: { usuarioId: usuario.id } });
      await auditar(tx, req, { modulo: 'auth', accion: 'mfa.desactivar', recurso: 'usuario', recursoId: usuario.id });
    });
    res.json({ mensaje: 'Verificación en dos pasos desactivada' });
  },
);

router.post('/mfa/codigos', validar(z.object({ codigo: z.string().trim().regex(/^\d{6}$/, 'Ingrese el código de 6 dígitos') })), async (req, res) => {
  const usuario = await cargarUsuario(req);
  if (!usuario.mfaActivo) throw conflicto('La verificación en dos pasos no está activa');
  const codigos = await req.db(async (tx) => {
    if (!(await mfa.verificarSegundoFactor(tx, usuario, req.body.codigo)).ok) throw noAutenticado('Código incorrecto');
    await auditar(tx, req, { modulo: 'auth', accion: 'mfa.regenerar_codigos', recurso: 'usuario', recursoId: usuario.id });
    return mfa.regenerarCodigos(tx, { tenantId: req.tenantId, usuarioId: usuario.id });
  });
  res.json({ codigosRecuperacion: codigos });
});

export default router;
