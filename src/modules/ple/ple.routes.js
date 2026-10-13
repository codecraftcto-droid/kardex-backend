import { Router } from 'express';
import { zipSync, strToU8 } from 'fflate';
import { obtenerPermisos } from '../../rbac/servicio.js';
import { puedeDentroDeEmpresa } from '../../rbac/resolver.js';
import { auditar } from '../../services/auditoria.js';
import { noEncontrado, prohibido, solicitudInvalida } from '../../lib/errors.js';
import { esPeriodo, etiquetaPeriodo, periodoActual } from '../../sire/periodos.js';
import { LIBROS, ORDEN_LIBROS } from '../../ple/formatos.js';
import { PERMISO_LIBRO, generarLibro } from '../../ple/servicio.js';

/**
 * Libros electrónicos PLE (Fase 4A): resumen por libro, vista previa, TXT y ZIP con todos.
 * Cada libro exige el permiso de su fuente (contabilidad o costos del kardex) en la empresa.
 */
const router = Router();
const uuid = /^[0-9a-f-]{36}$/i;
const MUESTRA = 30;

async function contexto(req) {
  const { empresaId, periodo = periodoActual() } = req.query;
  if (!uuid.test(empresaId ?? '')) throw solicitudInvalida('Indique la empresa');
  if (!esPeriodo(periodo) || periodo > periodoActual()) throw solicitudInvalida('Período inválido');
  req.permisos = await obtenerPermisos(req.user);
  const empresa = await req.db((tx) => tx.empresa.findUnique({ where: { id: empresaId }, select: { id: true, ruc: true, razonSocial: true } }));
  if (!empresa) throw noEncontrado('Empresa no encontrada');
  const permitidos = ORDEN_LIBROS.filter((l) => puedeDentroDeEmpresa(req.permisos, PERMISO_LIBRO[l], empresaId));
  if (!permitidos.length) throw prohibido();
  return { empresa, periodo, permitidos };
}
// El TXT del PLE va en ANSI (Latin-1), sin BOM
const latin1 = (lineas) => Buffer.from(lineas.length ? `${lineas.join('\r\n')}\r\n` : '', 'latin1');

router.get('/', async (req, res) => {
  const { empresa, periodo, permitidos } = await contexto(req);
  const libros = await req.db(async (tx) => {
    const r = [];
    for (const libro of permitidos) {
      const g = await generarLibro(tx, { empresa, periodo, libro });
      r.push({ libro, codigo: g.codigo, nombre: g.nombre, nombreArchivo: g.nombreArchivo, filas: g.lineas.length, conInformacion: g.conInformacion, avisos: g.avisos });
    }
    return r;
  }, { timeout: 60_000 });
  res.json({ periodo, etiqueta: etiquetaPeriodo(periodo), empresa, libros });
});

router.get('/zip', async (req, res) => {
  const { empresa, periodo, permitidos } = await contexto(req);
  const archivos = await req.db(async (tx) => {
    const r = {};
    for (const libro of permitidos) {
      const g = await generarLibro(tx, { empresa, periodo, libro });
      r[g.nombreArchivo] = new Uint8Array(latin1(g.lineas));
    }
    return r;
  }, { timeout: 60_000 });
  await req.db((tx) => auditar(tx, req, { modulo: 'ple', accion: 'libros.descargar', recurso: 'periodo', recursoId: periodo, empresaId: empresa.id, despues: { libros: Object.keys(archivos) } }));
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="PLE-${empresa.ruc}-${periodo}.zip"`);
  res.send(Buffer.from(zipSync(archivos)));
});

async function libroDe(req) {
  const ctx = await contexto(req);
  if (!LIBROS[req.params.libro]) throw noEncontrado('Libro no soportado');
  if (!ctx.permitidos.includes(req.params.libro)) throw prohibido();
  const g = await req.db((tx) => generarLibro(tx, { empresa: ctx.empresa, periodo: ctx.periodo, libro: req.params.libro }), { timeout: 60_000 });
  return { ...ctx, g };
}

router.get('/:libro', async (req, res) => {
  const { periodo, g } = await libroDe(req);
  const { lineas, ...resto } = g;
  res.json({ ...resto, periodo, filas: lineas.length, muestra: lineas.slice(0, MUESTRA) });
});

router.get('/:libro/txt', async (req, res) => {
  const { empresa, periodo, g } = await libroDe(req);
  await req.db((tx) => auditar(tx, req, { modulo: 'ple', accion: 'libro.descargar', recurso: 'libro', recursoId: `${g.libro}-${periodo}`, empresaId: empresa.id, despues: { archivo: g.nombreArchivo, filas: g.lineas.length } }));
  res.setHeader('Content-Type', 'text/plain; charset=ISO-8859-1');
  res.setHeader('Content-Disposition', `attachment; filename="${g.nombreArchivo}"`);
  res.send(latin1(g.lineas));
});

export default router;
