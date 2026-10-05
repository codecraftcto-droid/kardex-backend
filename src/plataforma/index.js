import { Router } from 'express';
import authRoutes from './auth.routes.js';
import estudiosRoutes from './estudios.routes.js';
import gestionRoutes from './gestion.routes.js';
import { autenticarPlataforma } from './middleware.js';

/** API de plataforma (Módulo C): /api/plataforma/* — autenticación propia, separada de los estudios. */
export function crearRouterPlataforma() {
  const router = Router();
  router.use('/auth', authRoutes);
  router.use(autenticarPlataforma);
  router.use('/estudios', estudiosRoutes);
  router.use('/', gestionRoutes);
  return router;
}
