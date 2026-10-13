import { Router } from 'express';
import { z } from 'zod';
import ExcelJS from 'exceljs';
import { autorizarEnEmpresa, empresaDe } from '../../middleware/autorizar.js';
import { validar } from '../../middleware/validar.js';
import { puedeDentroDeEmpresa } from '../../rbac/resolver.js';
import { auditar } from '../../services/auditoria.js';
import { noEncontrado, solicitudInvalida } from '../../lib/errors.js';
import { esPeriodo, etiquetaPeriodo, periodoActual } from '../../sire/periodos.js';
import { calcularDaot, calcularPdt621 } from '../../declaraciones/pdt621.js';

/** Apoyo para declaraciones (Fase 4B): PDT 621 mensual y DAOT anual. */
const router = Router();
const uuid = /^[0-9a-f-]{36}$/i;
const periodoValido = (p) => {
  if (!esPeriodo(p) || p > periodoActual()) throw solicitudInvalida('Período inválido');
  return p;
};
const entero = (v) => (v === undefined || v === '' || v === null ? null : Number(v));
async function empresaDeReq(req) {
  const e = await req.db((tx) => tx.empresa.findUnique({ where: { id: req.empresaId }, select: { id: true, ruc: true, razonSocial: true, regimenTributario: true } }));
  if (!e) throw noEncontrado('Empresa no encontrada');
  return e;
}

// ───────────── PDT 621 ─────────────

router.get('/pdt621', autorizarEnEmpresa('declaraciones.pdt.ver', empresaDe('query')), async (req, res) => {
  const periodo = periodoValido(req.query.periodo ?? periodoActual());
  const saldoAnterior = entero(req.query.saldoAnterior);
  const tasaRenta = entero(req.query.tasaRenta);
  if ((saldoAnterior != null && !(saldoAnterior >= 0)) || (tasaRenta != null && !(tasaRenta >= 0 && tasaRenta < 1))) throw solicitudInvalida('Saldo o tasa inválidos');
  const empresa = await empresaDeReq(req);
  const r = await req.db((tx) => calcularPdt621(tx, { empresa, periodo, saldoAnterior, tasaRenta }), { timeout: 30_000 });
  res.json({ ...r, etiqueta: etiquetaPeriodo(periodo), empresa, acciones: { registrar: puedeDentroDeEmpresa(req.permisos, 'declaraciones.pdt.registrar', empresa.id) } });
});

const esquemaRegistro = z.object({
  empresaId: z.uuid(),
  periodo: z.string(),
  numeroOrden: z.string().trim().regex(/^\d{6,12}$/, 'Número de orden de 6 a 12 dígitos'),
  fechaPresentacion: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha AAAA-MM-DD'),
  saldoAnterior: z.coerce.number().min(0).nullish(),
  tasaRenta: z.coerce.number().min(0).max(0.99).nullish(),
});

/** Registra lo presentado: guarda los importes calculados y el saldo a favor para el mes siguiente */
router.put('/pdt621', autorizarEnEmpresa('declaraciones.pdt.registrar', empresaDe('body')), validar(esquemaRegistro), async (req, res) => {
  const periodo = periodoValido(req.body.periodo);
  const empresa = await empresaDeReq(req);
  const d = await req.db(async (tx) => {
    const c = await calcularPdt621(tx, { empresa, periodo, saldoAnterior: req.body.saldoAnterior ?? null, tasaRenta: req.body.tasaRenta ?? null });
    const datos = { igv: c.igv, renta: c.renta, totales: c.totales };
    const valores = {
      numeroOrden: req.body.numeroOrden, fechaPresentacion: new Date(`${req.body.fechaPresentacion}T00:00:00Z`), datos,
      igvPagado: c.igv.aPagar, rentaPagada: c.renta.pagoCuenta ?? 0, saldoFavorSiguiente: c.igv.saldoFavorSiguiente, usuarioId: req.user.id,
    };
    const x = await tx.declaracionMensual.upsert({
      where: { empresaId_periodo: { empresaId: empresa.id, periodo } },
      create: { tenantId: req.tenantId, empresaId: empresa.id, periodo, ...valores },
      update: valores,
    });
    await auditar(tx, req, {
      modulo: 'declaraciones', accion: 'pdt621.registrar', recurso: 'periodo', recursoId: periodo, empresaId: empresa.id,
      despues: { numeroOrden: x.numeroOrden, igvPagado: c.igv.aPagar, rentaPagada: c.renta.pagoCuenta, saldoFavorSiguiente: c.igv.saldoFavorSiguiente },
    });
    return x;
  });
  res.json({ periodo, numeroOrden: d.numeroOrden, saldoFavorSiguiente: Number(d.saldoFavorSiguiente) });
});

router.delete('/pdt621', autorizarEnEmpresa('declaraciones.pdt.registrar', empresaDe('query')), async (req, res) => {
  const periodo = periodoValido(req.query.periodo);
  await req.db(async (tx) => {
    const { count } = await tx.declaracionMensual.deleteMany({ where: { empresaId: req.empresaId, periodo } });
    if (!count) throw noEncontrado('No hay declaración registrada en ese período');
    await auditar(tx, req, { modulo: 'declaraciones', accion: 'pdt621.eliminar', recurso: 'periodo', recursoId: periodo, empresaId: req.empresaId });
  });
  res.status(204).end();
});

/** Declaraciones registradas del año (para el resumen anual) */
router.get('/pdt621/anio', autorizarEnEmpresa('declaraciones.pdt.ver', empresaDe('query')), async (req, res) => {
  const anio = String(Number(req.query.anio) || new Date().getFullYear());
  const lista = await req.db((tx) => tx.declaracionMensual.findMany({ where: { empresaId: req.empresaId, periodo: { startsWith: anio } }, orderBy: { periodo: 'asc' } }));
  res.json(lista.map((d) => ({
    periodo: d.periodo, etiqueta: etiquetaPeriodo(d.periodo), numeroOrden: d.numeroOrden, fechaPresentacion: d.fechaPresentacion.toISOString().slice(0, 10),
    igvPagado: Number(d.igvPagado), rentaPagada: Number(d.rentaPagada), saldoFavorSiguiente: Number(d.saldoFavorSiguiente),
  })));
});

// ───────────── DAOT ─────────────

const parametrosDaot = (req) => {
  const anio = Number(req.query.anio) || new Date().getFullYear() - 1;
  if (anio < 2000 || anio > new Date().getFullYear()) throw solicitudInvalida('Año inválido');
  const uit = entero(req.query.uit);
  if (uit != null && !(uit > 0)) throw solicitudInvalida('UIT inválida');
  return { anio, uit };
};

router.get('/daot', autorizarEnEmpresa('declaraciones.pdt.ver', empresaDe('query')), async (req, res) => {
  const empresa = await empresaDeReq(req);
  res.json({ ...(await req.db((tx) => calcularDaot(tx, { empresa, ...parametrosDaot(req) }), { timeout: 60_000 })), empresa });
});

router.get('/daot/excel', autorizarEnEmpresa('declaraciones.pdt.ver', empresaDe('query')), async (req, res) => {
  const empresa = await empresaDeReq(req);
  const d = await req.db((tx) => calcularDaot(tx, { empresa, ...parametrosDaot(req) }), { timeout: 60_000 });
  const libro = new ExcelJS.Workbook();
  for (const [nombre, lista] of [['Ingresos (clientes)', d.ventas], ['Costos y gastos (proveedores)', d.compras]]) {
    const h = libro.addWorksheet(nombre);
    h.addRow([`DAOT ${d.anio} — ${empresa.razonSocial} (RUC ${empresa.ruc}) — operaciones mayores a 2 UIT (S/ ${d.limite.toLocaleString('es-PE')})`]).font = { bold: true };
    h.addRow([]);
    const enc = h.addRow(['Tipo doc.', 'Número', 'Nombre o razón social', 'Comprobantes', 'Monto (S/)']);
    enc.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    enc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F766E' } };
    for (const x of lista) h.addRow([x.tipoDocumento === '6' ? 'RUC' : 'DNI', x.documento, x.nombre, x.comprobantes, x.monto]);
    h.columns.forEach((c, i) => { c.width = [10, 14, 46, 14, 16][i]; });
    h.getColumn(5).numFmt = '#,##0.00';
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="daot-${empresa.ruc}-${d.anio}.xlsx"`);
  res.send(Buffer.from(await libro.xlsx.writeBuffer()));
});

export default router;
