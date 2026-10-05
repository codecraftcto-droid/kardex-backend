import express, { Router } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { autenticar, contextoTenant } from './middleware/autenticar.js';
import { manejadorErrores, noEncontradoRuta } from './middleware/errores.js';
import authRoutes from './modules/auth/auth.routes.js';
import meRoutes from './modules/me/me.routes.js';
import permisosRoutes from './modules/permisos/permisos.routes.js';
import rolesRoutes from './modules/roles/roles.routes.js';
import usuariosRoutes from './modules/usuarios/usuarios.routes.js';
import empresasRoutes from './modules/empresas/empresas.routes.js';
import sedesRoutes from './modules/sedes/sedes.routes.js';
import almacenesRoutes from './modules/almacenes/almacenes.routes.js';
import auditoriaRoutes from './modules/auditoria/auditoria.routes.js';
import catalogosRoutes from './modules/catalogos/catalogos.routes.js';
import productosRoutes from './modules/productos/productos.routes.js';
import kardexRoutes from './modules/kardex/kardex.routes.js';
import transferenciasRoutes from './modules/transferencias/transferencias.routes.js';
import reportesRoutes from './modules/reportes/reportes.routes.js';
import { crearRouterDocumentos } from './modules/comercial/documentos.routes.js';
import { crearRouterPlataforma } from './plataforma/index.js';

// Los identificadores BigInt (kardex, auditoría) se serializan como texto en JSON
BigInt.prototype.toJSON = function toJSON() {
  return this.toString();
};

export function crearApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.isProd ? 1 : false);

  app.use(helmet());
  app.use(cors({ origin: env.corsOrigins, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  if (env.NODE_ENV !== 'test') app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/api/salud' } }));

  app.get('/api/salud', (_req, res) => res.json({ ok: true }));

  // Público
  app.use('/api/auth', authRoutes);

  // Plataforma SaaS (Módulo C): autenticación propia, antes del router de estudios
  app.use('/api/plataforma', crearRouterPlataforma());

  // Protegido: autenticación + contexto de tenant en TODAS las rutas siguientes
  const api = Router();
  api.use(autenticar, contextoTenant);
  api.use('/me', meRoutes);
  api.use('/permisos', permisosRoutes);
  api.use('/roles', rolesRoutes);
  api.use('/usuarios', usuariosRoutes);
  api.use('/empresas', empresasRoutes);
  api.use('/sedes', sedesRoutes);
  api.use('/almacenes', almacenesRoutes);
  api.use('/auditoria', auditoriaRoutes);
  api.use('/catalogos', catalogosRoutes);
  api.use('/productos', productosRoutes);
  api.use('/kardex', kardexRoutes);
  api.use('/transferencias', transferenciasRoutes);
  api.use('/reportes', reportesRoutes);
  api.use('/compras', crearRouterDocumentos('COMPRA'));
  api.use('/ventas', crearRouterDocumentos('VENTA'));
  app.use('/api', api);

  app.use(noEncontradoRuta);
  app.use(manejadorErrores);
  return app;
}
