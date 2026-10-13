import { Router } from 'express';
import { z } from 'zod';
import { validar } from '../../middleware/validar.js';
import { obtenerPermisos } from '../../rbac/servicio.js';
import { puedeDentroDeEmpresa } from '../../rbac/resolver.js';
import { auditar } from '../../services/auditoria.js';
import { noEncontrado, prohibido, solicitudInvalida } from '../../lib/errors.js';
import { paginacion, respuestaPaginada } from '../../lib/http.js';
import { plantilla } from '../../importador/lector.js';
import { TIPOS } from '../../importador/tipos.js';
import { aplicarImportacion, descartarImportacion, validarImportacion } from '../../importador/servicio.js';

/**
 * Importación desde Excel (Fase 4C). Cada tipo exige el mismo permiso que su alta manual
 * (crear clientes, productos, entradas de kardex o asientos manuales) dentro de la empresa.
 */
const router = Router();
const uuid = /^[0-9a-f-]{36}$/i;
const MAX_BYTES = 8 * 1024 * 1024;

/** Verifica el permiso del tipo en la empresa y deja req.empresaId */
async function exigir(req, tipo, empresaId) {
  const t = TIPOS[tipo];
  if (!t) throw noEncontrado('Tipo de importación desconocido');
  if (!uuid.test(empresaId ?? '')) throw solicitudInvalida('Indique la empresa');
  req.permisos ??= await obtenerPermisos(req.user);
  if (!puedeDentroDeEmpresa(req.permisos, t.permiso, empresaId)) throw prohibido();
  req.empresaId = empresaId;
  return t;
}

router.get('/tipos', async (req, res) => {
  req.permisos = await obtenerPermisos(req.user);
  const empresaId = uuid.test(req.query.empresaId ?? '') ? req.query.empresaId : null;
  res.json(Object.entries(TIPOS).map(([codigo, t]) => ({
    codigo, nombre: t.nombre, notas: t.notas ?? [],
    columnas: t.columnas.map(({ clave, titulo, requerido, ayuda }) => ({ clave, titulo, requerido: Boolean(requerido), ayuda: ayuda ?? null })),
    permitido: Boolean(empresaId) && puedeDentroDeEmpresa(req.permisos, t.permiso, empresaId),
  })));
});

router.get('/plantilla/:tipo', async (req, res) => {
  const t = await exigir(req, req.params.tipo, req.query.empresaId);
  const buffer = await plantilla({ titulo: `Plantilla de importación: ${t.nombre}`, columnas: t.columnas, ejemplo: t.ejemplo, notas: t.notas });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="plantilla-${req.params.tipo.toLowerCase().replace(/_/g, '-')}.xlsx"`);
  res.send(Buffer.from(buffer));
});

const esquemaValidar = z.object({
  empresaId: z.uuid(),
  tipo: z.enum(Object.keys(TIPOS)),
  nombreArchivo: z.string().trim().min(1).max(200),
  /** Contenido del archivo en base64 */
  archivo: z.string().min(1),
  opciones: z.object({ fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).default({}),
});

router.post('/validar', validar(esquemaValidar), async (req, res) => {
  await exigir(req, req.body.tipo, req.body.empresaId);
  const buffer = Buffer.from(req.body.archivo, 'base64');
  if (!buffer.length) throw solicitudInvalida('El archivo está vacío');
  if (buffer.length > MAX_BYTES) throw solicitudInvalida('El archivo supera los 8 MB');
  const r = await req.db((tx) => validarImportacion(tx, {
    tenantId: req.tenantId, empresaId: req.empresaId, usuarioId: req.user.id,
    tipo: req.body.tipo, nombreArchivo: req.body.nombreArchivo, buffer, opciones: req.body.opciones,
  }), { timeout: 60_000 });
  res.status(201).json(r);
});

async function cargar(req) {
  if (!uuid.test(req.params.id)) throw noEncontrado();
  const imp = await req.db((tx) => tx.importacion.findUnique({ where: { id: req.params.id }, select: { id: true, tipo: true, empresaId: true } }));
  if (!imp) throw noEncontrado('Importación no encontrada');
  await exigir(req, imp.tipo, imp.empresaId);
  return imp;
}

router.post('/:id/aplicar', async (req, res) => {
  const imp = await cargar(req);
  const r = await req.db(async (tx) => {
    const x = await aplicarImportacion(tx, { tenantId: req.tenantId, empresaId: imp.empresaId, usuarioId: req.user.id, id: imp.id });
    await auditar(tx, req, { modulo: 'importacion', accion: `${imp.tipo.toLowerCase()}.importar`, recurso: 'importacion', recursoId: imp.id, empresaId: imp.empresaId, despues: x.resultado });
    return x;
  }, { timeout: 120_000 });
  res.json(r);
});

router.post('/:id/descartar', async (req, res) => {
  const imp = await cargar(req);
  await req.db((tx) => descartarImportacion(tx, { empresaId: imp.empresaId, id: imp.id }));
  res.status(204).end();
});

/** Historial de la empresa: solo los tipos que el usuario puede importar */
router.get('/', async (req, res) => {
  const empresaId = req.query.empresaId;
  if (!uuid.test(empresaId ?? '')) throw solicitudInvalida('Indique la empresa');
  req.permisos = await obtenerPermisos(req.user);
  const tipos = Object.entries(TIPOS).filter(([, t]) => puedeDentroDeEmpresa(req.permisos, t.permiso, empresaId)).map(([k]) => k);
  if (!tipos.length) throw prohibido();
  const pag = paginacion(req.query);
  const where = { empresaId, tipo: { in: tipos } };
  const { datos, total, usuarios } = await req.db(async (tx) => {
    const datos = await tx.importacion.findMany({
      where, orderBy: { creadoEn: 'desc' }, skip: pag.skip, take: pag.take,
      select: { id: true, tipo: true, estado: true, nombreArchivo: true, totalFilas: true, filasValidas: true, resultado: true, usuarioId: true, creadoEn: true, aplicadoEn: true },
    });
    return {
      datos, total: await tx.importacion.count({ where }),
      usuarios: new Map((await tx.usuario.findMany({ where: { id: { in: [...new Set(datos.map((d) => d.usuarioId))] } }, select: { id: true, nombres: true } })).map((u) => [u.id, u.nombres])),
    };
  });
  res.json(respuestaPaginada(datos.map((d) => ({ ...d, usuario: usuarios.get(d.usuarioId) ?? null, tipoNombre: TIPOS[d.tipo].nombre })), total, pag));
});

export default router;
