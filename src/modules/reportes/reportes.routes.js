import fs from 'node:fs';
import { Router } from 'express';
import { z } from 'zod';
import { validar } from '../../middleware/validar.js';
import { obtenerPermisos } from '../../rbac/servicio.js';
import { puedeDentroDeEmpresa } from '../../rbac/resolver.js';
import { auditar } from '../../services/auditoria.js';
import { HttpError, noEncontrado, prohibido, solicitudInvalida } from '../../lib/errors.js';
import { REPORTES, validarPermisos } from '../../reportes/definiciones.js';
import { crearAcumulador } from '../../reportes/escritores.js';
import { encolarExportacion } from '../../reportes/cola.js';

/**
 * Reportes:
 *  - GET  /reportes/:tipo                    vista previa inmediata (hasta 500 filas)
 *  - POST /reportes/exportaciones            encola la exportación a Excel/PDF (sin límite de filas en Excel)
 *  - GET  /reportes/exportaciones            mis exportaciones recientes
 *  - GET  /reportes/exportaciones/:id/archivo descarga (solo quien la pidió, mientras esté vigente)
 * Las filas siempre se filtran por el alcance del usuario y RLS por estudio.
 */
const router = Router();
const VISTA_PREVIA = 500;
const MAX_EN_CURSO = 3;

function definicion(tipo) {
  const def = REPORTES[tipo];
  if (!def) throw noEncontrado('Reporte no encontrado');
  return def;
}

function parsear(def, datos) {
  const r = def.esquema.safeParse(datos);
  if (!r.success) {
    throw solicitudInvalida('Parámetros inválidos', r.error.issues.map((i) => ({ campo: i.path.join('.'), mensaje: i.message })));
  }
  return r.data;
}

// ───────────── Exportaciones en segundo plano ─────────────

const camposExportacion = {
  id: true, tipo: true, formato: true, titulo: true, estado: true, progreso: true, filas: true,
  nombreArchivo: true, tamanoBytes: true, error: true, creadoEn: true, terminadoEn: true, expiraEn: true,
};

router.get('/exportaciones', async (req, res) => {
  const lista = await req.db((tx) =>
    tx.exportacionReporte.findMany({
      where: { usuarioId: req.user.id, creadoEn: { gt: new Date(Date.now() - 7 * 86400_000) } },
      select: camposExportacion,
      orderBy: { creadoEn: 'desc' },
      take: 20,
    }),
  );
  res.json(lista);
});

router.post(
  '/exportaciones',
  validar(z.object({ tipo: z.string().max(30), formato: z.enum(['xlsx', 'pdf']), parametros: z.record(z.string(), z.unknown()) })),
  async (req, res) => {
    const def = definicion(req.body.tipo);
    const permisos = await obtenerPermisos(req.user);
    validarPermisos(permisos, def);
    const q = parsear(def, req.body.parametros);
    if (!puedeDentroDeEmpresa(permisos, 'reporte.exportar', q.empresaId)) throw prohibido('No tiene permiso para exportar reportes');
    // Valida alcance y existencia de los filtros ahora (sin leer filas: los lotes son perezosos)
    await def.preparar({ db: req.db, permisos, q });

    const exportacion = await req.db(async (tx) => {
      const enCurso = await tx.exportacionReporte.count({ where: { usuarioId: req.user.id, estado: { in: ['PENDIENTE', 'PROCESANDO'] } } });
      if (enCurso >= MAX_EN_CURSO) throw new HttpError(429, `Ya tiene ${MAX_EN_CURSO} exportaciones en curso; espere a que terminen`);
      const e = await tx.exportacionReporte.create({
        data: { tenantId: req.tenantId, usuarioId: req.user.id, empresaId: q.empresaId, tipo: req.body.tipo, formato: req.body.formato, parametros: req.body.parametros },
      });
      await auditar(tx, req, {
        modulo: 'reporte', accion: 'reporte.exportar', recurso: 'exportacion', recursoId: e.id, empresaId: q.empresaId,
        despues: { tipo: e.tipo, formato: e.formato, parametros: e.parametros },
      });
      return e;
    });
    await encolarExportacion(exportacion);
    res.status(202).json({ id: exportacion.id, estado: exportacion.estado });
  },
);

router.get('/exportaciones/:id/archivo', async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw noEncontrado();
  // Solo el usuario que la pidió (y RLS limita al estudio)
  const e = await req.db((tx) => tx.exportacionReporte.findFirst({ where: { id: req.params.id, usuarioId: req.user.id } }));
  if (!e) throw noEncontrado();
  if (e.estado === 'EXPIRADO' || (e.expiraEn && e.expiraEn < new Date())) throw new HttpError(410, 'El archivo expiró; vuelva a generar el reporte');
  if (e.estado !== 'LISTO' || !e.rutaArchivo || !fs.existsSync(e.rutaArchivo)) throw new HttpError(409, 'El reporte aún no está listo');
  res.download(e.rutaArchivo, e.nombreArchivo);
});

// ───────────── Vista previa ─────────────

router.get('/:tipo', async (req, res) => {
  const def = definicion(req.params.tipo);
  const permisos = await obtenerPermisos(req.user);
  validarPermisos(permisos, def);
  const q = parsear(def, req.query);
  const { meta, lotes, contar } = await def.preparar({ db: req.db, permisos, q });

  const filas = [];
  const acumulador = crearAcumulador(meta);
  let hayMas = false;
  for await (const lote of lotes()) {
    filas.push(...lote);
    acumulador.agregar(lote);
    if (filas.length > VISTA_PREVIA) {
      hayMas = true;
      break; // no se lee el resto: para el reporte completo, exportar
    }
  }
  res.json({
    titulo: meta.titulo,
    subtitulo: meta.subtitulo,
    columnas: meta.columnas,
    verCostos: meta.verCostos,
    filas: filas.slice(0, VISTA_PREVIA),
    hayMas,
    total: hayMas ? (contar ? await contar() : null) : filas.length,
    totales: hayMas ? null : acumulador.totales(),
  });
});

export default router;
