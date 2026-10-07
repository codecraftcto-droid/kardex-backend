import IORedis from 'ioredis';
import { Emitter } from '@socket.io/redis-emitter';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { withTenant } from '../lib/prisma.js';
import { conflicto, noEncontrado, solicitudInvalida } from '../lib/errors.js';
import { MODOS_SIRE } from './proveedores/index.js';
import { DOC_IDENTIDAD, TIPO_CP, conciliar, fila, totales } from './conciliacion.js';
import { desplazar } from './periodos.js';

/**
 * Registros del SIRE (Fase 2B: RVIE). Flujo de un período:
 *  1. Descargar la propuesta de SUNAT (operación por ticket) y guardarla como vigente.
 *  2. Conciliarla con las ventas del sistema: cada diferencia queda PENDIENTE hasta resolverla
 *     (aceptar lo que dice SUNAT o justificarla con una nota).
 *  3. Sin diferencias pendientes el período queda CONCILIADO y se puede aceptar la propuesta,
 *     con lo que SUNAT genera el registro (GENERADO). Después ya no se modifica.
 * Las llamadas a SUNAT se hacen fuera de las transacciones.
 */
export const ESTADO_CAMPO = { RVIE: 'estadoRvie', RCE: 'estadoRce' };
const MAX_CONSULTAS = 40;

// ───────────── Ventas del sistema ─────────────

/** Rango UTC de un período en hora de Lima (UTC−5) */
const rangoLima = (periodo) => {
  const sig = desplazar(periodo, 1);
  return {
    gte: new Date(`${periodo.slice(0, 4)}-${periodo.slice(4)}-01T05:00:00Z`),
    lt: new Date(`${sig.slice(0, 4)}-${sig.slice(4)}-01T05:00:00Z`),
  };
};
const rangoFecha = (periodo) => {
  const sig = desplazar(periodo, 1);
  return { gte: new Date(`${periodo.slice(0, 4)}-${periodo.slice(4)}-01T00:00:00Z`), lt: new Date(`${sig.slice(0, 4)}-${sig.slice(4)}-01T00:00:00Z`) };
};
const fechaLima = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(d);
const docTipoPorNumero = (n) => (/^\d{11}$/.test(n) ? '6' : /^\d{8}$/.test(n) ? '1' : '0');

/** Ventas del período registradas en el sistema (caja y ventas comerciales), normalizadas */
export async function ventasDelSistema(tx, empresaId, periodo) {
  const [comprobantes, documentos] = await Promise.all([
    tx.comprobante.findMany({
      where: { empresaId, tipo: { in: Object.keys(TIPO_CP) }, fechaEmision: rangoLima(periodo) },
      select: {
        id: true, tipo: true, serie: true, numero: true, fechaEmision: true, moneda: true, clienteTipoDocumento: true, clienteNumeroDocumento: true,
        clienteNombre: true, opGravada: true, opExonerada: true, opInafecta: true, igv: true, total: true, estado: true, estadoSunat: true,
      },
    }),
    tx.documentoComercial.findMany({
      where: { empresaId, tipo: 'VENTA', estado: { in: ['CONFIRMADO', 'ANULADO'] }, comprobanteTipo: { in: ['FACTURA', 'BOLETA'] }, fechaEmision: rangoFecha(periodo) },
      select: { id: true, comprobanteTipo: true, serie: true, numero: true, fechaEmision: true, moneda: true, terceroDocumento: true, terceroNombre: true, subtotal: true, igv: true, total: true, estado: true },
    }),
  ]);
  return [
    ...comprobantes.map((c) => fila({
      tipoCp: TIPO_CP[c.tipo], serie: c.serie, numero: c.numero, fechaEmision: fechaLima(c.fechaEmision),
      docTipo: DOC_IDENTIDAD[c.clienteTipoDocumento], docNumero: c.clienteNumeroDocumento === '-' ? null : c.clienteNumeroDocumento, nombre: c.clienteNombre,
      baseGravada: c.opGravada, igv: c.igv, exonerado: c.opExonerada, inafecto: c.opInafecta, total: c.total, moneda: c.moneda,
      anulado: c.estado === 'ANULADO', comprobanteId: c.id, estadoSunat: c.estadoSunat,
    })),
    ...documentos.map((d) => fila({
      tipoCp: TIPO_CP[d.comprobanteTipo], serie: d.serie, numero: d.numero, fechaEmision: d.fechaEmision.toISOString().slice(0, 10),
      docTipo: docTipoPorNumero(d.terceroDocumento), docNumero: d.terceroDocumento, nombre: d.terceroNombre,
      baseGravada: d.subtotal, igv: d.igv, total: d.total, moneda: d.moneda, anulado: d.estado === 'ANULADO', documentoId: d.id,
    })),
  ];
}

/** RUC peruano: los demás proveedores son no domiciliados y van a un registro aparte */
const esRuc = (n) => /^\d{11}$/.test(n ?? '');

/**
 * Compras del período registradas en el sistema (proveedores con RUC), normalizadas.
 * La clave lleva el RUC del proveedor.
 */
export async function comprasDelSistema(tx, empresaId, periodo) {
  const documentos = await tx.documentoComercial.findMany({
    where: { empresaId, tipo: 'COMPRA', estado: { in: ['CONFIRMADO', 'ANULADO'] }, comprobanteTipo: { in: ['FACTURA', 'BOLETA'] }, fechaEmision: rangoFecha(periodo) },
    select: {
      id: true, comprobanteTipo: true, serie: true, numero: true, fechaEmision: true, moneda: true, terceroDocumento: true, terceroNombre: true,
      subtotal: true, igv: true, total: true, estado: true, detraccionMonto: true, detraccionConstancia: true,
    },
  });
  return documentos.filter((d) => esRuc(d.terceroDocumento)).map((d) => fila({
    tipoCp: TIPO_CP[d.comprobanteTipo], serie: d.serie, numero: d.numero, emisor: d.terceroDocumento, fechaEmision: d.fechaEmision.toISOString().slice(0, 10),
    docTipo: '6', docNumero: d.terceroDocumento, nombre: d.terceroNombre,
    baseGravada: d.subtotal, igv: d.igv, total: d.total, moneda: d.moneda, anulado: d.estado === 'ANULADO', documentoId: d.id,
    detraccionMonto: Number(d.detraccionMonto), detraccionConstancia: d.detraccionConstancia,
  }));
}

/** Lo registrado en el sistema para el registro pedido */
export const registrosDelSistema = (tx, empresaId, periodo, registro) =>
  (registro === 'RCE' ? comprasDelSistema(tx, empresaId, periodo) : ventasDelSistema(tx, empresaId, periodo));

/** Compras del período que el RCE trata aparte o con cuidado: detracción sin depositar y no domiciliados */
async function avisosCompras(tx, empresaId, periodo) {
  const [pendientes, noDomiciliados] = await Promise.all([
    tx.documentoComercial.findMany({
      where: { empresaId, tipo: 'COMPRA', estado: 'CONFIRMADO', fechaEmision: rangoFecha(periodo), detraccionMonto: { gt: 0 }, detraccionConstancia: null },
      select: { id: true, serie: true, numero: true, terceroDocumento: true, terceroNombre: true, igv: true, detraccionMonto: true, moneda: true },
      orderBy: { fechaEmision: 'asc' },
      take: 50,
    }),
    tx.documentoComercial.findMany({
      where: { empresaId, tipo: 'COMPRA', estado: 'CONFIRMADO', fechaEmision: rangoFecha(periodo) },
      select: { terceroDocumento: true },
    }),
  ]);
  return {
    detraccionesPendientes: pendientes.map((d) => ({ ...d, numero: String(Number(d.numero)) })),
    igvSinCredito: Math.round(pendientes.reduce((s, d) => s + Number(d.igv), 0) * 100) / 100,
    noDomiciliados: noDomiciliados.filter((d) => !esRuc(d.terceroDocumento)).length,
  };
}

// ───────────── Estado del período ─────────────

async function fijarEstado(tx, { tenantId, empresaId, periodo, registro }, estado) {
  const campo = ESTADO_CAMPO[registro];
  await tx.periodoSire.upsert({
    where: { empresaId_periodo: { empresaId, periodo } },
    create: { tenantId, empresaId, periodo, [campo]: estado },
    update: { [campo]: estado },
  });
}

async function estadoActual(tx, empresaId, periodo, registro) {
  const p = await tx.periodoSire.findUnique({ where: { empresaId_periodo: { empresaId, periodo } } });
  return p?.[ESTADO_CAMPO[registro]] ?? 'PENDIENTE';
}

/** Tras conciliar o resolver: CON_DIFERENCIAS si queda alguna pendiente, si no CONCILIADO */
async function recalcularEstado(tx, propuesta) {
  const pendientes = await tx.diferenciaSire.count({ where: { propuestaId: propuesta.id, resolucion: 'PENDIENTE' } });
  await fijarEstado(tx, propuesta, pendientes ? 'CON_DIFERENCIAS' : 'CONCILIADO');
  return pendientes;
}

// ───────────── Propuesta ─────────────

const decimal = (v) => (v == null ? null : Number(v).toFixed(2));

/** Guarda la propuesta como vigente, la concilia y conserva lo ya resuelto en la anterior */
async function guardarPropuesta(tx, op, filasSunat) {
  const clave = { empresaId: op.empresaId, periodo: op.periodo, registro: op.registro };
  const anterior = await tx.propuestaSire.findFirst({ where: { ...clave, vigente: true }, include: { diferencias: { where: { resolucion: { not: 'PENDIENTE' } } } } });
  if (anterior) await tx.propuestaSire.update({ where: { id: anterior.id }, data: { vigente: false } });

  const t = totales(filasSunat);
  const propuesta = await tx.propuestaSire.create({
    data: { tenantId: op.tenantId, ...clave, operacionId: op.id, cantidad: filasSunat.length, totalBase: t.base, totalIgv: t.igv, total: t.total },
  });
  for (let i = 0; i < filasSunat.length; i += 1000) {
    await tx.propuestaSireDetalle.createMany({
      data: filasSunat.slice(i, i + 1000).map((f) => ({
        tenantId: op.tenantId, propuestaId: propuesta.id, tipoCp: f.tipoCp, serie: f.serie, numero: f.numero, fechaEmision: new Date(`${f.fechaEmision}T00:00:00Z`),
        docTipo: f.docTipo ?? null, docNumero: f.docNumero ?? null, nombre: f.nombre?.slice(0, 200) ?? null,
        baseGravada: f.baseGravada, igv: f.igv, exonerado: f.exonerado, inafecto: f.inafecto, otros: f.otros, total: f.total, moneda: f.moneda,
        anulado: f.anulado, refTipo: f.refTipo ?? null, refSerie: f.refSerie ?? null, refNumero: f.refNumero ?? null,
      })),
    });
  }

  const sistema = await registrosDelSistema(tx, op.empresaId, op.periodo, op.registro);
  const { coinciden, diferencias } = conciliar(filasSunat, sistema);
  const previas = new Map((anterior?.diferencias ?? []).map((d) => [`${d.tipo}|${d.clave}`, d]));
  await tx.diferenciaSire.createMany({
    data: diferencias.map((d) => {
      const base = d.sunat ?? d.sistema;
      const previa = previas.get(`${d.tipo}|${d.clave}`);
      return {
        tenantId: op.tenantId, propuestaId: propuesta.id, tipo: d.tipo, clave: d.clave, tipoCp: base.tipoCp, serie: base.serie, numero: base.numero,
        fechaEmision: base.fechaEmision ? new Date(`${base.fechaEmision}T00:00:00Z`) : null, nombre: base.nombre?.slice(0, 200) ?? null, docNumero: base.docNumero ?? null,
        totalSunat: decimal(d.sunat?.total), totalSistema: decimal(d.sistema?.total), igvSunat: decimal(d.sunat?.igv), igvSistema: decimal(d.sistema?.igv),
        comprobanteId: d.sistema?.comprobanteId ?? null, documentoId: d.sistema?.documentoId ?? null, estadoSunatSistema: d.sistema?.estadoSunat ?? null,
        // Lo resuelto en la propuesta anterior se conserva
        ...(previa && { resolucion: previa.resolucion, nota: previa.nota, resueltoPorId: previa.resueltoPorId, resueltoEn: previa.resueltoEn }),
      };
    }),
  });
  const pendientes = await recalcularEstado(tx, propuesta);
  return { propuesta, coinciden, diferencias: diferencias.length, pendientes };
}

// ───────────── Operaciones por ticket ─────────────

let emisor = null;
function notificar(op) {
  try {
    emisor ||= new Emitter(new IORedis(env.REDIS_URL));
    emisor.to(`empresa:${op.empresaId}`).emit('sire:operacion', { id: op.id, periodo: op.periodo, registro: op.registro, tipo: op.tipo, estado: op.estado });
  } catch (e) {
    logger.warn({ err: e.message }, 'No se pudo notificar la operación SIRE');
  }
}

async function terminar(tenantId, op, datos) {
  const fin = await withTenant(tenantId, (tx) => tx.operacionSire.update({ where: { id: op.id }, data: { terminadoEn: new Date(), ...datos } }));
  notificar(fin);
  return fin;
}

/**
 * Avanza una operación un paso: pide a SUNAT, consulta el ticket o descarga el resultado.
 * Devuelve { estado, pendiente } — pendiente = hay que volver a consultar más tarde.
 */
export async function avanzarOperacion({ tenantId, operacionId }) {
  const { op, cfg, empresa } = await withTenant(tenantId, async (tx) => {
    const o = await tx.operacionSire.findUnique({ where: { id: operacionId } });
    return o && {
      op: o,
      cfg: await tx.configSire.findUnique({ where: { empresaId: o.empresaId } }),
      empresa: await tx.empresa.findUnique({ where: { id: o.empresaId }, select: { id: true, ruc: true } }),
    };
  }) ?? {};
  if (!op) return { estado: null, pendiente: false };
  if (op.estado !== 'PROCESANDO') return { estado: op.estado, pendiente: false };
  if (!cfg?.activo) return { estado: (await terminar(tenantId, op, { estado: 'ERROR', mensaje: 'El SIRE de la empresa no está configurado o está desactivado' })).estado, pendiente: false };

  const modo = MODOS_SIRE[cfg.modo];
  const ctx = { ruc: empresa.ruc, registro: op.registro, periodo: op.periodo };
  let r;
  try {
    if (!op.ticket) {
      // Primer paso: pedir a SUNAT
      if (op.tipo === 'PROPUESTA') {
        const sistema = cfg.modo === 'SIMULADO' ? await withTenant(tenantId, (tx) => registrosDelSistema(tx, op.empresaId, op.periodo, op.registro)) : [];
        r = await modo.solicitarPropuesta(cfg, { ...ctx, sistema });
      } else {
        const ajustes = op.registro === 'RCE' ? await withTenant(tenantId, (tx) => ajustesRce(tx, op)) : null;
        r = await modo.aceptarPropuesta(cfg, { ...ctx, ajustes });
      }
    } else {
      r = await modo.consultarTicket(cfg, { ...ctx, ticket: op.ticket });
      if (r.listo && !r.error && op.tipo === 'PROPUESTA') r = { filas: await modo.descargarPropuesta(cfg, { ...ctx, ticket: op.ticket, codProceso: r.codProceso, archivos: r.archivos }) };
      else if (r.listo && !r.error) r = { constancia: op.ticket };
    }
  } catch (e) {
    // Sin ticket aún: el pedido falló (credenciales, período cerrado…) → error para reintentar a mano.
    // Con ticket: falla de red al consultar → se vuelve a intentar.
    logger.warn({ err: e.message, operacionId }, 'Operación SIRE con error');
    if (op.ticket && op.intentos < MAX_CONSULTAS) {
      await withTenant(tenantId, (tx) => tx.operacionSire.update({ where: { id: op.id }, data: { intentos: { increment: 1 }, mensaje: e.message.slice(0, 500) } }));
      return { estado: 'PROCESANDO', pendiente: true };
    }
    return { estado: (await terminar(tenantId, op, { estado: 'ERROR', mensaje: e.message.slice(0, 500) })).estado, pendiente: false };
  }

  if (r.error) return { estado: (await terminar(tenantId, op, { estado: 'ERROR', mensaje: r.error.slice(0, 500) })).estado, pendiente: false };
  if (r.ticket || (op.ticket && !r.listo && !r.filas && !r.constancia)) {
    if (op.intentos >= MAX_CONSULTAS) return { estado: (await terminar(tenantId, op, { estado: 'ERROR', mensaje: 'SUNAT no terminó de procesar el pedido. Inténtelo de nuevo.' })).estado, pendiente: false };
    await withTenant(tenantId, (tx) => tx.operacionSire.update({
      where: { id: op.id }, data: { ...(r.ticket && { ticket: r.ticket }), intentos: { increment: 1 }, mensaje: r.mensaje ?? 'SUNAT está procesando el pedido' },
    }));
    return { estado: 'PROCESANDO', pendiente: true };
  }

  if (op.tipo === 'PROPUESTA') {
    const g = await withTenant(tenantId, (tx) => guardarPropuesta(tx, op, r.filas), { timeout: 60_000 });
    await terminar(tenantId, op, {
      estado: 'TERMINADO',
      mensaje: `Propuesta con ${r.filas.length} comprobante(s): ${g.coinciden} coinciden con el sistema, ${g.diferencias} diferencia(s)${g.pendientes ? `, ${g.pendientes} por resolver` : ''}`,
    });
  } else {
    await withTenant(tenantId, async (tx) => {
      await fijarEstado(tx, op, 'GENERADO');
      await tx.periodoSire.update({ where: { empresaId_periodo: { empresaId: op.empresaId, periodo: op.periodo } }, data: { sincronizadoEn: new Date() } });
    });
    await terminar(tenantId, op, {
      estado: 'TERMINADO', constancia: r.constancia ?? null,
      mensaje: `SUNAT generó el registro con la propuesta aceptada${r.ajustes ? ` y ${r.ajustes} ajuste(s)` : ''}`,
    });
  }
  return { estado: 'TERMINADO', pendiente: false };
}

/** RCE: comprobantes que se agregan (compras del sistema) y que se retiran (claves de la propuesta) */
async function ajustesRce(tx, op) {
  const propuesta = await tx.propuestaSire.findFirst({ where: { empresaId: op.empresaId, periodo: op.periodo, registro: 'RCE', vigente: true }, select: { id: true } });
  if (!propuesta) return { incluir: [], excluir: [] };
  const difs = await tx.diferenciaSire.findMany({ where: { propuestaId: propuesta.id, resolucion: { in: ['INCLUIDA', 'EXCLUIDA'] } }, select: { clave: true, resolucion: true } });
  const incluir = new Set(difs.filter((d) => d.resolucion === 'INCLUIDA').map((d) => d.clave));
  const compras = incluir.size ? await comprasDelSistema(tx, op.empresaId, op.periodo) : [];
  return {
    incluir: compras.filter((c) => incluir.has(c.clave)),
    excluir: difs.filter((d) => d.resolucion === 'EXCLUIDA').map((d) => d.clave),
  };
}

/** Crea la operación (una sola en curso por período y registro) */
async function nuevaOperacion(tx, { tenantId, empresaId, periodo, registro, tipo, usuarioId }) {
  const enCurso = await tx.operacionSire.findFirst({ where: { empresaId, periodo, registro, estado: 'PROCESANDO' } });
  if (enCurso) throw conflicto('Ya hay un pedido a SUNAT en curso para este período; espere a que termine');
  return tx.operacionSire.create({ data: { tenantId, empresaId, periodo, registro, tipo, usuarioId } });
}

export async function iniciarDescarga(db, { tenantId, empresaId, periodo, registro, usuarioId }) {
  return db(async (tx) => {
    if ((await estadoActual(tx, empresaId, periodo, registro)) === 'GENERADO') throw conflicto('El registro de este período ya fue generado en SUNAT');
    return nuevaOperacion(tx, { tenantId, empresaId, periodo, registro, tipo: 'PROPUESTA', usuarioId });
  });
}

export async function iniciarAceptacion(db, { tenantId, empresaId, periodo, registro, usuarioId }) {
  return db(async (tx) => {
    const estado = await estadoActual(tx, empresaId, periodo, registro);
    if (estado === 'GENERADO') throw conflicto('El registro de este período ya fue generado');
    if (estado !== 'CONCILIADO') throw conflicto('Primero descargue la propuesta y resuelva todas las diferencias');
    return nuevaOperacion(tx, { tenantId, empresaId, periodo, registro, tipo: 'ACEPTACION', usuarioId });
  });
}

// ───────────── Diferencias ─────────────

/**
 * Cómo se puede resolver cada tipo de diferencia. En ventas, lo que falta en SUNAT se corrige
 * enviando el comprobante; en compras, la compra registrada se puede INCLUIR en la propuesta y lo
 * que SUNAT trae y no corresponde se puede EXCLUIR.
 */
export const RESOLUCIONES_PERMITIDAS = {
  RVIE: { SOLO_SUNAT: ['ACEPTADA', 'JUSTIFICADA'], SOLO_SISTEMA: ['JUSTIFICADA'], MONTO: ['ACEPTADA', 'JUSTIFICADA'], ESTADO: ['ACEPTADA', 'JUSTIFICADA'] },
  RCE: { SOLO_SUNAT: ['ACEPTADA', 'EXCLUIDA', 'JUSTIFICADA'], SOLO_SISTEMA: ['INCLUIDA', 'JUSTIFICADA'], MONTO: ['ACEPTADA', 'JUSTIFICADA'], ESTADO: ['ACEPTADA', 'JUSTIFICADA'] },
};
const CON_NOTA = ['JUSTIFICADA', 'EXCLUIDA'];

export async function resolverDiferencia(tx, { diferenciaId, empresaId, periodo, registro, resolucion, nota, usuarioId }) {
  const d = await tx.diferenciaSire.findUnique({ where: { id: diferenciaId }, include: { propuesta: true } });
  if (!d || d.propuesta.empresaId !== empresaId || d.propuesta.periodo !== periodo || d.propuesta.registro !== registro) throw noEncontrado('Diferencia no encontrada');
  if (!d.propuesta.vigente) throw conflicto('Esta diferencia es de una propuesta anterior');
  if ((await estadoActual(tx, empresaId, periodo, registro)) === 'GENERADO') throw conflicto('El registro ya fue generado: no se modifica');
  if (resolucion !== 'PENDIENTE' && !RESOLUCIONES_PERMITIDAS[registro][d.tipo].includes(resolucion)) {
    throw solicitudInvalida(registro === 'RVIE' && d.tipo === 'SOLO_SISTEMA'
      ? 'Este comprobante no figura en SUNAT: envíelo y vuelva a descargar la propuesta, o justifique por qué no se incluye'
      : 'Esa resolución no corresponde a este tipo de diferencia');
  }
  if (CON_NOTA.includes(resolucion) && (nota ?? '').trim().length < 5) throw solicitudInvalida('Escriba el motivo (mínimo 5 caracteres)');
  const actualizada = await tx.diferenciaSire.update({
    where: { id: d.id },
    data: resolucion === 'PENDIENTE'
      ? { resolucion, nota: null, resueltoPorId: null, resueltoEn: null }
      : { resolucion, nota: nota?.trim() || null, resueltoPorId: usuarioId, resueltoEn: new Date() },
  });
  const pendientes = await recalcularEstado(tx, d.propuesta);
  return { diferencia: actualizada, pendientes };
}

// ───────────── Resumen del período ─────────────

export async function resumenRegistro(tx, { empresaId, periodo, registro }) {
  const [periodoSire, propuesta, operacion, generacion, sistema] = await Promise.all([
    tx.periodoSire.findUnique({ where: { empresaId_periodo: { empresaId, periodo } } }),
    tx.propuestaSire.findFirst({ where: { empresaId, periodo, registro, vigente: true } }),
    tx.operacionSire.findFirst({ where: { empresaId, periodo, registro }, orderBy: { creadoEn: 'desc' } }),
    tx.operacionSire.findFirst({ where: { empresaId, periodo, registro, tipo: 'ACEPTACION', estado: 'TERMINADO' }, orderBy: { creadoEn: 'desc' } }),
    registrosDelSistema(tx, empresaId, periodo, registro),
  ]);
  const porTipo = propuesta
    ? await tx.diferenciaSire.groupBy({ by: ['tipo', 'resolucion'], where: { propuestaId: propuesta.id }, _count: { _all: true } })
    : [];
  const diferencias = { total: 0, pendientes: 0, porTipo: {} };
  for (const g of porTipo) {
    diferencias.total += g._count._all;
    if (g.resolucion === 'PENDIENTE') diferencias.pendientes += g._count._all;
    diferencias.porTipo[g.tipo] = (diferencias.porTipo[g.tipo] ?? 0) + g._count._all;
  }
  return {
    estado: periodoSire?.[ESTADO_CAMPO[registro]] ?? 'PENDIENTE',
    propuesta: propuesta && { id: propuesta.id, cantidad: propuesta.cantidad, base: propuesta.totalBase, igv: propuesta.totalIgv, total: propuesta.total, descargadaEn: propuesta.descargadaEn },
    sistema: totales(sistema),
    diferencias,
    operacion: operacion && { id: operacion.id, tipo: operacion.tipo, estado: operacion.estado, mensaje: operacion.mensaje, creadoEn: operacion.creadoEn, terminadoEn: operacion.terminadoEn },
    generacion: generacion && { constancia: generacion.constancia, terminadoEn: generacion.terminadoEn, mensaje: generacion.mensaje },
    ...(registro === 'RCE' && { compras: await avisosCompras(tx, empresaId, periodo) }),
  };
}
