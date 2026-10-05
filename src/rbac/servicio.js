import { withTenant } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import { conflicto } from '../lib/errors.js';
import { CATALOGO_PERMISOS, PERMISO_ADMIN } from './catalogo.js';
import { construirPermisos } from './resolver.js';
import { reevaluarSalasUsuario } from '../realtime/socket.js';

const CLAVE = (usuarioId) => `rbac:permisos:${usuarioId}`;
const TTL_SEGUNDOS = 600;
const PERMISOS_LECTURA = new Set(CATALOGO_PERMISOS.filter((p) => p.lectura).map((p) => p.codigo));

/** Resuelve la cadena de ancestros de los alcances referenciados. */
async function resolverAlcances(tx, filas) {
  const sedeIds = filas.filter((f) => f.alcanceTipo === 'sede').map((f) => f.alcanceId);
  const almacenIds = filas.filter((f) => f.alcanceTipo === 'almacen').map((f) => f.alcanceId);
  const empresaIds = filas.filter((f) => f.alcanceTipo === 'empresa').map((f) => f.alcanceId);
  const [sedes, almacenes, empresas] = await Promise.all([
    sedeIds.length ? tx.sede.findMany({ where: { id: { in: sedeIds } }, select: { id: true, empresaId: true } }) : [],
    almacenIds.length
      ? tx.almacen.findMany({ where: { id: { in: almacenIds } }, select: { id: true, empresaId: true, sedeId: true } })
      : [],
    empresaIds.length ? tx.empresa.findMany({ where: { id: { in: empresaIds } }, select: { id: true } }) : [],
  ]);
  const mSede = new Map(sedes.map((s) => [s.id, s]));
  const mAlm = new Map(almacenes.map((a) => [a.id, a]));
  const sEmp = new Set(empresas.map((e) => e.id));

  return (f) => {
    switch (f.alcanceTipo) {
      case 'estudio':
        return { tipo: 'estudio', id: null, empresaId: null, sedeId: null };
      case 'empresa':
        return sEmp.has(f.alcanceId) ? { tipo: 'empresa', id: f.alcanceId, empresaId: f.alcanceId, sedeId: null } : null;
      case 'sede': {
        const s = mSede.get(f.alcanceId);
        return s ? { tipo: 'sede', id: s.id, empresaId: s.empresaId, sedeId: s.id } : null;
      }
      case 'almacen': {
        const a = mAlm.get(f.alcanceId);
        return a ? { tipo: 'almacen', id: a.id, empresaId: a.empresaId, sedeId: a.sedeId } : null;
      }
      default:
        return null;
    }
  };
}

export async function calcularPermisos(tx, usuarioId) {
  const usuario = await tx.usuario.findUnique({ where: { id: usuarioId }, select: { tipo: true, empresaId: true } });
  if (!usuario) return construirPermisos({ tipoUsuario: 'interno', asignaciones: [] });

  const [asignaciones, excepciones] = await Promise.all([
    tx.usuarioRol.findMany({
      where: { usuarioId, rol: { activo: true } },
      select: {
        alcanceTipo: true,
        alcanceId: true,
        rol: { select: { permisos: { select: { permiso: { select: { codigo: true } } } } } },
      },
    }),
    tx.usuarioPermisoExcepcion.findMany({
      where: { usuarioId },
      select: { alcanceTipo: true, alcanceId: true, efecto: true, permiso: { select: { codigo: true } } },
    }),
  ]);
  const alcanceDe = await resolverAlcances(tx, [...asignaciones, ...excepciones]);

  return construirPermisos({
    tipoUsuario: usuario.tipo,
    empresaCliente: usuario.empresaId,
    permisosLectura: PERMISOS_LECTURA,
    asignaciones: asignaciones
      .map((a) => ({ alcance: alcanceDe(a), permisos: a.rol.permisos.map((rp) => rp.permiso.codigo) }))
      .filter((a) => a.alcance),
    excepciones: excepciones
      .map((e) => ({ alcance: alcanceDe(e), permiso: e.permiso.codigo, efecto: e.efecto }))
      .filter((e) => e.alcance),
  });
}

/** Permisos efectivos con caché en Redis. */
export async function obtenerPermisos({ id, tenantId }) {
  const cache = await redis.get(CLAVE(id));
  if (cache) return JSON.parse(cache);
  const perms = await withTenant(tenantId, (tx) => calcularPermisos(tx, id));
  await redis.set(CLAVE(id), JSON.stringify(perms), 'EX', TTL_SEGUNDOS);
  return perms;
}

/**
 * Invalida la caché y reevalúa las salas de Socket.io de los usuarios afectados.
 * Llamar DESPUÉS de confirmar la transacción.
 */
export async function invalidarPermisos(usuarioIds) {
  const ids = [...new Set(usuarioIds)].filter(Boolean);
  if (!ids.length) return;
  await redis.del(...ids.map(CLAVE));
  await Promise.all(ids.map((id) => reevaluarSalasUsuario(id)));
}

export async function usuariosConRol(tx, rolId) {
  const filas = await tx.usuarioRol.findMany({ where: { rolId }, select: { usuarioId: true }, distinct: ['usuarioId'] });
  return filas.map((f) => f.usuarioId);
}

/**
 * Regla: no puede quedar el estudio sin administrador. Se ejecuta DENTRO de la
 * transacción que modifica roles/asignaciones/usuarios, para que se revierta si falla.
 */
export async function verificarAdministradorRestante(tx) {
  const total = await tx.usuario.count({
    where: {
      estado: 'activo',
      tipo: 'interno',
      asignaciones: {
        some: {
          alcanceTipo: 'estudio',
          rol: { activo: true, permisos: { some: { permiso: { codigo: PERMISO_ADMIN } } } },
        },
      },
      NOT: { excepciones: { some: { efecto: 'deny', alcanceTipo: 'estudio', permiso: { codigo: PERMISO_ADMIN } } } },
    },
  });
  if (total === 0) throw conflicto('Operación rechazada: el estudio debe conservar al menos un administrador activo');
}
