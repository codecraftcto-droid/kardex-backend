import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { autorizarEnEmpresa } from '../../middleware/autorizar.js';
import { validar } from '../../middleware/validar.js';
import { obtenerPermisos } from '../../rbac/servicio.js';
import { puedeDentroDeEmpresa, tieneAlguno } from '../../rbac/resolver.js';
import { auditar } from '../../services/auditoria.js';
import { emitir } from '../../realtime/socket.js';
import { paginacion, respuestaPaginada } from '../../lib/http.js';
import { textoOpcional } from '../../lib/esquemas.js';
import { noEncontrado, prohibido } from '../../lib/errors.js';
import * as pos from '../../pos/servicio.js';
import { estadoCuotas, hoyLima, montoEnLetras, tramoAntiguedad } from '../../pos/reglas.js';

/**
 * Cuentas por cobrar: deudas de clientes por ventas al crédito, estados de cuenta y cobranzas.
 * Es un recurso de TODA la empresa (como los clientes): un cliente que compró en una tienda
 * puede pagar en otra.
 */
const router = Router();
const D = (v) => new Prisma.Decimal(v ?? 0);
const uuid = /^[0-9a-f-]{36}$/i;
const empresaDeQuery = (req) => (uuid.test(req.query.empresaId || '') ? req.query.empresaId : null);
const empresaDelCliente = async (req) => {
  if (!uuid.test(req.params.id || '')) return null;
  return (await req.db((tx) => tx.cliente.findUnique({ where: { id: req.params.id }, select: { empresaId: true } })))?.empresaId ?? null;
};
const empresaDelComprobante = async (req) => {
  if (!uuid.test(req.body?.comprobanteId || '')) return null;
  return (await req.db((tx) => tx.comprobante.findUnique({ where: { id: req.body.comprobanteId }, select: { empresaId: true } })))?.empresaId ?? null;
};
const empresaDeCobranza = async (req) => {
  if (!uuid.test(req.params.id || '')) return null;
  return (await req.db((tx) => tx.cobranza.findUnique({ where: { id: req.params.id }, select: { empresaId: true } })))?.empresaId ?? null;
};
const decimal = z.union([z.string(), z.number()]).transform((v) => String(v).trim()).pipe(z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, 'Monto inválido'));
const numeroDoc = (c) => `${c.serie}-${String(c.numero).padStart(8, '0')}`;
const TRAMOS = ['porVencer', 'd1_30', 'd31_60', 'd61_90', 'd90'];

/** Documento al crédito con sus cuotas al día de hoy y su tramo de antigüedad. */
function analizar(doc, hoy) {
  const cuotas = estadoCuotas(doc.cuotas, doc.montoCredito, doc.saldoPendiente, hoy);
  const pendientes = cuotas.filter((c) => c.pendiente.gt(0));
  const diasVencido = Math.max(0, ...pendientes.map((c) => c.diasVencido));
  const vencido = pendientes.filter((c) => c.vencida).reduce((s, c) => s.add(c.pendiente), D(0));
  return { cuotas, diasVencido, vencido, proximoVencimiento: pendientes.at(0)?.fechaVencimiento ?? null, tramo: tramoAntiguedad(diasVencido) };
}

// ═════════════ Resumen por cliente (antigüedad de saldos) ═════════════

router.get(
  '/clientes',
  autorizarEnEmpresa('cxc.cuenta.ver', empresaDeQuery),
  validar(z.object({ empresaId: z.uuid(), q: z.string().trim().max(100).optional(), vencidos: z.enum(['true', 'false']).optional(), pagina: z.string().optional(), porPagina: z.string().optional() }), 'query'),
  async (req, res) => {
    const { q, vencidos } = req.validQuery;
    const pag = paginacion(req.validQuery);
    const docs = await req.db((tx) =>
      tx.comprobante.findMany({
        where: {
          empresaId: req.empresaId, estado: 'EMITIDO', formaPago: 'CREDITO', saldoPendiente: { gt: 0 },
          ...(q && { cliente: { OR: [{ nombre: { contains: q, mode: 'insensitive' } }, { numeroDocumento: { startsWith: q.toUpperCase() } }] } }),
        },
        select: {
          clienteId: true, montoCredito: true, saldoPendiente: true, cuotas: true,
          cliente: { select: { id: true, nombre: true, tipoDocumento: true, numeroDocumento: true, limiteCredito: true, telefono: true } },
        },
      }),
    );
    const hoy = hoyLima();
    const porCliente = new Map();
    const totales = { saldo: D(0), vencido: D(0), ...Object.fromEntries(TRAMOS.map((t) => [t, D(0)])) };
    for (const d of docs) {
      const a = analizar(d, hoy);
      const x = porCliente.get(d.clienteId) ?? { ...d.cliente, documentos: 0, saldo: D(0), vencido: D(0), diasVencido: 0, proximoVencimiento: null, ...Object.fromEntries(TRAMOS.map((t) => [t, D(0)])) };
      x.documentos += 1;
      x.saldo = x.saldo.add(d.saldoPendiente);
      x.vencido = x.vencido.add(a.vencido);
      x.diasVencido = Math.max(x.diasVencido, a.diasVencido);
      // Cada cuota pendiente cae en su propio tramo de antigüedad
      for (const c of a.cuotas.filter((k) => k.pendiente.gt(0))) {
        const t = tramoAntiguedad(c.diasVencido);
        x[t] = x[t].add(c.pendiente);
        totales[t] = totales[t].add(c.pendiente);
        if (!c.vencida && (!x.proximoVencimiento || c.fechaVencimiento < x.proximoVencimiento)) x.proximoVencimiento = c.fechaVencimiento;
      }
      totales.saldo = totales.saldo.add(d.saldoPendiente);
      totales.vencido = totales.vencido.add(a.vencido);
      porCliente.set(d.clienteId, x);
    }
    let filas = [...porCliente.values()];
    if (vencidos === 'true') filas = filas.filter((f) => f.vencido.gt(0));
    // Primero los más atrasados, luego los de mayor saldo
    filas.sort((a, b) => b.diasVencido - a.diasVencido || b.saldo.cmp(a.saldo));
    res.json({ ...respuestaPaginada(filas.slice(pag.skip, pag.skip + pag.take), filas.length, pag), totales });
  },
);

// ═════════════ Estado de cuenta de un cliente ═════════════

router.get(
  '/clientes/:id',
  autorizarEnEmpresa('cxc.cuenta.ver', empresaDelCliente),
  validar(z.object({ todos: z.enum(['true', 'false']).optional() }), 'query'),
  async (req, res) => {
    const todos = req.validQuery.todos === 'true';
    const datos = await req.db(async (tx) => {
      const cliente = await tx.cliente.findUnique({ where: { id: req.params.id }, include: { empresa: { select: { razonSocial: true, nombreComercial: true, ruc: true, direccion: true } } } });
      const documentos = await tx.comprobante.findMany({
        where: { clienteId: cliente.id, formaPago: 'CREDITO', estado: 'EMITIDO', ...(!todos && { saldoPendiente: { gt: 0 } }) },
        include: {
          cuotas: true,
          cobranzas: { where: { estado: 'VIGENTE' }, select: { id: true, numero: true, fecha: true, medio: true, monto: true } },
          notasCredito: { where: { estado: 'EMITIDO', aplicadoASaldo: { gt: 0 } }, select: { id: true, serie: true, numero: true, fechaEmision: true, aplicadoASaldo: true } },
        },
        orderBy: { fechaEmision: 'asc' },
      });
      const cobranzas = await tx.cobranza.findMany({
        where: { clienteId: cliente.id },
        include: { comprobante: { select: { serie: true, numero: true } } },
        orderBy: { numero: 'desc' },
        take: 100,
      });
      return { cliente, documentos, cobranzas };
    });
    const hoy = hoyLima();
    const documentos = datos.documentos.map((d) => {
      const a = analizar(d, hoy);
      return {
        id: d.id, tipo: d.tipo, serie: d.serie, numero: d.numero, numeroCompleto: numeroDoc(d), fechaEmision: d.fechaEmision,
        total: d.total, montoCredito: d.montoCredito, saldoPendiente: d.saldoPendiente, inicial: D(d.total).sub(d.montoCredito),
        cuotas: a.cuotas, diasVencido: a.diasVencido, vencido: a.vencido, proximoVencimiento: a.proximoVencimiento,
        cobranzas: d.cobranzas, notasCredito: d.notasCredito,
      };
    });
    // Movimientos de la cuenta, en orden: cargos (crédito otorgado) y abonos (cobranzas y notas de crédito)
    const movs = [];
    for (const d of documentos) {
      movs.push({ fecha: d.fechaEmision, concepto: `Venta al crédito ${d.numeroCompleto}`, comprobanteId: d.id, cargo: D(d.montoCredito), abono: D(0) });
      for (const k of d.cobranzas) movs.push({ fecha: k.fecha, concepto: `Cobranza Nº ${k.numero} · ${d.numeroCompleto}`, cobranzaId: k.id, cargo: D(0), abono: D(k.monto) });
      for (const n of d.notasCredito) movs.push({ fecha: n.fechaEmision, concepto: `Nota de crédito ${numeroDoc(n)} · ${d.numeroCompleto}`, comprobanteId: n.id, cargo: D(0), abono: D(n.aplicadoASaldo) });
    }
    movs.sort((a, b) => a.fecha - b.fecha);
    let saldo = D(0);
    const movimientos = movs.map((m) => ({ ...m, saldo: (saldo = saldo.add(m.cargo).sub(m.abono)) }));

    const { cliente } = datos;
    const deuda = documentos.reduce((s, d) => s.add(d.saldoPendiente), D(0));
    const vencido = documentos.reduce((s, d) => s.add(d.vencido), D(0));
    res.json({
      cliente: { ...cliente, empresa: undefined },
      empresa: cliente.empresa,
      resumen: {
        deuda, vencido, porVencer: deuda.sub(vencido),
        limite: cliente.limiteCredito, disponible: cliente.limiteCredito != null ? Prisma.Decimal.max(D(cliente.limiteCredito).sub(deuda), 0) : null,
        deudaEnLetras: montoEnLetras(deuda),
      },
      documentos: documentos.filter((d) => todos || D(d.saldoPendiente).gt(0)),
      movimientos,
      cobranzas: datos.cobranzas.map((k) => ({ ...k, comprobante: numeroDoc(k.comprobante) })),
      fecha: hoy,
      acciones: {
        cobrar: puedeDentroDeEmpresa(req.permisos, 'cxc.cobranza.crear', cliente.empresaId),
        anular: puedeDentroDeEmpresa(req.permisos, 'cxc.cobranza.anular', cliente.empresaId),
      },
    });
  },
);

/**
 * Crédito disponible del cliente, para la caja (lo usa quien vende al crédito aunque no
 * vea las cuentas por cobrar).
 */
router.get('/clientes/:id/credito', async (req, res) => {
  const empresaId = await empresaDelCliente(req);
  const perms = await obtenerPermisos(req.user);
  if (!tieneAlguno(perms, 'pos.venta.credito') && !tieneAlguno(perms, 'cxc.cuenta.ver')) throw prohibido();
  if (!empresaId || !(puedeDentroDeEmpresa(perms, 'pos.venta.credito', empresaId) || puedeDentroDeEmpresa(perms, 'cxc.cuenta.ver', empresaId))) throw noEncontrado();
  const r = await req.db(async (tx) => {
    const c = await tx.cliente.findUnique({ where: { id: req.params.id }, select: { creditoHabilitado: true, limiteCredito: true, diasCredito: true } });
    return { ...c, ...(await pos.deudaCliente(tx, req.params.id)) };
  });
  res.json({ ...r, disponible: r.limiteCredito != null ? Prisma.Decimal.max(D(r.limiteCredito).sub(r.deuda), 0) : null });
});

// ═════════════ Cobranzas ═════════════

router.get(
  '/cobranzas',
  autorizarEnEmpresa('cxc.cuenta.ver', empresaDeQuery),
  validar(
    z.object({
      empresaId: z.uuid(), clienteId: z.uuid().optional(), sesionCajaId: z.uuid().optional(), estado: z.enum(['VIGENTE', 'ANULADA']).optional(),
      desde: z.coerce.date().optional(), hasta: z.coerce.date().optional(), pagina: z.string().optional(), porPagina: z.string().optional(),
    }),
    'query',
  ),
  async (req, res) => {
    const { clienteId, sesionCajaId, estado, desde, hasta } = req.validQuery;
    const pag = paginacion(req.validQuery);
    const where = {
      empresaId: req.empresaId, ...(clienteId && { clienteId }), ...(sesionCajaId && { sesionCajaId }), ...(estado && { estado }),
      ...((desde || hasta) && { fecha: { ...(desde && { gte: desde }), ...(hasta && { lte: hasta }) } }),
    };
    const [datos, total] = await req.db((tx) =>
      Promise.all([
        tx.cobranza.findMany({
          where, orderBy: { numero: 'desc' }, skip: pag.skip, take: pag.take,
          include: { cliente: { select: { nombre: true } }, comprobante: { select: { id: true, serie: true, numero: true } } },
        }),
        tx.cobranza.count({ where }),
      ]),
    );
    res.json(respuestaPaginada(datos, total, pag));
  },
);

/** Recibo de cobranza (para imprimir). El saldo "después" se reconstruye a la fecha del cobro. */
router.get('/cobranzas/:id', autorizarEnEmpresa('cxc.cuenta.ver', empresaDeCobranza), async (req, res) => {
  const k = await req.db((tx) =>
    tx.cobranza.findUnique({
      where: { id: req.params.id },
      include: {
        empresa: { select: { razonSocial: true, nombreComercial: true, ruc: true, direccion: true } },
        cliente: { select: { nombre: true, tipoDocumento: true, numeroDocumento: true, direccion: true } },
        comprobante: {
          select: {
            id: true, tipo: true, serie: true, numero: true, fechaEmision: true, total: true, montoCredito: true,
            cuotas: { orderBy: { numero: 'asc' } },
            cobranzas: { where: { estado: 'VIGENTE' }, select: { numero: true, monto: true } },
            notasCredito: { where: { estado: 'EMITIDO' }, select: { fechaEmision: true, aplicadoASaldo: true } },
          },
        },
      },
    }),
  );
  const usuario = await req.db((tx) => tx.usuario.findUnique({ where: { id: k.usuarioId }, select: { nombres: true } }));
  const c = k.comprobante;
  const abonado = c.cobranzas.filter((x) => x.numero <= k.numero).reduce((s, x) => s.add(x.monto), D(0))
    .add(c.notasCredito.filter((n) => n.fechaEmision <= k.fecha).reduce((s, n) => s.add(n.aplicadoASaldo), D(0)));
  const saldoDespues = Prisma.Decimal.max(D(c.montoCredito).sub(abonado), 0);
  // Cuotas que cubrió ESTE pago: lo abonado antes se aplica primero (en orden), luego este monto
  let antes = abonado.sub(k.monto);
  let resto = D(k.monto);
  const cuotasPagadas = [];
  for (const q of c.cuotas) {
    const yaPagado = Prisma.Decimal.min(D(q.monto), Prisma.Decimal.max(antes, 0));
    antes = antes.sub(yaPagado);
    const debe = D(q.monto).sub(yaPagado);
    if (debe.lte(0) || resto.lte(0)) continue;
    const paga = Prisma.Decimal.min(debe, resto);
    resto = resto.sub(paga);
    cuotasPagadas.push({ numero: q.numero, total: c.cuotas.length, fechaVencimiento: q.fechaVencimiento.toISOString().slice(0, 10), paga, queda: debe.sub(paga) });
  }
  res.json({
    ...k,
    comprobante: { id: c.id, tipo: c.tipo, numeroCompleto: numeroDoc(c), fechaEmision: c.fechaEmision, total: c.total, montoCredito: c.montoCredito },
    cuotasPagadas: k.estado === 'VIGENTE' ? cuotasPagadas : [],
    saldoAnterior: k.estado === 'VIGENTE' ? saldoDespues.add(k.monto) : null,
    saldoDespues: k.estado === 'VIGENTE' ? saldoDespues : null,
    montoEnLetras: montoEnLetras(k.monto),
    usuario: usuario?.nombres,
    acciones: { anular: k.estado === 'VIGENTE' && puedeDentroDeEmpresa(req.permisos, 'cxc.cobranza.anular', k.empresaId) },
  });
});

router.post(
  '/cobranzas',
  autorizarEnEmpresa('cxc.cobranza.crear', empresaDelComprobante),
  validar(
    z.object({
      comprobanteId: z.uuid(), monto: decimal, medio: z.enum(['EFECTIVO', 'TARJETA', 'YAPE', 'PLIN', 'TRANSFERENCIA', 'OTRO']),
      referencia: textoOpcional(60), observacion: textoOpcional(300), cajaId: z.uuid().nullish(),
    }),
  ),
  async (req, res) => {
    const r = await req.db(async (tx) => {
      const x = await pos.registrarCobranza(tx, { ...req.body, tenantId: req.tenantId, usuarioId: req.user.id });
      await auditar(tx, req, {
        modulo: 'cxc', accion: 'cobranza.registrar', recurso: 'cobranza', recursoId: x.cobranza.id, empresaId: req.empresaId,
        despues: { numero: x.cobranza.numero, comprobante: numeroDoc(x.comprobante), monto: x.cobranza.monto, medio: x.cobranza.medio, saldo: x.comprobante.saldoPendiente },
      });
      return x;
    });
    emitir('cxc:cambio', { empresaId: req.empresaId }, { clienteId: r.cobranza.clienteId });
    if (r.cobranza.sesionCajaId) emitir('pos:turno', { almacenId: r.almacenId }, { cobranza: r.cobranza.id });
    res.status(201).json({ ...r.cobranza, saldoPendiente: r.comprobante.saldoPendiente });
  },
);

router.post(
  '/cobranzas/:id/anular',
  autorizarEnEmpresa('cxc.cobranza.anular', empresaDeCobranza),
  validar(z.object({ motivo: z.string().trim().min(5, 'Indique el motivo').max(300) })),
  async (req, res) => {
    const k = await req.db(async (tx) => {
      const x = await pos.anularCobranza(tx, { cobranzaId: req.params.id, usuarioId: req.user.id, motivo: req.body.motivo });
      await auditar(tx, req, {
        modulo: 'cxc', accion: 'cobranza.anular', recurso: 'cobranza', recursoId: x.id, empresaId: x.empresaId,
        antes: { estado: 'VIGENTE', monto: x.monto }, despues: { estado: 'ANULADA', motivo: req.body.motivo },
      });
      return x;
    });
    emitir('cxc:cambio', { empresaId: k.empresaId }, { clienteId: k.clienteId });
    res.json({ id: k.id, estado: k.estado });
  },
);

export default router;
