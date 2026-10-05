import { CATALOGO_PERMISOS, ROLES_PLANTILLA } from '../rbac/catalogo.js';

/**
 * Sincroniza el catálogo global de permisos con la BD (idempotente).
 * Los permisos que se crean por primera vez se agregan a los roles plantilla (es_sistema)
 * de cada estudio cuya definición los incluye; así, al agregar un módulo, el Administrador
 * recibe sus permisos y puede otorgarlos (sin ello la regla anti-escalamiento lo impediría).
 * Los permisos ya existentes no se tocan: respetan lo que cada estudio editó.
 */
export async function sincronizarCatalogo(prisma) {
  const existentes = new Set((await prisma.permiso.findMany({ select: { codigo: true } })).map((p) => p.codigo));
  const nuevos = [];
  for (const p of CATALOGO_PERMISOS) {
    const fila = await prisma.permiso.upsert({ where: { codigo: p.codigo }, update: p, create: p });
    if (!existentes.has(p.codigo)) nuevos.push(fila);
  }
  if (!nuevos.length || !existentes.size) return nuevos;

  for (const plantilla of ROLES_PLANTILLA) {
    const otorgar = nuevos.filter((p) => plantilla.permisos.includes(p.codigo));
    if (!otorgar.length) continue;
    const roles = await prisma.rol.findMany({ where: { nombre: plantilla.nombre, esSistema: true }, select: { id: true, tenantId: true } });
    await prisma.rolPermiso.createMany({
      data: roles.flatMap((r) => otorgar.map((p) => ({ rolId: r.id, permisoId: p.id, tenantId: r.tenantId }))),
      skipDuplicates: true,
    });
  }
  return nuevos;
}

/** Unidades de medida iniciales (catálogo 6 de SUNAT); el estudio puede agregar más. */
export const UNIDADES_BASE = [
  ['NIU', 'Unidad'], ['KGM', 'Kilogramo'], ['GRM', 'Gramo'], ['LTR', 'Litro'], ['MTR', 'Metro'],
  ['BX', 'Caja'], ['PK', 'Paquete'], ['GLL', 'Galón'], ['DZN', 'Docena'], ['ZZ', 'Servicio'],
];

export async function sembrarUnidades(tx, tenantId) {
  await tx.unidadMedida.createMany({
    data: UNIDADES_BASE.map(([codigo, nombre]) => ({ tenantId, codigo, nombre })),
    skipDuplicates: true,
  });
}

/** Crea un estudio con sus roles plantilla editables y catálogos base. Devuelve { tenant, roles }. */
export async function crearEstudio(tx, { nombre, ruc }) {
  const tenant = await tx.tenant.create({ data: { nombre, ruc } });
  const permisos = await tx.permiso.findMany({ select: { id: true, codigo: true } });
  const idDe = new Map(permisos.map((p) => [p.codigo, p.id]));
  const roles = {};
  for (const plantilla of ROLES_PLANTILLA) {
    roles[plantilla.nombre] = await tx.rol.create({
      data: {
        tenantId: tenant.id,
        nombre: plantilla.nombre,
        descripcion: plantilla.descripcion,
        requiereMfa: plantilla.requiereMfa ?? false,
        esSistema: true,
        permisos: {
          create: plantilla.permisos.map((codigo) => ({ permisoId: idDe.get(codigo), tenantId: tenant.id })),
        },
      },
    });
  }
  await sembrarUnidades(tx, tenant.id);
  return { tenant, roles };
}
