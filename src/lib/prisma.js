import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';

/**
 * Cliente "sistema": conexión dueña, sin RLS. Uso restringido a flujos donde
 * aún no se conoce el tenant (login, refresh, activación) y al seed.
 */
export const prismaSystem = new PrismaClient({ datasourceUrl: env.DATABASE_URL });

/** Cliente de aplicación: rol kardex_app, siempre sujeto a RLS. */
export const prismaApp = new PrismaClient({ datasourceUrl: env.DATABASE_APP_URL });

/**
 * Ejecuta `fn` dentro de una transacción con `app.tenant_id` fijado.
 * Las políticas RLS de PostgreSQL filtran por ese valor: aunque una consulta
 * olvide el filtro, la BD no devuelve filas de otro estudio.
 */
export function withTenant(tenantId, fn, options) {
  return prismaApp.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  }, options);
}
