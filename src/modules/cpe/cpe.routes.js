import { Router } from 'express';
import { z } from 'zod';
import { autorizarEnEmpresa } from '../../middleware/autorizar.js';
import { validar } from '../../middleware/validar.js';
import { obtenerPermisos } from '../../rbac/servicio.js';
import { puede, puedeDentroDeEmpresa, tieneAlguno, whereAlcance } from '../../rbac/resolver.js';
import { auditar } from '../../services/auditoria.js';
import { noEncontrado, prohibido } from '../../lib/errors.js';
import { ELECTRONICOS, configPublica, enviarComprobante, guardarConfig, probarConexion } from '../../cpe/servicio.js';
import { encolarEnvio } from '../../cpe/cola.js';
import { PROVEEDORES } from '../../cpe/proveedores/index.js';

/**
 * Facturación electrónica: configuración del proveedor por empresa y envíos a SUNAT.
 * La configuración (y el token) es de la empresa; los envíos respetan el alcance del comprobante.
 */
const router = Router();
const uuid = /^[0-9a-f-]{36}$/i;
const empresaDe = (origen) => (req) => {
  const v = origen === 'query' ? req.query.empresaId : req.body?.empresaId;
  return uuid.test(v || '') ? v : null;
};

// ───────────── Configuración ─────────────

router.get('/proveedores', (_req, res) => res.json(Object.entries(PROVEEDORES).map(([codigo, p]) => ({ codigo, nombre: p.nombre }))));

router.get('/config', autorizarEnEmpresa('cpe.configuracion.editar', empresaDe('query')), async (req, res) => {
  const cfg = await req.db((tx) => tx.configFacturacion.findUnique({ where: { empresaId: req.empresaId } }));
  res.json(configPublica(cfg));
});

const esquemaConfig = z.object({
  empresaId: z.uuid(),
  proveedor: z.enum(Object.keys(PROVEEDORES)),
  ambiente: z.enum(['PRUEBAS', 'PRODUCCION']),
  url: z.union([z.url('Ingrese la RUTA completa (https://…)'), z.literal('')]).nullish().transform((v) => v || null),
  /** Solo se envía para cambiarlo; vacío = conservar el actual */
  token: z.string().trim().max(500).nullish().transform((v) => v || null),
  envioAutomatico: z.boolean().default(true),
  activo: z.boolean().default(true),
  serieGuia: z.string().trim().toUpperCase().regex(/^T[A-Z0-9]{3}$/, 'Serie de guía: T + 3 caracteres (p. ej. T001)').default('T001'),
  /** Credenciales API SUNAT (consulta de validez de comprobantes de compra) */
  sunatClientId: z.string().trim().max(100).nullish().transform((v) => v || null),
  sunatClientSecret: z.string().trim().max(200).nullish().transform((v) => v || null),
});

router.put('/config', autorizarEnEmpresa('cpe.configuracion.editar', empresaDe('body')), validar(esquemaConfig), async (req, res) => {
  const cfg = await req.db(async (tx) => {
    const antes = await tx.configFacturacion.findUnique({ where: { empresaId: req.empresaId } });
    const c = await guardarConfig(tx, { ...req.body, tenantId: req.tenantId });
    // El token nunca se audita: solo si cambió
    await auditar(tx, req, {
      modulo: 'cpe', accion: 'configuracion.editar', recurso: 'empresa', recursoId: req.empresaId, empresaId: req.empresaId,
      antes: configPublica(antes), despues: { ...configPublica(c), tokenCambiado: Boolean(req.body.token), secretoSunatCambiado: Boolean(req.body.sunatClientSecret) },
    });
    return c;
  });
  res.json(configPublica(cfg));
});

router.post('/config/probar', autorizarEnEmpresa('cpe.configuracion.editar', empresaDe('body')), async (req, res) => {
  res.json(await req.db((tx) => probarConexion(tx, req.empresaId)));
});

// ───────────── Envíos ─────────────

/** Comprobante con alcance de almacén (404 si no lo ve) */
async function cargarComprobante(req, codigo) {
  req.permisos = await obtenerPermisos(req.user);
  if (!tieneAlguno(req.permisos, codigo)) throw prohibido();
  if (!uuid.test(req.params.id || '')) throw noEncontrado();
  const c = await req.db((tx) => tx.comprobante.findUnique({ where: { id: req.params.id } }));
  if (!c || !puede(req.permisos, codigo, { empresaId: c.empresaId, sedeId: c.sedeId, almacenId: c.almacenId })) throw noEncontrado();
  return c;
}

/** Envía o reenvía AHORA (sin cola), para ver la respuesta de SUNAT en el momento */
router.post('/comprobantes/:id/enviar', async (req, res) => {
  const c = await cargarComprobante(req, 'cpe.envio.gestionar');
  let r;
  try {
    r = await enviarComprobante({ tenantId: req.tenantId, comprobanteId: c.id });
  } catch (e) {
    // Proveedor caído: queda en cola para reintentar sola
    await encolarEnvio(req.tenantId, c.id, { retraso: 60_000 });
    r = { estado: c.estadoSunat, mensaje: `${e.message}. Se reintentará automáticamente.`, error: true };
  }
  await req.db((tx) => auditar(tx, req, {
    modulo: 'cpe', accion: 'comprobante.enviar', recurso: 'comprobante', recursoId: c.id, empresaId: c.empresaId,
    despues: { comprobante: `${c.serie}-${c.numero}`, estado: r.estado },
  }));
  res.json(r);
});

/** Reenvía en segundo plano todo lo pendiente de la empresa (p. ej. tras configurar el proveedor) */
router.post('/pendientes/enviar', autorizarEnEmpresa('cpe.envio.gestionar', empresaDe('body')), async (req, res) => {
  const alcance = whereAlcance(req.permisos, 'cpe.envio.gestionar', 'registro') ?? { id: null };
  const pendientes = await req.db((tx) =>
    tx.comprobante.findMany({
      where: { AND: [alcance, { empresaId: req.empresaId, tipo: { in: ELECTRONICOS }, estadoSunat: { in: ['PENDIENTE', 'ENVIADO'] }, NOT: { estado: 'ANULADO', sunatEnviadoEn: null } }] },
      select: { id: true },
      take: 1000,
    }),
  );
  for (const p of pendientes) await encolarEnvio(req.tenantId, p.id);
  res.json({ encolados: pendientes.length });
});

/** Resumen de estados SUNAT de la empresa (para el aviso de pendientes y rechazados) */
router.get('/resumen', autorizarEnEmpresa('pos.venta.ver', empresaDe('query')), async (req, res) => {
  const alcance = whereAlcance(req.permisos, 'pos.venta.ver', 'registro') ?? { id: null };
  const grupos = await req.db((tx) =>
    tx.comprobante.groupBy({
      by: ['estadoSunat'],
      where: { AND: [alcance, { empresaId: req.empresaId, tipo: { in: ELECTRONICOS } }] },
      _count: { _all: true },
    }),
  );
  const cfg = await req.db((tx) => tx.configFacturacion.findUnique({ where: { empresaId: req.empresaId }, select: { activo: true, proveedor: true, ambiente: true } }));
  res.json({
    porEstado: Object.fromEntries(grupos.map((g) => [g.estadoSunat, g._count._all])),
    configurada: Boolean(cfg?.activo),
    proveedor: cfg?.proveedor ?? null,
    ambiente: cfg?.ambiente ?? null,
    puedeConfigurar: puedeDentroDeEmpresa(req.permisos, 'cpe.configuracion.editar', req.empresaId),
    puedeEnviar: puedeDentroDeEmpresa(req.permisos, 'cpe.envio.gestionar', req.empresaId),
  });
});

export default router;
