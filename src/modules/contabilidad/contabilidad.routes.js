import { Router } from 'express';
import { z } from 'zod';
import { autorizarEnEmpresa } from '../../middleware/autorizar.js';
import { validar } from '../../middleware/validar.js';
import { puedeDentroDeEmpresa } from '../../rbac/resolver.js';
import { auditar } from '../../services/auditoria.js';
import { conflicto, noEncontrado, solicitudInvalida } from '../../lib/errors.js';
import { paginacion, respuestaPaginada } from '../../lib/http.js';
import { esPeriodo, etiquetaPeriodo, periodoActual } from '../../sire/periodos.js';
import { generarPeriodo, regenerarPeriodo, resumenPeriodo } from '../../contabilidad/asientos.js';
import { cerrarPeriodo, crearManual, editarManual, eliminarManual, periodoCerrado, reabrirPeriodo } from '../../contabilidad/manual.js';
import { libroDiario, mayorCuenta, mayorResumen } from '../../contabilidad/libros.js';
import { excelDiario, excelEstados, excelMayor } from '../../contabilidad/excel.js';
import { cerrarEjercicio, estadoResultados, hojaDeTrabajo, situacionFinanciera } from '../../contabilidad/estados.js';
import { ELEMENTOS } from '../../contabilidad/reglas.js';
import { cargarBase, copiarPlan, crearCuenta, editarCuenta, eliminarCuenta, guardarConfig, listarPlan, obtenerConfig } from '../../contabilidad/servicio.js';

/**
 * Contabilidad (Fase 3A): plan contable de cada empresa y cuentas por operación.
 * El plan es de la empresa: los permisos se evalúan dentro de ella.
 */
const router = Router();
const uuid = /^[0-9a-f-]{36}$/i;
const empresaDe = (origen) => (req) => {
  const v = origen === 'query' ? req.query.empresaId : req.body?.empresaId;
  return uuid.test(v || '') ? v : null;
};
const audit = (req, tx, accion, recursoId, extra) =>
  auditar(tx, req, { modulo: 'contabilidad', accion, recurso: 'cuenta', recursoId, empresaId: req.empresaId, ...extra });

// ───────────── Plan contable ─────────────

router.get('/plan', autorizarEnEmpresa('contabilidad.plan.ver', empresaDe('query')), async (req, res) => {
  const cuentas = await req.db((tx) => listarPlan(tx, req.empresaId));
  res.json({
    cuentas, elementos: ELEMENTOS,
    acciones: {
      editar: puedeDentroDeEmpresa(req.permisos, 'contabilidad.plan.editar', req.empresaId),
      configurar: puedeDentroDeEmpresa(req.permisos, 'contabilidad.configuracion.editar', req.empresaId),
    },
  });
});

router.post('/plan/cargar-base', autorizarEnEmpresa('contabilidad.plan.editar', empresaDe('body')), async (req, res) => {
  const n = await req.db(async (tx) => {
    const total = await cargarBase(tx, { tenantId: req.tenantId, empresaId: req.empresaId });
    await audit(req, tx, 'plan.cargar_base', req.empresaId, { recurso: 'empresa', despues: { cuentas: total } });
    return total;
  });
  res.status(201).json({ cuentas: n });
});

router.post(
  '/plan/copiar',
  autorizarEnEmpresa('contabilidad.plan.editar', empresaDe('body')),
  validar(z.object({ empresaId: z.uuid(), desdeEmpresaId: z.uuid() })),
  async (req, res) => {
    // También debe poder ver el plan de la empresa de origen
    if (!puedeDentroDeEmpresa(req.permisos, 'contabilidad.plan.ver', req.body.desdeEmpresaId)) throw noEncontrado('Empresa de origen no encontrada');
    const n = await req.db(async (tx) => {
      const total = await copiarPlan(tx, { tenantId: req.tenantId, empresaId: req.empresaId, desdeEmpresaId: req.body.desdeEmpresaId });
      await audit(req, tx, 'plan.copiar', req.empresaId, { recurso: 'empresa', despues: { desdeEmpresaId: req.body.desdeEmpresaId, cuentas: total } });
      return total;
    });
    res.status(201).json({ cuentas: n });
  },
);

const destino = z.string().trim().regex(/^\d{2,10}$/).nullish().or(z.literal('')).transform((v) => v || null);
const esquemaCuenta = z.object({
  empresaId: z.uuid(),
  nombre: z.string().trim().min(2).max(150),
  naturaleza: z.enum(['DEUDORA', 'ACREEDORA']).optional(),
  pideTercero: z.boolean().optional(),
  destinoDebe: destino,
  destinoHaber: destino,
});

router.post(
  '/plan/cuentas',
  autorizarEnEmpresa('contabilidad.plan.editar', empresaDe('body')),
  validar(esquemaCuenta.extend({ codigo: z.string().trim().regex(/^\d{2,10}$/, 'El código tiene de 2 a 10 dígitos') })),
  async (req, res) => {
    const c = await req.db(async (tx) => {
      const nueva = await crearCuenta(tx, { tenantId: req.tenantId, empresaId: req.empresaId, datos: req.body });
      await audit(req, tx, 'cuenta.crear', nueva.codigo, { despues: nueva });
      return nueva;
    });
    res.status(201).json(c);
  },
);

router.put(
  '/plan/cuentas/:id',
  autorizarEnEmpresa('contabilidad.plan.editar', empresaDe('body')),
  validar(esquemaCuenta.extend({ activo: z.boolean().default(true) })),
  async (req, res) => {
    if (!uuid.test(req.params.id)) throw noEncontrado();
    const c = await req.db(async (tx) => {
      const antes = await tx.cuentaContable.findUnique({ where: { id: req.params.id } });
      const x = await editarCuenta(tx, { empresaId: req.empresaId, id: req.params.id, datos: req.body });
      await audit(req, tx, 'cuenta.editar', x.codigo, { antes, despues: x });
      return x;
    });
    res.json(c);
  },
);

router.delete('/plan/cuentas/:id', autorizarEnEmpresa('contabilidad.plan.editar', empresaDe('query')), async (req, res) => {
  if (!uuid.test(req.params.id)) throw noEncontrado();
  await req.db(async (tx) => {
    const c = await eliminarCuenta(tx, { empresaId: req.empresaId, id: req.params.id });
    await audit(req, tx, 'cuenta.eliminar', c.codigo, { antes: c });
  });
  res.status(204).end();
});

// ───────────── Cuentas por operación ─────────────

router.get('/configuracion', autorizarEnEmpresa('contabilidad.plan.ver', empresaDe('query')), async (req, res) => {
  const cfg = await req.db((tx) => obtenerConfig(tx, req.empresaId));
  res.json({ ...cfg, acciones: { editar: puedeDentroDeEmpresa(req.permisos, 'contabilidad.configuracion.editar', req.empresaId) } });
});

router.put(
  '/configuracion',
  autorizarEnEmpresa('contabilidad.configuracion.editar', empresaDe('body')),
  validar(z.object({ empresaId: z.uuid(), cuentas: z.record(z.string(), z.string().trim().regex(/^\d{2,10}$/).nullable().or(z.literal(''))) })),
  async (req, res) => {
    const cfg = await req.db(async (tx) => {
      const antes = await tx.configContable.findUnique({ where: { empresaId: req.empresaId } });
      const c = await guardarConfig(tx, { tenantId: req.tenantId, empresaId: req.empresaId, cuentas: req.body.cuentas });
      await audit(req, tx, 'configuracion.editar', req.empresaId, { recurso: 'empresa', antes: antes?.cuentas ?? null, despues: c.cuentas });
      return obtenerConfig(tx, req.empresaId);
    });
    res.json(cfg);
  },
);

// ───────────── Asientos ─────────────

const periodoDe = (v) => {
  const p = v || periodoActual();
  if (!esPeriodo(p) || p > periodoActual()) throw solicitudInvalida('Período inválido');
  return p;
};
const ORIGENES = ['VENTA', 'COBRO', 'NOTA_CREDITO', 'REEMBOLSO', 'COBRANZA', 'COMPRA', 'VENTA_COMERCIAL', 'COSTO_VENTA', 'MANUAL'];

router.get('/asientos/resumen', autorizarEnEmpresa('contabilidad.asiento.ver', empresaDe('query')), async (req, res) => {
  const periodo = periodoDe(req.query.periodo);
  const r = await req.db((tx) => resumenPeriodo(tx, { empresaId: req.empresaId, periodo }), { timeout: 30_000 });
  const puede = (c) => puedeDentroDeEmpresa(req.permisos, c, req.empresaId);
  res.json({
    ...r, etiqueta: etiquetaPeriodo(periodo),
    acciones: {
      generar: !r.cerrado && puede('contabilidad.asiento.generar'),
      registrar: !r.cerrado && !r.sinPlan && puede('contabilidad.asiento.registrar'),
      cerrar: !r.cerrado && puede('contabilidad.periodo.cerrar'),
      reabrir: r.cerrado && puede('contabilidad.periodo.reabrir'),
    },
  });
});

for (const [ruta, fn, accion] of [['generar', generarPeriodo, 'periodo.contabilizar'], ['regenerar', regenerarPeriodo, 'periodo.regenerar']]) {
  router.post(`/asientos/${ruta}`, autorizarEnEmpresa('contabilidad.asiento.generar', empresaDe('body')), async (req, res) => {
    const periodo = periodoDe(req.body.periodo);
    const r = await req.db(async (tx) => {
      const x = await fn(tx, { tenantId: req.tenantId, empresaId: req.empresaId, periodo, usuarioId: req.user.id });
      if (x.bloqueado) throw conflicto(x.bloqueado);
      await auditar(tx, req, {
        modulo: 'contabilidad', accion, recurso: 'periodo', recursoId: periodo, empresaId: req.empresaId,
        despues: { creados: x.creados, eliminados: x.eliminados, errores: x.errores.length },
      });
      return x;
    }, { timeout: 120_000 });
    res.json(r);
  });
}

const esquemaLista = z.object({
  empresaId: z.uuid(),
  periodo: z.string().optional(),
  origen: z.enum(ORIGENES).optional().or(z.literal('')).transform((v) => v || undefined),
  q: z.string().trim().max(100).optional(),
});

router.get('/asientos', autorizarEnEmpresa('contabilidad.asiento.ver', empresaDe('query')), validar(esquemaLista, 'query'), async (req, res) => {
  const periodo = periodoDe(req.validQuery.periodo);
  const pag = paginacion(req.query);
  const { origen, q } = req.validQuery;
  const where = {
    empresaId: req.empresaId, periodo, ...(origen && { origen }),
    ...(q && { OR: [{ glosa: { contains: q, mode: 'insensitive' } }, { lineas: { some: { cuenta: { startsWith: q } } } }, ...(/^\d+$/.test(q) ? [{ numero: Number(q) }] : [])] }),
  };
  const [datos, total] = await req.db((tx) => Promise.all([
    tx.asiento.findMany({ where, orderBy: [{ numero: 'asc' }], skip: pag.skip, take: pag.take, select: { id: true, numero: true, fecha: true, glosa: true, origen: true, totalDebe: true, extornoDeId: true, _count: { select: { lineas: true } } } }),
    tx.asiento.count({ where }),
  ]));
  res.json(respuestaPaginada(datos.map((a) => ({ ...a, fecha: a.fecha.toISOString().slice(0, 10) })), total, pag));
});

router.get('/asientos/:id', autorizarEnEmpresa('contabilidad.asiento.ver', empresaDe('query')), async (req, res) => {
  if (!uuid.test(req.params.id)) throw noEncontrado();
  const r = await req.db(async (tx) => {
    const a = await tx.asiento.findUnique({ where: { id: req.params.id }, include: { lineas: { orderBy: { orden: 'asc' } }, extornoDe: { select: { id: true, numero: true, periodo: true } }, extornos: { select: { id: true, numero: true, periodo: true } } } });
    if (!a || a.empresaId !== req.empresaId) throw noEncontrado('Asiento no encontrado');
    const cuentas = new Map((await tx.cuentaContable.findMany({ where: { empresaId: req.empresaId, codigo: { in: a.lineas.map((l) => l.cuenta) } }, select: { codigo: true, nombre: true } })).map((c) => [c.codigo, c.nombre]));
    const documento = a.documentoId ? await tx.documentoComercial.findUnique({ where: { id: a.documentoId }, select: { tipo: true } }) : null;
    // Enlace a la operación de origen
    const origen = a.comprobanteId ? { texto: 'Ver comprobante', ruta: `/comprobantes/${a.comprobanteId}` }
      : a.documentoId ? { texto: documento?.tipo === 'COMPRA' ? 'Ver compra' : 'Ver venta', ruta: `/${documento?.tipo === 'COMPRA' ? 'compras' : 'ventas'}/${a.documentoId}` }
        : a.movimientoId ? { texto: 'Ver movimiento de kardex', ruta: `/movimientos?movimiento=${a.movimientoId}` } : null;
    const editable = a.origen === 'MANUAL' && !(await periodoCerrado(tx, req.empresaId, a.periodo)) && puedeDentroDeEmpresa(req.permisos, 'contabilidad.asiento.registrar', req.empresaId);
    return { ...a, fecha: a.fecha.toISOString().slice(0, 10), lineas: a.lineas.map((l) => ({ ...l, cuentaNombre: cuentas.get(l.cuenta) ?? null })), enlace: origen, editable };
  });
  res.json(r);
});

// ───────────── Asientos manuales ─────────────

const importe = z.union([z.string(), z.number()]).transform((v) => (v === '' || v == null ? 0 : Number(v))).pipe(z.number().min(0).max(1e12));
const esquemaManual = z.object({
  empresaId: z.uuid(),
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha AAAA-MM-DD'),
  glosa: z.string().trim().min(3, 'Escriba la glosa').max(300),
  lineas: z.array(z.object({
    cuenta: z.string().trim().regex(/^\d{2,10}$/, 'Cuenta inválida'),
    debe: importe.optional(), haber: importe.optional(),
    glosa: z.string().trim().max(200).nullish(),
    terceroDoc: z.string().trim().max(20).nullish(), terceroNombre: z.string().trim().max(200).nullish(),
    docSerie: z.string().trim().max(20).nullish(), docNumero: z.string().trim().max(20).nullish(),
  })).min(2, 'El asiento necesita al menos dos líneas').max(200),
});

router.post('/asientos/manual', autorizarEnEmpresa('contabilidad.asiento.registrar', empresaDe('body')), validar(esquemaManual), async (req, res) => {
  const a = await req.db(async (tx) => {
    const x = await crearManual(tx, { tenantId: req.tenantId, empresaId: req.empresaId, usuarioId: req.user.id, datos: req.body });
    await auditar(tx, req, { modulo: 'contabilidad', accion: 'asiento.registrar', recurso: 'asiento', recursoId: x.id, empresaId: req.empresaId, despues: { periodo: x.periodo, numero: x.numero, glosa: x.glosa, total: x.totalDebe } });
    return x;
  });
  res.status(201).json({ id: a.id, periodo: a.periodo, numero: a.numero });
});

router.put('/asientos/manual/:id', autorizarEnEmpresa('contabilidad.asiento.registrar', empresaDe('body')), validar(esquemaManual), async (req, res) => {
  if (!uuid.test(req.params.id)) throw noEncontrado();
  const a = await req.db(async (tx) => {
    const { antes, despues } = await editarManual(tx, { tenantId: req.tenantId, empresaId: req.empresaId, usuarioId: req.user.id, id: req.params.id, datos: req.body });
    await auditar(tx, req, {
      modulo: 'contabilidad', accion: 'asiento.editar', recurso: 'asiento', recursoId: despues.id, empresaId: req.empresaId,
      antes: { id: antes.id, periodo: antes.periodo, numero: antes.numero, glosa: antes.glosa, total: antes.totalDebe }, despues: { periodo: despues.periodo, numero: despues.numero, glosa: despues.glosa, total: despues.totalDebe },
    });
    return despues;
  });
  res.json({ id: a.id, periodo: a.periodo, numero: a.numero });
});

router.delete('/asientos/manual/:id', autorizarEnEmpresa('contabilidad.asiento.registrar', empresaDe('query')), async (req, res) => {
  if (!uuid.test(req.params.id)) throw noEncontrado();
  await req.db(async (tx) => {
    const a = await eliminarManual(tx, { empresaId: req.empresaId, id: req.params.id });
    await auditar(tx, req, { modulo: 'contabilidad', accion: 'asiento.eliminar', recurso: 'asiento', recursoId: a.id, empresaId: req.empresaId, antes: { periodo: a.periodo, numero: a.numero, glosa: a.glosa, total: a.totalDebe } });
  });
  res.status(204).end();
});

// ───────────── Cierre de período ─────────────

router.post('/periodos/cerrar', autorizarEnEmpresa('contabilidad.periodo.cerrar', empresaDe('body')), async (req, res) => {
  const periodo = periodoDe(req.body.periodo);
  const p = await req.db(async (tx) => {
    const x = await cerrarPeriodo(tx, { tenantId: req.tenantId, empresaId: req.empresaId, periodo, usuarioId: req.user.id });
    await auditar(tx, req, { modulo: 'contabilidad', accion: 'periodo.cerrar', recurso: 'periodo', recursoId: periodo, empresaId: req.empresaId });
    return x;
  }, { timeout: 30_000 });
  res.json({ periodo: p.periodo, cerrado: p.cerrado, cerradoEn: p.cerradoEn });
});

router.post(
  '/periodos/reabrir',
  autorizarEnEmpresa('contabilidad.periodo.reabrir', empresaDe('body')),
  validar(z.object({ empresaId: z.uuid(), periodo: z.string(), motivo: z.string().trim().min(5, 'Indique el motivo de la reapertura').max(300) })),
  async (req, res) => {
    const periodo = periodoDe(req.body.periodo);
    const p = await req.db(async (tx) => {
      const x = await reabrirPeriodo(tx, { empresaId: req.empresaId, periodo, motivo: req.body.motivo });
      await auditar(tx, req, { modulo: 'contabilidad', accion: 'periodo.reabrir', recurso: 'periodo', recursoId: periodo, empresaId: req.empresaId, despues: { motivo: req.body.motivo } });
      return x;
    });
    res.json({ periodo: p.periodo, cerrado: p.cerrado });
  },
);

// ───────────── Libros Diario y Mayor ─────────────

const empresaYPeriodo = async (req) => ({
  empresa: await req.db((tx) => tx.empresa.findUnique({ where: { id: req.empresaId }, select: { razonSocial: true, ruc: true } })),
  periodo: periodoDe(req.query.periodo),
});
const enviarExcel = (res, buffer, nombre) => {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
  res.send(Buffer.from(buffer));
};

router.get('/libros/diario', autorizarEnEmpresa('contabilidad.asiento.ver', empresaDe('query')), async (req, res) => {
  const periodo = periodoDe(req.query.periodo);
  const pag = paginacion(req.query, { maxPorPagina: 100 });
  const r = await req.db((tx) => libroDiario(tx, { empresaId: req.empresaId, periodo, skip: pag.skip, take: pag.take }));
  res.json({ ...respuestaPaginada(r.asientos, r.total, pag), totales: r.totales, etiqueta: etiquetaPeriodo(periodo) });
});

router.get('/libros/diario/excel', autorizarEnEmpresa('contabilidad.asiento.ver', empresaDe('query')), async (req, res) => {
  const { empresa, periodo } = await empresaYPeriodo(req);
  const r = await req.db((tx) => libroDiario(tx, { empresaId: req.empresaId, periodo, take: 100_000 }), { timeout: 60_000 });
  enviarExcel(res, await excelDiario({ empresa, etiqueta: etiquetaPeriodo(periodo), asientos: r.asientos, totales: r.totales }), `libro-diario-${empresa.ruc}-${periodo}.xlsx`);
});

router.get('/libros/mayor', autorizarEnEmpresa('contabilidad.asiento.ver', empresaDe('query')), async (req, res) => {
  const periodo = periodoDe(req.query.periodo);
  const r = await req.db((tx) => mayorResumen(tx, { empresaId: req.empresaId, periodo }));
  res.json({ ...r, etiqueta: etiquetaPeriodo(periodo) });
});

router.get('/libros/mayor/cuenta', autorizarEnEmpresa('contabilidad.asiento.ver', empresaDe('query')), async (req, res) => {
  const periodo = periodoDe(req.query.periodo);
  if (!/^\d{2,10}$/.test(req.query.cuenta ?? '')) throw solicitudInvalida('Cuenta inválida');
  res.json(await req.db((tx) => mayorCuenta(tx, { empresaId: req.empresaId, periodo, cuenta: req.query.cuenta })));
});

router.get('/libros/mayor/excel', autorizarEnEmpresa('contabilidad.asiento.ver', empresaDe('query')), async (req, res) => {
  const { empresa, periodo } = await empresaYPeriodo(req);
  const { resumen, detalles } = await req.db(async (tx) => {
    const resumen = await mayorResumen(tx, { empresaId: req.empresaId, periodo });
    const detalles = [];
    for (const c of resumen.cuentas) detalles.push(await mayorCuenta(tx, { empresaId: req.empresaId, periodo, cuenta: c.cuenta }));
    return { resumen, detalles };
  }, { timeout: 60_000 });
  enviarExcel(res, await excelMayor({ empresa, etiqueta: etiquetaPeriodo(periodo), resumen, detalles }), `libro-mayor-${empresa.ruc}-${periodo}.xlsx`);
});

// ───────────── Estados financieros ─────────────

router.get('/estados', autorizarEnEmpresa('contabilidad.estados.ver', empresaDe('query')), async (req, res) => {
  const periodo = periodoDe(req.query.periodo);
  const nivel = req.query.nivel === 'detalle' ? 'detalle' : 2;
  const anio = periodo.slice(0, 4);
  const r = await req.db(async (tx) => ({
    situacion: await situacionFinanciera(tx, { empresaId: req.empresaId, periodo }),
    resultados: await estadoResultados(tx, { empresaId: req.empresaId, periodo }),
    hoja: await hojaDeTrabajo(tx, { empresaId: req.empresaId, periodo, nivel }),
    cierre: await tx.asiento.findUnique({ where: { empresaId_clave: { empresaId: req.empresaId, clave: `CIERRE:${anio}` } }, select: { id: true, numero: true, glosa: true, creadoEn: true } }),
    diciembreCerrado: await periodoCerrado(tx, req.empresaId, `${anio}12`),
  }), { timeout: 30_000 });
  res.json({
    ...r, periodo, etiqueta: etiquetaPeriodo(periodo), anio: Number(anio),
    acciones: {
      // El cierre del ejercicio se genera desde diciembre (y diciembre debe estar abierto)
      cerrarEjercicio: periodo.endsWith('12') && !r.diciembreCerrado && puedeDentroDeEmpresa(req.permisos, 'contabilidad.ejercicio.cerrar', req.empresaId),
    },
  });
});

router.get('/estados/excel', autorizarEnEmpresa('contabilidad.estados.ver', empresaDe('query')), async (req, res) => {
  const { empresa, periodo } = await empresaYPeriodo(req);
  const datos = await req.db(async (tx) => ({
    situacion: await situacionFinanciera(tx, { empresaId: req.empresaId, periodo }),
    resultados: await estadoResultados(tx, { empresaId: req.empresaId, periodo }),
    hoja: await hojaDeTrabajo(tx, { empresaId: req.empresaId, periodo }),
  }), { timeout: 30_000 });
  enviarExcel(res, await excelEstados({ empresa, etiqueta: etiquetaPeriodo(periodo), ...datos }), `estados-financieros-${empresa.ruc}-${periodo}.xlsx`);
});

router.post(
  '/cierre-ejercicio',
  autorizarEnEmpresa('contabilidad.ejercicio.cerrar', empresaDe('body')),
  validar(z.object({ empresaId: z.uuid(), anio: z.coerce.number().int().min(2000).max(2100) })),
  async (req, res) => {
    if (`${req.body.anio}12` > periodoActual()) throw solicitudInvalida('El ejercicio aún no termina');
    const r = await req.db(async (tx) => {
      const x = await cerrarEjercicio(tx, { tenantId: req.tenantId, empresaId: req.empresaId, anio: req.body.anio, usuarioId: req.user.id });
      await auditar(tx, req, {
        modulo: 'contabilidad', accion: 'ejercicio.cerrar', recurso: 'ejercicio', recursoId: String(req.body.anio), empresaId: req.empresaId,
        despues: { asiento: x.asiento.numero, resultado: x.resultado, regenerado: x.regenerado },
      });
      return x;
    }, { timeout: 30_000 });
    res.status(201).json({ id: r.asiento.id, numero: r.asiento.numero, resultado: r.resultado, regenerado: r.regenerado });
  },
);

export default router;
