import { obtenerPermisos } from '../rbac/servicio.js';
import { tieneAlguno, puede, puedeDentroDeEmpresa } from '../rbac/resolver.js';
import { prohibido, noEncontrado } from '../lib/errors.js';

/**
 * Guard de permisos: authorize('codigo.permiso', { alcance }).
 * - Sin el permiso en ningún alcance → 403.
 * - Con el permiso, pero el recurso no existe o está fuera de su alcance → 404
 *   (no se revela la existencia de recursos ajenos).
 * `alcance` es una función (req) => Promise<{empresaId?, sedeId?, almacenId?} | null>.
 */
export function autorizar(codigo, { alcance } = {}) {
  return async (req, _res, next) => {
    const perms = await obtenerPermisos(req.user);
    req.permisos = perms;
    if (!tieneAlguno(perms, codigo)) throw prohibido();
    if (alcance) {
      const recurso = await alcance(req);
      if (!recurso) throw noEncontrado();
      if (!puede(perms, codigo, recurso)) {
        // Operaciones a nivel estudio no ocultan ningún recurso: 403 explícito
        throw Object.keys(recurso).length ? noEncontrado() : prohibido('Esta acción requiere alcance sobre todo el estudio');
      }
      req.recurso = recurso;
    }
    next();
  };
}

/**
 * Guard para recursos de toda la empresa (productos, categorías): basta tener el
 * permiso en cualquier alcance dentro de ella. `empresaDe(req)` devuelve el empresaId
 * del recurso (o null si no existe → 404).
 */
export function autorizarEnEmpresa(codigo, empresaDe) {
  return async (req, _res, next) => {
    const perms = await obtenerPermisos(req.user);
    req.permisos = perms;
    if (!tieneAlguno(perms, codigo)) throw prohibido();
    const empresaId = await empresaDe(req);
    if (!empresaId || !puedeDentroDeEmpresa(perms, codigo, empresaId)) throw noEncontrado();
    req.empresaId = empresaId;
    next();
  };
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const leer = (req, origen, campo) => (origen === 'params' ? req.params : origen === 'query' ? req.query : req.body)?.[campo];

/** Resolutores de alcance: cargan la cadena de ancestros del recurso (bajo RLS). */
export const alcance = {
  estudio: () => async () => ({}),
  empresa: (campo = 'empresaId', origen = 'params') => async (req) => {
    const id = leer(req, origen, campo);
    if (!uuid.test(id || '')) return null;
    const e = await req.db((tx) => tx.empresa.findUnique({ where: { id }, select: { id: true } }));
    return e && { empresaId: e.id };
  },
  sede: (campo = 'sedeId', origen = 'params') => async (req) => {
    const id = leer(req, origen, campo);
    if (!uuid.test(id || '')) return null;
    const s = await req.db((tx) => tx.sede.findUnique({ where: { id }, select: { id: true, empresaId: true } }));
    return s && { empresaId: s.empresaId, sedeId: s.id };
  },
  almacen: (campo = 'almacenId', origen = 'params') => async (req) => {
    const id = leer(req, origen, campo);
    if (!uuid.test(id || '')) return null;
    const a = await req.db((tx) =>
      tx.almacen.findUnique({ where: { id }, select: { id: true, empresaId: true, sedeId: true } }),
    );
    return a && { empresaId: a.empresaId, sedeId: a.sedeId, almacenId: a.id };
  },
};
