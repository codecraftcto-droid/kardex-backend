// Arranque en producción (Docker / Dokploy):
//   1. Crea el rol de aplicación `kardex_app` si no existe (lo exige RLS; ANTES de migrar,
//      porque las migraciones le otorgan permisos solo si el rol ya existe).
//   2. Aplica las migraciones pendientes (prisma migrate deploy).
//   3. Sincroniza el catálogo de permisos (NO carga datos demo).
//   4. Inicia la API (y el worker de reportes si REPORTES_WORKER_EMBEBIDO=true).
import { spawnSync } from 'node:child_process';
import pg from '@prisma/client';

const { PrismaClient } = pg;
const appUrl = new URL(process.env.DATABASE_APP_URL);
const rolApp = decodeURIComponent(appUrl.username);
const claveApp = decodeURIComponent(appUrl.password);
// Las migraciones otorgan los permisos (y aplican RLS) al rol con este nombre exacto
if (rolApp !== 'kardex_app') {
  console.error(`DATABASE_APP_URL debe usar el usuario "kardex_app" (recibido "${rolApp}"): las migraciones otorgan los permisos a ese rol.`);
  process.exit(1);
}
if (!claveApp) throw new Error('DATABASE_APP_URL debe incluir contraseña');

const prisma = new PrismaClient();
try {
  const [{ existe }] = await prisma.$queryRaw`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${rolApp}) AS existe`;
  // PostgreSQL arma la sentencia con format(): %I y %L escapan identificador y contraseña
  const plantilla = `${existe ? 'ALTER' : 'CREATE'} ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS`;
  const [{ sentencia }] = await prisma.$queryRaw`SELECT format(${plantilla}, ${rolApp}::text, ${claveApp}::text) AS sentencia`;
  try {
    await prisma.$executeRawUnsafe(sentencia);
  } catch (err) {
    // El rol ya existe pero lo creó otro usuario (PostgreSQL 16+ exige ser su administrador):
    // se continúa con la contraseña que ya tenga.
    if (!existe) throw err;
    console.warn(`⚠ No se pudo actualizar la contraseña del rol "${rolApp}" (se conserva la actual): ${err.meta?.message ?? err.message}`);
  }
  const [{ grant }] = await prisma.$queryRaw`SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), ${rolApp}::text) AS grant`;
  await prisma.$executeRawUnsafe(grant);
  console.log(`✔ Rol de aplicación "${rolApp}" ${existe ? "verificado" : "creado"}`);
} finally {
  await prisma.$disconnect();
}

const migrar = spawnSync('npx', ['prisma', 'migrate', 'deploy'], { stdio: 'inherit' });
if (migrar.status !== 0) process.exit(migrar.status ?? 1);

const { sincronizarCatalogo } = await import('../src/services/estudios.js');
const cliente = new PrismaClient();
const nuevos = await sincronizarCatalogo(cliente);
await cliente.$disconnect();
console.log(`✔ Catálogo de permisos sincronizado${nuevos.length ? ` (${nuevos.length} nuevos)` : ''}`);

await import('../src/index.js');
