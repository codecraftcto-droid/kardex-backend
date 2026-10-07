import { ErrorDocumento, ErrorTransitorio } from '../documento.js';

/**
 * Conector Nubefact (API JSON). Cada cuenta de Nubefact tiene su RUTA y TOKEN propios.
 * Documentación del proveedor: https://www.nubefact.com/integracion
 * Nota: los nombres de campo siguen la especificación pública de Nubefact; verificar contra
 * su documentación vigente y probar en su entorno DEMO antes de pasar a producción.
 */
const TIPO = { FACTURA: 1, BOLETA: 2, NOTA_CREDITO: 3 };
const DOC = { RUC: '6', DNI: '1', CARNE_EXTRANJERIA: '4', PASAPORTE: '7', SIN_DOCUMENTO: '-' };
const IGV = { 10: 1, 20: 8, 30: 9 }; // gravado, exonerado, inafecto (operación onerosa)
const fecha = (iso) => iso.split('-').reverse().join('-'); // AAAA-MM-DD → DD-MM-AAAA
const n = (d, dec = 2) => Number(d.toFixed(dec));

export function cuerpoNubefact(doc) {
  const credito = doc.formaPago === 'CREDITO';
  return {
    operacion: 'generar_comprobante',
    tipo_de_comprobante: TIPO[doc.tipo],
    serie: doc.serie,
    numero: doc.numero,
    // 1 = venta interna; 30 = operación sujeta a detracción
    sunat_transaction: doc.detraccion ? 30 : 1,
    cliente_tipo_de_documento: DOC[doc.cliente.tipoDocumento],
    cliente_numero_de_documento: doc.cliente.tipoDocumento === 'SIN_DOCUMENTO' ? '-' : doc.cliente.numeroDocumento,
    cliente_denominacion: doc.cliente.nombre,
    cliente_direccion: doc.cliente.direccion ?? '',
    cliente_email: '',
    fecha_de_emision: fecha(doc.fecha),
    moneda: doc.moneda === 'USD' ? 2 : 1,
    porcentaje_de_igv: 18.0,
    total_gravada: n(doc.totales.gravada),
    total_exonerada: n(doc.totales.exonerada),
    total_inafecta: n(doc.totales.inafecta),
    total_igv: n(doc.totales.igv),
    total: n(doc.totales.total),
    enviar_automaticamente_a_la_sunat: true,
    enviar_automaticamente_al_cliente: false,
    ...(doc.referencia && {
      documento_que_se_modifica_tipo: TIPO[doc.referencia.tipo],
      documento_que_se_modifica_serie: doc.referencia.serie,
      documento_que_se_modifica_numero: doc.referencia.numero,
      tipo_de_nota_de_credito: Number(doc.motivoNotaCredito?.codigo ?? 1),
    }),
    // Detracción y retención: campos según la documentación de Nubefact (verificar en su entorno DEMO)
    ...(doc.detraccion && {
      detraccion: true,
      detraccion_tipo: Number(doc.detraccion.codigo),
      detraccion_porcentaje: n(doc.detraccion.porcentaje),
      detraccion_total: n(doc.detraccion.monto),
      medio_de_pago_detraccion: 1, // depósito en cuenta
    }),
    ...(doc.retencion && {
      retencion_tipo: 1, // tasa 3%
      retencion_base_imponible: n(doc.retencion.base),
      total_retencion: n(doc.retencion.monto),
    }),
    ...(credito && {
      condiciones_de_pago: 'CRÉDITO',
      venta_al_credito: doc.cuotas.map((q) => ({ cuota: q.numero, fecha_de_pago: fecha(q.fecha), importe: n(q.monto) })),
    }),
    items: doc.items.map((i) => ({
      unidad_de_medida: i.unidad,
      codigo: i.codigo,
      descripcion: i.descripcion,
      cantidad: n(i.cantidad, 4),
      valor_unitario: n(i.valorUnitario, 10),
      precio_unitario: n(i.precioUnitario, 10),
      descuento: '',
      subtotal: n(i.valorVenta),
      tipo_de_igv: IGV[i.afectacion] ?? 1,
      igv: n(i.igv),
      total: n(i.total),
      anticipo_regularizacion: false,
    })),
  };
}

async function llamar(config, cuerpo) {
  if (!config.url || !config.token) throw new ErrorDocumento('Falta la RUTA o el TOKEN de Nubefact en la configuración de facturación');
  let r;
  try {
    r = await fetch(config.url, {
      method: 'POST',
      headers: { Authorization: `Token token="${config.token}"`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    throw new ErrorTransitorio(`Nubefact no respondió: ${e.message}`);
  }
  if (r.status >= 500 || r.status === 429) throw new ErrorTransitorio(`Nubefact respondió ${r.status}; se reintentará`);
  const json = await r.json().catch(() => ({}));
  if (r.status === 401 || r.status === 403) throw new ErrorDocumento('Nubefact rechazó el TOKEN: revise la configuración');
  if (json.errors) throw new ErrorDocumento(`Nubefact: ${json.errors}${json.codigo ? ` (código ${json.codigo})` : ''}`);
  return json;
}

/** Traduce la respuesta de Nubefact a nuestro estado */
function interpretar(j) {
  const base = { hash: j.codigo_hash ?? null, qr: j.cadena_para_codigo_qr ?? null, pdf: j.enlace_del_pdf ?? null, xml: j.enlace_del_xml ?? null, cdr: j.enlace_del_cdr ?? null };
  const codigo = j.sunat_responsecode != null ? String(j.sunat_responsecode) : null;
  if (j.aceptada_por_sunat) return { ...base, estado: j.sunat_note ? 'OBSERVADO' : 'ACEPTADO', codigo: codigo ?? '0', descripcion: [j.sunat_description, j.sunat_note].filter(Boolean).join(' · ') };
  if (codigo && codigo !== '0') return { ...base, estado: 'RECHAZADO', codigo, descripcion: j.sunat_description || j.sunat_soap_error || 'Rechazado por SUNAT' };
  return { ...base, estado: 'ENVIADO', codigo: null, descripcion: j.sunat_description || 'Recibido por el proveedor; SUNAT aún no responde' };
}

/** Guía de remisión remitente (tipo 7 en Nubefact). Verificar campos en su documentación vigente. */
export function cuerpoGuiaNubefact(g) {
  const publico = g.modalidad === 'PUBLICO';
  return {
    operacion: 'generar_guia',
    tipo_de_comprobante: 7,
    serie: g.serie,
    numero: g.numero,
    cliente_tipo_de_documento: DOC[g.destinatario.tipoDocumento],
    cliente_numero_de_documento: g.destinatario.numeroDocumento,
    cliente_denominacion: g.destinatario.nombre,
    cliente_direccion: g.llegada.direccion,
    fecha_de_emision: fecha(g.fecha),
    observaciones: g.observacion ?? '',
    motivo_de_traslado: g.motivo,
    ...(g.motivo === '13' && { motivo_de_traslado_otros_descripcion: g.motivoDescripcion }),
    peso_bruto_total: n(g.pesoBruto, 3),
    peso_bruto_unidad_de_medida: g.unidadPeso,
    numero_de_bultos: g.bultos ?? 0,
    tipo_de_transporte: publico ? '01' : '02',
    fecha_de_inicio_de_traslado: fecha(g.fechaTraslado),
    ...(publico
      ? { transportista_documento_tipo: '6', transportista_documento_numero: g.transportista.ruc, transportista_denominacion: g.transportista.nombre, transportista_numero_registro_mtc: g.transportista.mtc ?? '' }
      : {
          transportista_placa_numero: g.vehiculoPlaca,
          conductor_documento_tipo: DOC[g.conductor.tipoDocumento ?? 'DNI'], conductor_documento_numero: g.conductor.numeroDocumento,
          conductor_nombre: g.conductor.nombres, conductor_apellidos: g.conductor.apellidos, conductor_numero_licencia: g.conductor.licencia,
        }),
    punto_de_partida_ubigeo: g.partida.ubigeo,
    punto_de_partida_direccion: g.partida.direccion,
    punto_de_partida_codigo_establecimiento_sunat: g.partida.establecimiento ?? '',
    punto_de_llegada_ubigeo: g.llegada.ubigeo,
    punto_de_llegada_direccion: g.llegada.direccion,
    punto_de_llegada_codigo_establecimiento_sunat: g.llegada.establecimiento ?? '',
    enviar_automaticamente_al_cliente: false,
    items: g.items.map((i) => ({ unidad_de_medida: i.unidad, codigo: i.codigo, descripcion: i.descripcion, cantidad: n(i.cantidad, 4) })),
    ...(g.documentoRelacionado && {
      documento_relacionado: [{ tipo: g.documentoRelacionado.tipo, serie: g.documentoRelacionado.serie, numero: g.documentoRelacionado.numero }],
    }),
  };
}

export const nubefact = {
  nombre: 'Nubefact',
  async probar(config) {
    // Consulta un comprobante inexistente: si el TOKEN es válido, Nubefact responde "no existe"
    try {
      await llamar(config, { operacion: 'consultar_comprobante', tipo_de_comprobante: 1, serie: 'F999', numero: 1 });
      return { ok: true, mensaje: 'Conexión con Nubefact correcta' };
    } catch (e) {
      if (e instanceof ErrorDocumento && !/TOKEN|RUTA/.test(e.message)) return { ok: true, mensaje: 'Conexión con Nubefact correcta' };
      return { ok: false, mensaje: e.message };
    }
  },
  async enviar(config, doc) {
    try {
      return interpretar(await llamar(config, cuerpoNubefact(doc)));
    } catch (e) {
      // Ya enviado antes (p. ej. se cortó la respuesta): se consulta en lugar de duplicar
      if (e instanceof ErrorDocumento && /ya existe|duplicad/i.test(e.message)) return this.consultar(config, doc);
      throw e;
    }
  },
  async consultar(config, doc) {
    return interpretar(await llamar(config, { operacion: 'consultar_comprobante', tipo_de_comprobante: TIPO[doc.tipo], serie: doc.serie, numero: doc.numero }));
  },
  async anular(config, doc, motivo) {
    const j = await llamar(config, { operacion: 'generar_anulacion', tipo_de_comprobante: TIPO[doc.tipo], serie: doc.serie, numero: doc.numero, motivo, codigo_unico: '' });
    return { estado: j.aceptada_por_sunat ? 'ACEPTADA' : 'PENDIENTE', ticket: j.sunat_ticket_numero ?? null, mensaje: j.sunat_description ?? 'Comunicación de baja enviada' };
  },
  async enviarGuia(config, g) {
    try {
      return interpretar(await llamar(config, cuerpoGuiaNubefact(g)));
    } catch (e) {
      if (e instanceof ErrorDocumento && /ya existe|duplicad/i.test(e.message)) return this.consultarGuia(config, g);
      throw e;
    }
  },
  async consultarGuia(config, g) {
    return interpretar(await llamar(config, { operacion: 'consultar_guia', tipo_de_comprobante: 7, serie: g.serie, numero: g.numero }));
  },
  async consultarBaja(config, doc) {
    const j = await llamar(config, { operacion: 'consultar_anulacion', tipo_de_comprobante: TIPO[doc.tipo], serie: doc.serie, numero: doc.numero });
    return { estado: j.aceptada_por_sunat ? 'ACEPTADA' : 'PENDIENTE', ticket: j.sunat_ticket_numero ?? null, mensaje: j.sunat_description ?? null };
  },
};
