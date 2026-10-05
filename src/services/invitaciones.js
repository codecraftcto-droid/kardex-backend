import { sha256, tokenAleatorio } from '../lib/crypto.js';

/** Genera una invitación de activación (72 h) e invalida las anteriores. Devuelve el token en claro. */
export async function crearInvitacion(tx, usuario) {
  const token = tokenAleatorio(32);
  await tx.tokenUsuario.updateMany({
    where: { usuarioId: usuario.id, tipo: 'invitacion', usadoEn: null },
    data: { usadoEn: new Date() },
  });
  await tx.tokenUsuario.create({
    data: {
      tenantId: usuario.tenantId,
      usuarioId: usuario.id,
      tipo: 'invitacion',
      tokenHash: sha256(token),
      expiraEn: new Date(Date.now() + 72 * 3600_000),
    },
  });
  return token;
}
