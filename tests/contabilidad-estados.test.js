import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import argon2 from 'argon2';
import ExcelJS from 'exceljs';

const { crearApp } = await import('../src/app.js');
const { prismaSystem, prismaApp, withTenant } = await import('../src/lib/prisma.js');
const { redis } = await import('../src/lib/redis.js');
const { crearEstudio } = await import('../src/services/estudios.js');
const { cargarBase } = await import('../src/contabilidad/servicio.js');

const app = crearApp();
const PASSWORD = 'Prueba123!';
const sufijo = crypto.randomBytes(4).toString('hex');
const auth = (t) => ({ Authorization: `Bearer ${t}` });
let F;
const T = {};
const api = (token) => ({
  get: (u) => request(app).get(`/api${u}`).set(auth(token)),
  post: (u, b) => request(app).post(`/api${u}`).set(auth(token)).send(b),
});
// Un año ya pasado (Y) y el anterior (Y-1), para no depender de la fecha del test
const Y = new Date().getFullYear() - 1;
const L = (cuenta, debe, haber) => ({ cuenta, debe, haber });
const importe = (lineas, texto) => lineas.find((l) => l.texto === texto)?.importe;

beforeAll(async () => {
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  F = await prismaSystem.$transaction(async (tx) => {
    const { tenant, roles } = await crearEstudio(tx, { nombre: `ESTADOS-${sufijo}` });
    const empresa = await tx.empresa.create({ data: { tenantId: tenant.id, razonSocial: 'Estados SAC', ruc: '20100070970' } });
    const usuario = (nombre, rol) =>
      tx.usuario.create({
        data: {
          tenantId: tenant.id, nombres: nombre, email: `${nombre}-${sufijo}@test.local`, estado: 'activo', passwordHash: hash,
          asignaciones: { create: { tenantId: tenant.id, rolId: roles[rol].id, alcanceTipo: 'estudio', alcanceId: null } },
        },
      });
    return { tenant, empresa, admin: await usuario('admin', 'Administrador'), asistente: await usuario('asistente', 'Asistente') };
  });
  await withTenant(F.tenant.id, (tx) => cargarBase(tx, { tenantId: F.tenant.id, empresaId: F.empresa.id }));
  for (const k of ['admin', 'asistente']) T[k] = (await request(app).post('/api/auth/login').send({ email: F[k].email, password: PASSWORD })).body.accessToken;

  const asiento = async (fecha, glosa, lineas) => {
    const r = await api(T.admin).post('/contabilidad/asientos/manual', { empresaId: F.empresa.id, fecha, glosa, lineas });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  };
  // Año anterior (sin cerrar): aporte de capital y un gasto
  await asiento(`${Y - 1}-12-10`, 'Aporte de capital', [L('1041', 1000, 0), L('5011', 0, 1000)]);
  await asiento(`${Y - 1}-12-20`, 'Luz de diciembre', [L('6361', 50, 0), L('1041', 0, 50)]);
  // Febrero: otro ingreso
  await asiento(`${Y}-02-10`, 'Ingreso diverso', [L('1041', 20, 0), L('759', 0, 20)]);
  // Marzo: compra con destino, venta con costo, gasto con destino, gasto financiero SIN destino y cobranza
  await asiento(`${Y}-03-05`, 'Compra de mercadería', [L('6011', 100, 0), L('40111', 18, 0), L('4212', 0, 118), L('20111', 100, 0), L('6111', 0, 100)]);
  await asiento(`${Y}-03-10`, 'Venta', [L('1212', 236, 0), L('40111', 0, 36), L('70111', 0, 200)]);
  await asiento(`${Y}-03-10`, 'Costo de la venta', [L('69111', 100, 0), L('20111', 0, 100)]);
  await asiento(`${Y}-03-15`, 'Internet con destino', [L('6365', 30, 0), L('1041', 0, 30), L('94', 30, 0), L('791', 0, 30)]);
  await asiento(`${Y}-03-20`, 'Comisión bancaria sin destino', [L('671', 10, 0), L('1041', 0, 10)]);
  await asiento(`${Y}-03-25`, 'Cobranza', [L('1041', 236, 0), L('1212', 0, 236)]);
});

afterAll(async () => {
  await Promise.all([prismaSystem.$disconnect(), prismaApp.$disconnect(), redis.quit()]);
});

describe('estados financieros', () => {
  const estados = async (periodo, t = T.asistente) => api(t).get(`/contabilidad/estados?empresaId=${F.empresa.id}&periodo=${periodo}`);

  it('estado de resultados por naturaleza y por función, del mes y acumulado', async () => {
    const r = await estados(`${Y}03`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const { mes, acumulado, avisos } = r.body.resultados;
    expect(importe(acumulado.naturaleza, 'Ventas netas')).toBe(200);
    expect(importe(acumulado.naturaleza, 'Consumo de mercaderías e insumos')).toBe(-100);
    expect(importe(acumulado.naturaleza, 'Margen comercial')).toBe(100);
    expect(importe(acumulado.naturaleza, 'Otros ingresos de gestión')).toBe(20);
    expect(importe(acumulado.naturaleza, 'Gastos financieros')).toBe(-10);
    expect(acumulado.resultado).toBe(80);
    expect(importe(acumulado.funcion, 'Utilidad bruta')).toBe(100);
    expect(importe(acumulado.funcion, 'Gastos de administración')).toBe(-30);
    expect(acumulado.resultadoFuncion).toBe(90);
    expect([mes.resultado, mes.resultadoFuncion]).toEqual([60, 70]);
    // La comisión sin destino aparece por naturaleza pero no por función
    expect(avisos[0]).toMatch(/S\/ 10\.00 de gastos sin destino/);
  });

  it('estado de situación financiera: cuadra con los resultados de años anteriores sin cerrar', async () => {
    const s = (await estados(`${Y}03`)).body.situacion;
    expect(s.activoCorriente.map((x) => [x.texto, x.importe])).toEqual([['Efectivo y equivalentes de efectivo', 1166]]);
    expect(s.pasivoCorriente.map((x) => [x.texto, x.importe])).toEqual([['Tributos y aportes por pagar', 18], ['Cuentas por pagar comerciales', 118]]);
    expect(s.patrimonio.map((x) => [x.texto, x.importe])).toEqual([['Capital', 1000], ['Resultados acumulados', -50], ['Resultado del ejercicio', 80]]);
    expect(s.totales).toMatchObject({ activo: 1166, pasivo: 136, patrimonio: 1030, pasivoPatrimonio: 1166 });
    expect([s.cuadra, s.resultadosAnterioresSinCerrar]).toEqual([true, -50]);
  });

  it('hoja de trabajo: sumas iguales y el mismo resultado en cada sección', async () => {
    const h = (await estados(`${Y}03`)).body.hoja;
    expect(h.totales.debe).toBe(h.totales.haber);
    expect(h.totales.deudor).toBe(h.totales.acreedor);
    // Con la partida de años anteriores sin cerrar, el inventario da el mismo resultado que naturaleza
    expect(h.resultado).toEqual({ inventario: 80, naturaleza: 80, funcion: 90 });
    expect(h.filas.find((f) => f.cuenta === '59*')).toMatchObject({ debe: 50, deudor: 50, activo: 50 });
    const fila = (c) => h.filas.find((f) => f.cuenta === c);
    expect(fila('10')).toMatchObject({ deudor: 1166, activo: 1166, perdidaNaturaleza: 0 });
    expect(fila('69')).toMatchObject({ deudor: 100, perdidaNaturaleza: 100, perdidaFuncion: 100 });
    expect(fila('94')).toMatchObject({ perdidaNaturaleza: 0, perdidaFuncion: 30 });
    expect(fila('79')).toMatchObject({ acreedor: 30, gananciaNaturaleza: 0, gananciaFuncion: 0 });
  });

  it('cierre del ejercicio anterior: salda los resultados contra la 892; diciembre sigue mostrando su resultado', async () => {
    expect((await api(T.asistente).post('/contabilidad/cierre-ejercicio', { empresaId: F.empresa.id, anio: Y - 1 })).status).toBe(403);
    expect((await api(T.admin).post('/contabilidad/cierre-ejercicio', { empresaId: F.empresa.id, anio: new Date().getFullYear() + 1 })).status).toBe(400);
    const c = await api(T.admin).post('/contabilidad/cierre-ejercicio', { empresaId: F.empresa.id, anio: Y - 1 });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect([c.body.resultado, c.body.regenerado]).toEqual([-50, false]);
    const a = await prismaSystem.asiento.findUnique({ where: { id: c.body.id }, include: { lineas: { orderBy: { orden: 'asc' } } } });
    expect(a.lineas.map((l) => `${l.cuenta} ${Number(l.debe) ? 'D' : 'H'} ${Number(l.debe) || Number(l.haber)}`)).toEqual(['6361 H 50', '892 D 50']);
    // Volver a generarlo lo reemplaza
    expect((await api(T.admin).post('/contabilidad/cierre-ejercicio', { empresaId: F.empresa.id, anio: Y - 1 })).body.regenerado).toBe(true);
    expect(await prismaSystem.asiento.count({ where: { empresaId: F.empresa.id, origen: 'CIERRE' } })).toBe(1);

    // El estado de resultados de diciembre no cuenta el asiento de cierre
    const dic = (await estados(`${Y - 1}12`)).body;
    expect(dic.resultados.acumulado.resultado).toBe(-50);
    expect(dic.cierre).toMatchObject({ glosa: expect.stringMatching(/pérdida de S\/ 50\.00/) });
    // La situación financiera de marzo no cambia
    const s = (await estados(`${Y}03`)).body.situacion;
    expect([s.cuadra, s.totales.patrimonio]).toEqual([true, 1030]);

    // Con diciembre cerrado ya no se regenera
    await api(T.admin).post('/contabilidad/periodos/cerrar', { empresaId: F.empresa.id, periodo: `${Y - 1}12` }).expect(200);
    expect((await api(T.admin).post('/contabilidad/cierre-ejercicio', { empresaId: F.empresa.id, anio: Y - 1 })).status).toBe(409);
    expect((await estados(`${Y - 1}12`, T.admin)).body.acciones.cerrarEjercicio).toBe(false);
  });

  it('exporta los estados a Excel', async () => {
    const r = await api(T.asistente).get(`/contabilidad/estados/excel?empresaId=${F.empresa.id}&periodo=${Y}03`).buffer(true).parse((res, cb) => {
      const partes = [];
      res.on('data', (x) => partes.push(x));
      res.on('end', () => cb(null, Buffer.concat(partes)));
    });
    expect(r.status).toBe(200);
    const libro = new ExcelJS.Workbook();
    await libro.xlsx.load(r.body);
    expect(libro.worksheets.map((h) => h.name)).toEqual(['Situación financiera', 'Resultados por función', 'Resultados por naturaleza', 'Hoja de trabajo']);
  });
});
