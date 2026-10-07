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
  put: (u, b) => request(app).put(`/api${u}`).set(auth(token)).send(b),
  del: (u) => request(app).delete(`/api${u}`).set(auth(token)),
  excel: (u) => request(app).get(`/api${u}`).set(auth(token)).buffer(true).parse((res, cb) => {
    const partes = [];
    res.on('data', (c) => partes.push(c));
    res.on('end', () => cb(null, Buffer.concat(partes)));
  }),
});
// Todo en un año ya pasado: así no depende de la fecha en que corre el test
const Y = new Date().getFullYear() - 1;
const P = `${Y}04`;
const L = (cuenta, debe, haber, extra = {}) => ({ cuenta, debe, haber, ...extra });

beforeAll(async () => {
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  F = await prismaSystem.$transaction(async (tx) => {
    const { tenant, roles } = await crearEstudio(tx, { nombre: `LIBROS-${sufijo}` });
    const empresa = await tx.empresa.create({ data: { tenantId: tenant.id, razonSocial: 'Libros SAC', ruc: '20100070970' } });
    const sede = await tx.sede.create({ data: { tenantId: tenant.id, empresaId: empresa.id, nombre: 'Oficina' } });
    const a1 = await tx.almacen.create({ data: { tenantId: tenant.id, empresaId: empresa.id, sedeId: sede.id, codigo: 'A1', nombre: 'A1' } });
    const usuario = (nombre, rol) =>
      tx.usuario.create({
        data: {
          tenantId: tenant.id, nombres: nombre, email: `${nombre}-${sufijo}@test.local`, estado: 'activo', passwordHash: hash,
          asignaciones: { create: { tenantId: tenant.id, rolId: roles[rol].id, alcanceTipo: 'estudio', alcanceId: null } },
        },
      });
    return { tenant, empresa, sede, a1, admin: await usuario('admin', 'Administrador'), asistente: await usuario('asistente', 'Asistente') };
  });
  await withTenant(F.tenant.id, (tx) => cargarBase(tx, { tenantId: F.tenant.id, empresaId: F.empresa.id }));
  for (const k of ['admin', 'asistente']) T[k] = (await request(app).post('/api/auth/login').send({ email: F[k].email, password: PASSWORD })).body.accessToken;
});

afterAll(async () => {
  await Promise.all([prismaSystem.$disconnect(), prismaApp.$disconnect(), redis.quit()]);
});

describe('asientos manuales, libros y cierre', () => {
  const manual = (b, t = T.admin) => api(t).post('/contabilidad/asientos/manual', { empresaId: F.empresa.id, ...b });
  let a3;

  it('valida el asiento manual', async () => {
    const base = { fecha: `${Y}-04-20`, glosa: 'Pago de servicios' };
    expect((await manual({ ...base, lineas: [L('6361', 100, 0), L('1041', 0, 90)] })).body.error).toMatch(/no cuadra/);
    expect((await manual({ ...base, lineas: [L('63', 100, 0), L('1041', 0, 100)] })).body.error).toMatch(/subcuentas/);
    expect((await manual({ ...base, lineas: [L('6361', 100, 100), L('1041', 0, 100)] })).body.error).toMatch(/solo uno/);
    expect((await manual({ ...base, lineas: [L('9999', 100, 0), L('1041', 0, 100)] })).body.error).toMatch(/no existe/);
    expect((await manual({ ...base, fecha: `${Y + 2}-01-01`, lineas: [L('6361', 1, 0), L('1041', 0, 1)] })).body.error).toMatch(/futura/);
    expect((await manual({ ...base, lineas: [L('6361', 1, 0), L('1041', 0, 1)] }, T.asistente)).status).toBe(403);
  });

  it('registra asientos en distintos períodos', async () => {
    const crear = async (b) => {
      const r = await manual(b);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body;
    };
    await crear({ fecha: `${Y - 1}-12-15`, glosa: 'Aporte de capital', lineas: [L('1041', 1000, 0), L('5011', 0, 1000)] });
    await crear({ fecha: `${Y - 1}-12-20`, glosa: 'Luz de diciembre', lineas: [L('6361', 50, 0), L('1041', 0, 50)] });
    await crear({ fecha: `${Y}-03-10`, glosa: 'Luz de marzo por pagar', lineas: [L('6361', 100, 0), L('4212', 0, 100, { terceroDoc: '20331898008', terceroNombre: 'Luz del Sur', docSerie: 'S001', docNumero: '12' })] });
    a3 = await crear({ fecha: `${Y}-04-20`, glosa: 'Pago de luz e internet', lineas: [L('4212', 100, 0, { terceroDoc: '20331898008', terceroNombre: 'Luz del Sur' }), L('6365', 30, 0), L('1041', 0, 130)] });
    expect(a3).toMatchObject({ periodo: P, numero: 1 });
  });

  it('Libro Diario del período', async () => {
    const d = (await api(T.asistente).get(`/contabilidad/libros/diario?empresaId=${F.empresa.id}&periodo=${P}`)).body;
    expect(d.total).toBe(1);
    expect(d.totales).toEqual({ debe: 130, haber: 130 });
    expect(d.datos[0].lineas.map((l) => [l.cuenta, l.cuentaNombre, l.debe, l.haber])).toEqual([
      ['4212', 'Emitidas', 100, 0], ['6365', 'Internet', 30, 0], ['1041', 'Cuentas corrientes operativas', 0, 130],
    ]);
  });

  it('Libro Mayor: las cuentas de balance arrastran todo; las de resultados solo el año', async () => {
    const m = (await api(T.asistente).get(`/contabilidad/libros/mayor?empresaId=${F.empresa.id}&periodo=${P}`)).body;
    const c = Object.fromEntries(m.cuentas.map((x) => [x.cuenta, [x.anterior, x.debe, x.haber, x.saldo]]));
    expect(c).toEqual({
      1041: [950, 0, 130, 820],
      4212: [-100, 100, 0, 0],
      5011: [-1000, 0, 0, -1000],
      6361: [100, 0, 0, 100], // la luz de diciembre del año anterior no cuenta
      6365: [0, 30, 0, 30],
    });
    const banco = (await api(T.asistente).get(`/contabilidad/libros/mayor/cuenta?empresaId=${F.empresa.id}&periodo=${P}&cuenta=1041`)).body;
    expect(banco.anterior).toBe(950);
    expect(banco.movimientos.map((x) => [x.numero, x.haber, x.saldo])).toEqual([[1, 130, 820]]);
  });

  it('editar conserva el número; los automáticos no se editan', async () => {
    const r = await api(T.admin).put(`/contabilidad/asientos/manual/${a3.id}`, {
      empresaId: F.empresa.id, fecha: `${Y}-04-21`, glosa: 'Pago de luz e internet (corregido)', lineas: [L('4212', 100, 0), L('6365', 35, 0), L('1041', 0, 135)],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.numero).toBe(1);
    a3 = r.body;
    const auto = await prismaSystem.asiento.create({
      data: {
        tenantId: F.tenant.id, empresaId: F.empresa.id, periodo: P, numero: 99, fecha: new Date(`${Y}-04-25T00:00:00Z`), glosa: 'Venta', origen: 'VENTA', clave: `VENTA:${sufijo}`,
        totalDebe: 10, totalHaber: 10, lineas: { create: [{ tenantId: F.tenant.id, orden: 1, cuenta: '1212', debe: 10 }, { tenantId: F.tenant.id, orden: 2, cuenta: '70111', haber: 10 }] },
      },
    });
    expect((await api(T.admin).put(`/contabilidad/asientos/manual/${auto.id}`, { empresaId: F.empresa.id, fecha: `${Y}-04-25`, glosa: 'x venta', lineas: [L('1212', 1, 0), L('70111', 0, 1)] })).status).toBe(409);
    expect((await api(T.admin).get(`/contabilidad/asientos/${a3.id}?empresaId=${F.empresa.id}`)).body.editable).toBe(true);
    await prismaSystem.asiento.delete({ where: { id: auto.id } });
  });

  it('cierre: nada cambia en un período cerrado (ni siquiera directo en la base); reabrir pide motivo', async () => {
    const cerrar = (periodo, t = T.admin) => api(t).post('/contabilidad/periodos/cerrar', { empresaId: F.empresa.id, periodo });
    expect((await cerrar(P, T.asistente)).status).toBe(403);
    const c = await cerrar(P);
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.cerrado).toBe(true);
    const r = (await api(T.admin).get(`/contabilidad/asientos/resumen?empresaId=${F.empresa.id}&periodo=${P}`)).body;
    expect([r.cerrado, r.acciones]).toEqual([true, { generar: false, registrar: false, cerrar: false, reabrir: true }]);

    expect((await manual({ fecha: `${Y}-04-22`, glosa: 'Otro gasto', lineas: [L('6365', 1, 0), L('1041', 0, 1)] })).body.error).toMatch(/cerrado/);
    expect((await api(T.admin).del(`/contabilidad/asientos/manual/${a3.id}?empresaId=${F.empresa.id}`)).status).toBe(409);
    expect((await api(T.admin).post('/contabilidad/asientos/generar', { empresaId: F.empresa.id, periodo: P })).status).toBe(409);
    expect((await api(T.admin).get(`/contabilidad/asientos/${a3.id}?empresaId=${F.empresa.id}`)).body.editable).toBe(false);
    await expect(prismaSystem.asiento.delete({ where: { id: a3.id } })).rejects.toThrow(/cerrado/);

    expect((await api(T.admin).post('/contabilidad/periodos/reabrir', { empresaId: F.empresa.id, periodo: P })).status).toBe(400);
    expect((await api(T.admin).post('/contabilidad/periodos/reabrir', { empresaId: F.empresa.id, periodo: P, motivo: 'Falta registrar la planilla' })).status).toBe(200);
    expect((await manual({ fecha: `${Y}-04-22`, glosa: 'Otro gasto', lineas: [L('6365', 1, 0), L('1041', 0, 1)] })).status).toBe(201);
  });

  it('no se cierra con operaciones sin contabilizar', async () => {
    await prismaSystem.documentoComercial.create({
      data: {
        tenantId: F.tenant.id, empresaId: F.empresa.id, sedeId: F.sede.id, almacenId: F.a1.id, tipo: 'COMPRA', estado: 'CONFIRMADO',
        terceroDocumento: '20512345678', terceroNombre: 'Proveedor SAC', comprobanteTipo: 'FACTURA', serie: 'F001', numero: '5',
        fechaEmision: new Date(`${Y}-05-10T00:00:00Z`), subtotal: 100, igv: 18, total: 118, creadoPorId: F.admin.id,
      },
    });
    const r = await api(T.admin).post('/contabilidad/periodos/cerrar', { empresaId: F.empresa.id, periodo: `${Y}05` });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/Faltan contabilizar 1/);
  });

  it('exporta Diario y Mayor a Excel', async () => {
    const d = await api(T.asistente).excel(`/contabilidad/libros/diario/excel?empresaId=${F.empresa.id}&periodo=${P}`);
    expect(d.status).toBe(200);
    const libro = new ExcelJS.Workbook();
    await libro.xlsx.load(d.body);
    expect(libro.getWorksheet('Libro Diario').getCell('A1').value).toBe('LIBRO DIARIO');
    const m = await api(T.asistente).excel(`/contabilidad/libros/mayor/excel?empresaId=${F.empresa.id}&periodo=${P}`);
    const libro2 = new ExcelJS.Workbook();
    await libro2.xlsx.load(m.body);
    expect(libro2.worksheets.map((h) => h.name)).toEqual(['Resumen', 'Detalle']);
  });
});
