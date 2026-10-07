// Worker de reportes como proceso independiente (para escalar): npm run worker
// Use REPORTES_WORKER_EMBEBIDO=false en la API para que no procese también ahí.
import { logger } from './lib/logger.js';
import { prismaApp, prismaSystem } from './lib/prisma.js';
import { detenerColas, iniciarWorkerReportes } from './reportes/cola.js';
import { detenerCpe, iniciarWorkerCpe } from './cpe/cola.js';
import { detenerSire, iniciarWorkerSire } from './sire/cola.js';

await iniciarWorkerReportes({ concurrencia: Number(process.env.REPORTES_CONCURRENCIA) || 2 });
await iniciarWorkerCpe();
await iniciarWorkerSire();

async function apagar() {
  logger.info('Deteniendo worker de reportes...');
  await detenerColas();
  await detenerCpe();
  await detenerSire();
  await Promise.allSettled([prismaApp.$disconnect(), prismaSystem.$disconnect()]);
  process.exit(0);
}
process.on('SIGINT', apagar);
process.on('SIGTERM', apagar);
