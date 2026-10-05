import { Router } from 'express';
import { z } from 'zod';
import { autorizar, alcance } from '../../middleware/autorizar.js';
import { validar } from '../../middleware/validar.js';
import { email } from '../../lib/esquemas.js';
import { puedeEnAlcance } from '../../rbac/resolver.js';
import { invalidarPermisos, verificarAdministradorRestante } from '../../rbac/servicio.js';
import { CATALOGO_PERMISOS } from '../../rbac/catalogo.js';
import { auditar } from '../../services/auditoria.js';
import { enviarInvitacion } from '../../services/correo.js';
import { revocarSesiones, revocarSesionesUsuario } from '../../services/sesiones.js';
import { crearInvitacion } from '../../services/invitaciones.js';
import { verificarLimite } from '../../services/limites.js';
import { paginacion, respuestaPaginada } from '../../lib/http.js';
import { conflicto, noEncontrado, prohibido, solicitudInvalida } from '../../lib/errors.js';

const router = Router();
const estudio = { alcance: alcance.estudio() };
const PERMISOS_LECTURA = new Set(CATALOGO_PERMISOS.filter((p) => p.lectura).map((p) => p.codigo));

const camposPublicos = {
  id: true, nombres: true, email: true, documento: true, cargo: true, telefono: true, tipo: true,
  estado: true, empresaId: true, mfaActivo: true, ultimoAcceso: true, creadoEn: true,
  empresa: { select: { id: true, razonSocial: true } },
};

const uuid = z.uuid();
const esquemaAlcance = z
  .object({ alcanceTipo: z.enum(['estudio', 'empresa', 'sede', 'almacen']), alcanceId: uuid.nullish() })
  .refine((v) => (v.alcanceTipo === 'estudio') === !v.alcanceId, {
    message: 'alcanceId es obligatorio salvo para alcance estudio',
    path: ['alcanceId'],
  });

/** Carga el alcance destino con su cadena de ancestros (404 si no existe en el tenant). */
async function resolverAlcance(tx, alcanceTipo, alcanceId) {
  if (alcanceTipo === 'estudio') return { tipo: 'estudio', id: null, empresaId: null, sedeId: null };
  if (alcanceTipo === 'empresa') {
    const e = await tx.empresa.findUnique({ where: { id: alcanceId }, select: { id: true } });
    if (e) return { tipo: 'empresa', id: e.id, empresaId: e.id, sedeId: null };
  }
  if (alcanceTipo === 'sede') {
    const s = await tx.sede.findUnique({ where: { id: alcanceId }, select: { id: true, empresaId: true } });
    if (s) return { tipo: 'sede', id: s.id, empresaId: s.empresaId, sedeId: s.id };
  }
  if (alcanceTipo === 'almacen') {
    const a = await tx.almacen.findUnique({ where: { id: alcanceId }, select: { id: true, empresaId: true, sedeId: true } });
    if (a) return { tipo: 'almacen', id: a.id, empresaId: a.empresaId, sedeId: a.sedeId };
  }
  throw noEncontrado('Alcance no encontrado');
}

async function cargarUsuario(tx, id) {
  const u = await tx.usuario.findUnique({ where: { id } });
  if (!u) throw noEncontrado();
  return u;
}

/** Reglas comunes al modificar asignaciones o excepciones de otro usuario. */
function validarGestionSobre(req, objetivo, destino) {
  if (objetivo.id === req.user.id) throw prohibido('No puede modificar sus propios permisos');
  if (!puedeEnAlcance(req.permisos, 'usuarios.roles.gestionar', destino)) throw noEncontrado('Alcance no encontrado');
}

/** Portal cliente: solo lectura y solo sobre su propia empresa. */
function validarReglasCliente(objetivo, destino, codigos) {
  if (objetivo.tipo !== 'cliente') return;
  if (destino.tipo === 'estudio' || destino.empresaId !== objetivo.empresaId) {
    throw solicitudInvalida('Un usuario cliente solo puede tener alcance dentro de su propia empresa');
  }
  const escritura = codigos.filter((c) => !PERMISOS_LECTURA.has(c));
  if (escritura.length) throw solicitudInvalida(`Un usuario cliente solo puede tener permisos de lectura: ${escritura.join(', ')}`);
}

// ───────────── CRUD ─────────────

router.get(
  '/',
  autorizar('usuarios.usuario.ver', estudio),
  validar(
    z.object({
      q: z.string().trim().max(100).optional(),
      estado: z.enum(['pendiente', 'activo', 'suspendido']).optional(),
      tipo: z.enum(['interno', 'cliente']).optional(),
      pagina: z.string().optional(),
      porPagina: z.string().optional(),
    }),
    'query',
  ),
  async (req, res) => {
    const { q, estado, tipo } = req.validQuery;
    const pag = paginacion(req.validQuery);
    const where = {
      ...(estado && { estado }),
      ...(tipo && { tipo }),
      ...(q && {
        OR: [
          { nombres: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
          { documento: { contains: q } },
        ],
      }),
    };
    const [datos, total] = await req.db((tx) =>
      Promise.all([
        tx.usuario.findMany({
          where, select: { ...camposPublicos, _count: { select: { asignaciones: true } } },
          orderBy: { nombres: 'asc' }, skip: pag.skip, take: pag.take,
        }),
        tx.usuario.count({ where }),
      ]),
    );
    res.json(respuestaPaginada(datos, total, pag));
  },
);

router.get('/:id', autorizar('usuarios.usuario.ver', estudio), async (req, res) => {
  const usuario = await req.db(async (tx) => {
    const u = await tx.usuario.findUnique({
      where: { id: req.params.id },
      select: {
        ...camposPublicos,
        asignaciones: { select: { id: true, alcanceTipo: true, alcanceId: true, rol: { select: { id: true, nombre: true, activo: true } } } },
        excepciones: { select: { id: true, efecto: true, alcanceTipo: true, alcanceId: true, permiso: { select: { codigo: true, descripcion: true } } } },
      },
    });
    if (!u) throw noEncontrado();
    // Nombres legibles de los alcances
    const ids = [...u.asignaciones, ...u.excepciones].map((a) => a.alcanceId).filter(Boolean);
    const [empresas, sedes, almacenes] = await Promise.all([
      tx.empresa.findMany({ where: { id: { in: ids } }, select: { id: true, razonSocial: true } }),
      tx.sede.findMany({ where: { id: { in: ids } }, select: { id: true, nombre: true, empresa: { select: { razonSocial: true } } } }),
      tx.almacen.findMany({ where: { id: { in: ids } }, select: { id: true, nombre: true, sede: { select: { nombre: true } }, empresa: { select: { razonSocial: true } } } }),
    ]);
    const nombres = new Map([
      ...empresas.map((e) => [e.id, e.razonSocial]),
      ...sedes.map((s) => [s.id, `${s.empresa.razonSocial} › ${s.nombre}`]),
      ...almacenes.map((a) => [a.id, `${a.empresa.razonSocial} › ${a.sede.nombre} › ${a.nombre}`]),
    ]);
    const conNombre = (x) => ({ ...x, alcanceNombre: x.alcanceId ? nombres.get(x.alcanceId) ?? '(eliminado)' : 'Todo el estudio' });
    return { ...u, asignaciones: u.asignaciones.map(conNombre), excepciones: u.excepciones.map(conNombre) };
  });
  res.json(usuario);
});

const esquemaDatos = {
  nombres: z.string().trim().min(2).max(150),
  documento: z.string().trim().max(20).nullish(),
  cargo: z.string().trim().max(100).nullish(),
  telefono: z.string().trim().max(30).nullish(),
};

router.post(
  '/',
  autorizar('usuarios.usuario.crear', estudio),
  validar(
    z
      .object({
        ...esquemaDatos,
        email: email(),
        tipo: z.enum(['interno', 'cliente']).default('interno'),
        empresaId: uuid.nullish(),
      })
      .refine((v) => v.tipo !== 'cliente' || v.empresaId, { message: 'Un usuario cliente requiere empresa', path: ['empresaId'] }),
  ),
  async (req, res) => {
    const datos = { ...req.body, empresaId: req.body.tipo === 'cliente' ? req.body.empresaId : null };
    const { usuario, token } = await req.db(async (tx) => {
      if (datos.empresaId && !(await tx.empresa.findUnique({ where: { id: datos.empresaId } }))) {
        throw solicitudInvalida('Empresa no encontrada');
      }
      await verificarLimite(tx, req.tenantId, 'usuarios');
      const creado = await tx.usuario.create({ data: { ...datos, tenantId: req.tenantId, estado: 'pendiente' } });
      const token = await crearInvitacion(tx, creado);
      await auditar(tx, req, { modulo: 'usuarios', accion: 'usuario.invitar', recurso: 'usuario', recursoId: creado.id, empresaId: creado.empresaId, despues: creado });
      return { usuario: creado, token };
    });
    await enviarInvitacion({ email: usuario.email, nombres: usuario.nombres, token });
    res.status(201).json({ id: usuario.id, email: usuario.email, estado: usuario.estado });
  },
);

router.put('/:id', autorizar('usuarios.usuario.editar', estudio), validar(z.object(esquemaDatos)), async (req, res) => {
  const usuario = await req.db(async (tx) => {
    const antes = await cargarUsuario(tx, req.params.id);
    const despues = await tx.usuario.update({ where: { id: antes.id }, data: req.body, select: camposPublicos });
    await auditar(tx, req, { modulo: 'usuarios', accion: 'usuario.editar', recurso: 'usuario', recursoId: antes.id, antes, despues });
    return despues;
  });
  res.json(usuario);
});

router.patch(
  '/:id/estado',
  autorizar('usuarios.usuario.editar', estudio),
  validar(z.object({ estado: z.enum(['activo', 'suspendido']) })),
  async (req, res) => {
    if (req.params.id === req.user.id) throw prohibido('No puede cambiar su propio estado');
    const usuario = await req.db(async (tx) => {
      const antes = await cargarUsuario(tx, req.params.id);
      if (antes.estado === 'pendiente' && req.body.estado === 'activo') {
        throw conflicto('El usuario debe activar su cuenta desde la invitación');
      }
      const despues = await tx.usuario.update({ where: { id: antes.id }, data: { estado: req.body.estado }, select: camposPublicos });
      await verificarAdministradorRestante(tx);
      await auditar(tx, req, {
        modulo: 'usuarios', accion: req.body.estado === 'suspendido' ? 'usuario.suspender' : 'usuario.reactivar',
        recurso: 'usuario', recursoId: antes.id, antes: { estado: antes.estado }, despues: { estado: despues.estado },
      });
      return despues;
    });
    // Suspensión inmediata: cierra todas las sesiones y sockets
    if (usuario.estado === 'suspendido') await revocarSesionesUsuario(usuario.id);
    await invalidarPermisos([usuario.id]);
    res.json(usuario);
  },
);

router.post('/:id/reenviar-invitacion', autorizar('usuarios.usuario.crear', estudio), async (req, res) => {
  const { usuario, token } = await req.db(async (tx) => {
    const u = await cargarUsuario(tx, req.params.id);
    if (u.estado !== 'pendiente') throw conflicto('El usuario ya activó su cuenta');
    const token = await crearInvitacion(tx, u);
    await auditar(tx, req, { modulo: 'usuarios', accion: 'usuario.reenviar_invitacion', recurso: 'usuario', recursoId: u.id });
    return { usuario: u, token };
  });
  await enviarInvitacion({ email: usuario.email, nombres: usuario.nombres, token });
  res.json({ mensaje: 'Invitación reenviada' });
});

// ───────────── 2FA: restablecimiento por un administrador (p. ej. celular perdido) ─────────────

router.post('/:id/mfa/restablecer', autorizar('usuarios.usuario.editar', estudio), async (req, res) => {
  if (req.params.id === req.user.id) throw prohibido('Use su perfil para gestionar su propia verificación en dos pasos');
  await req.db(async (tx) => {
    const u = await cargarUsuario(tx, req.params.id);
    await tx.usuario.update({ where: { id: u.id }, data: { mfaActivo: false, mfaSecret: null } });
    await tx.mfaCodigoRecuperacion.deleteMany({ where: { usuarioId: u.id } });
    await auditar(tx, req, { modulo: 'usuarios', accion: 'mfa.restablecer', recurso: 'usuario', recursoId: u.id, antes: { mfaActivo: u.mfaActivo }, despues: { mfaActivo: false } });
  });
  // Por seguridad se cierran sus sesiones: deberá volver a ingresar (y configurar 2FA si su rol lo exige)
  await revocarSesionesUsuario(req.params.id);
  res.json({ mensaje: 'Verificación en dos pasos restablecida' });
});

// ───────────── Sesiones de otros usuarios ─────────────

router.get('/:id/sesiones', autorizar('usuarios.sesiones.gestionar', estudio), async (req, res) => {
  const sesiones = await req.db((tx) =>
    tx.sesion.findMany({
      where: { usuarioId: req.params.id, revocada: false, expiraEn: { gt: new Date() } },
      select: { id: true, dispositivo: true, ip: true, creadaEn: true, ultimoUso: true },
      orderBy: { ultimoUso: 'desc' },
    }),
  );
  res.json(sesiones);
});

router.delete('/:id/sesiones', autorizar('usuarios.sesiones.gestionar', estudio), async (req, res) => {
  const ids = await req.db(async (tx) => {
    await cargarUsuario(tx, req.params.id);
    const s = await tx.sesion.findMany({ where: { usuarioId: req.params.id, revocada: false }, select: { id: true } });
    await auditar(tx, req, { modulo: 'usuarios', accion: 'sesiones.cerrar_todas', recurso: 'usuario', recursoId: req.params.id });
    return s.map((x) => x.id);
  });
  await revocarSesiones(ids);
  res.status(204).end();
});

// ───────────── Asignación de roles con alcance ─────────────

router.post(
  '/:id/asignaciones',
  autorizar('usuarios.roles.gestionar'),
  validar(esquemaAlcance.and(z.object({ rolId: uuid }))),
  async (req, res) => {
    const { rolId, alcanceTipo } = req.body;
    const alcanceId = alcanceTipo === 'estudio' ? null : req.body.alcanceId;
    const asignacion = await req.db(async (tx) => {
      const objetivo = await cargarUsuario(tx, req.params.id);
      const destino = await resolverAlcance(tx, alcanceTipo, alcanceId);
      validarGestionSobre(req, objetivo, destino);

      const rol = await tx.rol.findUnique({
        where: { id: rolId },
        include: { permisos: { select: { permiso: { select: { codigo: true } } } } },
      });
      if (!rol) throw noEncontrado('Rol no encontrado');
      if (!rol.activo) throw conflicto('El rol está desactivado');
      const codigos = rol.permisos.map((p) => p.permiso.codigo);

      // Anti-escalamiento: debe tener TODOS los permisos del rol sobre el alcance destino
      const ajenos = codigos.filter((c) => !puedeEnAlcance(req.permisos, c, destino));
      if (ajenos.length) throw prohibido(`No puede asignar un rol con permisos que usted no tiene en ese alcance: ${ajenos.join(', ')}`);
      validarReglasCliente(objetivo, destino, codigos);

      const creada = await tx.usuarioRol.create({
        data: { tenantId: req.tenantId, usuarioId: objetivo.id, rolId, alcanceTipo, alcanceId },
      });
      await auditar(tx, req, {
        modulo: 'usuarios', accion: 'asignacion.crear', recurso: 'usuario', recursoId: objetivo.id,
        empresaId: destino.empresaId, despues: { rol: rol.nombre, alcanceTipo, alcanceId },
      });
      return creada;
    });
    await invalidarPermisos([req.params.id]);
    res.status(201).json(asignacion);
  },
);

router.delete('/:id/asignaciones/:asignacionId', autorizar('usuarios.roles.gestionar'), async (req, res) => {
  await req.db(async (tx) => {
    const objetivo = await cargarUsuario(tx, req.params.id);
    const a = await tx.usuarioRol.findFirst({
      where: { id: req.params.asignacionId, usuarioId: objetivo.id },
      include: { rol: { select: { nombre: true } } },
    });
    if (!a) throw noEncontrado();
    const destino = await resolverAlcance(tx, a.alcanceTipo, a.alcanceId).catch(() => ({ tipo: 'estudio' }));
    validarGestionSobre(req, objetivo, destino);
    await tx.usuarioRol.delete({ where: { id: a.id } });
    await verificarAdministradorRestante(tx);
    await auditar(tx, req, {
      modulo: 'usuarios', accion: 'asignacion.eliminar', recurso: 'usuario', recursoId: objetivo.id,
      empresaId: destino.empresaId ?? null, antes: { rol: a.rol.nombre, alcanceTipo: a.alcanceTipo, alcanceId: a.alcanceId },
    });
  });
  await invalidarPermisos([req.params.id]);
  res.status(204).end();
});

// ───────────── Excepciones allow/deny por permiso ─────────────

router.post(
  '/:id/excepciones',
  autorizar('usuarios.roles.gestionar'),
  validar(esquemaAlcance.and(z.object({ permiso: z.string().max(100), efecto: z.enum(['allow', 'deny']) }))),
  async (req, res) => {
    const { permiso, efecto, alcanceTipo } = req.body;
    const alcanceId = alcanceTipo === 'estudio' ? null : req.body.alcanceId;
    const excepcion = await req.db(async (tx) => {
      const objetivo = await cargarUsuario(tx, req.params.id);
      const destino = await resolverAlcance(tx, alcanceTipo, alcanceId);
      validarGestionSobre(req, objetivo, destino);
      const p = await tx.permiso.findUnique({ where: { codigo: permiso } });
      if (!p) throw solicitudInvalida('Permiso inexistente');
      if (efecto === 'allow') {
        if (!puedeEnAlcance(req.permisos, permiso, destino)) throw prohibido('No puede otorgar un permiso que usted no tiene en ese alcance');
        validarReglasCliente(objetivo, destino, [permiso]);
      }
      const creada = await tx.usuarioPermisoExcepcion.create({
        data: { tenantId: req.tenantId, usuarioId: objetivo.id, permisoId: p.id, efecto, alcanceTipo, alcanceId },
      });
      if (efecto === 'deny') await verificarAdministradorRestante(tx);
      await auditar(tx, req, {
        modulo: 'usuarios', accion: 'excepcion.crear', recurso: 'usuario', recursoId: objetivo.id,
        empresaId: destino.empresaId, despues: { permiso, efecto, alcanceTipo, alcanceId },
      });
      return creada;
    });
    await invalidarPermisos([req.params.id]);
    res.status(201).json(excepcion);
  },
);

router.delete('/:id/excepciones/:excepcionId', autorizar('usuarios.roles.gestionar'), async (req, res) => {
  await req.db(async (tx) => {
    const objetivo = await cargarUsuario(tx, req.params.id);
    const e = await tx.usuarioPermisoExcepcion.findFirst({
      where: { id: req.params.excepcionId, usuarioId: objetivo.id },
      include: { permiso: { select: { codigo: true } } },
    });
    if (!e) throw noEncontrado();
    const destino = await resolverAlcance(tx, e.alcanceTipo, e.alcanceId).catch(() => ({ tipo: 'estudio' }));
    validarGestionSobre(req, objetivo, destino);
    await tx.usuarioPermisoExcepcion.delete({ where: { id: e.id } });
    await verificarAdministradorRestante(tx);
    await auditar(tx, req, {
      modulo: 'usuarios', accion: 'excepcion.eliminar', recurso: 'usuario', recursoId: objetivo.id,
      empresaId: destino.empresaId ?? null, antes: { permiso: e.permiso.codigo, efecto: e.efecto, alcanceTipo: e.alcanceTipo, alcanceId: e.alcanceId },
    });
  });
  await invalidarPermisos([req.params.id]);
  res.status(204).end();
});

export default router;
