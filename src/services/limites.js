import { conflicto } from '../lib/errors.js';

/**
 * Límites del plan contratado por el estudio (Módulo C). Se validan en el backend al crear
 * el recurso, dentro de la misma transacción (con RLS, los conteos son solo del estudio).
 * Un límite null significa ilimitado; un estudio sin plan no tiene límites.
 */
const RECURSOS = {
  empresas: { campo: 'maxEmpresas', contar: (tx) => tx.empresa.count() },
  usuarios: { campo: 'maxUsuarios', contar: (tx) => tx.usuario.count({ where: { estado: { not: 'suspendido' } } }) },
  almacenes: { campo: 'maxAlmacenes', contar: (tx) => tx.almacen.count() },
};

export async function verificarLimite(tx, tenantId, recurso) {
  const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { plan: true } });
  const max = tenant?.plan?.[RECURSOS[recurso].campo];
  if (max == null) return;
  const actual = await RECURSOS[recurso].contar(tx);
  if (actual >= max) {
    throw conflicto(`Su plan ${tenant.plan.nombre} permite hasta ${max} ${recurso}. Solicite una ampliación de plan para agregar más.`);
  }
}

/** Plan y consumo actual del estudio (para mostrarlo al administrador del estudio). */
export async function usoDelPlan(tx, tenantId) {
  const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { plan: true } });
  const uso = {};
  for (const [recurso, def] of Object.entries(RECURSOS)) {
    uso[recurso] = { usados: await def.contar(tx), maximo: tenant?.plan?.[def.campo] ?? null };
  }
  return { plan: tenant?.plan ? { codigo: tenant.plan.codigo, nombre: tenant.plan.nombre } : null, uso };
}
