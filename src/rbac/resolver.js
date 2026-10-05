/**
 * Resolución PURA de permisos efectivos (sin BD), fácil de testear.
 *
 * Un "alcance" es { tipo: 'estudio'|'empresa'|'sede'|'almacen', id, empresaId, sedeId }.
 * Un "recurso" es { empresaId?, sedeId?, almacenId? } con su cadena de ancestros.
 * El alcance hereda hacia abajo: un rol en una empresa cubre sus sedes y almacenes.
 */

export function cubre(alcance, recurso) {
  switch (alcance.tipo) {
    case 'estudio':
      return true;
    case 'empresa':
      return !!recurso.empresaId && recurso.empresaId === alcance.id;
    case 'sede':
      return !!recurso.sedeId && recurso.sedeId === alcance.id;
    case 'almacen':
      return !!recurso.almacenId && recurso.almacenId === alcance.id;
    default:
      return false;
  }
}

/**
 * @param {object} p
 * @param {'interno'|'cliente'} p.tipoUsuario
 * @param {{alcance: object, permisos: string[]}[]} p.asignaciones  roles activos con su alcance
 * @param {{alcance: object, permiso: string, efecto: 'allow'|'deny'}[]} p.excepciones
 * @param {Set<string>} [p.permisosLectura] códigos de solo lectura (filtra para usuarios cliente)
 * @param {string|null} [p.empresaCliente] empresa del usuario cliente
 */
export function construirPermisos({ tipoUsuario, asignaciones, excepciones = [], permisosLectura, empresaCliente = null }) {
  const grants = {};
  const denies = {};
  const esCliente = tipoUsuario === 'cliente';

  const permitido = (codigo, alcance) => {
    if (!esCliente) return true;
    // Portal cliente: solo lectura y solo dentro de su empresa
    return permisosLectura?.has(codigo) && alcance.tipo !== 'estudio' && alcance.empresaId === empresaCliente;
  };
  const agregar = (mapa, codigo, alcance) => {
    (mapa[codigo] ||= []).push(alcance);
  };

  for (const { alcance, permisos } of asignaciones) {
    for (const codigo of permisos) if (permitido(codigo, alcance)) agregar(grants, codigo, alcance);
  }
  for (const { alcance, permiso, efecto } of excepciones) {
    if (efecto === 'deny') agregar(denies, permiso, alcance);
    else if (permitido(permiso, alcance)) agregar(grants, permiso, alcance);
  }
  return { tipoUsuario, grants, denies };
}

/** ¿Tiene el permiso en algún alcance? (para decidir 403 vs. revisar alcance) */
export function tieneAlguno(perms, codigo) {
  const g = perms.grants[codigo] || [];
  const d = perms.denies[codigo] || [];
  if (d.some((a) => a.tipo === 'estudio')) return false;
  return g.length > 0;
}

/** Permiso efectivo sobre un recurso concreto. `deny` tiene prioridad sobre `allow`. */
export function puede(perms, codigo, recurso = {}) {
  if ((perms.denies[codigo] || []).some((a) => cubre(a, recurso))) return false;
  return (perms.grants[codigo] || []).some((a) => cubre(a, recurso));
}

/** ¿El usuario tiene `codigo` cubriendo TODO el alcance destino? (anti-escalamiento) */
export function puedeEnAlcance(perms, codigo, alcanceDestino) {
  return puede(perms, codigo, recursoDeAlcance(alcanceDestino));
}

export function recursoDeAlcance(alcance) {
  switch (alcance.tipo) {
    case 'empresa':
      return { empresaId: alcance.id };
    case 'sede':
      return { empresaId: alcance.empresaId, sedeId: alcance.id };
    case 'almacen':
      return { empresaId: alcance.empresaId, sedeId: alcance.sedeId, almacenId: alcance.id };
    default:
      return {};
  }
}

/**
 * Construye un filtro Prisma para listar registros de `nivel` sobre los que el
 * usuario tiene `codigo`. Devuelve `null` si no puede ver ninguno.
 * nivel: 'empresa' | 'sede' | 'almacen' | 'registro' | { empresa, sede, almacen } (nombres de campo)
 */
export function whereAlcance(perms, codigo, nivel) {
  const grants = perms.grants[codigo] || [];
  const denies = perms.denies[codigo] || [];
  if (!grants.length || denies.some((a) => a.tipo === 'estudio')) return null;

  const campo = typeof nivel === 'object' ? nivel : {
    empresa: { empresa: 'id' },
    sede: { empresa: 'empresaId', sede: 'id' },
    almacen: { empresa: 'empresaId', sede: 'sedeId', almacen: 'id' },
    // Registros que pertenecen a un almacén (stock, movimientos)
    registro: { empresa: 'empresaId', sede: 'sedeId', almacen: 'almacenId' },
  }[nivel];

  const condiciones = (lista) => {
    const ors = [];
    for (const tipo of ['empresa', 'sede', 'almacen']) {
      if (!campo[tipo]) continue;
      const ids = [...new Set(lista.filter((a) => a.tipo === tipo).map((a) => a.id))];
      if (ids.length) ors.push({ [campo[tipo]]: { in: ids } });
    }
    return ors;
  };

  const where = {};
  if (!grants.some((a) => a.tipo === 'estudio')) {
    const ors = condiciones(grants);
    if (!ors.length) return null; // p.ej. rol solo en almacén: no ve la empresa
    where.OR = ors;
  }
  const negados = condiciones(denies);
  if (negados.length) where.NOT = { OR: negados };
  return where;
}

/** Empresas a las que el usuario tiene alguna asignación (selector de contexto). */
export function empresasConAcceso(perms) {
  const todas = Object.values(perms.grants).flat();
  if (todas.some((a) => a.tipo === 'estudio')) return 'todas';
  return [...new Set(todas.map((a) => a.empresaId).filter(Boolean))];
}

/**
 * ¿Tiene el permiso en algún punto DENTRO de la empresa? (estudio, la empresa, o una de
 * sus sedes/almacenes). Para recursos compartidos por toda la empresa, como el catálogo
 * de productos: un almacenero de un solo almacén también necesita ver los productos.
 */
export function puedeDentroDeEmpresa(perms, codigo, empresaId) {
  if (!empresaId) return false;
  const denies = perms.denies[codigo] || [];
  if (denies.some((a) => a.tipo === 'estudio' || (a.tipo === 'empresa' && a.id === empresaId))) return false;
  return (perms.grants[codigo] || []).some((a) => a.tipo === 'estudio' || a.empresaId === empresaId);
}
