import { Router } from 'express';
import { z } from 'zod';
import { autorizarEnEmpresa } from '../../middleware/autorizar.js';
import { validar } from '../../middleware/validar.js';
import { puede, puedeDentroDeEmpresa, tieneAlguno } from '../../rbac/resolver.js';
import { obtenerPermisos } from '../../rbac/servicio.js';
import { panelEstudio } from '../../sire/panel.js';
import { excelPanel } from '../../sire/excel.js';
import { auditar } from '../../services/auditoria.js';
import { noEncontrado, prohibido, solicitudInvalida } from '../../lib/errors.js';
import { paginacion, respuestaPaginada } from '../../lib/http.js';
import { MODOS_SIRE } from '../../sire/proveedores/index.js';
import { configPublica, guardarConfig, listarPeriodos, probarConexion, sincronizar } from '../../sire/servicio.js';
import { esPeriodo, etiquetaPeriodo, grupoCronograma, periodoActual } from '../../sire/periodos.js';
import { RESOLUCIONES_PERMITIDAS, avanzarOperacion, iniciarAceptacion, iniciarDescarga, registrosDelSistema, resolverDiferencia, resumenRegistro } from '../../sire/registros.js';
import { encolarOperacion } from '../../sire/cola.js';
import { NOMBRE_TIPO_CP } from '../../sire/conciliacion.js';

/**
 * SIRE: credenciales por empresa, períodos tributarios (vencimiento y avance de los
 * registros de ventas y compras) y sincronización del estado con SUNAT.
 */
const router = Router();
const uuid = /^[0-9a-f-]{36}$/i;
const empresaDe = (origen) => (req) => {
  const v = origen === 'query' ? req.query.empresaId : req.body?.empresaId;
  return uuid.test(v || '') ? v : null;
};
const SELECT_EMPRESA = { id: true, ruc: true, razonSocial: true, buenContribuyente: true };
async function cargarEmpresa(req) {
  const e = await req.db((tx) => tx.empresa.findUnique({ where: { id: req.empresaId }, select: SELECT_EMPRESA }));
  if (!e) throw noEncontrado('Empresa no encontrada');
  return e;
}

// ───────────── Configuración ─────────────

router.get('/modos', (_req, res) => res.json(Object.entries(MODOS_SIRE).map(([codigo, m]) => ({ codigo, nombre: m.nombre }))));

router.get('/config', autorizarEnEmpresa('sire.configuracion.editar', empresaDe('query')), async (req, res) => {
  const cfg = await req.db((tx) => tx.configSire.findUnique({ where: { empresaId: req.empresaId } }));
  res.json(configPublica(cfg));
});

const texto = (max) => z.string().trim().max(max).nullish().transform((v) => v || null);
const esquemaConfig = z.object({
  empresaId: z.uuid(),
  modo: z.enum(Object.keys(MODOS_SIRE)),
  clientId: texto(100),
  /** Secretos: solo se envían para cambiarlos; vacío = conservar los actuales */
  clientSecret: texto(200),
  usuarioSol: z.string().trim().toUpperCase().max(20).regex(/^[A-Z0-9]*$/, 'El usuario SOL solo lleva letras y números (sin el RUC)').nullish().transform((v) => v || null),
  claveSol: texto(100),
  activo: z.boolean().default(true),
});

router.put('/config', autorizarEnEmpresa('sire.configuracion.editar', empresaDe('body')), validar(esquemaConfig), async (req, res) => {
  const empresa = await cargarEmpresa(req);
  if (req.body.modo === 'SUNAT') {
    const antes = await req.db((tx) => tx.configSire.findUnique({ where: { empresaId: req.empresaId } }));
    const falta = [
      !req.body.clientId && 'client_id',
      !req.body.clientSecret && !antes?.clientSecretCifrado && 'client_secret',
      !req.body.usuarioSol && 'usuario SOL',
      !req.body.claveSol && !antes?.claveSolCifrada && 'clave SOL',
    ].filter(Boolean);
    if (falta.length) return res.status(400).json({ error: `Para conectarse con SUNAT falta: ${falta.join(', ')}` });
  }
  const cfg = await req.db(async (tx) => {
    const antes = await tx.configSire.findUnique({ where: { empresaId: req.empresaId } });
    const c = await guardarConfig(tx, { ...req.body, tenantId: req.tenantId }, empresa.ruc);
    // Los secretos nunca se auditan: solo si cambiaron
    await auditar(tx, req, {
      modulo: 'sire', accion: 'configuracion.editar', recurso: 'empresa', recursoId: req.empresaId, empresaId: req.empresaId,
      antes: configPublica(antes), despues: { ...configPublica(c), clientSecretCambiado: Boolean(req.body.clientSecret), claveSolCambiada: Boolean(req.body.claveSol) },
    });
    return c;
  });
  res.json(configPublica(cfg));
});

router.post('/config/probar', autorizarEnEmpresa('sire.configuracion.editar', empresaDe('body')), async (req, res) => {
  res.json(await probarConexion(req.db, await cargarEmpresa(req)));
});

// ───────────── Períodos ─────────────

const esquemaPeriodos = z.object({
  empresaId: z.uuid(),
  n: z.coerce.number().int().min(1).max(36).default(12),
});

router.get('/periodos', autorizarEnEmpresa('sire.periodo.ver', empresaDe('query')), validar(esquemaPeriodos, 'query'), async (req, res) => {
  const empresa = await cargarEmpresa(req);
  const { periodos, cfg, cronograma } = await req.db(async (tx) => ({
    periodos: await listarPeriodos(tx, empresa, { n: req.validQuery.n }),
    cfg: await tx.configSire.findUnique({ where: { empresaId: empresa.id }, select: { modo: true, activo: true, ultimaConexion: true, ultimoError: true } }),
    cronograma: await tx.cronogramaSunat.count(),
  }));
  res.json({
    empresa: { ...empresa, grupoCronograma: grupoCronograma(empresa) },
    config: cfg,
    cronogramaCargado: cronograma > 0,
    periodos,
    acciones: {
      sincronizar: Boolean(cfg?.activo) && puedeDentroDeEmpresa(req.permisos, 'sire.registro.gestionar', empresa.id),
      configurar: puedeDentroDeEmpresa(req.permisos, 'sire.configuracion.editar', empresa.id),
    },
  });
});

router.post('/periodos/sincronizar', autorizarEnEmpresa('sire.registro.gestionar', empresaDe('body')), async (req, res) => {
  const empresa = await cargarEmpresa(req);
  const r = await sincronizar(req.db, { tenantId: req.tenantId, empresa });
  if (r.ok) {
    await req.db((tx) => auditar(tx, req, {
      modulo: 'sire', accion: 'periodos.sincronizar', recurso: 'empresa', recursoId: empresa.id, empresaId: empresa.id, despues: r,
    }));
  }
  res.json(r);
});

// ───────────── Registros: ventas (RVIE) y compras (RCE) ─────────────

const REGISTROS_DISPONIBLES = ['RVIE', 'RCE'];
const RESOLUCIONES = ['PENDIENTE', 'ACEPTADA', 'JUSTIFICADA', 'INCLUIDA', 'EXCLUIDA'];
/** Valida :registro y :periodo (no se trabaja un período futuro) */
function registroYPeriodo(req) {
  const { registro, periodo } = req.params;
  if (!REGISTROS_DISPONIBLES.includes(registro)) throw noEncontrado('Registro no disponible');
  if (!esPeriodo(periodo) || periodo > periodoActual()) throw solicitudInvalida('Período inválido');
  return { registro, periodo, empresaId: req.empresaId };
}

/** Lanza la operación y da el primer paso en el acto (el simulador termina aquí; SUNAT da ticket) */
async function ejecutar(req, op) {
  const r = await avanzarOperacion({ tenantId: req.tenantId, operacionId: op.id });
  if (r.pendiente) await encolarOperacion(req.tenantId, op.id);
  return r;
}

router.get('/registros/:registro/:periodo', autorizarEnEmpresa('sire.periodo.ver', empresaDe('query')), async (req, res) => {
  const p = registroYPeriodo(req);
  const empresa = await cargarEmpresa(req);
  const resumen = await req.db((tx) => resumenRegistro(tx, p));
  const gestiona = puedeDentroDeEmpresa(req.permisos, 'sire.registro.gestionar', empresa.id);
  const ocupado = resumen.operacion?.estado === 'PROCESANDO';
  res.json({
    ...resumen,
    registro: p.registro, periodo: p.periodo, etiqueta: etiquetaPeriodo(p.periodo), empresa,
    acciones: {
      descargar: gestiona && !ocupado && resumen.estado !== 'GENERADO',
      resolver: gestiona && resumen.estado !== 'GENERADO',
      generar: gestiona && !ocupado && resumen.estado === 'CONCILIADO',
    },
  });
});

router.post('/registros/:registro/:periodo/propuesta', autorizarEnEmpresa('sire.registro.gestionar', empresaDe('body')), async (req, res) => {
  const p = registroYPeriodo(req);
  const op = await iniciarDescarga(req.db, { ...p, tenantId: req.tenantId, usuarioId: req.user.id });
  await req.db((tx) => auditar(tx, req, { modulo: 'sire', accion: 'propuesta.descargar', recurso: 'periodo', recursoId: `${p.registro}-${p.periodo}`, empresaId: p.empresaId, despues: { operacionId: op.id } }));
  const r = await ejecutar(req, op);
  res.status(202).json({ operacionId: op.id, ...r });
});

router.post('/registros/:registro/:periodo/generar', autorizarEnEmpresa('sire.registro.gestionar', empresaDe('body')), async (req, res) => {
  const p = registroYPeriodo(req);
  const op = await iniciarAceptacion(req.db, { ...p, tenantId: req.tenantId, usuarioId: req.user.id });
  await req.db((tx) => auditar(tx, req, { modulo: 'sire', accion: 'registro.generar', recurso: 'periodo', recursoId: `${p.registro}-${p.periodo}`, empresaId: p.empresaId, despues: { operacionId: op.id } }));
  const r = await ejecutar(req, op);
  res.status(202).json({ operacionId: op.id, ...r });
});

const esquemaDiferencias = z.object({
  empresaId: z.uuid(),
  tipo: z.enum(['SOLO_SUNAT', 'SOLO_SISTEMA', 'MONTO', 'ESTADO']).optional().or(z.literal('')).transform((v) => v || undefined),
  resolucion: z.enum(RESOLUCIONES).optional().or(z.literal('')).transform((v) => v || undefined),
});

router.get('/registros/:registro/:periodo/diferencias', autorizarEnEmpresa('sire.periodo.ver', empresaDe('query')), validar(esquemaDiferencias, 'query'), async (req, res) => {
  const p = registroYPeriodo(req);
  const pag = paginacion(req.query);
  const { tipo, resolucion } = req.validQuery;
  const { datos, total } = await req.db(async (tx) => {
    const propuesta = await tx.propuestaSire.findFirst({ where: { empresaId: p.empresaId, periodo: p.periodo, registro: p.registro, vigente: true }, select: { id: true } });
    if (!propuesta) return { datos: [], total: 0 };
    const where = { propuestaId: propuesta.id, ...(tipo && { tipo }), ...(resolucion && { resolucion }) };
    return {
      datos: await tx.diferenciaSire.findMany({ where, orderBy: [{ resolucion: 'asc' }, { tipoCp: 'asc' }, { serie: 'asc' }, { numero: 'asc' }], skip: pag.skip, take: pag.take }),
      total: await tx.diferenciaSire.count({ where }),
    };
  });
  res.json(respuestaPaginada(datos.map((d) => ({
    ...d, tipoNombre: NOMBRE_TIPO_CP[d.tipoCp] ?? d.tipoCp,
    // Resoluciones posibles para este tipo de diferencia (las muestra el menú de acciones)
    resoluciones: RESOLUCIONES_PERMITIDAS[p.registro][d.tipo],
  })), total, pag));
});

const esquemaResolver = z.object({
  empresaId: z.uuid(),
  resolucion: z.enum(RESOLUCIONES),
  nota: z.string().trim().max(500).nullish(),
});

router.post('/registros/:registro/:periodo/diferencias/:id/resolver', autorizarEnEmpresa('sire.registro.gestionar', empresaDe('body')), validar(esquemaResolver), async (req, res) => {
  const p = registroYPeriodo(req);
  if (!uuid.test(req.params.id)) throw noEncontrado();
  const r = await req.db(async (tx) => {
    const x = await resolverDiferencia(tx, { ...p, diferenciaId: req.params.id, resolucion: req.body.resolucion, nota: req.body.nota, usuarioId: req.user.id });
    await auditar(tx, req, {
      modulo: 'sire', accion: 'diferencia.resolver', recurso: 'diferencia', recursoId: req.params.id, empresaId: p.empresaId,
      despues: { clave: x.diferencia.clave, tipo: x.diferencia.tipo, resolucion: x.diferencia.resolucion, nota: x.diferencia.nota },
    });
    return x;
  });
  res.json(r);
});

const esquemaComprobantes = z.object({
  empresaId: z.uuid(),
  origen: z.enum(['sunat', 'sistema']).default('sunat'),
  q: z.string().trim().max(100).optional(),
});

/** Comprobantes de la propuesta vigente o del sistema, para revisarlos lado a lado */
router.get('/registros/:registro/:periodo/comprobantes', autorizarEnEmpresa('sire.periodo.ver', empresaDe('query')), validar(esquemaComprobantes, 'query'), async (req, res) => {
  const p = registroYPeriodo(req);
  const pag = paginacion(req.query);
  const { origen, q } = req.validQuery;
  const coincide = (x) => !q || [x.serie, x.numero, `${x.serie}-${x.numero}`, x.nombre, x.docNumero].some((v) => v && String(v).toUpperCase().includes(q.toUpperCase()));
  if (origen === 'sistema') {
    const lista = (await req.db((tx) => registrosDelSistema(tx, p.empresaId, p.periodo, p.registro)))
      .filter(coincide)
      .sort((a, b) => a.fechaEmision.localeCompare(b.fechaEmision) || a.clave.localeCompare(b.clave));
    return res.json(respuestaPaginada(lista.slice(pag.skip, pag.skip + pag.take).map((x) => ({ ...x, tipoNombre: NOMBRE_TIPO_CP[x.tipoCp] })), lista.length, pag));
  }
  const { datos, total } = await req.db(async (tx) => {
    const propuesta = await tx.propuestaSire.findFirst({ where: { empresaId: p.empresaId, periodo: p.periodo, registro: p.registro, vigente: true }, select: { id: true } });
    if (!propuesta) return { datos: [], total: 0 };
    const where = {
      propuestaId: propuesta.id,
      ...(q && { OR: [{ serie: { contains: q, mode: 'insensitive' } }, { numero: { contains: q } }, { nombre: { contains: q, mode: 'insensitive' } }, { docNumero: { contains: q } }] }),
    };
    return {
      datos: await tx.propuestaSireDetalle.findMany({ where, orderBy: [{ fechaEmision: 'asc' }, { tipoCp: 'asc' }, { serie: 'asc' }, { numero: 'asc' }], skip: pag.skip, take: pag.take }),
      total: await tx.propuestaSireDetalle.count({ where }),
    };
  });
  res.json(respuestaPaginada(datos.map((x) => ({ ...x, fechaEmision: x.fechaEmision.toISOString().slice(0, 10), tipoNombre: NOMBRE_TIPO_CP[x.tipoCp] ?? x.tipoCp })), total, pag));
});

// ───────────── Panel del estudio: todas las empresas ─────────────

/** Empresas activas en las que el usuario tiene el permiso (403 si no lo tiene en ninguna) */
async function empresasVisibles(req, codigo) {
  req.permisos = await obtenerPermisos(req.user);
  if (!tieneAlguno(req.permisos, codigo)) throw prohibido();
  const todas = await req.db((tx) => tx.empresa.findMany({ where: { activo: true }, select: SELECT_EMPRESA, orderBy: { razonSocial: 'asc' } }));
  return todas.filter((e) => puedeDentroDeEmpresa(req.permisos, codigo, e.id));
}
const esquemaPanel = z.object({ n: z.coerce.number().int().min(1).max(12).default(6) });

router.get('/panel', validar(esquemaPanel, 'query'), async (req, res) => {
  const empresas = await empresasVisibles(req, 'sire.periodo.ver');
  const panel = await req.db((tx) => panelEstudio(tx, empresas, { n: req.validQuery.n }));
  res.json({ ...panel, acciones: { sincronizar: empresas.some((e) => puedeDentroDeEmpresa(req.permisos, 'sire.registro.gestionar', e.id)) } });
});

router.get('/panel/excel', validar(esquemaPanel, 'query'), async (req, res) => {
  const empresas = await empresasVisibles(req, 'sire.periodo.ver');
  const panel = await req.db((tx) => panelEstudio(tx, empresas, { n: req.validQuery.n }));
  const buffer = await excelPanel(panel, { estudio: req.user.tenantNombre ?? 'Estudio' });
  const nombre = `panel-sire-${periodoActual()}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
  res.send(Buffer.from(buffer));
});

/** Sincroniza con SUNAT todas las empresas que el usuario gestiona y tienen el SIRE activo */
router.post('/panel/sincronizar', async (req, res) => {
  const empresas = await empresasVisibles(req, 'sire.registro.gestionar');
  const activas = new Set((await req.db((tx) => tx.configSire.findMany({ where: { empresaId: { in: empresas.map((e) => e.id) }, activo: true }, select: { empresaId: true } }))).map((c) => c.empresaId));
  const resultados = [];
  // Una por una: SUNAT limita las llamadas por segundo
  for (const empresa of empresas.filter((e) => activas.has(e.id))) {
    const r = await sincronizar(req.db, { tenantId: req.tenantId, empresa });
    resultados.push({ empresaId: empresa.id, empresa: empresa.razonSocial, ok: r.ok, mensaje: r.mensaje });
    // Queda también en el historial de cada empresa
    if (r.ok) {
      await req.db((tx) => auditar(tx, req, {
        modulo: 'sire', accion: 'periodos.sincronizar', recurso: 'empresa', recursoId: empresa.id, empresaId: empresa.id, despues: { ...r, desdePanel: true },
      }));
    }
  }
  const conError = resultados.filter((r) => !r.ok).length;
  await req.db((tx) => auditar(tx, req, {
    modulo: 'sire', accion: 'panel.sincronizar', recurso: 'estudio', recursoId: req.tenantId,
    despues: { empresas: resultados.length, conError },
  }));
  res.json({ resultados, sinConfigurar: empresas.length - activas.size, conError });
});

const ACCIONES_SIRE = {
  'configuracion.editar': 'Cambió las credenciales SIRE',
  'periodos.sincronizar': 'Sincronizó con SUNAT',
  'propuesta.descargar': 'Descargó la propuesta',
  'diferencia.resolver': 'Resolvió una diferencia',
  'registro.generar': 'Generó el registro',
  'panel.sincronizar': 'Sincronizó todas las empresas',
};
const esquemaHistorial = z.object({ empresaId: z.uuid().optional().or(z.literal('')).transform((v) => v || undefined) });

/** Quién hizo qué en el SIRE (de la auditoría), solo de las empresas que el usuario ve */
router.get('/historial', validar(esquemaHistorial, 'query'), async (req, res) => {
  const empresas = await empresasVisibles(req, 'sire.periodo.ver');
  const pag = paginacion(req.query);
  const ids = empresas.map((e) => e.id).filter((id) => !req.validQuery.empresaId || id === req.validQuery.empresaId);
  // Las acciones de todo el estudio (sin empresa) solo las ve quien tiene el permiso a nivel de estudio
  const verGenerales = !req.validQuery.empresaId && puede(req.permisos, 'sire.periodo.ver', {});
  const where = { modulo: 'sire', OR: [{ empresaId: { in: ids } }, ...(verGenerales ? [{ empresaId: null }] : [])] };
  const { datos, total, usuarios } = await req.db(async (tx) => {
    const datos = await tx.auditoria.findMany({ where, orderBy: { fecha: 'desc' }, skip: pag.skip, take: pag.take });
    const usuarioIds = [...new Set(datos.map((a) => a.usuarioId).filter(Boolean))];
    return {
      datos, total: await tx.auditoria.count({ where }),
      usuarios: new Map((await tx.usuario.findMany({ where: { id: { in: usuarioIds } }, select: { id: true, nombres: true } })).map((u) => [u.id, u.nombres])),
    };
  });
  const empresa = new Map(empresas.map((e) => [e.id, e.razonSocial]));
  res.json(respuestaPaginada(datos.map((a) => ({
    id: String(a.id), fecha: a.fecha, usuario: usuarios.get(a.usuarioId) ?? null, empresa: empresa.get(a.empresaId) ?? null, empresaId: a.empresaId,
    accion: a.accion, texto: ACCIONES_SIRE[a.accion] ?? a.accion, recursoId: a.recursoId, detalle: a.despues,
  })), total, pag));
});

export default router;
