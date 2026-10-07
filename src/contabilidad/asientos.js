import { siguienteValor } from '../kardex/servicio.js';
import { DOC_IDENTIDAD, TIPO_CP } from '../sire/conciliacion.js';
import { desplazar, esPeriodo } from '../sire/periodos.js';
import { CUENTAS_OPERACION } from './pcge.js';
import { listarPlan } from './servicio.js';

/**
 * Asientos automáticos (Fase 3B). Se contabiliza por período y es idempotente: cada operación
 * tiene una clave (VENTA:<id>, COBRO:<id>, COSTO:<id>…) y genera su asiento una sola vez.
 * Si la operación se anula, se registra el EXTORNO (mismas cuentas, debe y haber invertidos)
 * en el período de la anulación; el asiento original no se toca.
 *
 * Asientos por operación (cuentas de "Cuentas por operación"):
 *  - Venta (factura/boleta): cxcFacturas a igvVentas + ventasMercaderias / ventasServicios (unidad ZZ)
 *  - Cobro al vender: caja/bancos (+ detracciones, retencionIgv) a cxcFacturas
 *  - Nota de crédito: devolucionesVentas (o ventas) + igvVentas a cxcFacturas; reembolso: cxc a caja/bancos
 *  - Cobranza: caja/bancos a cxcFacturas
 *  - Compra: comprasMercaderias + igvCompras a cxpFacturas, y destino mercaderias a variacionMercaderias
 *    (sin factura, el IGV no es crédito fiscal y va al costo). En dólares, al tipo de cambio del documento.
 *  - Venta comercial: cxcFacturas a igvVentas + ventasMercaderias
 *  - Costo de ventas (kardex): costoVentas a mercaderias; devolución de cliente: al revés
 */
const NOMBRE_OPERACION = Object.fromEntries(CUENTAS_OPERACION.map(([clave, , nombre]) => [clave, nombre]));
const r2 = (v) => Math.round(Number(v) * 100) / 100;
const MAX_DESCUADRE = 0.05;
const fechaLima = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(d);
const fechaIso = (d) => d.toISOString().slice(0, 10);
const rangoLima = (periodo) => {
  const s = desplazar(periodo, 1);
  return { gte: new Date(`${periodo.slice(0, 4)}-${periodo.slice(4)}-01T05:00:00Z`), lt: new Date(`${s.slice(0, 4)}-${s.slice(4)}-01T05:00:00Z`) };
};
const rangoFecha = (periodo) => {
  const s = desplazar(periodo, 1);
  return { gte: new Date(`${periodo.slice(0, 4)}-${periodo.slice(4)}-01T00:00:00Z`), lt: new Date(`${s.slice(0, 4)}-${s.slice(4)}-01T00:00:00Z`) };
};
const numCp = (serie, numero) => `${serie}-${String(numero).padStart(8, '0')}`;
const docTipoPorNumero = (n) => (/^\d{11}$/.test(n) ? '6' : /^\d{8}$/.test(n) ? '1' : '0');

class FaltaCuenta extends Error {}

/** Orden dentro de una misma hora: la venta antes que su cobro y su costo */
const PRIORIDAD = { VENTA: 1, VENTA_COMERCIAL: 1, COMPRA: 1, NOTA_CREDITO: 2, COSTO_VENTA: 3, COBRO: 4, REEMBOLSO: 4, COBRANZA: 5 };
const prioridadExtorno = (o) => (o.extornoDe ? 1 : 0);

/** Resuelve las cuentas configuradas; si falta una, la operación queda pendiente con el motivo */
function cuentasDe(config, imputables) {
  return (clave, { opcional = false } = {}) => {
    const codigo = config[clave];
    if (!codigo) {
      if (opcional) return null;
      throw new FaltaCuenta(`Falta configurar la cuenta de "${NOMBRE_OPERACION[clave]}"`);
    }
    if (!imputables.has(codigo)) throw new FaltaCuenta(`La cuenta ${codigo} (${NOMBRE_OPERACION[clave]}) ya no recibe movimientos: revise la configuración`);
    return codigo;
  };
}

const linea = (cuenta, debe, haber, extra = {}) => ({ cuenta, debe: r2(debe), haber: r2(haber), ...extra });

/** Suma por cuenta y lado (varias líneas iguales se juntan) y quita las de monto cero */
function compactar(lineas) {
  const m = new Map();
  for (const l of lineas) {
    const lado = l.debe > 0 ? 'D' : 'H';
    const k = `${l.cuenta}|${lado}|${l.terceroDoc ?? ''}|${l.docSerie ?? ''}|${l.docNumero ?? ''}`;
    const x = m.get(k);
    if (x) {
      x.debe = r2(x.debe + l.debe);
      x.haber = r2(x.haber + l.haber);
    } else m.set(k, { ...l });
  }
  return [...m.values()].filter((l) => l.debe > 0 || l.haber > 0);
}

/**
 * Cuadra el asiento: diferencias de redondeo de hasta 5 céntimos se absorben en la línea indicada.
 * Una diferencia mayor es un error de datos y la operación queda pendiente.
 */
function cuadrar(lineas, cuentaCuadre) {
  const debe = r2(lineas.reduce((s, l) => s + l.debe, 0));
  const haber = r2(lineas.reduce((s, l) => s + l.haber, 0));
  const dif = r2(debe - haber);
  if (dif === 0) return lineas;
  if (Math.abs(dif) > MAX_DESCUADRE) throw new FaltaCuenta(`El asiento no cuadra (diferencia S/ ${dif.toFixed(2)})`);
  // La línea indicada, o la de mayor monto si esa no quedó (p. ej. monto cero)
  const l = lineas.find((x) => x.cuenta === cuentaCuadre) ?? [...lineas].sort((a, b) => b.debe + b.haber - (a.debe + a.haber))[0];
  if (l.haber > 0) l.haber = r2(l.haber + dif);
  else l.debe = r2(l.debe - dif);
  return lineas;
}

// ───────────── Operaciones del período ─────────────

/**
 * Lista las operaciones del período que llevan asiento, cada una con su clave y una función que
 * arma el asiento. Los extornos dependen del asiento original (que puede ser de otro período).
 */
async function operacionesDelPeriodo(tx, empresaId, periodo) {
  const [comprobantes, anulados, cobranzas, cobranzasAnuladas, documentos, documentosAnulados, movimientos] = await Promise.all([
    tx.comprobante.findMany({
      where: { empresaId, tipo: { in: Object.keys(TIPO_CP) }, fechaEmision: rangoLima(periodo) },
      include: { detalles: { select: { unidadCodigo: true, valorVenta: true } }, pagos: { select: { medio: true, monto: true } }, referencia: { select: { tipo: true, serie: true, numero: true } } },
    }),
    tx.comprobante.findMany({ where: { empresaId, estado: 'ANULADO', anuladoEn: rangoLima(periodo) }, select: { id: true, anuladoEn: true, serie: true, numero: true } }),
    tx.cobranza.findMany({ where: { empresaId, fecha: rangoLima(periodo) }, include: { comprobante: { select: { tipo: true, serie: true, numero: true, clienteTipoDocumento: true, clienteNumeroDocumento: true, clienteNombre: true } } } }),
    tx.cobranza.findMany({ where: { empresaId, estado: 'ANULADA', anuladoEn: rangoLima(periodo) }, select: { id: true, anuladoEn: true, numero: true } }),
    tx.documentoComercial.findMany({ where: { empresaId, estado: { in: ['CONFIRMADO', 'ANULADO'] }, fechaEmision: rangoFecha(periodo) } }),
    tx.documentoComercial.findMany({ where: { empresaId, estado: 'ANULADO', anuladoEn: rangoLima(periodo) }, select: { id: true, anuladoEn: true, serie: true, numero: true, tipo: true } }),
    tx.movimiento.findMany({
      where: { empresaId, fecha: rangoLima(periodo), OR: [{ tipo: 'SALIDA', motivo: 'VENTA' }, { tipo: 'ENTRADA', motivo: 'DEVOLUCION_CLIENTE' }, { motivo: 'ANULACION' }] },
      include: { detalles: { select: { costoTotal: true } }, comprobante: { select: { serie: true, numero: true } }, documentoComercial: { select: { serie: true, numero: true } } },
    }),
  ]);
  const ops = [];

  for (const c of comprobantes) {
    const fecha = fechaLima(c.fechaEmision);
    const tercero = { terceroTipo: DOC_IDENTIDAD[c.clienteTipoDocumento], terceroDoc: c.clienteNumeroDocumento === '-' ? null : c.clienteNumeroDocumento, terceroNombre: c.clienteNombre };
    const doc = { docTipo: TIPO_CP[c.tipo], docSerie: c.serie, docNumero: String(c.numero) };
    const numero = numCp(c.serie, c.numero);
    const base = (servicio) => c.detalles.filter((d) => (d.unidadCodigo === 'ZZ') === servicio).reduce((s, d) => s + Number(d.valorVenta), 0);
    const refs = { comprobanteId: c.id };

    if (c.tipo === 'NOTA_CREDITO') {
      ops.push({
        clave: `NC:${c.id}`, origen: 'NOTA_CREDITO', fecha, momento: c.fechaEmision.toISOString(), refs, glosa: `Nota de crédito ${numero}${c.referencia ? ` (modifica ${numCp(c.referencia.serie, c.referencia.numero)})` : ''} · ${c.clienteNombre}`,
        armar: (cta) => {
          const devol = cta('devolucionesVentas', { opcional: true });
          const l = [
            linea(devol ?? cta('ventasMercaderias'), base(false), 0),
            linea(devol ?? cta('ventasServicios'), base(true), 0),
            linea(cta('igvVentas'), c.igv, 0),
            linea(cta('cxcFacturas'), 0, c.total, { ...tercero, ...doc }),
          ];
          return { lineas: l, cuadre: 0 };
        },
      });
      // El reembolso se guarda como pago negativo (sale dinero de la caja)
      const reembolso = c.pagos.reduce((s, p) => s + Math.abs(Number(p.monto)), 0);
      if (reembolso > 0) {
        ops.push({
          clave: `REEMBOLSO:${c.id}`, origen: 'REEMBOLSO', fecha, momento: c.fechaEmision.toISOString(), refs, glosa: `Reembolso de la nota de crédito ${numero} · ${c.clienteNombre}`,
          armar: (cta) => ({
            lineas: [
              linea(cta('cxcFacturas'), reembolso, 0, { ...tercero, ...doc }),
              ...c.pagos.map((p) => linea(cta(p.medio === 'EFECTIVO' ? 'caja' : 'bancos'), 0, Math.abs(Number(p.monto)))),
            ],
          }),
        });
      }
      continue;
    }

    ops.push({
      clave: `VENTA:${c.id}`, origen: 'VENTA', fecha, momento: c.fechaEmision.toISOString(), refs, glosa: `Venta ${c.tipo === 'FACTURA' ? 'factura' : 'boleta'} ${numero} · ${c.clienteNombre}`,
      armar: (cta) => {
        const merc = base(false);
        const serv = base(true);
        const l = [
          linea(cta('cxcFacturas'), c.total, 0, { ...tercero, ...doc }),
          linea(cta('igvVentas'), 0, c.igv),
          merc > 0 ? linea(cta('ventasMercaderias'), 0, merc) : null,
          serv > 0 ? linea(cta('ventasServicios'), 0, serv) : null,
        ].filter(Boolean);
        // El redondeo lo absorbe la línea de ventas más grande
        return { lineas: l, cuadre: merc >= serv ? 2 : l.length - 1 };
      },
    });
    const pagado = c.pagos.reduce((s, p) => s + Number(p.monto), 0);
    const spot = Number(c.detraccionMonto);
    const retencion = Number(c.retencionMonto);
    if (pagado + spot + retencion > 0) {
      ops.push({
        clave: `COBRO:${c.id}`, origen: 'COBRO', fecha, momento: c.fechaEmision.toISOString(), refs, glosa: `Cobro ${numero} · ${c.clienteNombre}`,
        armar: (cta) => ({
          lineas: [
            ...c.pagos.map((p) => linea(cta(p.medio === 'EFECTIVO' ? 'caja' : 'bancos'), p.monto, 0)),
            spot > 0 ? linea(cta('detracciones'), spot, 0, { glosa: 'Detracción depositada por el cliente' }) : null,
            retencion > 0 ? linea(cta('retencionIgv'), retencion, 0, { glosa: 'Retención de IGV' }) : null,
            linea(cta('cxcFacturas'), 0, pagado + spot + retencion, { ...tercero, ...doc }),
          ].filter(Boolean),
        }),
      });
    }
  }
  for (const c of anulados) {
    for (const k of ['VENTA', 'COBRO', 'NC', 'REEMBOLSO']) {
      ops.push({ clave: `${k}:${c.id}:EXTORNO`, extornoDe: `${k}:${c.id}`, fecha: fechaLima(c.anuladoEn), momento: c.anuladoEn.toISOString(), glosa: `Anulación de ${numCp(c.serie, c.numero)}`, opcional: true });
    }
  }

  for (const k of cobranzas) {
    const c = k.comprobante;
    ops.push({
      clave: `COBRANZA:${k.id}`, origen: 'COBRANZA', fecha: fechaLima(k.fecha), momento: k.fecha.toISOString(), refs: { cobranzaId: k.id, comprobanteId: k.comprobanteId },
      glosa: `Cobranza N.º ${k.numero} de ${numCp(c.serie, c.numero)} · ${c.clienteNombre}`,
      armar: (cta) => ({
        lineas: [
          linea(cta(k.medio === 'EFECTIVO' ? 'caja' : 'bancos'), k.monto, 0),
          linea(cta('cxcFacturas'), 0, k.monto, {
            terceroTipo: DOC_IDENTIDAD[c.clienteTipoDocumento], terceroDoc: c.clienteNumeroDocumento, terceroNombre: c.clienteNombre,
            docTipo: TIPO_CP[c.tipo], docSerie: c.serie, docNumero: String(c.numero),
          }),
        ],
      }),
    });
  }
  for (const k of cobranzasAnuladas) {
    ops.push({ clave: `COBRANZA:${k.id}:EXTORNO`, extornoDe: `COBRANZA:${k.id}`, fecha: fechaLima(k.anuladoEn), momento: k.anuladoEn.toISOString(), glosa: `Anulación de la cobranza N.º ${k.numero}` });
  }

  for (const d of documentos) {
    const tc = Number(d.tipoCambio) || 1;
    const fecha = fechaIso(d.fechaEmision);
    const tercero = { terceroTipo: docTipoPorNumero(d.terceroDocumento), terceroDoc: d.terceroDocumento, terceroNombre: d.terceroNombre };
    const doc = { docTipo: d.comprobanteTipo === 'FACTURA' ? '01' : d.comprobanteTipo === 'BOLETA' ? '03' : '00', docSerie: d.serie, docNumero: d.numero };
    const enDolares = d.moneda === 'USD' ? ` (US$ ${Number(d.total).toFixed(2)} × ${tc})` : '';
    if (d.tipo === 'COMPRA') {
      // Sin factura, el IGV no es crédito fiscal: forma parte del costo
      const conCredito = d.comprobanteTipo === 'FACTURA';
      const costo = conCredito ? Number(d.subtotal) * tc : Number(d.total) * tc;
      ops.push({
        clave: `COMPRA:${d.id}`, origen: 'COMPRA', fecha, momento: d.confirmadoEn?.toISOString() ?? fecha, refs: { documentoId: d.id }, glosa: `Compra ${d.comprobanteTipo.toLowerCase()} ${d.serie}-${d.numero} · ${d.terceroNombre}${enDolares}`,
        armar: (cta) => ({
          lineas: [
            linea(cta('comprasMercaderias'), costo, 0),
            conCredito ? linea(cta('igvCompras'), Number(d.igv) * tc, 0) : null,
            linea(cta('cxpFacturas'), 0, Number(d.total) * tc, { ...tercero, ...doc }),
            // Destino: la compra entra al inventario
            linea(cta('mercaderias'), costo, 0, { glosa: 'Destino de la compra' }),
            linea(cta('variacionMercaderias'), 0, costo, { glosa: 'Destino de la compra' }),
          ].filter(Boolean),
          cuadre: conCredito ? 2 : 1,
        }),
      });
    } else {
      ops.push({
        clave: `VENTA_COMERCIAL:${d.id}`, origen: 'VENTA_COMERCIAL', fecha, momento: d.confirmadoEn?.toISOString() ?? fecha, refs: { documentoId: d.id }, glosa: `Venta ${d.comprobanteTipo.toLowerCase()} ${d.serie}-${d.numero} · ${d.terceroNombre}${enDolares}`,
        armar: (cta) => ({
          lineas: [
            linea(cta('cxcFacturas'), Number(d.total) * tc, 0, { ...tercero, ...doc }),
            linea(cta('igvVentas'), 0, Number(d.igv) * tc),
            linea(cta('ventasMercaderias'), 0, Number(d.subtotal) * tc),
          ],
          cuadre: 2,
        }),
      });
    }
  }
  for (const d of documentosAnulados) {
    const k = d.tipo === 'COMPRA' ? 'COMPRA' : 'VENTA_COMERCIAL';
    ops.push({ clave: `${k}:${d.id}:EXTORNO`, extornoDe: `${k}:${d.id}`, fecha: fechaLima(d.anuladoEn), momento: d.anuladoEn.toISOString(), glosa: `Anulación de ${d.serie}-${d.numero}` });
  }

  for (const m of movimientos) {
    const fecha = fechaLima(m.fecha);
    if (m.motivo === 'ANULACION') {
      if (m.anulaId) ops.push({ clave: `COSTO:${m.anulaId}:EXTORNO`, extornoDe: `COSTO:${m.anulaId}`, fecha, momento: m.fecha.toISOString(), glosa: `Anulación del movimiento de kardex`, opcional: true });
      continue;
    }
    const costo = m.detalles.reduce((s, x) => s + Number(x.costoTotal), 0);
    if (r2(costo) <= 0) continue;
    const ref = m.comprobante ? numCp(m.comprobante.serie, m.comprobante.numero) : m.documentoComercial ? `${m.documentoComercial.serie}-${m.documentoComercial.numero}` : m.numero;
    const devolucion = m.motivo === 'DEVOLUCION_CLIENTE';
    ops.push({
      clave: `COSTO:${m.id}`, origen: 'COSTO_VENTA', fecha, momento: m.fecha.toISOString(), refs: { movimientoId: m.id },
      glosa: `${devolucion ? 'Devolución al inventario' : 'Costo de venta'} ${ref} (kardex ${m.numero})`,
      armar: (cta) => ({
        lineas: devolucion
          ? [linea(cta('mercaderias'), costo, 0), linea(cta('costoVentas'), 0, costo)]
          : [linea(cta('costoVentas'), costo, 0), linea(cta('mercaderias'), 0, costo)],
      }),
    });
  }
  // Por fecha y hora de la operación; a la misma hora, primero la venta y luego su cobro y su costo.
  // Los extornos van después de sus originales.
  const prioridad = (o) => (o.extornoDe ? 9 : PRIORIDAD[o.origen] ?? 5);
  return ops.sort((a, b) => a.fecha.localeCompare(b.fecha) || prioridadExtorno(a) - prioridadExtorno(b) || (a.momento ?? '').localeCompare(b.momento ?? '') || prioridad(a) - prioridad(b) || a.clave.localeCompare(b.clave));
}

// ───────────── Generación ─────────────

/** Arma (sin guardar) los asientos que faltan del período; también sirve para mostrar lo pendiente */
async function pendientesDelPeriodo(tx, empresaId, periodo) {
  const [cfg, plan] = await Promise.all([tx.configContable.findUnique({ where: { empresaId } }), listarPlan(tx, empresaId)]);
  if (!plan.length) return { sinPlan: true, listos: [], errores: [] };
  const cta = cuentasDe(cfg?.cuentas ?? {}, new Set(plan.filter((c) => c.imputable && c.activo).map((c) => c.codigo)));
  const ops = await operacionesDelPeriodo(tx, empresaId, periodo);
  const existentes = await tx.asiento.findMany({
    where: { empresaId, clave: { in: [...ops.map((o) => o.clave), ...ops.filter((o) => o.extornoDe).map((o) => o.extornoDe)] } },
    include: { lineas: { orderBy: { orden: 'asc' } } },
  });
  // Originales: los ya guardados y los que se arman en esta misma pasada
  const porClave = new Map(existentes.map((a) => [a.clave, {
    origen: a.origen, glosa: a.glosa,
    refs: { comprobanteId: a.comprobanteId, documentoId: a.documentoId, cobranzaId: a.cobranzaId, movimientoId: a.movimientoId },
    lineas: a.lineas.map(({ cuenta, debe, haber, glosa, terceroTipo, terceroDoc, terceroNombre, docTipo, docSerie, docNumero }) => ({
      cuenta, debe: Number(debe), haber: Number(haber), glosa, terceroTipo, terceroDoc, terceroNombre, docTipo, docSerie, docNumero,
    })),
  }]));
  const guardados = new Map(existentes.map((a) => [a.clave, a.id]));
  const listos = [];
  const errores = [];
  for (const op of ops) {
    if (guardados.has(op.clave)) continue;
    if (op.extornoDe) {
      const original = porClave.get(op.extornoDe);
      if (!original) {
        // Una anulación de algo que nunca tuvo asiento (p. ej. venta sin cobro) no lleva extorno
        if (!op.opcional) errores.push({ clave: op.clave, fecha: op.fecha, glosa: op.glosa, error: 'Contabilice primero el período del documento original' });
        continue;
      }
      listos.push({
        ...op, origen: original.origen, glosa: `Extorno: ${original.glosa}`, extornoDeClave: op.extornoDe, refs: original.refs,
        lineas: original.lineas.map((l) => ({ ...l, debe: l.haber, haber: l.debe })),
      });
      continue;
    }
    try {
      const { lineas, cuadre } = op.armar(cta);
      const armado = { ...op, lineas: cuadrar(compactar(lineas), lineas[cuadre]?.cuenta) };
      listos.push(armado);
      porClave.set(op.clave, armado);
    } catch (e) {
      if (!(e instanceof FaltaCuenta)) throw e;
      errores.push({ clave: op.clave, origen: op.origen, fecha: op.fecha, glosa: op.glosa, error: e.message });
    }
  }
  return { sinPlan: false, listos, errores, guardados };
}

async function cerrado(tx, empresaId, periodo) {
  return Boolean((await tx.periodoContable.findUnique({ where: { empresaId_periodo: { empresaId, periodo } } }))?.cerrado);
}

export async function generarPeriodo(tx, { tenantId, empresaId, periodo, usuarioId }) {
  if (!esPeriodo(periodo)) throw new Error('Período inválido');
  if (await cerrado(tx, empresaId, periodo)) return { bloqueado: 'El período está cerrado: reábralo para contabilizar', creados: 0, errores: [] };
  const { sinPlan, listos, errores, guardados } = await pendientesDelPeriodo(tx, empresaId, periodo);
  if (sinPlan) return { creados: 0, errores: [{ error: 'La empresa no tiene plan contable' }] };
  const ids = new Map(guardados);
  for (const a of listos) {
    const numero = await siguienteValor(tx, { tenantId, empresaId, clave: `ASIENTO:${periodo}` });
    const total = r2(a.lineas.reduce((s, l) => s + l.debe, 0));
    const creado = await tx.asiento.create({
      data: {
        tenantId, empresaId, periodo, numero, fecha: new Date(`${a.fecha}T00:00:00Z`), glosa: a.glosa.slice(0, 300), origen: a.origen, clave: a.clave,
        ...a.refs, extornoDeId: a.extornoDeClave ? ids.get(a.extornoDeClave) : null, totalDebe: total, totalHaber: total, usuarioId,
        lineas: { create: a.lineas.map((l, i) => ({ tenantId, orden: i + 1, ...l, glosa: l.glosa ?? null })) },
      },
      select: { id: true },
    });
    ids.set(a.clave, creado.id);
  }
  return { creados: listos.length, errores };
}

/** Borra los asientos automáticos del período y los vuelve a generar (p. ej. tras cambiar cuentas) */
export async function regenerarPeriodo(tx, { tenantId, empresaId, periodo, usuarioId }) {
  if (await cerrado(tx, empresaId, periodo)) return { bloqueado: 'El período está cerrado: reábralo para regenerar' };
  // Si un asiento del período tiene extornos en otro período, borrarlo los dejaría huérfanos
  const conExtornoFuera = await tx.asiento.count({ where: { empresaId, periodo, origen: { not: 'MANUAL' }, extornos: { some: { periodo: { not: periodo } } } } });
  if (conExtornoFuera) return { bloqueado: 'Hay asientos de este período extornados en un período posterior: regenere primero ese período' };
  const { count } = await tx.asiento.deleteMany({ where: { empresaId, periodo, origen: { not: 'MANUAL' } } });
  // Sin asientos en el período, la numeración vuelve a empezar
  if (!(await tx.asiento.count({ where: { empresaId, periodo } }))) {
    await tx.$executeRaw`UPDATE correlativos SET ultimo = 0 WHERE empresa_id = ${empresaId}::uuid AND tipo = ${`ASIENTO:${periodo}`}`;
  }
  return { eliminados: count, ...(await generarPeriodo(tx, { tenantId, empresaId, periodo, usuarioId })) };
}

/** Resumen del período: lo contabilizado, lo pendiente (con el motivo) y si cuadra */
export async function resumenPeriodo(tx, { empresaId, periodo }) {
  const [porOrigen, totales, pend] = await Promise.all([
    tx.asiento.groupBy({ by: ['origen'], where: { empresaId, periodo }, _count: { _all: true } }),
    tx.asiento.aggregate({ where: { empresaId, periodo }, _sum: { totalDebe: true, totalHaber: true }, _count: { _all: true } }),
    pendientesDelPeriodo(tx, empresaId, periodo),
  ]);
  const estado = await tx.periodoContable.findUnique({ where: { empresaId_periodo: { empresaId, periodo } } });
  return {
    periodo,
    cerrado: Boolean(estado?.cerrado),
    cerradoEn: estado?.cerrado ? estado.cerradoEn : null,
    asientos: totales._count._all,
    totalDebe: totales._sum.totalDebe ?? 0,
    totalHaber: totales._sum.totalHaber ?? 0,
    porOrigen: Object.fromEntries(porOrigen.map((g) => [g.origen, g._count._all])),
    sinPlan: pend.sinPlan,
    pendientes: pend.listos.map(({ clave, origen, fecha, glosa }) => ({ clave, origen, fecha, glosa })),
    errores: pend.errores,
  };
}
