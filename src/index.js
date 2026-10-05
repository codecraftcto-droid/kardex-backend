import http from 'node:http';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { prismaApp, prismaSystem } from './lib/prisma.js';
import { redis } from './lib/redis.js';
import { crearApp } from './app.js';
import { iniciarSocket } from './realtime/socket.js';
import { detenerColas, iniciarWorkerReportes } from './reportes/cola.js';

const server = http.createServer(crearApp());
iniciarSocket(server);
if (env.REPORTES_WORKER_EMBEBIDO) await iniciarWorkerReportes();

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    logger.error(`El puerto ${env.PORT} ya está en uso. Detenga el otro proceso (lsof -i :${env.PORT}) o cambie PORT en .env`);
    process.exit(1);
  }
  throw err;
});
server.listen(env.PORT, () => logger.info(`API Kardex escuchando en http://localhost:${env.PORT}`));

async function apagar(senal) {
  logger.info(`${senal} recibido, cerrando...`);
  server.close();
  await detenerColas();
  await Promise.allSettled([prismaApp.$disconnect(), prismaSystem.$disconnect(), redis.quit()]);
  process.exit(0);
}
process.on('SIGINT', apagar);
process.on('SIGTERM', apagar);
