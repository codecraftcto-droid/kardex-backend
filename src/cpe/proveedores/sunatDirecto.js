import IORedis from 'ioredis';
import { env } from '../../config/env.js';
import { hoyLima, montoEnLetras } from '../../pos/reglas.js';
import { ErrorDocumento, ErrorTransitorio, cadenaQr } from '../documento.js';

/**
 * Conector SUNAT directo: envía por el servicio propio (Laravel + Greenter, repo sunat-service),
 * que arma el XML, lo firma con el certificado de la empresa y lo envía a SUNAT.
 * - Facturas, boletas y notas: respuesta inmediata con CDR.
 * - Anulaciones: comunicación de baja (facturas) o resumen diario estado 3 (boletas), por ticket.
 * - Guías de remisión: API REST de SUNAT, por ticket.
 * El certificado, la clave SOL y los secretos viajan solo por la red interna hacia el servicio.
 */
const TIPO = { FACTURA: '01', BOLETA: '03', NOTA_CREDITO: '07', NOTA_DEBITO: '08' };
const DOC = { SIN_DOCUMENTO: '0', DNI: '1', CARNE_EXTRANJERIA: '4', RUC: '6', PASAPORTE: '7' };
const n = (d, dec = 2) => Number(Number(d).toFixed(dec));
const horaLima = (fecha) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(fecha ?? new Date());

class Duplicado extends Error {}

function credenciales(cfg, ruc) {
  return {
    ruc,
    usuarioSol: cfg.solUsuario || null,
    claveSol: cfg.solClave || null,
    certificado: cfg.certificado || null,
    greClientId: cfg.greClientId || null,
    greClientSecret: cfg.greClientSecret || null,
  };
}

export async function llamarServicio(ruta, cuerpo) {
  if (!env.SUNAT_SERVICIO_URL || !env.SUNAT_SERVICIO_TOKEN) throw new ErrorDocumento('El servicio SUNAT no está configurado en el servidor (SUNAT_SERVICIO_URL y SUNAT_SERVICIO_TOKEN)');
  let r;
  try {
    r = await fetch(`${env.SUNAT_SERVICIO_URL.replace(/\/$/, '')}/v1/${ruta}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.SUNAT_SERVICIO_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (e) {
    throw new ErrorTransitorio(`El servicio SUNAT no respondió: ${e.message}`);
  }
  const j = await r.json().catch(() => ({}));
  if (r.ok) return j;
  if (r.status >= 500 || r.status === 429) throw new ErrorTransitorio(j.mensaje || `El servicio SUNAT respondió ${r.status}; se reintentará`);
  if (r.status === 401) throw new ErrorDocumento('El servicio SUNAT rechazó la clave del servidor (SUNAT_SERVICIO_TOKEN)');
  if (r.status === 409 && j.tipo === 'duplicado') throw new Duplicado(j.mensaje);
  // Validación de Laravel ({ message, errors }) o error de SUNAT ({ tipo, codigo, mensaje })
  const detalle = j.errors ? Object.values(j.errors).flat()[0] : null;
  throw new ErrorDocumento(j.mensaje || detalle || j.message || `El servicio SUNAT respondió ${r.status}`);
}

/** Documento en el formato del servicio (códigos de SUNAT e importes ya calculados) */
export function cuerpoComprobante(doc) {
  const credito = doc.formaPago === 'CREDITO';
  return {
    tipoDoc: TIPO[doc.tipo],
    serie: doc.serie,
    numero: doc.numero,
    fechaEmision: doc.fecha,
    horaEmision: horaLima(doc.fechaHora),
    moneda: doc.moneda,
    tipoOperacion: doc.detraccion ? '1001' : '0101',
    leyenda: montoEnLetras(doc.totales.total, doc.moneda),
    emisor: doc.emisor,
    cliente: {
      tipoDoc: DOC[doc.cliente.tipoDocumento] ?? '0',
      numDoc: doc.cliente.tipoDocumento === 'SIN_DOCUMENTO' || !doc.cliente.numeroDocumento ? '-' : doc.cliente.numeroDocumento,
      nombre: doc.cliente.nombre,
      direccion: doc.cliente.direccion || null,
    },
    totales: {
      gravada: n(doc.totales.gravada), exonerada: n(doc.totales.exonerada), inafecta: n(doc.totales.inafecta),
      igv: n(doc.totales.igv), total: n(doc.totales.total),
    },
    items: doc.items.map((i) => ({
      codigo: i.codigo, descripcion: i.descripcion, unidad: i.unidad, cantidad: n(i.cantidad, 4),
      valorUnitario: n(i.valorUnitario, 10), precioUnitario: n(i.precioUnitario, 10),
      valorVenta: n(i.valorVenta), igv: n(i.igv), afectacion: String(i.afectacion),
    })),
    formaPago: credito ? 'CREDITO' : 'CONTADO',
    ...(credito && { montoCredito: n(doc.montoCredito), cuotas: doc.cuotas.map((q) => ({ monto: n(q.monto), fecha: q.fecha })) }),
    ...(doc.detraccion && {
      detraccion: { codigo: doc.detraccion.codigo, porcentaje: n(doc.detraccion.porcentaje), monto: n(doc.detraccion.monto), cuenta: doc.detraccion.cuenta, medioPago: '001' },
    }),
    ...(doc.retencion && { retencion: { porcentaje: n(doc.retencion.porcentaje), monto: n(doc.retencion.monto), base: n(doc.retencion.base) } }),
    ...(doc.referencia && {
      referencia: { tipoDoc: TIPO[doc.referencia.tipo], serie: doc.referencia.serie, numero: doc.referencia.numero },
      motivo: { codigo: String(doc.motivoNotaCredito?.codigo ?? '01').padStart(2, '0'), descripcion: doc.motivoNotaCredito?.descripcion || 'ANULACION DE LA OPERACION' },
    }),
  };
}

export function cuerpoGuia(g) {
  // Traslado entre establecimientos de la misma empresa (04): SUNAT pide RUC y código de local
  const propio = g.motivo === '04' ? { ruc: g.emisor.ruc } : {};
  return {
    serie: g.serie, numero: g.numero, fechaEmision: g.fecha, horaEmision: horaLima(g.fechaHora), fechaTraslado: g.fechaTraslado,
    motivo: g.motivo, motivoDescripcion: g.motivoDescripcion, modalidad: g.modalidad === 'PUBLICO' ? '01' : '02',
    pesoBruto: n(g.pesoBruto, 3), unidadPeso: g.unidadPeso, bultos: g.bultos ?? null,
    emisor: g.emisor,
    destinatario: { tipoDoc: DOC[g.destinatario.tipoDocumento] ?? '0', numDoc: g.destinatario.numeroDocumento || '-', nombre: g.destinatario.nombre },
    partida: { ...g.partida, ...propio }, llegada: { ...g.llegada, ...propio },
    ...(g.transportista && { transportista: g.transportista }),
    ...(g.conductor && {
      placa: g.vehiculoPlaca,
      conductor: { tipoDoc: DOC[g.conductor.tipoDocumento ?? 'DNI'], numDoc: g.conductor.numeroDocumento, nombres: g.conductor.nombres, apellidos: g.conductor.apellidos, licencia: g.conductor.licencia },
    }),
    ...(g.documentoRelacionado && { documentoRelacionado: { tipoDoc: g.documentoRelacionado.tipo, serie: g.documentoRelacionado.serie, numero: g.documentoRelacionado.numero } }),
    observacion: g.observacion || null,
    items: g.items.map((i) => ({ codigo: i.codigo, descripcion: i.descripcion, unidad: i.unidad, cantidad: n(i.cantidad, 4) })),
  };
}

const archivo = (tipo, nombre, base64) => (base64 ? { tipo, nombre: `${nombre}.${tipo.startsWith('CDR') ? 'zip' : 'xml'}`, base64 } : null);
const descripcion = (j) => [j.descripcion, ...(j.notas ?? [])].filter(Boolean).join(' · ');

/** Correlativo diario de resúmenes y bajas por RUC (SUNAT exige que no se repita en el día) */
let redis = null;
async function correlativo(ruc, tipo, fecha) {
  redis ||= new IORedis(env.REDIS_URL);
  const clave = `cpe:correlativo:${ruc}:${tipo}:${fecha}`;
  const valor = await redis.incr(clave);
  await redis.expire(clave, 3 * 86400);
  return valor;
}

/** Las boletas (y sus notas, serie B) se anulan por resumen diario; las facturas, por comunicación de baja */
const porResumen = (doc) => doc.tipo === 'BOLETA' || doc.serie.startsWith('B');

export const sunatDirecto = {
  nombre: 'SUNAT directo (servicio propio)',
  async probar(config) {
    try {
      const r = await llamarServicio('probar', { ambiente: config.ambiente, credenciales: credenciales(config, config.ruc) });
      return { ok: true, mensaje: r.mensaje };
    } catch (e) {
      return { ok: false, mensaje: e.message };
    }
  },
  async enviar(config, doc) {
    let j;
    try {
      j = await llamarServicio('comprobantes/enviar', { ambiente: config.ambiente, credenciales: credenciales(config, doc.emisor.ruc), documento: cuerpoComprobante(doc) });
    } catch (e) {
      // SUNAT ya lo tiene (p. ej. se cortó la respuesta): se consulta en lugar de duplicar
      if (e instanceof Duplicado) return this.consultar(config, doc);
      throw e;
    }
    return {
      estado: j.estado, codigo: j.codigo, descripcion: descripcion(j), hash: j.hash, qr: cadenaQr(doc, j.hash ?? ''),
      archivos: [archivo('XML', j.nombre, j.xml), archivo('CDR', `R-${j.nombre}`, j.cdr)].filter(Boolean),
    };
  },
  async consultar(config, doc) {
    const j = await llamarServicio('comprobantes/consultar', {
      ambiente: config.ambiente, credenciales: credenciales(config, doc.emisor.ruc),
      comprobante: { tipoDoc: TIPO[doc.tipo], serie: doc.serie, numero: doc.numero },
    });
    if (j.estado === 'NO_EXISTE') throw new ErrorDocumento('SUNAT no tiene este comprobante: reenvíelo');
    const nombre = `${doc.emisor.ruc}-${TIPO[doc.tipo]}-${doc.serie}-${doc.numero}`;
    return { estado: j.estado, codigo: j.codigo, descripcion: descripcion(j), archivos: [archivo('CDR', `R-${nombre}`, j.cdr)].filter(Boolean) };
  },
  async anular(config, doc, motivo) {
    const hoy = hoyLima();
    const resumen = porResumen(doc);
    const detalle = resumen
      ? {
          tipoDoc: TIPO[doc.tipo], serie: doc.serie, numero: doc.numero, estado: '3',
          clienteTipo: DOC[doc.cliente.tipoDocumento] ?? '0', clienteNro: doc.cliente.numeroDocumento || '-',
          totales: { gravada: n(doc.totales.gravada), exonerada: n(doc.totales.exonerada), inafecta: n(doc.totales.inafecta), igv: n(doc.totales.igv), total: n(doc.totales.total) },
          ...(doc.referencia && { referencia: { tipoDoc: TIPO[doc.referencia.tipo], serie: doc.referencia.serie, numero: doc.referencia.numero } }),
        }
      : { tipoDoc: TIPO[doc.tipo], serie: doc.serie, numero: doc.numero, motivo: (motivo || 'ANULACION DE LA OPERACION').toUpperCase().slice(0, 100) };
    const j = await llamarServicio(resumen ? 'resumenes/enviar' : 'bajas/enviar', {
      ambiente: config.ambiente, credenciales: credenciales(config, doc.emisor.ruc), emisor: doc.emisor,
      lote: { correlativo: await correlativo(doc.emisor.ruc, resumen ? 'RC' : 'RA', hoy), fechaDocumentos: doc.fecha, fechaEnvio: hoy, detalles: [detalle] },
    });
    return {
      estado: 'PENDIENTE', ticket: j.ticket, mensaje: `${resumen ? 'Resumen diario enviado' : 'Comunicación de baja enviada'} a SUNAT (ticket ${j.ticket})`,
      archivos: [archivo('XML_BAJA', j.nombre, j.xml)].filter(Boolean),
    };
  },
  async consultarBaja(config, doc) {
    const j = await llamarServicio('tickets/consultar', { ambiente: config.ambiente, credenciales: credenciales(config, doc.emisor.ruc), ticket: doc.bajaTicket });
    const estado = { ENVIADO: 'PENDIENTE', ACEPTADO: 'ACEPTADA', OBSERVADO: 'ACEPTADA', RECHAZADO: 'RECHAZADA' }[j.estado] ?? 'PENDIENTE';
    return {
      estado, ticket: doc.bajaTicket, mensaje: descripcion(j) || null,
      archivos: [archivo('CDR_BAJA', `R-${doc.emisor.ruc}-baja-${doc.serie}-${doc.numero}`, j.cdr)].filter(Boolean),
    };
  },
  async enviarGuia(config, g) {
    const j = await llamarServicio('guias/enviar', { ambiente: config.ambiente, credenciales: credenciales(config, g.emisor.ruc), guia: cuerpoGuia(g) });
    return { estado: 'ENVIADO', ticket: j.ticket, codigo: null, descripcion: `Guía recibida; SUNAT la está procesando (ticket ${j.ticket})`, archivos: [archivo('XML', j.nombre, j.xml)].filter(Boolean) };
  },
  async consultarGuia(config, g) {
    if (!g.ticket) return this.enviarGuia(config, g);
    const j = await llamarServicio('guias/consultar', { ambiente: config.ambiente, credenciales: credenciales(config, g.emisor.ruc), ticket: g.ticket });
    const nombre = `${g.emisor.ruc}-09-${g.serie}-${g.numero}`;
    return { estado: j.estado, codigo: j.codigo ?? null, descripcion: descripcion(j), archivos: [archivo('CDR', `R-${nombre}`, j.cdr)].filter(Boolean) };
  },
};
