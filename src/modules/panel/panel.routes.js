import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { validar } from '../../middleware/validar.js';
import { obtenerPermisos } from '../../rbac/servicio.js';
import { puedeDentroDeEmpresa, tieneAlguno, whereAlcance } from '../../rbac/resolver.js';
import { estadoCuotas, hoyLima, sumarDias } from '../../pos/reglas.js';

/**
 * Indicadores del panel de inicio. Cada bloque se calcula solo si el usuario tiene el permiso,
 * y siempre dentro de su alcance (un cajero ve las ventas de su almacén, no las de toda la empresa).
 * Los días se cuentan en hora de Perú.
 */
const router = Router();
const D = (v) => new Prisma.Decimal(v ?? 0);
/** Medianoche de Lima (UTC−5, sin horario de verano) de una fecha AAAA-MM-DD. */
const inicioDiaLima = (iso) => new Date(`${iso}T05:00:00Z`);

router.get('/', validar(z.object({ empresaId: z.uuid(), dias: z.coerce.number().int().min(7).max(31).default(14) }), 'query'), async (req, res) => {
  const { empresaId, dias } = req.validQuery;
  const permisos = await obtenerPermisos(req.user);
  const hoy = hoyLima();
  const fechas = Array.from({ length: dias }, (_, i) => sumarDias(hoy, i - dias + 1));
  const desde = inicioDiaLima(fechas[0]);
  const respuesta = { hoy, fechas };

  // ── Ventas en caja (comprobantes emitidos; las notas de crédito restan) ──
  const alcanceVentas = tieneAlguno(permisos, 'pos.venta.ver') && whereAlcance(permisos, 'pos.venta.ver', 'registro');
  if (alcanceVentas) {
    const cs = await req.db((tx) =>
      tx.comprobante.findMany({
        where: { AND: [alcanceVentas, { empresaId, estado: 'EMITIDO', fechaEmision: { gte: desde } }] },
        select: { fechaEmision: true, tipo: true, total: true, formaPago: true, montoCredito: true },
      }),
    );
    const porDia = new Map(fechas.map((f) => [f, { fecha: f, total: D(0), comprobantes: 0 }]));
    for (const c of cs) {
      const d = porDia.get(hoyLima(c.fechaEmision));
      if (!d) continue;
      const nc = c.tipo === 'NOTA_CREDITO';
      d.total = d.total.add(nc ? D(c.total).neg() : c.total);
      if (!nc) d.comprobantes += 1;
    }
    const serie = [...porDia.values()];
    const [ayer, deHoy] = serie.slice(-2);
    respuesta.ventas = {
      serie,
      hoy: deHoy.total,
      ayer: ayer.total,
      comprobantesHoy: deHoy.comprobantes,
      ticketPromedioHoy: deHoy.comprobantes ? deHoy.total.div(deHoy.comprobantes).toDecimalPlaces(2) : D(0),
      totalPeriodo: serie.reduce((s, d) => s.add(d.total), D(0)),
    };
  }

  // ── Movimientos de kardex por día (cantidad de entradas y salidas) ──
  const alcanceKardex = tieneAlguno(permisos, 'kardex.stock.ver') && whereAlcance(permisos, 'kardex.stock.ver', 'registro');
  if (alcanceKardex) {
    const ms = await req.db((tx) =>
      tx.movimiento.findMany({ where: { AND: [alcanceKardex, { empresaId, fecha: { gte: desde } }] }, select: { fecha: true, tipo: true } }),
    );
    const porDia = new Map(fechas.map((f) => [f, { fecha: f, entradas: 0, salidas: 0 }]));
    for (const m of ms) {
      const d = porDia.get(hoyLima(m.fecha));
      if (d) d[m.tipo === 'ENTRADA' ? 'entradas' : 'salidas'] += 1;
    }
    respuesta.movimientos = { serie: [...porDia.values()] };
  }

  // ── Cuentas por cobrar (recurso de toda la empresa) ──
  if (puedeDentroDeEmpresa(permisos, 'cxc.cuenta.ver', empresaId)) {
    const docs = await req.db((tx) =>
      tx.comprobante.findMany({
        where: { empresaId, estado: 'EMITIDO', formaPago: 'CREDITO', saldoPendiente: { gt: 0 } },
        select: { clienteId: true, montoCredito: true, saldoPendiente: true, cuotas: true },
      }),
    );
    let saldo = D(0);
    let vencido = D(0);
    const clientesVencidos = new Set();
    for (const d of docs) {
      saldo = saldo.add(d.saldoPendiente);
      for (const q of estadoCuotas(d.cuotas, d.montoCredito, d.saldoPendiente, hoy)) {
        if (q.vencida) {
          vencido = vencido.add(q.pendiente);
          clientesVencidos.add(d.clienteId);
        }
      }
    }
    respuesta.cxc = { saldo, vencido, clientes: new Set(docs.map((d) => d.clienteId)).size, clientesVencidos: clientesVencidos.size };
  }

  res.json(respuesta);
});

export default router;
