import { contextoCliente } from '../lib/http.js';

/** Convierte valores no serializables (BigInt, Date) y quita secretos. */
function limpiar(obj) {
  if (obj == null) return undefined;
  return JSON.parse(
    JSON.stringify(obj, (k, v) => {
      if (['passwordHash', 'mfaSecret', 'refreshTokenHash', 'tokenHash'].includes(k)) return undefined;
      return typeof v === 'bigint' ? v.toString() : v;
    }),
  );
}

/**
 * Registra un evento inmutable en la misma transacción que la operación auditada.
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 */
export function auditar(tx, req, { modulo, accion, recurso, recursoId, empresaId, antes, despues, usuarioId, tenantId }) {
  const { ip, dispositivo } = contextoCliente(req);
  return tx.auditoria.create({
    data: {
      tenantId: tenantId ?? req.user.tenantId,
      usuarioId: usuarioId ?? req.user?.id ?? null,
      empresaId: empresaId ?? null,
      modulo,
      accion,
      recurso,
      recursoId: recursoId != null ? String(recursoId) : null,
      antes: limpiar(antes),
      despues: limpiar(despues),
      ip,
      dispositivo,
    },
  });
}
