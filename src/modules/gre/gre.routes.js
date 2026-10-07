import { Router } from 'express';
import { z } from 'zod';
import QRCode from 'qrcode';
import { autorizar } from '../../middleware/autorizar.js';
import { validar } from '../../middleware/validar.js';
import { obtenerPermisos } from '../../rbac/servicio.js';
import { puede, tieneAlguno, whereAlcance } from '../../rbac/resolver.js';
import { auditar } from '../../services/auditoria.js';
import { paginacion, respuestaPaginada } from '../../lib/http.js';
import { textoOpcional } from '../../lib/esquemas.js';
import { conflicto, noEncontrado, prohibido } from '../../lib/errors.js';
import { encolarGuia } from '../../cpe/cola.js';
import { MOTIVOS_TRASLADO } from '../../gre/reglas.js';
import { crearGuia, enviarGuia, prepararDesdeComprobante, prepararDesdeTransferencia } from '../../gre/servicio.js';

/**
 * Guías de remisión electrónicas. El alcance es el ALMACÉN DE PARTIDA: quien despacha desde
 * un almacén emite y ve sus guías.
 */
const router = Router();
const uuid = /^[0-9a-f-]{36}$/i;
const recurso = (g) => ({ empresaId: g.empresaId, sedeId: g.sedeId, almacenId: g.almacenId });
const TIPOS_DOC = ['DNI', 'RUC', 'CARNE_EXTRANJERIA', 'PASAPORTE', 'SIN_DOCUMENTO'];
const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida');
const texto = (max) => z.string().trim().max(max);

async function cargar(req, codigo, include) {
  req.permisos ??= await obtenerPermisos(req.user);
  if (!tieneAlguno(req.permisos, codigo)) throw prohibido();
  if (!uuid.test(req.params.id || '')) throw noEncontrado();
  const g = await req.db((tx) => tx.guiaRemision.findUnique({ where: { id: req.params.id }, include }));
  if (!g || !puede(req.permisos, codigo, recurso(g))) throw noEncontrado();
  return g;
}

router.get('/motivos', (_req, res) => res.json(MOTIVOS_TRASLADO));

router.get(
  '/',
  autorizar('gre.guia.ver'),
  validar(z.object({
    empresaId: z.uuid(), q: z.string().trim().max(60).optional(), estadoSunat: z.string().optional(),
    transferenciaId: z.uuid().optional(), comprobanteId: z.uuid().optional(), pagina: z.string().optional(), porPagina: z.string().optional(),
  }), 'query'),
  async (req, res) => {
    const pag = paginacion(req.validQuery);
    const alcance = whereAlcance(req.permisos, 'gre.guia.ver', 'registro');
    if (!alcance) return res.json(respuestaPaginada([], 0, pag));
    const { empresaId, q, estadoSunat, transferenciaId, comprobanteId } = req.validQuery;
    const numero = q && /^\d+$/.test(q.split('-').at(-1)) ? Number(q.split('-').at(-1)) : null;
    const where = {
      AND: [
        alcance, { empresaId },
        estadoSunat ? { estadoSunat } : {},
        transferenciaId ? { transferenciaId } : {},
        comprobanteId ? { comprobanteId } : {},
        q ? { OR: [{ destinatarioNombre: { contains: q, mode: 'insensitive' } }, { destinatarioNumDoc: { startsWith: q } }, ...(numero ? [{ numero }] : [])] } : {},
      ],
    };
    const [datos, total] = await req.db((tx) =>
      Promise.all([
        tx.guiaRemision.findMany({ where, orderBy: { fechaEmision: 'desc' }, skip: pag.skip, take: pag.take, include: { _count: { select: { detalles: true } } } }),
        tx.guiaRemision.count({ where }),
      ]),
    );
    res.json(respuestaPaginada(datos, total, pag));
  },
);

/** Borrador precargado desde una transferencia o una venta (no guarda nada) */
router.get(
  '/preparar',
  autorizar('gre.guia.crear'),
  validar(z.object({ desde: z.enum(['transferencia', 'comprobante']), id: z.uuid() }), 'query'),
  async (req, res) => {
    const { desde, id } = req.validQuery;
    const borrador = await req.db((tx) => (desde === 'transferencia' ? prepararDesdeTransferencia(tx, id) : prepararDesdeComprobante(tx, id)));
    const almacen = await req.db((tx) => tx.almacen.findUnique({ where: { id: borrador.almacenId }, select: { id: true, empresaId: true, sedeId: true } }));
    if (!puede(req.permisos, 'gre.guia.crear', { empresaId: almacen.empresaId, sedeId: almacen.sedeId, almacenId: almacen.id })) throw noEncontrado();
    const previas = await req.db((tx) => tx.guiaRemision.count({ where: { estado: 'EMITIDA', ...(desde === 'transferencia' ? { transferenciaId: id } : { comprobanteId: id }) } }));
    res.json({ ...borrador, guiasPrevias: previas });
  },
);

router.get('/:id', async (req, res) => {
  const g = await cargar(req, 'gre.guia.ver', {
    detalles: true,
    empresa: { select: { razonSocial: true, nombreComercial: true, ruc: true, direccion: true } },
  });
  const usuario = await req.db((tx) => tx.usuario.findUnique({ where: { id: g.usuarioId }, select: { nombres: true } }));
  res.json({
    ...g,
    motivoTexto: MOTIVOS_TRASLADO[g.motivo],
    numeroCompleto: `${g.serie}-${String(g.numero).padStart(8, '0')}`,
    emitidoPor: usuario?.nombres,
    qr: g.sunatQr ? await QRCode.toDataURL(g.sunatQr, { margin: 1, width: 180 }) : null,
    acciones: {
      enviar: g.estado === 'EMITIDA' && ['PENDIENTE', 'ENVIADO'].includes(g.estadoSunat) && puede(req.permisos, 'gre.guia.crear', recurso(g)),
      anular: g.estado === 'EMITIDA' && !g.sunatEnviadoEn && puede(req.permisos, 'gre.guia.crear', recurso(g)),
    },
  });
});

const tipoDoc = z.enum(TIPOS_DOC);
const esquemaGuia = z.object({
  almacenId: z.uuid(),
  fechaTraslado: fecha,
  motivo: z.enum(Object.keys(MOTIVOS_TRASLADO)),
  motivoDescripcion: textoOpcional(100),
  modalidad: z.enum(['PUBLICO', 'PRIVADO']),
  destinatarioTipoDoc: tipoDoc,
  destinatarioNumDoc: texto(15).default(''),
  destinatarioNombre: texto(200).min(2, 'Indique el destinatario'),
  partidaUbigeo: texto(6), partidaDireccion: texto(250), partidaEstablecimiento: textoOpcional(4),
  llegadaUbigeo: texto(6), llegadaDireccion: texto(250), llegadaEstablecimiento: textoOpcional(4),
  pesoBruto: z.coerce.number().positive('El peso debe ser mayor que cero').max(1_000_000),
  unidadPeso: z.enum(['KGM', 'TNE']).default('KGM'),
  bultos: z.coerce.number().int().min(0).max(100000).nullish(),
  transportistaRuc: textoOpcional(11), transportistaNombre: textoOpcional(200), transportistaMtc: textoOpcional(20),
  conductorTipoDoc: tipoDoc.nullish(), conductorNumDoc: textoOpcional(15), conductorNombres: textoOpcional(100), conductorApellidos: textoOpcional(100),
  conductorLicencia: textoOpcional(10), vehiculoPlaca: textoOpcional(10),
  docRelTipo: z.enum(['01', '03']).nullish(), docRelSerie: textoOpcional(4), docRelNumero: textoOpcional(10),
  transferenciaId: z.uuid().nullish(), comprobanteId: z.uuid().nullish(),
  observacion: textoOpcional(500),
  items: z.array(z.object({
    productoId: z.uuid().nullish(), codigo: textoOpcional(30), descripcion: texto(250).optional(), unidadCodigo: textoOpcional(5),
    cantidad: z.union([z.string(), z.number()]).transform((v) => String(v)).pipe(z.string().regex(/^\d{1,12}(\.\d{1,4})?$/, 'Cantidad inválida')),
  })).min(1, 'Agregue al menos un producto').max(300),
});

router.post('/', autorizar('gre.guia.crear'), validar(esquemaGuia), async (req, res) => {
  const almacen = await req.db((tx) => tx.almacen.findUnique({ where: { id: req.body.almacenId }, select: { id: true, empresaId: true, sedeId: true } }));
  if (!almacen || !puede(req.permisos, 'gre.guia.crear', { empresaId: almacen.empresaId, sedeId: almacen.sedeId, almacenId: almacen.id })) throw noEncontrado('Almacén no encontrado');
  const g = await req.db(async (tx) => {
    const creada = await crearGuia(tx, { tenantId: req.tenantId, usuarioId: req.user.id, datos: req.body });
    await auditar(tx, req, {
      modulo: 'gre', accion: 'guia.emitir', recurso: 'guia_remision', recursoId: creada.id, empresaId: creada.empresaId,
      despues: { guia: `${creada.serie}-${creada.numero}`, motivo: creada.motivo, destinatario: creada.destinatarioNombre },
    });
    return creada;
  });
  const cfg = await req.db((tx) => tx.configFacturacion.findUnique({ where: { empresaId: g.empresaId }, select: { activo: true, envioAutomatico: true } }));
  if (cfg?.activo && cfg.envioAutomatico) await encolarGuia(req.tenantId, g.id);
  res.status(201).json({ id: g.id, serie: g.serie, numero: g.numero });
});

/** Envía (o consulta) ahora, sin esperar a la cola */
router.post('/:id/enviar', async (req, res) => {
  const g = await cargar(req, 'gre.guia.crear');
  let r;
  try {
    r = await enviarGuia({ tenantId: req.tenantId, guiaId: g.id });
  } catch (e) {
    await encolarGuia(req.tenantId, g.id, { retraso: 60_000 });
    r = { estado: g.estadoSunat, mensaje: `${e.message}. Se reintentará automáticamente.`, error: true };
  }
  res.json(r);
});

/** Solo mientras no se haya enviado a SUNAT; después se gestiona en SUNAT Operaciones en Línea */
router.post('/:id/anular', validar(z.object({ motivo: z.string().trim().min(5, 'Indique el motivo').max(300) })), async (req, res) => {
  const g = await cargar(req, 'gre.guia.crear');
  if (g.estado === 'ANULADA') throw conflicto('La guía ya está anulada');
  if (g.sunatEnviadoEn) throw conflicto('La guía ya se envió a SUNAT: si el traslado no se realizó, dela de baja en SUNAT Operaciones en Línea');
  await req.db(async (tx) => {
    await tx.guiaRemision.update({ where: { id: g.id }, data: { estado: 'ANULADA', observacion: [g.observacion, `Anulada: ${req.body.motivo}`].filter(Boolean).join(' · ') } });
    await auditar(tx, req, { modulo: 'gre', accion: 'guia.anular', recurso: 'guia_remision', recursoId: g.id, empresaId: g.empresaId, despues: { motivo: req.body.motivo } });
  });
  res.json({ id: g.id, estado: 'ANULADA' });
});

export default router;
