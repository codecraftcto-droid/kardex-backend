import IORedis from 'ioredis';
import { Emitter } from '@socket.io/redis-emitter';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { withTenant } from '../lib/prisma.js';
import { conflicto, noEncontrado, solicitudInvalida } from '../lib/errors.js';
import { siguienteValor } from '../kardex/servicio.js';
import { descifrar } from '../services/mfa.js';
import { hoyLima } from '../pos/reglas.js';
import { PROVEEDORES } from '../cpe/proveedores/index.js';
import { ErrorDocumento, ErrorTransitorio } from '../cpe/documento.js';
import { CODIGO_DOC_RELACIONADO, MOTIVOS_TRASLADO, erroresGuia } from './reglas.js';

/**
 * Guías de remisión electrónicas (remitente): preparación desde una transferencia o una venta,
 * emisión con correlativo propio y envío a SUNAT por medio del proveedor de la empresa.
 */
const FINALES = ['ACEPTADO', 'OBSERVADO'];
const direccionSede = (sede) => ({ ubigeo: sede.ubigeo ?? '', direccion: sede.direccion ?? '', establecimiento: sede.codigoEstablecimiento ?? null });

/** Borrador a partir de una transferencia entre almacenes (motivo 04) */
export async function prepararDesdeTransferencia(tx, transferenciaId) {
  const t = await tx.transferencia.findUnique({
    where: { id: transferenciaId },
    include: {
      empresa: { select: { ruc: true, razonSocial: true } },
      origen: { include: { sede: true } },
      destino: { include: { sede: true } },
      detalles: { include: { producto: { select: { id: true, sku: true, nombre: true, unidad: { select: { codigo: true } } } } } },
    },
  });
  if (!t) throw noEncontrado('Transferencia no encontrada');
  if (['RECHAZADA', 'CANCELADA'].includes(t.estado)) throw conflicto('La transferencia fue rechazada o cancelada');
  const partida = direccionSede(t.origen.sede);
  const llegada = direccionSede(t.destino.sede);
  return {
    empresaId: t.empresaId, almacenId: t.origenAlmacenId, motivo: '04', transferenciaId: t.id, fechaTraslado: hoyLima(),
    destinatarioTipoDoc: 'RUC', destinatarioNumDoc: t.empresa.ruc, destinatarioNombre: t.empresa.razonSocial,
    partidaUbigeo: partida.ubigeo, partidaDireccion: partida.direccion, partidaEstablecimiento: partida.establecimiento,
    llegadaUbigeo: llegada.ubigeo, llegadaDireccion: llegada.direccion, llegadaEstablecimiento: llegada.establecimiento,
    observacion: `Transferencia ${t.numero}: ${t.origen.nombre} → ${t.destino.nombre}`,
    items: t.detalles.map((d) => ({
      productoId: d.producto.id, codigo: d.producto.sku, descripcion: d.producto.nombre, unidadCodigo: d.producto.unidad.codigo,
      cantidad: String(d.cantidadDespachada ?? d.cantidadSolicitada),
    })),
  };
}

/** Borrador a partir de una venta de caja (motivo 01, con el comprobante relacionado) */
export async function prepararDesdeComprobante(tx, comprobanteId) {
  const c = await tx.comprobante.findUnique({
    where: { id: comprobanteId },
    include: { detalles: { include: { producto: { select: { sku: true } } } }, caja: { include: { almacen: { include: { sede: true } } } } },
  });
  if (!c) throw noEncontrado('Comprobante no encontrado');
  if (!CODIGO_DOC_RELACIONADO[c.tipo]) throw conflicto('Solo se emiten guías para facturas y boletas');
  if (c.estado === 'ANULADO') throw conflicto('El comprobante está anulado');
  const partida = direccionSede(c.caja.almacen.sede);
  return {
    empresaId: c.empresaId, almacenId: c.almacenId, motivo: '01', comprobanteId: c.id, fechaTraslado: hoyLima(),
    destinatarioTipoDoc: c.clienteTipoDocumento, destinatarioNumDoc: c.clienteNumeroDocumento === '-' ? '' : c.clienteNumeroDocumento,
    destinatarioNombre: c.clienteNombre,
    partidaUbigeo: partida.ubigeo, partidaDireccion: partida.direccion, partidaEstablecimiento: partida.establecimiento,
    llegadaUbigeo: '', llegadaDireccion: c.clienteDireccion ?? '', llegadaEstablecimiento: null,
    docRelTipo: CODIGO_DOC_RELACIONADO[c.tipo], docRelSerie: c.serie, docRelNumero: String(c.numero),
    items: c.detalles.map((d) => ({
      productoId: d.productoId, codigo: d.producto?.sku ?? null, descripcion: d.descripcion, unidadCodigo: d.unidadCodigo, cantidad: String(d.cantidad),
    })),
  };
}

/** Emite la guía: valida, numera (serie de la empresa) y guarda. */
export async function crearGuia(tx, { tenantId, usuarioId, datos }) {
  const almacen = await tx.almacen.findUnique({ where: { id: datos.almacenId }, include: { empresa: { select: { id: true, ruc: true } } } });
  if (!almacen) throw noEncontrado('Almacén no encontrado');
  const errores = erroresGuia(datos, { empresaRuc: almacen.empresa.ruc });
  if (errores.length) throw solicitudInvalida(errores[0], errores.map((mensaje) => ({ campo: 'guia', mensaje })));

  // Productos del catálogo de la empresa: se toma su nombre/unidad si no vienen
  const ids = datos.items.map((i) => i.productoId).filter(Boolean);
  const productos = new Map((await tx.producto.findMany({ where: { id: { in: ids }, empresaId: almacen.empresaId }, include: { unidad: true } })).map((p) => [p.id, p]));
  if (ids.some((id) => !productos.has(id))) throw solicitudInvalida('Algún producto no pertenece a la empresa');

  const config = await tx.configFacturacion.findUnique({ where: { empresaId: almacen.empresaId }, select: { serieGuia: true } });
  const serie = config?.serieGuia ?? 'T001';
  const numero = await siguienteValor(tx, { tenantId, empresaId: almacen.empresaId, clave: `GUIA:${serie}` });
  const { items, ...cabecera } = datos;
  return tx.guiaRemision.create({
    data: {
      ...cabecera,
      tenantId, empresaId: almacen.empresaId, sedeId: almacen.sedeId, serie, numero, usuarioId,
      fechaTraslado: new Date(`${String(datos.fechaTraslado).slice(0, 10)}T00:00:00Z`),
      vehiculoPlaca: datos.vehiculoPlaca ? datos.vehiculoPlaca.replace(/-/g, '').toUpperCase() : null,
      conductorLicencia: datos.conductorLicencia?.toUpperCase() ?? null,
      motivoDescripcion: datos.motivoDescripcion || (datos.motivo !== '13' ? MOTIVOS_TRASLADO[datos.motivo] : null),
      detalles: {
        create: items.map((i) => {
          const p = i.productoId ? productos.get(i.productoId) : null;
          return {
            tenantId, productoId: i.productoId ?? null, codigo: i.codigo ?? p?.sku ?? null,
            descripcion: i.descripcion || p?.nombre, unidadCodigo: i.unidadCodigo || p?.unidad.codigo || 'NIU', cantidad: i.cantidad,
          };
        }),
      },
    },
    include: { detalles: true },
  });
}

/** Documento neutro de la guía (lo traduce cada conector) */
export function documentoGuia(g, empresa) {
  return {
    emisor: { ruc: empresa.ruc, razonSocial: empresa.razonSocial },
    serie: g.serie, numero: g.numero, fecha: hoyLima(g.fechaEmision), fechaTraslado: g.fechaTraslado.toISOString().slice(0, 10),
    motivo: g.motivo, motivoDescripcion: g.motivoDescripcion, modalidad: g.modalidad,
    destinatario: { tipoDocumento: g.destinatarioTipoDoc, numeroDocumento: g.destinatarioNumDoc, nombre: g.destinatarioNombre },
    partida: { ubigeo: g.partidaUbigeo, direccion: g.partidaDireccion, establecimiento: g.partidaEstablecimiento },
    llegada: { ubigeo: g.llegadaUbigeo, direccion: g.llegadaDireccion, establecimiento: g.llegadaEstablecimiento },
    pesoBruto: g.pesoBruto, unidadPeso: g.unidadPeso, bultos: g.bultos,
    transportista: g.modalidad === 'PUBLICO' ? { ruc: g.transportistaRuc, nombre: g.transportistaNombre, mtc: g.transportistaMtc } : null,
    conductor: g.modalidad === 'PRIVADO'
      ? { tipoDocumento: g.conductorTipoDoc, numeroDocumento: g.conductorNumDoc, nombres: g.conductorNombres, apellidos: g.conductorApellidos, licencia: g.conductorLicencia }
      : null,
    vehiculoPlaca: g.vehiculoPlaca,
    documentoRelacionado: g.docRelTipo ? { tipo: g.docRelTipo, serie: g.docRelSerie, numero: g.docRelNumero } : null,
    observacion: g.observacion,
    items: g.detalles.map((d) => ({ codigo: d.codigo ?? '', descripcion: d.descripcion, unidad: d.unidadCodigo, cantidad: d.cantidad })),
  };
}

let emisor = null;
const notificar = (g) => {
  emisor ||= new Emitter(new IORedis(env.REDIS_URL));
  emisor.to(`almacen:${g.almacenId}`).to(`empresa:${g.empresaId}`).emit('gre:guia', { id: g.id, serie: g.serie, numero: g.numero, estadoSunat: g.estadoSunat });
};

/** Envía (o consulta, si ya se envió) la guía a SUNAT. Lanza ErrorTransitorio para reintentar. */
export async function enviarGuia({ tenantId, guiaId }) {
  const db = (fn) => withTenant(tenantId, fn);
  const { g, cfg } = await db(async (tx) => {
    const g = await tx.guiaRemision.findUnique({ where: { id: guiaId }, include: { detalles: true, empresa: { select: { ruc: true, razonSocial: true } } } });
    const c = g ? await tx.configFacturacion.findUnique({ where: { empresaId: g.empresaId } }) : null;
    return { g, cfg: c?.activo ? { ...c, token: c.tokenCifrado ? descifrar(c.tokenCifrado) : null } : null };
  });
  if (!g) return { estado: 'NO_APLICA', mensaje: 'Guía no encontrada' };
  if (FINALES.includes(g.estadoSunat)) return { estado: g.estadoSunat, mensaje: 'Ya tiene respuesta de SUNAT' };
  if (g.estado === 'ANULADA') return { estado: g.estadoSunat, mensaje: 'La guía está anulada: no se envía' };
  if (!cfg) return { estado: g.estadoSunat, mensaje: 'La empresa no tiene configurada la facturación electrónica' };
  const proveedor = PROVEEDORES[cfg.proveedor];
  const doc = documentoGuia(g, g.empresa);
  let r;
  try {
    r = g.estadoSunat === 'ENVIADO' ? await proveedor.consultarGuia(cfg, doc) : await proveedor.enviarGuia(cfg, doc);
  } catch (e) {
    await db((tx) => tx.guiaRemision.update({ where: { id: g.id }, data: { sunatIntentos: { increment: 1 }, sunatUltimoError: e.message.slice(0, 500) } }));
    logger.warn({ guia: `${g.serie}-${g.numero}`, err: e.message }, 'Envío de guía con error');
    if (e instanceof ErrorTransitorio || !(e instanceof ErrorDocumento)) throw e;
    return { estado: g.estadoSunat, mensaje: e.message, error: true };
  }
  const a = await db((tx) => tx.guiaRemision.update({
    where: { id: g.id },
    data: {
      estadoSunat: r.estado, sunatCodigo: r.codigo ?? null, sunatDescripcion: r.descripcion?.slice(0, 1000) ?? null,
      sunatHash: r.hash ?? g.sunatHash, sunatQr: r.qr ?? g.sunatQr, sunatPdf: r.pdf ?? g.sunatPdf, sunatXml: r.xml ?? g.sunatXml, sunatCdr: r.cdr ?? g.sunatCdr,
      sunatIntentos: { increment: 1 }, sunatUltimoError: null, sunatEnviadoEn: g.sunatEnviadoEn ?? new Date(),
    },
  }));
  notificar(a);
  return { estado: r.estado, mensaje: r.descripcion };
}
