import { Prisma } from '@prisma/client';
import { autorizacionRequerida, conflicto, noEncontrado, prohibido, solicitudInvalida } from '../lib/errors.js';
import { anularMovimiento, registrarMovimiento, siguienteValor } from '../kardex/servicio.js';
import {
  CLIENTES_VARIOS, DETRACCIONES, aplicarDescuentos, calcularSpot, aplicarPagos, aplicarPagosCredito, calcularLineas, cuotasIguales, errorCliente, errorCuotas,
  estadoCuotas, hoyLima, identidadParaEmitir,
} from './reglas.js';

/**
 * Punto de venta: turnos de caja, ventas, anulaciones, notas de crédito y arqueo.
 * Todo ocurre en UNA transacción por operación: si falla el stock, no se consume el número
 * del comprobante ni queda la venta a medias.
 */
const D = (v) => new Prisma.Decimal(v ?? 0);

/** Turno abierto de la caja, bloqueado para esta transacción (evita ventas cruzadas con el cierre). */
async function turnoAbierto(tx, cajaId) {
  const [fila] = await tx.$queryRaw`SELECT id FROM sesiones_caja WHERE caja_id = ${cajaId}::uuid AND estado = 'ABIERTA' FOR UPDATE`;
  return fila ? tx.sesionCaja.findUnique({ where: { id: fila.id }, include: { caja: true } }) : null;
}

export async function abrirTurno(tx, { tenantId, cajaId, usuarioId, montoApertura }) {
  const caja = await tx.caja.findUnique({ where: { id: cajaId } });
  if (!caja) throw noEncontrado('Caja no encontrada');
  if (!caja.activo) throw conflicto('La caja está desactivada');
  if (await turnoAbierto(tx, cajaId)) throw conflicto('La caja ya tiene un turno abierto');
  try {
    return await tx.sesionCaja.create({ data: { tenantId, cajaId, usuarioId, montoApertura } });
  } catch (err) {
    // Índice único parcial: otro usuario abrió la caja en el mismo instante
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw conflicto('La caja ya tiene un turno abierto');
    throw err;
  }
}

/** Turno de la caja que debe pertenecer al usuario que opera. */
async function turnoDelUsuario(tx, cajaId, usuarioId) {
  const turno = await turnoAbierto(tx, cajaId);
  if (!turno) throw conflicto('La caja no tiene un turno abierto: ábralo para vender');
  if (turno.usuarioId !== usuarioId) throw prohibido('El turno de esta caja pertenece a otro usuario');
  return turno;
}

async function resolverCliente(tx, empresaId, clienteId) {
  if (!clienteId) return { id: null, ...CLIENTES_VARIOS };
  const c = await tx.cliente.findUnique({ where: { id: clienteId } });
  if (!c || c.empresaId !== empresaId) throw solicitudInvalida('Cliente no válido para esta empresa');
  if (!c.activo) throw conflicto('El cliente está desactivado');
  return c;
}

const SERIE_DE = { FACTURA: 'serieFactura', BOLETA: 'serieBoleta', NOTA_VENTA: 'serieNotaVenta' };
const MOTIVO_KARDEX = { FACTURA: 'FACTURA', BOLETA: 'BOLETA', NOTA_VENTA: 'NOTA DE VENTA', NOTA_CREDITO: 'NOTA DE CRÉDITO' };

/** Crea el comprobante con su número correlativo, detalle y pagos. */
async function crearComprobante(tx, { tenantId, turno, tipo, serie, cliente, calculo, pagos, montoRecibido = null, vuelto = 0, usuarioId, cuotas = null, extra = {} }) {
  const caja = turno.caja;
  const numero = await siguienteValor(tx, { tenantId, empresaId: caja.empresaId, clave: `SERIE:${serie}` });
  return tx.comprobante.create({
    data: {
      tenantId, empresaId: caja.empresaId, sedeId: caja.sedeId, almacenId: caja.almacenId, cajaId: caja.id, sesionCajaId: turno.id,
      tipo, serie, numero,
      clienteId: cliente.id, clienteTipoDocumento: cliente.tipoDocumento, clienteNumeroDocumento: cliente.numeroDocumento,
      clienteNombre: cliente.nombre, clienteDireccion: cliente.direccion,
      opGravada: calculo.opGravada, opExonerada: calculo.opExonerada, opInafecta: calculo.opInafecta, igv: calculo.igv,
      descuentoTotal: calculo.descuentoTotal, total: calculo.total, montoRecibido, vuelto,
      // Sin integración con SUNAT todavía: factura/boleta/NC quedan pendientes de envío
      estadoSunat: tipo === 'NOTA_VENTA' ? 'NO_APLICA' : 'PENDIENTE',
      usuarioId,
      ...extra,
      detalles: {
        create: calculo.lineas.map((l) => ({
          tenantId, productoId: l.productoId, descripcion: l.descripcion, unidadCodigo: l.unidadCodigo, cantidad: l.cantidad,
          precioUnitario: l.precioUnitario, valorUnitario: l.valorUnitario, descuento: l.descuento, afectacionIgv: l.afectacionIgv,
          valorVenta: l.valorVenta, igv: l.igv, total: l.total,
        })),
      },
      pagos: { create: pagos.map((p) => ({ tenantId, medio: p.medio, monto: p.monto, referencia: p.referencia ?? null })) },
      ...(cuotas?.length && {
        cuotas: { create: cuotas.map((c) => ({ tenantId, numero: c.numero, monto: c.monto, fechaVencimiento: new Date(`${c.fechaVencimiento}T00:00:00Z`) })) },
      }),
    },
  });
}

/**
 * Deuda de un cliente: saldo de sus ventas al crédito y si alguna cuota está vencida.
 * Con `bloquear`, bloquea la fila del cliente para que dos ventas simultáneas no superen el límite.
 */
export async function deudaCliente(tx, clienteId, { bloquear = false } = {}) {
  if (bloquear) await tx.$queryRaw`SELECT id FROM clientes WHERE id = ${clienteId}::uuid FOR UPDATE`;
  const docs = await tx.comprobante.findMany({
    where: { clienteId, estado: 'EMITIDO', formaPago: 'CREDITO', saldoPendiente: { gt: 0 } },
    select: { id: true, serie: true, numero: true, montoCredito: true, saldoPendiente: true, cuotas: true },
  });
  const hoy = hoyLima();
  let deuda = D(0);
  let vencido = D(0);
  for (const d of docs) {
    deuda = deuda.add(d.saldoPendiente);
    for (const c of estadoCuotas(d.cuotas, d.montoCredito, d.saldoPendiente, hoy)) if (c.vencida) vencido = vencido.add(c.pendiente);
  }
  return { deuda, vencido, documentos: docs.length };
}

/**
 * Venta en caja: valida turno, cliente (reglas SUNAT), descuentos y pagos; emite el comprobante
 * y registra la salida del kardex en el almacén de la caja.
 * items: [{ productoId, cantidad, precioUnitario? (con IGV; por defecto el del catálogo), descuento? | descuentoPorcentaje? }]
 * descuentoGlobal?: { tipo: 'MONTO' | 'PORCENTAJE', valor }
 * formaPago: CONTADO | CREDITO (con `cuotas` opcionales: [{ monto, fechaVencimiento }])
 * permisos: { credito, autorizaDescuento, autorizaCredito } del cajero
 * autorizacion?: { supervisorId, nombre, tipos: ['DESCUENTO' | 'CREDITO'] } validada por la ruta
 */
export async function vender(tx, {
  tenantId, usuarioId, cajaId, tipo, clienteId, items, pagos = [], observacion, descuentoGlobal = null,
  formaPago = 'CONTADO', cuotas = null, permisos = {}, autorizacion = null,
}) {
  const turno = await turnoDelUsuario(tx, cajaId, usuarioId);
  const caja = turno.caja;
  if (!caja.activo) throw conflicto('La caja está desactivada');

  const ids = items.map((i) => i.productoId);
  if (new Set(ids).size !== ids.length) throw solicitudInvalida('Hay productos repetidos: sume las cantidades en una sola línea');
  const productos = new Map(
    (await tx.producto.findMany({ where: { id: { in: ids }, empresaId: caja.empresaId }, include: { unidad: { select: { codigo: true } } } })).map((p) => [p.id, p]),
  );
  const lineas = items.map((i) => {
    const p = productos.get(i.productoId);
    if (!p) throw solicitudInvalida('Algún producto no existe o es de otra empresa');
    if (!p.activo) throw conflicto(`El producto ${p.nombre} está inactivo`);
    const precio = i.precioUnitario ?? p.precioReferencial;
    if (precio == null) throw solicitudInvalida(`El producto ${p.nombre} no tiene precio de venta: indíquelo`);
    return {
      productoId: p.id, descripcion: p.nombre, unidadCodigo: p.unidad.codigo, afectacionIgv: p.afectacionIgv,
      cantidad: i.cantidad, precioUnitario: precio, precioReferencial: p.precioReferencial,
      descuento: i.descuento ?? 0, descuentoPorcentaje: i.descuentoPorcentaje ?? null,
    };
  });

  let calculo;
  let descuentos;
  try {
    descuentos = aplicarDescuentos(lineas, descuentoGlobal);
    calculo = calcularLineas(descuentos.lineas);
  } catch (e) {
    throw solicitudInvalida(e.message);
  }
  if (calculo.total.lte(0)) throw solicitudInvalida('El total de la venta debe ser mayor que cero');

  // Tope de descuento de la caja (incluye bajar el precio de lista a mano)
  const autorizadas = new Set(autorizacion?.tipos ?? []);
  const notas = [];
  let requiereSupervisor = false;
  if (descuentos.rebajaMaxima.gt(caja.descuentoMaximo)) {
    requiereSupervisor ||= !permisos.autorizaDescuento;
    if (!permisos.autorizaDescuento && !autorizadas.has('DESCUENTO')) {
      throw autorizacionRequerida(
        'DESCUENTO',
        `El descuento (${descuentos.rebajaMaxima.toFixed(2)} %) supera el tope de la caja (${D(caja.descuentoMaximo).toFixed(2)} %): requiere autorización de un supervisor`,
      );
    }
    notas.push(`Descuento ${descuentos.rebajaMaxima.toFixed(2)} % (tope ${D(caja.descuentoMaximo).toFixed(2)} %)`);
  }

  const registrado = await resolverCliente(tx, caja.empresaId, clienteId);
  const cliente = identidadParaEmitir(tipo, registrado);
  const errCli = errorCliente(tipo, cliente, calculo.total);
  if (errCli) throw solicitudInvalida(errCli);

  // SPOT / retención del IGV: el cliente paga el neto (la detracción la deposita en el Banco de la Nación)
  const empresa = await tx.empresa.findUnique({ where: { id: caja.empresaId }, select: { cuentaDetracciones: true, exceptuadoRetencion: true } });
  const spot = calcularSpot({
    tipo, total: calculo.total, igv: calculo.igv,
    codigosDetraccion: lineas.map((l) => productos.get(l.productoId).detraccionCodigo).filter(Boolean),
    clienteAgenteRetencion: Boolean(registrado.agenteRetencion),
    empresaExceptuada: empresa.exceptuadoRetencion,
  });
  if (spot.detraccion && !empresa.cuentaDetracciones) {
    throw conflicto(`Factura sujeta a detracción (${DETRACCIONES[spot.detraccion.codigo].nombre}): registre la cuenta de detracciones del Banco de la Nación en los datos de la empresa`);
  }

  let pago;
  let cuotasFinal = null;
  if (formaPago === 'CREDITO') {
    if (!permisos.credito) throw prohibido('No tiene permiso para vender al crédito');
    if (!registrado.id) throw solicitudInvalida('La venta al crédito exige un cliente registrado');
    if (!registrado.creditoHabilitado) throw conflicto(`${registrado.nombre} no tiene crédito habilitado`);
    pago = aplicarPagosCredito(spot.aCobrar, pagos);
    if (pago.error) throw solicitudInvalida(pago.error);
    cuotasFinal = cuotas?.length
      ? cuotas.map((c, i) => ({ numero: i + 1, monto: D(c.monto), fechaVencimiento: String(c.fechaVencimiento).slice(0, 10) }))
      : cuotasIguales(pago.montoCredito, 1, registrado.diasCredito || 30);
    const errC = errorCuotas(cuotasFinal, pago.montoCredito);
    if (errC) throw solicitudInvalida(errC);

    const { deuda, vencido } = await deudaCliente(tx, registrado.id, { bloquear: true });
    const excede = registrado.limiteCredito != null && deuda.add(pago.montoCredito).gt(registrado.limiteCredito);
    if ((excede || vencido.gt(0)) && !permisos.autorizaCredito && !autorizadas.has('CREDITO')) {
      throw autorizacionRequerida(
        'CREDITO',
        vencido.gt(0)
          ? `${registrado.nombre} tiene S/ ${vencido.toFixed(2)} vencidos: el crédito requiere autorización de un supervisor`
          : `El crédito supera el límite de ${registrado.nombre} (deuda S/ ${deuda.toFixed(2)} + S/ ${pago.montoCredito.toFixed(2)} > límite S/ ${D(registrado.limiteCredito).toFixed(2)}): requiere autorización`,
      );
    }
    if (excede || vencido.gt(0)) requiereSupervisor ||= !permisos.autorizaCredito;
    if (excede) notas.push(`Crédito sobre el límite (deuda previa S/ ${deuda.toFixed(2)})`);
    if (vencido.gt(0)) notas.push(`Crédito con deuda vencida S/ ${vencido.toFixed(2)}`);
  } else {
    pago = aplicarPagos(spot.aCobrar, pagos);
    if (pago.error) throw solicitudInvalida(pago.error);
  }

  const comprobante = await crearComprobante(tx, {
    tenantId, turno, tipo, serie: caja[SERIE_DE[tipo]], cliente, calculo, pagos: pago.pagos,
    montoRecibido: pago.montoRecibido, vuelto: pago.vuelto, usuarioId, cuotas: cuotasFinal,
    extra: {
      observacion: observacion ?? null,
      descuentoGlobal: descuentos.descuentoGlobal,
      ...(spot.detraccion && { detraccionCodigo: spot.detraccion.codigo, detraccionPorcentaje: spot.detraccion.porcentaje, detraccionMonto: spot.detraccion.monto }),
      retencionMonto: spot.retencion,
      formaPago,
      montoCredito: pago.montoCredito ?? 0,
      saldoPendiente: pago.montoCredito ?? 0,
      ...(notas.length && { autorizacion: notas.join(' · '), autorizadoPorId: requiereSupervisor ? autorizacion.supervisorId : usuarioId }),
    },
  });

  const kardex = await registrarMovimiento(tx, {
    tenantId, almacenId: caja.almacenId, tipo: 'SALIDA', motivo: 'VENTA', usuarioId,
    documentoTipo: MOTIVO_KARDEX[tipo], documentoSerie: comprobante.serie, documentoNumero: String(comprobante.numero),
    observacion: `${MOTIVO_KARDEX[tipo]} ${comprobante.serie}-${comprobante.numero} · ${cliente.nombre}`,
    items: calculo.lineas.map((l) => ({ productoId: l.productoId, cantidad: l.cantidad })),
  });
  await tx.comprobante.update({ where: { id: comprobante.id }, data: { movimientoId: kardex.movimiento.id } });
  return { comprobante, kardex };
}

/**
 * Anulación: solo mientras el turno en que se emitió siga abierto (el dinero aún está en caja).
 * Después, la corrección es una nota de crédito.
 */
export async function anular(tx, { comprobanteId, usuarioId, tenantId, motivo }) {
  const c = await tx.comprobante.findUnique({
    where: { id: comprobanteId },
    include: {
      sesion: true,
      notasCredito: { where: { estado: 'EMITIDO' }, select: { id: true } },
      _count: { select: { cobranzas: { where: { estado: 'VIGENTE' } } } },
    },
  });
  if (!c) throw noEncontrado();
  if (c.estado === 'ANULADO') throw conflicto('El comprobante ya está anulado');
  if (c.sesion.estado !== 'ABIERTA') throw conflicto('El turno de caja ya se cerró: para revertir esta venta emita una nota de crédito');
  if (c.notasCredito.length) throw conflicto('El comprobante tiene notas de crédito; anúlelas primero');
  if (c._count.cobranzas) throw conflicto('La venta tiene cobranzas registradas; anúlelas primero');

  const { count } = await tx.comprobante.updateMany({
    where: { id: c.id, estado: 'EMITIDO' },
    // Una venta al crédito anulada ya no se debe
    data: { estado: 'ANULADO', anuladoPorId: usuarioId, anuladoEn: new Date(), motivoAnulacion: motivo, saldoPendiente: 0 },
  });
  if (!count) throw conflicto('El comprobante ya está anulado');
  // Nota de crédito anulada: lo que había rebajado de la deuda vuelve a deberse
  if (c.tipo === 'NOTA_CREDITO' && D(c.aplicadoASaldo).gt(0)) {
    await tx.$queryRaw`SELECT id FROM comprobantes WHERE id = ${c.referenciaId}::uuid FOR UPDATE`;
    await tx.comprobante.update({ where: { id: c.referenciaId }, data: { saldoPendiente: { increment: c.aplicadoASaldo } } });
  }
  const r = await anularMovimiento(tx, {
    tenantId, movimientoId: c.movimientoId, usuarioId, desdeDocumento: true,
    observacion: `Anulación de ${c.serie}-${c.numero}: ${motivo}`,
  });
  await tx.comprobante.update({ where: { id: c.id }, data: { movimientoAnulacionId: r.movimiento.id } });
  return { comprobante: { ...c, estado: 'ANULADO' }, kardex: r };
}

/** Catálogo 09 SUNAT (motivos de nota de crédito) que maneja la caja. */
export const MOTIVOS_NC = {
  '01': 'Anulación de la operación',
  '06': 'Devolución total',
  '07': 'Devolución por ítem',
};

/**
 * Nota de crédito sobre una factura o boleta: devuelve productos (total o por ítem),
 * reingresa el stock AL COSTO con que salió y registra el reembolso como pago negativo.
 * items (motivo 07): [{ productoId, cantidad }]; con 01/06 se devuelve todo lo pendiente.
 */
export async function notaCredito(tx, { tenantId, usuarioId, cajaId, comprobanteId, motivoCodigo, motivoDescripcion, items, medioReembolso }) {
  const turno = await turnoDelUsuario(tx, cajaId, usuarioId);
  // Bloquea el original: su saldo (si fue al crédito) cambia con esta nota
  await tx.$queryRaw`SELECT id FROM comprobantes WHERE id = ${comprobanteId}::uuid FOR UPDATE`;
  const original = await tx.comprobante.findUnique({
    where: { id: comprobanteId },
    include: {
      detalles: true,
      notasCredito: { where: { estado: 'EMITIDO' }, include: { detalles: true } },
      movimiento: { include: { detalles: true } },
    },
  });
  if (!original || original.empresaId !== turno.caja.empresaId) throw noEncontrado('Comprobante no encontrado');
  if (!['FACTURA', 'BOLETA'].includes(original.tipo)) throw conflicto('Solo se emiten notas de crédito sobre facturas y boletas; una nota de venta se anula');
  if (original.estado !== 'EMITIDO') throw conflicto('El comprobante está anulado');

  // Cantidad que aún se puede devolver por producto
  const devuelto = new Map();
  for (const nc of original.notasCredito) for (const d of nc.detalles) devuelto.set(d.productoId, D(devuelto.get(d.productoId)).add(d.cantidad));
  const pendientes = original.detalles.map((d) => ({ d, pendiente: D(d.cantidad).sub(D(devuelto.get(d.productoId))) })).filter((x) => x.pendiente.gt(0));
  if (!pendientes.length) throw conflicto('Ya se devolvió todo lo vendido en este comprobante');

  const solicitadas = motivoCodigo === '07' ? new Map((items ?? []).map((i) => [i.productoId, D(i.cantidad)])) : null;
  if (solicitadas && !solicitadas.size) throw solicitudInvalida('Indique los productos y cantidades a devolver');
  const lineas = [];
  for (const { d, pendiente } of pendientes) {
    const cantidad = solicitadas ? solicitadas.get(d.productoId) : pendiente;
    if (!cantidad || cantidad.lte(0)) continue;
    if (cantidad.gt(pendiente)) throw solicitudInvalida(`${d.descripcion}: solo quedan ${pendiente} por devolver`);
    lineas.push({
      productoId: d.productoId, descripcion: d.descripcion, unidadCodigo: d.unidadCodigo, afectacionIgv: d.afectacionIgv,
      cantidad, precioUnitario: d.precioUnitario,
      // El descuento se devuelve en proporción a lo devuelto
      descuento: D(d.descuento).mul(cantidad).div(d.cantidad).toDecimalPlaces(2),
    });
  }
  if (solicitadas && lineas.length !== solicitadas.size) throw solicitudInvalida('Algún producto no pertenece al comprobante');
  if (!lineas.length) throw solicitudInvalida('No hay nada que devolver');

  const calculo = calcularLineas(lineas);
  const serie = original.tipo === 'FACTURA' ? turno.caja.serieNotaCreditoFactura : turno.caja.serieNotaCreditoBoleta;
  const cliente = {
    id: original.clienteId, tipoDocumento: original.clienteTipoDocumento, numeroDocumento: original.clienteNumeroDocumento,
    nombre: original.clienteNombre, direccion: original.clienteDireccion,
  };
  // Venta al crédito: la nota primero rebaja la deuda; solo se reembolsa lo que el cliente ya pagó de más
  const aplicadoASaldo = Prisma.Decimal.min(calculo.total, D(original.saldoPendiente));
  const reembolso = calculo.total.sub(aplicadoASaldo);
  const nc = await crearComprobante(tx, {
    tenantId, turno, tipo: 'NOTA_CREDITO', serie, cliente, calculo, usuarioId,
    // Reembolso: sale dinero de la caja (pago negativo)
    pagos: reembolso.gt(0) ? [{ medio: medioReembolso, monto: reembolso.neg() }] : [],
    extra: { referenciaId: original.id, motivoCodigo, motivoDescripcion: motivoDescripcion || MOTIVOS_NC[motivoCodigo], aplicadoASaldo },
  });
  if (aplicadoASaldo.gt(0)) {
    await tx.comprobante.update({ where: { id: original.id }, data: { saldoPendiente: { decrement: aplicadoASaldo } } });
  }

  // Reingreso al kardex al costo con que salió cada producto en la venta original
  const costoSalida = new Map((original.movimiento?.detalles ?? []).map((d) => [d.productoId, d.costoUnitario]));
  const kardex = await registrarMovimiento(tx, {
    tenantId, almacenId: turno.caja.almacenId, tipo: 'ENTRADA', motivo: 'DEVOLUCION_CLIENTE', usuarioId,
    documentoTipo: MOTIVO_KARDEX.NOTA_CREDITO, documentoSerie: nc.serie, documentoNumero: String(nc.numero),
    observacion: `NC ${nc.serie}-${nc.numero} sobre ${original.serie}-${original.numero}`,
    items: calculo.lineas.map((l) => ({ productoId: l.productoId, cantidad: l.cantidad, costoUnitario: costoSalida.get(l.productoId) })),
  });
  await tx.comprobante.update({ where: { id: nc.id }, data: { movimientoId: kardex.movimiento.id } });
  return { comprobante: nc, kardex };
}

/** Totales del turno: por tipo de comprobante y por medio de pago (anulados excluidos). */
export async function resumenTurno(tx, sesionId) {
  const turno = await tx.sesionCaja.findUnique({ where: { id: sesionId } });
  if (!turno) throw noEncontrado();
  const comprobantes = await tx.comprobante.findMany({
    where: { sesionCajaId: sesionId },
    select: { tipo: true, estado: true, total: true, montoCredito: true, pagos: { select: { medio: true, monto: true } } },
  });
  const cobros = await tx.cobranza.findMany({ where: { sesionCajaId: sesionId, estado: 'VIGENTE' }, select: { medio: true, monto: true } });
  const porMedio = {};
  const porTipo = {};
  let anulados = 0;
  let ventasCredito = D(0);
  for (const c of comprobantes) {
    if (c.estado === 'ANULADO') {
      anulados += 1;
      continue;
    }
    const t = (porTipo[c.tipo] ||= { cantidad: 0, total: D(0) });
    t.cantidad += 1;
    t.total = t.total.add(c.tipo === 'NOTA_CREDITO' ? D(c.total).neg() : c.total);
    for (const p of c.pagos) porMedio[p.medio] = D(porMedio[p.medio]).add(p.monto);
    ventasCredito = ventasCredito.add(c.montoCredito);
  }
  // Cobranzas de ventas al crédito recibidas en este turno: entran al arqueo
  const cobranzas = { cantidad: cobros.length, total: D(0) };
  for (const p of cobros) {
    porMedio[p.medio] = D(porMedio[p.medio]).add(p.monto);
    cobranzas.total = cobranzas.total.add(p.monto);
  }
  const efectivoEsperado = D(turno.montoApertura).add(D(porMedio.EFECTIVO));
  const ventasNetas = Object.values(porTipo).reduce((s, t) => s.add(t.total), D(0));
  return { turno, porMedio, porTipo, anulados, efectivoEsperado, ventasNetas, ventasCredito, cobranzas };
}

/** Cierre con arqueo: efectivo esperado contra el declarado por el cajero. */
export async function cerrarTurno(tx, { sesionId, usuarioId, puedeCerrarAjeno, efectivoDeclarado, observacion }) {
  const [fila] = await tx.$queryRaw`SELECT id FROM sesiones_caja WHERE id = ${sesionId}::uuid FOR UPDATE`;
  if (!fila) throw noEncontrado();
  const r = await resumenTurno(tx, sesionId);
  if (r.turno.estado !== 'ABIERTA') throw conflicto('El turno ya está cerrado');
  if (r.turno.usuarioId !== usuarioId && !puedeCerrarAjeno) throw prohibido('Solo quien abrió el turno (o un supervisor) puede cerrarlo');
  const declarado = D(efectivoDeclarado);
  const resumen = {
    porMedio: Object.fromEntries(Object.entries(r.porMedio).map(([k, v]) => [k, v.toFixed(2)])),
    porTipo: Object.fromEntries(Object.entries(r.porTipo).map(([k, v]) => [k, { cantidad: v.cantidad, total: v.total.toFixed(2) }])),
    anulados: r.anulados,
    ventasNetas: r.ventasNetas.toFixed(2),
    ventasCredito: r.ventasCredito.toFixed(2),
    cobranzas: { cantidad: r.cobranzas.cantidad, total: r.cobranzas.total.toFixed(2) },
  };
  return tx.sesionCaja.update({
    where: { id: sesionId },
    data: {
      estado: 'CERRADA', cerradaEn: new Date(), efectivoEsperado: r.efectivoEsperado, efectivoDeclarado: declarado,
      diferencia: declarado.sub(r.efectivoEsperado), resumen, observacion: observacion ?? null,
    },
  });
}


// ═════════════ Cobranzas (cuentas por cobrar) ═════════════

/**
 * Cobro a cuenta de una venta al crédito. En efectivo exige un turno de caja propio abierto
 * (el dinero entra al arqueo); con otros medios puede registrarse sin caja (p. ej. depósito).
 */
export async function registrarCobranza(tx, { tenantId, usuarioId, comprobanteId, monto, medio, referencia, observacion, cajaId }) {
  await tx.$queryRaw`SELECT id FROM comprobantes WHERE id = ${comprobanteId}::uuid FOR UPDATE`;
  const c = await tx.comprobante.findUnique({ where: { id: comprobanteId } });
  if (!c) throw noEncontrado('Comprobante no encontrado');
  if (c.estado !== 'EMITIDO' || c.formaPago !== 'CREDITO') throw conflicto('Solo se cobran ventas al crédito vigentes');
  if (D(c.saldoPendiente).lte(0)) throw conflicto('El comprobante ya está pagado');
  const importe = D(monto);
  if (importe.lte(0)) throw solicitudInvalida('El monto debe ser mayor que cero');
  if (importe.gt(c.saldoPendiente)) throw solicitudInvalida(`El monto supera el saldo pendiente (S/ ${D(c.saldoPendiente).toFixed(2)})`);

  let turno = null;
  if (cajaId) {
    turno = await turnoDelUsuario(tx, cajaId, usuarioId);
    if (turno.caja.empresaId !== c.empresaId) throw solicitudInvalida('La caja es de otra empresa');
  } else if (medio === 'EFECTIVO') {
    throw solicitudInvalida('El efectivo se cobra en una caja con turno abierto (entra al arqueo)');
  }

  const numero = await siguienteValor(tx, { tenantId, empresaId: c.empresaId, clave: 'COBRANZA' });
  const cobranza = await tx.cobranza.create({
    data: {
      tenantId, empresaId: c.empresaId, clienteId: c.clienteId, comprobanteId: c.id, sesionCajaId: turno?.id ?? null,
      numero, medio, monto: importe, referencia: referencia ?? null, observacion: observacion ?? null, usuarioId,
    },
  });
  const actualizado = await tx.comprobante.update({ where: { id: c.id }, data: { saldoPendiente: { decrement: importe } } });
  return { cobranza, comprobante: actualizado, almacenId: c.almacenId };
}

/** Anula una cobranza (error de registro): la deuda vuelve. Si entró a una caja, solo mientras ese turno siga abierto. */
export async function anularCobranza(tx, { cobranzaId, usuarioId, motivo }) {
  await tx.$queryRaw`SELECT id FROM cobranzas WHERE id = ${cobranzaId}::uuid FOR UPDATE`;
  const k = await tx.cobranza.findUnique({ where: { id: cobranzaId }, include: { sesion: { select: { estado: true } } } });
  if (!k) throw noEncontrado();
  if (k.estado === 'ANULADA') throw conflicto('La cobranza ya está anulada');
  if (k.sesion && k.sesion.estado !== 'ABIERTA') throw conflicto('La cobranza entró a un turno de caja ya cerrado y arqueado: no se puede anular');
  await tx.$queryRaw`SELECT id FROM comprobantes WHERE id = ${k.comprobanteId}::uuid FOR UPDATE`;
  const anulada = await tx.cobranza.update({
    where: { id: k.id },
    data: { estado: 'ANULADA', anuladoPorId: usuarioId, anuladoEn: new Date(), motivoAnulacion: motivo },
  });
  await tx.comprobante.update({ where: { id: k.comprobanteId }, data: { saldoPendiente: { increment: k.monto } } });
  return anulada;
}
