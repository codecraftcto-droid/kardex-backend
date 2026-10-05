import { execSync } from 'node:child_process';

/** Aplica migraciones a la BD de pruebas, sincroniza el catálogo y limpia Redis de pruebas. */
export default async function () {
  await import('./env.js');
  execSync('npx prisma migrate deploy', { stdio: 'ignore', env: process.env });
  const { PrismaClient } = await import('@prisma/client');
  const { sincronizarCatalogo } = await import('../src/services/estudios.js');
  const prisma = new PrismaClient();
  await sincronizarCatalogo(prisma);
  await prisma.$disconnect();
  const { default: Redis } = await import('ioredis');
  const r = new Redis(process.env.REDIS_URL);
  await r.flushdb();
  await r.quit();
}
