import { noAutenticado, prohibido } from '../lib/errors.js';
import { prismaSystem } from '../lib/prisma.js';
import { contextoCliente } from '../lib/http.js';
import { sesionRevocada, verificarToken } from './sesiones.js';

/** Autenticación de plataforma (rechaza tokens de estudios: otro secreto y audiencia). */
export async function autenticarPlataforma(req, _res, next) {
  const h = req.get('authorization') || '';
  if (!h.startsWith('Bearer ')) throw noAutenticado();
  const admin = verificarToken(h.slice(7));
  if (await sesionRevocada(admin.sesionId)) throw noAutenticado('Sesión cerrada');
  req.admin = admin;
  next();
}

/** Acciones que cambian planes, facturación o el estado de un estudio: solo rol ADMIN. */
export function soloAdmin(req, _res, next) {
  if (req.admin.rol !== 'ADMIN') throw prohibido('Requiere rol ADMIN de plataforma');
  next();
}

/** Registro inmutable de acciones de plataforma. */
export function auditarPlataforma(req, { accion, recurso, recursoId, tenantId, antes, despues, adminId }, tx = prismaSystem) {
  const limpiar = (o) => (o == null ? undefined : JSON.parse(JSON.stringify(o, (k, v) => (['passwordHash', 'mfaSecret', 'refreshTokenHash'].includes(k) ? undefined : typeof v === 'bigint' ? v.toString() : v))));
  return tx.plataformaAuditoria.create({
    data: {
      adminId: adminId ?? req.admin?.id ?? null,
      tenantId: tenantId ?? null,
      accion,
      recurso,
      recursoId: recursoId != null ? String(recursoId) : null,
      antes: limpiar(antes),
      despues: limpiar(despues),
      ip: contextoCliente(req).ip,
    },
  });
}
