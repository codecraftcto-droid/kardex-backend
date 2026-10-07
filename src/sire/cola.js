import IORedis from 'ioredis';
import { Queue, Worker } from 'bullmq';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { avanzarOperacion } from './registros.js';

/**
 * Cola del SIRE: SUNAT atiende las propuestas y aceptaciones por ticket. Mientras el ticket
 * siga en proceso, la operación se vuelve a consultar cada 15 segundos (hasta ~10 minutos).
 */
const NOMBRE = 'sire';
const conexion = () => new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
let cola = null;
let worker = null;

const obtenerCola = () => (cola ||= new Queue(NOMBRE, { connection: conexion(), defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 15_000 }, removeOnComplete: 500, removeOnFail: 500 } }));

export async function encolarOperacion(tenantId, operacionId, { retraso = 15_000 } = {}) {
  try {
    await obtenerCola().add('operacion', { tenantId, operacionId }, { jobId: `op-${operacionId}-${Date.now()}`, delay: retraso });
  } catch (e) {
    logger.error({ err: e.message, operacionId }, 'No se pudo encolar la operación SIRE');
  }
}

async function procesar(job) {
  const r = await avanzarOperacion(job.data);
  if (r.pendiente) await encolarOperacion(job.data.tenantId, job.data.operacionId);
  return r;
}

export async function iniciarWorkerSire() {
  worker = new Worker(NOMBRE, procesar, { connection: conexion(), concurrency: 2 });
  worker.on('failed', (job, err) => logger.warn({ job: job?.id, err: err.message }, 'Operación SIRE falló; se reintentará'));
  logger.info('Worker del SIRE activo');
}

export async function detenerSire() {
  await Promise.allSettled([worker?.close(), cola?.close()]);
}
