/** Datos del cliente para auditoría y sesiones. */
export function contextoCliente(req) {
  return {
    ip: req.ip,
    dispositivo: (req.get('user-agent') || '').slice(0, 255) || null,
  };
}

/** Parámetros de paginación normalizados. */
export function paginacion(query, { maxPorPagina = 100 } = {}) {
  const pagina = Math.max(1, Number.parseInt(query.pagina, 10) || 1);
  const porPagina = Math.min(maxPorPagina, Math.max(1, Number.parseInt(query.porPagina, 10) || 20));
  return { pagina, porPagina, skip: (pagina - 1) * porPagina, take: porPagina };
}

export const respuestaPaginada = (datos, total, { pagina, porPagina }) => ({
  datos,
  total,
  pagina,
  porPagina,
  paginas: Math.ceil(total / porPagina),
});

/** Limpia asignaciones y excepciones que apuntan a un alcance eliminado. Devuelve usuarios afectados. */
export async function limpiarAlcances(tx, alcanceIds) {
  const where = { alcanceId: { in: alcanceIds } };
  const [a, e] = await Promise.all([
    tx.usuarioRol.findMany({ where, select: { usuarioId: true } }),
    tx.usuarioPermisoExcepcion.findMany({ where, select: { usuarioId: true } }),
  ]);
  await tx.usuarioRol.deleteMany({ where });
  await tx.usuarioPermisoExcepcion.deleteMany({ where });
  return [...a, ...e].map((x) => x.usuarioId);
}
