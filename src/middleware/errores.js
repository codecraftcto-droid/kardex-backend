import { Prisma } from '@prisma/client';
import { HttpError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export function noEncontradoRuta(_req, res) {
  res.status(404).json({ error: 'Ruta no encontrada' });
}

// eslint-disable-next-line no-unused-vars
export function manejadorErrores(err, req, res, _next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, ...(err.details ? { detalles: err.details } : {}) });
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'Ya existe un registro con esos datos' });
    if (err.code === 'P2025' || err.code === 'P2023') return res.status(404).json({ error: 'Recurso no encontrado' });
    if (err.code === 'P2003') return res.status(409).json({ error: 'El registro está siendo usado por otros datos' });
  }
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido' });
  // Nunca exponer detalles internos al cliente
  logger.error({ err, path: req.path }, 'Error no controlado');
  res.status(500).json({ error: 'Error interno del servidor' });
}
