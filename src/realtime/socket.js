import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { env } from '../config/env.js';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { withTenant } from '../lib/prisma.js';
import { verificarAccessToken, sesionRevocada } from '../services/sesiones.js';
import { obtenerPermisos } from '../rbac/servicio.js';

/**
 * Salas:
 *  tenant:{id}   — todos los usuarios del estudio (avisos generales)
 *  usuario:{id}  — eventos personales (p. ej. permisos actualizados)
 *  sesion:{id}   — para expulsar una sesión concreta
 *  empresa:{id}  — solo usuarios con alcance estudio/empresa sobre esa empresa
 *  almacen:{id}  — usuarios cuyo alcance cubre ese almacén
 */
let io = null;
const DINAMICAS = /^(empresa|almacen):/;

async function salasPermitidas(user) {
  const perms = await obtenerPermisos(user);
  const alcances = Object.values(perms.grants).flat();
  if (!alcances.length) return new Set();

  const estudio = alcances.some((a) => a.tipo === 'estudio');
  const ids = (tipo) => [...new Set(alcances.filter((a) => a.tipo === tipo).map((a) => a.id))];
  const [empresaIds, sedeIds, almacenIds] = [ids('empresa'), ids('sede'), ids('almacen')];

  const { empresas, almacenes } = await withTenant(user.tenantId, async (tx) => ({
    empresas: estudio ? await tx.empresa.findMany({ select: { id: true } }) : empresaIds.map((id) => ({ id })),
    almacenes: await tx.almacen.findMany({
      where: estudio
        ? {}
        : { OR: [{ empresaId: { in: empresaIds } }, { sedeId: { in: sedeIds } }, { id: { in: almacenIds } }] },
      select: { id: true },
    }),
  }));
  return new Set([...empresas.map((e) => `empresa:${e.id}`), ...almacenes.map((a) => `almacen:${a.id}`)]);
}

async function sincronizarSalas(socket, user) {
  const deseadas = await salasPermitidas(user);
  for (const sala of socket.rooms) if (DINAMICAS.test(sala) && !deseadas.has(sala)) socket.leave(sala);
  for (const sala of deseadas) if (!socket.rooms.has(sala)) socket.join(sala);
}

export function iniciarSocket(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: env.corsOrigins, credentials: true },
  });
  const pub = redis.duplicate();
  const sub = redis.duplicate();
  io.adapter(createAdapter(pub, sub));

  // Autenticación en el handshake
  io.use(async (socket, next) => {
    try {
      const user = verificarAccessToken(socket.handshake.auth?.token);
      if (await sesionRevocada(user.sesionId)) return next(new Error('Sesión cerrada'));
      socket.data.user = user;
      next();
    } catch {
      next(new Error('No autenticado'));
    }
  });

  io.on('connection', async (socket) => {
    const user = socket.data.user;
    socket.join([`tenant:${user.tenantId}`, `usuario:${user.id}`, `sesion:${user.sesionId}`]);
    try {
      await sincronizarSalas(socket, user);
    } catch (err) {
      logger.error({ err }, 'Error asignando salas de socket');
      socket.disconnect(true);
    }
  });

  logger.info('Socket.io listo');
  return io;
}

/** Recalcula las salas de todos los sockets del usuario (tras cambiar sus permisos). */
export async function reevaluarSalasUsuario(usuarioId) {
  if (!io) return;
  const sockets = await io.in(`usuario:${usuarioId}`).fetchSockets();
  for (const s of sockets) {
    const deseadas = await salasPermitidas(s.data.user);
    for (const sala of s.rooms) if (DINAMICAS.test(sala) && !deseadas.has(sala)) s.leave(sala);
    s.join([...deseadas]);
  }
  io.to(`usuario:${usuarioId}`).emit('permisos:actualizados');
}

/** Reevalúa a todo el estudio (p. ej. al crear una empresa o almacén nuevo). */
export async function reevaluarTenant(tenantId) {
  if (!io) return;
  const sockets = await io.in(`tenant:${tenantId}`).fetchSockets();
  const usuarios = new Set(sockets.map((s) => s.data.user.id));
  for (const id of usuarios) await reevaluarSalasUsuario(id);
}

export async function desconectarSesiones(sesionIds) {
  if (!io) return;
  for (const sid of sesionIds) {
    io.to(`sesion:${sid}`).emit('sesion:cerrada');
    io.in(`sesion:${sid}`).disconnectSockets(true);
  }
}

/** Conexiones de tiempo real activas (todas las instancias, vía adaptador Redis). */
export async function contarConexiones() {
  if (!io) return 0;
  return (await io.fetchSockets()).length;
}

/** Emite a varios almacenes a la vez (socket.io no duplica si el usuario está en ambos). */
export function emitirAlmacenes(evento, almacenIds, payload) {
  if (!io) return;
  io.to([...new Set(almacenIds)].map((id) => `almacen:${id}`)).emit(evento, payload);
}

/** Emite un evento a la sala más específica que corresponda. */
export function emitir(evento, { empresaId, almacenId, tenantId }, payload) {
  if (!io) return;
  const sala = almacenId ? `almacen:${almacenId}` : empresaId ? `empresa:${empresaId}` : `tenant:${tenantId}`;
  io.to(sala).emit(evento, payload);
}
