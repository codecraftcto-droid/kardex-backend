import IORedis from 'ioredis';
import { Queue, Worker } from 'bullmq';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { darDeBaja, enviarComprobante } from './servicio.js';
import { enviarGuia } from '../gre/servicio.js';

/**
 * Cola de envíos a SUNAT. Cada comprobante se envía en segundo plano (la venta no espera al
 * proveedor). Si el proveedor no responde, se reintenta con espera creciente; si SUNAT aún no
 * contesta (boletas en resumen diario), se vuelve a consultar más tarde.
 */
const NOMBRE = 'cpe';
const conexion = () => new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
let cola = null;
let worker = null;

function obtenerCola() {
  cola ||= new Queue(NOMBRE, {
    connection: conexion(),
    defaultJobOptions: { attempts: 8, backoff: { type: 'exponential', delay: 30_000 }, removeOnComplete: 1000, removeOnFail: 1000 },
  });
  return cola;
}

/** Encola el envío (idempotente por comprobante). */
export async function encolarEnvio(tenantId, comprobanteId, { retraso = 0 } = {}) {
  try {
    await obtenerCola().add('enviar', { tenantId, comprobanteId }, { jobId: `enviar-${comprobanteId}-${Date.now()}`, delay: retraso });
  } catch (e) {
    // Sin Redis no se pierde nada: el comprobante queda PENDIENTE y puede reenviarse
    logger.error({ err: e.message, comprobanteId }, 'No se pudo encolar el envío a SUNAT');
  }
}

export async function encolarGuia(tenantId, guiaId, { retraso = 0, consultas = 0 } = {}) {
  try {
    await obtenerCola().add('guia', { tenantId, guiaId, consultas }, { jobId: `guia-${guiaId}-${Date.now()}`, delay: retraso });
  } catch (e) {
    logger.error({ err: e.message, guiaId }, 'No se pudo encolar el envío de la guía');
  }
}

export async function encolarBaja(tenantId, comprobanteId, motivo, { retraso = 0 } = {}) {
  try {
    await obtenerCola().add('baja', { tenantId, comprobanteId, motivo }, { jobId: `baja-${comprobanteId}-${Date.now()}`, delay: retraso });
  } catch (e) {
    logger.error({ err: e.message, comprobanteId }, 'No se pudo encolar la comunicación de baja');
  }
}

async function procesar(job) {
  if (job.name === 'enviar') {
    const r = await enviarComprobante(job.data);
    // SUNAT aún no responde (resumen diario): consultar de nuevo en 10 minutos
    if (r.estado === 'ENVIADO' && (job.data.consultas ?? 0) < 36) {
      await obtenerCola().add('enviar', { ...job.data, consultas: (job.data.consultas ?? 0) + 1 }, { delay: 10 * 60_000 });
    }
    return r;
  }
  if (job.name === 'guia') {
    const r = await enviarGuia(job.data);
    // SUNAT procesa las guías por ticket: se consulta cada 2 minutos (hasta 1 hora)
    if (r.estado === 'ENVIADO' && (job.data.consultas ?? 0) < 30) await encolarGuia(job.data.tenantId, job.data.guiaId, { retraso: 2 * 60_000, consultas: (job.data.consultas ?? 0) + 1 });
    return r;
  }
  if (job.name === 'baja') {
    const r = await darDeBaja(job.data);
    if (r.estado === 'PENDIENTE') await obtenerCola().add('baja', job.data, { delay: 10 * 60_000 });
    return r;
  }
  return null;
}

export async function iniciarWorkerCpe({ concurrencia = 3 } = {}) {
  worker = new Worker(NOMBRE, procesar, { connection: conexion(), concurrency: concurrencia });
  worker.on('failed', (job, err) => logger.warn({ job: job?.name, intento: job?.attemptsMade, err: err.message }, 'Envío a SUNAT falló; se reintentará'));
  logger.info(`Worker de facturación electrónica activo (concurrencia ${concurrencia})`);
}

export async function detenerCpe() {
  await Promise.allSettled([worker?.close(), cola?.close()]);
}
