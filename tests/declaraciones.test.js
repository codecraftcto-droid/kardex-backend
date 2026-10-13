import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import argon2 from 'argon2';

const { crearApp } = await import('../src/app.js');
const { prismaSystem, prismaApp } = await import('../src/lib/prisma.js');
const { redis } = await import('../src/lib/redis.js');
const { crearEstudio } = await import('../src/services/estudios.js');

const app = crearApp();
const PASSWORD = 'Prueba123!';
const sufijo = crypto.randomBytes(4).toString('hex');
const auth = (t) => ({ Authorization: `Bearer ${t}` });
let F;
const T = {};
const api = (token) => ({
  get: (u) => request(app).get(`/api${u}`).set(auth(token)),
  put: (u, b) => request(app).put(`/api${u}`).set(auth(token)).send(b),
});
// Un año ya pasado, para no depender de la fecha del test
const Y = new Date().getFullYear() - 1;
const linea = (lineas, texto) => lineas.find((l) => l.texto === texto);

beforeAll(async () => {
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  F = await prismaSystem.$transaction(async (tx) => {
    const { tenant, roles } = await crearEstudio(tx, { nombre: `DECL-${sufijo}` });
    const empresa = await tx.empresa.create({ data: { tenantId: tenant.id, razonSocial: 'Declara SAC', ruc: '20100070970', regimenTributario: 'MYPE' } });
    const sede = await tx.sede.create({ data: { tenantId: tenant.id, empresaId: empresa.id, nombre: 'Central' } });
    const a1 = await tx.almacen.create({ data: { tenantId: tenant.id, empresaId: empresa.id, sedeId: sede.id, codigo: 'A1', nombre: 'A1' } });
    const usuario = (nombre, rol) =>
      tx.usuario.create({
        data: {
          tenantId: tenant.id, nombres: nombre, email: `${nombre}-${sufijo}@test.local`, estado: 'activo', passwordHash: hash,
          asignaciones: { create: { tenantId: tenant.id, rolId: roles[rol].id, alcanceTipo: 'estudio', alcanceId: null } },
        },
      });
    const admin = await usuario('admin', 'Administrador');
    const doc = (tipo, comprobanteTipo, serie, numero, fecha, terceroDocumento, terceroNombre, subtotal, igv, extra = {}) =>
      tx.documentoComercial.create({
        data: {
          tenantId: tenant.id, empresaId: empresa.id, sedeId: sede.id, almacenId: a1.id, tipo, estado: 'CONFIRMADO', comprobanteTipo, serie, numero,
          fechaEmision: new Date(`${fecha}T00:00:00Z`), terceroDocumento, terceroNombre, subtotal, igv, total: subtotal + igv, creadoPorId: admin.id, ...extra,
        },
      });
    // Febrero: una compra normal (deja saldo a favor) y otra con detracción que se deposita en marzo
    await doc('COMPRA', 'FACTURA', 'F005', '1', `${Y}-02-10`, '20512345678', 'Proveedor Uno SAC', 1000, 180);
    await doc('COMPRA', 'FACTURA', 'F009', '7', `${Y}-02-20`, '20331898008', 'Servicios Dos SAC', 300, 54, { detraccionMonto: 36, detraccionConstancia: '111', detraccionFecha: new Date(`${Y}-03-10T00:00:00Z`) });
    // Marzo: ventas (una en dólares), compras con y sin crédito fiscal
    await doc('VENTA', 'FACTURA', 'F001', '1', `${Y}-03-05`, '20131312955', 'Cliente SAC', 1000, 180);
    await doc('VENTA', 'FACTURA', 'F001', '2', `${Y}-03-15`, '20131312955', 'Cliente SAC', 100, 18, { moneda: 'USD', tipoCambio: 3.8 });
    await doc('COMPRA', 'FACTURA', 'F005', '2', `${Y}-03-08`, '20512345678', 'Proveedor Uno SAC', 500, 90);
    await doc('COMPRA', 'FACTURA', 'F010', '3', `${Y}-03-12`, '20100047218', 'Transportes SAC', 200, 36, { detraccionMonto: 24 });
    await doc('COMPRA', 'BOLETA', 'B001', '9', `${Y}-03-20`, '20600000001', 'Bodega SAC', 100, 0);
    return { tenant, empresa, admin, asistente: await usuario('asistente', 'Asistente') };
  });
  for (const k of ['admin', 'asistente']) T[k] = (await request(app).post('/api/auth/login').send({ email: F[k].email, password: PASSWORD })).body.accessToken;
});

afterAll(async () => {
  await Promise.all([prismaSystem.$disconnect(), prismaApp.$disconnect(), redis.quit()]);
});

describe('PDT 621', () => {
  const pdt = (periodo, extra = '', t = T.asistente) => api(t).get(`/declaraciones/pdt621?empresaId=${F.empresa.id}&periodo=${periodo}${extra}`);

  it('febrero: solo compras → saldo a favor; la compra con detracción sin depositar queda en espera', async () => {
    const r = (await pdt(`${Y}02`)).body;
    expect(r.igv).toMatchObject({ debito: 0, credito: 180, resultado: -180, aPagar: 0, saldoFavorSiguiente: 180 });
    expect(r.comprasEnEspera.map((c) => c.comprobante)).toEqual(['F009-7']);
    expect((await api(T.asistente).put('/declaraciones/pdt621', { empresaId: F.empresa.id, periodo: `${Y}02`, numeroOrden: '750000001', fechaPresentacion: `${Y}-03-12` })).status).toBe(403);
    const reg = await api(T.admin).put('/declaraciones/pdt621', { empresaId: F.empresa.id, periodo: `${Y}02`, numeroOrden: '750000001', fechaPresentacion: `${Y}-03-12` });
    expect(reg.status, JSON.stringify(reg.body)).toBe(200);
    expect(reg.body.saldoFavorSiguiente).toBe(180);
  });

  it('marzo: ventas en soles y dólares, crédito del mes y de la detracción depositada, saldo a favor anterior', async () => {
    const r = (await pdt(`${Y}03`)).body;
    expect(linea(r.igv.lineas, 'Ventas netas gravadas')).toMatchObject({ casilla: '100', base: 1380, impuesto: 248 });
    // 500 + 90 del mes, y 300 + 54 de febrero (detracción depositada en marzo); la de marzo sin depositar queda fuera
    expect(linea(r.igv.lineas, 'Compras gravadas con derecho a crédito fiscal')).toMatchObject({ casilla: '107', base: 800, impuesto: 144, casillaImpuesto: '108' });
    expect(linea(r.igv.lineas, 'Compras sin derecho a crédito fiscal (boletas y otros)').base).toBe(100);
    expect(r.igv).toMatchObject({ debito: 248, credito: 144, resultado: 104, saldoAnterior: 180, aPagar: 0, saldoFavorSiguiente: 76 });
    expect(r.renta).toMatchObject({ casilla: '301', ingresosNetos: 1380, tasa: 0.01, pagoCuenta: 14, regimen: 'MYPE' });
    expect(r.comprasEnEspera.map((c) => c.comprobante)).toEqual(['F010-3']);
    expect(r.creditoDiferido.map((c) => c.comprobante)).toEqual(['F009-7']);
    expect(r.avisos.join(' ')).toMatch(/dólares/);
    // El saldo anterior y la tasa se pueden indicar a mano
    const manual = (await pdt(`${Y}03`, '&saldoAnterior=0&tasaRenta=0.015')).body;
    expect([manual.igv.aPagar, manual.renta.pagoCuenta]).toEqual([104, 21]);
    expect((await pdt(`${Y}03`, '&tasaRenta=2')).status).toBe(400);
  });

  it('registrar marzo y verlo en el resumen del año', async () => {
    await api(T.admin).put('/declaraciones/pdt621', { empresaId: F.empresa.id, periodo: `${Y}03`, numeroOrden: '750000002', fechaPresentacion: `${Y}-04-14` }).expect(200);
    expect((await api(T.admin).put('/declaraciones/pdt621', { empresaId: F.empresa.id, periodo: `${Y}03`, numeroOrden: 'X1', fechaPresentacion: `${Y}-04-14` })).status).toBe(400);
    const r = (await pdt(`${Y}03`)).body;
    expect(r.declarada).toMatchObject({ numeroOrden: '750000002', igvPagado: 0, rentaPagada: 14, saldoFavorSiguiente: 76 });
    const anio = (await api(T.asistente).get(`/declaraciones/pdt621/anio?empresaId=${F.empresa.id}&anio=${Y}`)).body;
    expect(anio.map((d) => [d.periodo, d.saldoFavorSiguiente])).toEqual([[`${Y}02`, 180], [`${Y}03`, 76]]);
    // Abril arranca con el saldo a favor de marzo
    expect((await pdt(`${Y}04`)).body.igv.saldoAnterior).toBe(76);
  });
});

describe('DAOT', () => {
  it('clientes y proveedores sobre 2 UIT (la UIT se puede indicar)', async () => {
    const conUit = (await api(T.asistente).get(`/declaraciones/daot?empresaId=${F.empresa.id}&anio=${Y}&uit=500`)).body;
    expect(conUit).toMatchObject({ uit: 500, limite: 1000, ingresosAnio: 1380 });
    expect(conUit.ventas).toEqual([expect.objectContaining({ documento: '20131312955', monto: 1380, comprobantes: 2 })]);
    expect(conUit.compras).toEqual([expect.objectContaining({ documento: '20512345678', monto: 1500 })]);
    // Con la UIT real (miles de soles) nadie supera el límite
    const real = (await api(T.asistente).get(`/declaraciones/daot?empresaId=${F.empresa.id}&anio=${Y}`)).body;
    expect([real.ventas.length, real.compras.length, real.uit > 4000]).toEqual([0, 0, true]);
    const x = await api(T.asistente).get(`/declaraciones/daot/excel?empresaId=${F.empresa.id}&anio=${Y}&uit=500`);
    expect([x.status, x.headers['content-type']]).toEqual([200, expect.stringMatching(/spreadsheetml/)]);
  });
});
