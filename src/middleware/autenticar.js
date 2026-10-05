import { verificarAccessToken, sesionRevocada } from '../services/sesiones.js';
import { noAutenticado } from '../lib/errors.js';
import { prismaSystem, withTenant } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';

/** Valida el JWT de acceso y que la sesión no haya sido revocada. */
export async function autenticar(req, _res, next) {
  const h = req.get('authorization') || '';
  if (!h.startsWith('Bearer ')) throw noAutenticado();
  const user = verificarAccessToken(h.slice(7));
  if (await sesionRevocada(user.sesionId)) throw noAutenticado('Sesión cerrada');
  req.user = user;
  next();
}

/** Valida que el tenant del token exista y esté activo, e inyecta el acceso a datos con RLS. */
export async function contextoTenant(req, _res, next) {
  const { tenantId } = req.user;
  const clave = `tenant:activo:${tenantId}`;
  let activo = await redis.get(clave);
  if (activo === null) {
    const t = await prismaSystem.tenant.findUnique({ where: { id: tenantId }, select: { activo: true } });
    activo = t?.activo ? '1' : '0';
    await redis.set(clave, activo, 'EX', 300);
  }
  if (activo !== '1') throw noAutenticado('Estudio inactivo');
  req.tenantId = tenantId;
  req.db = (fn, opts) => withTenant(tenantId, fn, opts);
  next();
}
