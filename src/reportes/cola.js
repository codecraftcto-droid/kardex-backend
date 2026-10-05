import fs from 'node:fs/promises';
import path from 'node:path';
import IORedis from 'ioredis';
import { Queue, Worker } from 'bullmq';
import { Emitter } from '@socket.io/redis-emitter';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { prismaSystem, withTenant } from '../lib/prisma.js';
import { HttpError, conflicto, prohibido } from '../lib/errors.js';
import { calcularPermisos } from '../rbac/servicio.js';
import { puedeDentroDeEmpresa } from '../rbac/resolver.js';
import { REPORTES, validarPermisos } from './definiciones.js';
import { crearAcumulador, crearEscritorPdf, crearEscritorXlsx } from './escritores.js';

/**
 * Cola de exportación de reportes (BullMQ sobre Redis).
 * - El worker puede correr dentro de la API (REPORTES_WORKER_EMBEBIDO=true) o como
 *   proceso aparte (`npm run worker`) para escalar sin afectar a la API.
 * - El avance se notifica por Socket.io mediante el emisor de Redis (funciona desde
 *   cualquier proceso) a la sala personal del usuario que pidió el reporte.
 */
export const LIMITE_PDF = Number(process.env.REPORTES_LIMITE_PDF) || 30000;
export const HORAS_VIGENCIA = 24;
const NOMBRE_COLA = 'reportes';
const DIR = path.resolve(env.REPORTES_DIR);

const conexion = () => new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
let cola = null;
let emisor = null;

export function obtenerCola() {
  cola ||= new Queue(NOMBRE_COLA, {
    connection: conexion(),
    defaultJobOptions: { attempts: 1, removeOnComplete: 500, removeOnFail: 500 },
  });
  return cola;
}

function notificar(usuarioId, evento, datos) {
  emisor ||= new Emitter(new IORedis(env.REDIS_URL));
  emisor.to(`usuario:${usuarioId}`).emit(evento, datos);
}

export async function encolarExportacion(exportacion) {
  await obtenerCola().add('exportar', { exportacionId: exportacion.id, tenantId: exportacion.tenantId }, { jobId: exportacion.id });
}

// ───────────── Procesamiento ─────────────

export async function procesarExportacion({ exportacionId, tenantId }) {
  const db = (fn) => withTenant(tenantId, fn);
  const exp = await db((tx) => tx.exportacionReporte.findUnique({ where: { id: exportacionId } }));
  if (!exp || exp.estado !== 'PENDIENTE') return;

  const actualizar = (data) => db((tx) => tx.exportacionReporte.update({ where: { id: exp.id }, data }));
  await actualizar({ estado: 'PROCESANDO', iniciadoEn: new Date() });
  notificar(exp.usuarioId, 'reporte:progreso', { id: exp.id, estado: 'PROCESANDO', progreso: 0 });

  const ruta = path.join(DIR, tenantId, `${exp.id}.${exp.formato}`);
  let escritor = null;
  try {
    // Permisos vigentes AHORA (si se los quitaron después de pedirlo, no se genera)
    const usuario = await db((tx) => tx.usuario.findUnique({ where: { id: exp.usuarioId }, select: { estado: true } }));
    if (usuario?.estado !== 'activo') throw prohibido('El usuario ya no está activo');
    const permisos = await db((tx) => calcularPermisos(tx, exp.usuarioId));
    const def = REPORTES[exp.tipo];
    validarPermisos(permisos, def);
    if (!puedeDentroDeEmpresa(permisos, 'reporte.exportar', exp.empresaId)) throw prohibido('No tiene permiso para exportar reportes');

    const q = def.esquema.parse(exp.parametros);
    const { meta, lotes, contar } = await def.preparar({ db, permisos, q });
    const total = contar ? await contar() : null;
    if (exp.formato === 'pdf' && total > LIMITE_PDF) {
      throw conflicto(`El PDF admite hasta ${LIMITE_PDF.toLocaleString('es-PE')} filas y este reporte tiene ${total.toLocaleString('es-PE')}. Expórtelo a Excel.`);
    }

    await fs.mkdir(path.dirname(ruta), { recursive: true });
    escritor = exp.formato === 'xlsx' ? crearEscritorXlsx(ruta, meta) : crearEscritorPdf(ruta, meta);
    const acumulador = crearAcumulador(meta);
    let ultimoAviso = 0;
    let progreso = 0;
    for await (const lote of lotes()) {
      escritor.agregar(lote);
      acumulador.agregar(lote);
      if (exp.formato === 'pdf' && acumulador.filas > LIMITE_PDF) throw conflicto(`El PDF admite hasta ${LIMITE_PDF.toLocaleString('es-PE')} filas. Expórtelo a Excel.`);
      // Avance: proporcional si se conoce el total; si no, incremental hasta 95 %
      progreso = total ? Math.min(99, Math.floor((acumulador.filas / total) * 100)) : Math.min(95, progreso + 5);
      if (Date.now() - ultimoAviso > 1000) {
        ultimoAviso = Date.now();
        await actualizar({ progreso, filas: acumulador.filas });
        notificar(exp.usuarioId, 'reporte:progreso', { id: exp.id, estado: 'PROCESANDO', progreso, filas: acumulador.filas });
      }
    }
    await escritor.cerrar(acumulador.totales());
    escritor = null;

    const { size } = await fs.stat(ruta);
    const nombreArchivo = `${meta.nombreArchivo}.${exp.formato}`;
    await actualizar({
      estado: 'LISTO', progreso: 100, filas: acumulador.filas, titulo: meta.titulo, nombreArchivo, rutaArchivo: ruta,
      tamanoBytes: size, terminadoEn: new Date(), expiraEn: new Date(Date.now() + HORAS_VIGENCIA * 3600_000),
    });
    notificar(exp.usuarioId, 'reporte:listo', { id: exp.id, titulo: meta.titulo, nombreArchivo, filas: acumulador.filas });
    logger.info({ exportacion: exp.id, filas: acumulador.filas, bytes: size }, 'Exportación lista');
  } catch (err) {
    await escritor?.cerrar(null).catch(() => {});
    await fs.rm(ruta, { force: true }).catch(() => {});
    // Al usuario solo se le muestran errores controlados; el detalle técnico va al log
    const mensaje = err instanceof HttpError ? err.message : err?.name === 'ZodError' ? 'Parámetros del reporte inválidos' : 'Error interno al generar el reporte';
    if (!(err instanceof HttpError)) logger.error({ err, exportacion: exp.id }, 'Falló la exportación');
    await actualizar({ estado: 'ERROR', error: mensaje, terminadoEn: new Date() });
    notificar(exp.usuarioId, 'reporte:error', { id: exp.id, error: mensaje });
  }
}

/** Borra archivos vencidos y marca como error las exportaciones colgadas (p. ej. worker caído). */
export async function limpiarExportaciones() {
  const vencidas = await prismaSystem.exportacionReporte.findMany({
    where: { estado: 'LISTO', expiraEn: { lt: new Date() } },
    select: { id: true, rutaArchivo: true },
  });
  for (const v of vencidas) {
    if (v.rutaArchivo) await fs.rm(v.rutaArchivo, { force: true }).catch(() => {});
  }
  if (vencidas.length) {
    await prismaSystem.exportacionReporte.updateMany({
      where: { id: { in: vencidas.map((v) => v.id) } },
      data: { estado: 'EXPIRADO', rutaArchivo: null },
    });
  }
  const colgadas = await prismaSystem.exportacionReporte.updateMany({
    where: { estado: { in: ['PENDIENTE', 'PROCESANDO'] }, creadoEn: { lt: new Date(Date.now() - 2 * 3600_000) } },
    data: { estado: 'ERROR', error: 'La exportación no terminó; vuelva a solicitarla', terminadoEn: new Date() },
  });
  if (vencidas.length || colgadas.count) logger.info({ vencidas: vencidas.length, colgadas: colgadas.count }, 'Limpieza de exportaciones');
}

let worker = null;

export async function iniciarWorkerReportes({ concurrencia = 2 } = {}) {
  worker = new Worker(
    NOMBRE_COLA,
    async (job) => (job.name === 'limpieza' ? limpiarExportaciones() : procesarExportacion(job.data)),
    { connection: conexion(), concurrency: concurrencia },
  );
  worker.on('failed', (job, err) => logger.error({ err, job: job?.id }, 'Trabajo de reportes fallido'));
  // Limpieza programada cada hora (idempotente: un solo programador aunque haya varios workers)
  await obtenerCola().upsertJobScheduler('limpieza-exportaciones', { every: 3600_000 }, { name: 'limpieza' });
  await limpiarExportaciones();
  logger.info(`Worker de reportes activo (concurrencia ${concurrencia})`);
  return worker;
}

export async function detenerColas() {
  await Promise.allSettled([worker?.close(), cola?.close()]);
}
