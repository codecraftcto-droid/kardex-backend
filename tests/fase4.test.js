import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import argon2 from 'argon2';
import { authenticator } from 'otplib';

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

async function login(email) {
  return request(app).post('/api/auth/login').send({ email, password: PASSWORD });
}

beforeAll(async () => {
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  F = await prismaSystem.$transaction(async (tx) => {
    const { tenant, roles } = await crearEstudio(tx, { nombre: `F4-${sufijo}` });
    const empresa = await tx.empresa.create({ data: { tenantId: tenant.id, razonSocial: 'Empresa F4', ruc: '20' + crypto.randomInt(1e8, 1e9) } });
    const sede = await tx.sede.create({ data: { tenantId: tenant.id, empresaId: empresa.id, nombre: 'S' } });
    const almacen = await tx.almacen.create({ data: { tenantId: tenant.id, empresaId: empresa.id, sedeId: sede.id, codigo: 'A1', nombre: 'A1' } });
    const unidad = await tx.unidadMedida.findFirst({ where: { tenantId: tenant.id, codigo: 'NIU' } });
    const producto = await tx.producto.create({ data: { tenantId: tenant.id, empresaId: empresa.id, sku: 'P', nombre: 'Producto', unidadId: unidad.id } });
    const usuario = (nombre, rol) =>
      tx.usuario.create({
        data: {
          tenantId: tenant.id, nombres: nombre, email: `${nombre}-${sufijo}@test.local`, estado: 'activo', passwordHash: hash,
          asignaciones: { create: { tenantId: tenant.id, rolId: roles[rol].id, alcanceTipo: 'empresa', alcanceId: empresa.id } },
        },
      });
    return { tenant, roles, empresa, almacen, producto, contador: await usuario('contador', 'Contador'), asistente: await usuario('asistente', 'Asistente') };
  });
  T.contador = (await login(F.contador.email)).body.accessToken;
  T.asistente = (await login(F.asistente.email)).body.accessToken;
});

afterAll(async () => {
  await Promise.all([prismaSystem.$disconnect(), prismaApp.$disconnect(), redis.quit()]);
});

const stock = async () =>
  (await prismaSystem.stock.findUnique({ where: { almacenId_productoId: { almacenId: F.almacen.id, productoId: F.producto.id } } }))?.cantidad.toString() ?? '0';

describe('compras y ventas integradas con el kardex', () => {
  let compraId;
  const compra = (extra = {}) => ({
    almacenId: F.almacen.id, terceroDocumento: '20100070970', terceroNombre: 'Proveedor SAC', comprobanteTipo: 'FACTURA',
    serie: 'F001', numero: '123', fechaEmision: '2026-10-01', moneda: 'USD', tipoCambio: '3.75',
    items: [{ productoId: F.producto.id, cantidad: '10', valorUnitario: '2' }], ...extra,
  });

  it('el asistente registra un borrador con IGV calculado, pero no lo confirma', async () => {
    const r = await request(app).post('/api/compras').set(auth(T.asistente)).send(compra());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.total).toBe('23.6'); // 20 + 18% IGV
    compraId = r.body.id;
    expect(await stock()).toBe('0');
    expect((await request(app).post(`/api/compras/${compraId}/confirmar`).set(auth(T.asistente))).status).toBe(403);
  });

  it('no permite registrar dos veces el mismo comprobante del proveedor', async () => {
    expect((await request(app).post('/api/compras').set(auth(T.asistente)).send(compra())).status).toBe(409);
  });

  it('al confirmar entra al kardex en soles (valor × tipo de cambio)', async () => {
    const r = await request(app).post(`/api/compras/${compraId}/confirmar`).set(auth(T.contador));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await stock()).toBe('10');
    const s = await prismaSystem.stock.findUnique({ where: { almacenId_productoId: { almacenId: F.almacen.id, productoId: F.producto.id } } });
    expect(s.costoPromedio.toString()).toBe('7.5');
    expect((await request(app).put(`/api/compras/${compraId}`).set(auth(T.contador)).send(compra({ numero: '999' }))).status).toBe(409);
  });

  it('la venta confirmada genera la salida y calcula el margen', async () => {
    const v = await request(app).post('/api/ventas').set(auth(T.contador)).send({
      almacenId: F.almacen.id, terceroDocumento: '45678912', terceroNombre: 'Cliente final', comprobanteTipo: 'BOLETA',
      serie: 'B001', numero: '55', fechaEmision: '2026-10-02', items: [{ productoId: F.producto.id, cantidad: '4', valorUnitario: '12' }],
    });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    await request(app).post(`/api/ventas/${v.body.id}/confirmar`).set(auth(T.contador)).expect(200);
    expect(await stock()).toBe('6');
    const d = await request(app).get(`/api/ventas/${v.body.id}`).set(auth(T.contador));
    expect(d.body.margen).toEqual({ costoVenta: '30', ventaSoles: '48', utilidad: '18' });
  });

  it('el movimiento se anula desde el documento, no desde el kardex', async () => {
    const d = await request(app).get(`/api/compras/${compraId}`).set(auth(T.contador));
    const directo = await request(app).post(`/api/kardex/movimientos/${d.body.movimiento.id}/anular`).set(auth(T.contador)).send({ observacion: 'intento directo' });
    expect(directo.status).toBe(409);
  });

  it('anular una venta confirmada devuelve el stock', async () => {
    const lista = await request(app).get(`/api/ventas?empresaId=${F.empresa.id}`).set(auth(T.contador));
    const r = await request(app).post(`/api/ventas/${lista.body.datos[0].id}/anular`).set(auth(T.contador)).send({ motivo: 'cliente devolvió todo' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await stock()).toBe('10');
    expect((await request(app).post(`/api/ventas/${lista.body.datos[0].id}/anular`).set(auth(T.contador)).send({ motivo: 'otra vez' })).status).toBe(409);
  });

  it('una venta sin stock no se confirma y queda en borrador', async () => {
    const v = await request(app).post('/api/ventas').set(auth(T.contador)).send({
      almacenId: F.almacen.id, terceroDocumento: '45678912', terceroNombre: 'Cliente', comprobanteTipo: 'BOLETA',
      serie: 'B001', numero: '56', fechaEmision: '2026-10-02', items: [{ productoId: F.producto.id, cantidad: '500', valorUnitario: '1' }],
    });
    expect((await request(app).post(`/api/ventas/${v.body.id}/confirmar`).set(auth(T.contador))).status).toBe(409);
    expect((await request(app).get(`/api/ventas/${v.body.id}`).set(auth(T.contador))).body.estado).toBe('BORRADOR');
  });
});

describe('verificación en dos pasos (TOTP)', () => {
  let secreto;
  const codigoActual = () => authenticator.generate(secreto);

  it('el usuario activa 2FA con su app y recibe códigos de recuperación', async () => {
    const ini = await request(app).post('/api/me/mfa/iniciar').set(auth(T.contador));
    expect(ini.body.qr).toMatch(/^data:image\/png;base64,/);
    secreto = ini.body.secreto;
    const act = await request(app).post('/api/me/mfa/activar').set(auth(T.contador)).send({ codigo: codigoActual() });
    expect(act.status, JSON.stringify(act.body)).toBe(200);
    expect(act.body.codigosRecuperacion).toHaveLength(8);
    F.codigos = act.body.codigosRecuperacion;
    const u = await prismaSystem.usuario.findUnique({ where: { id: F.contador.id } });
    expect(u.mfaSecret).not.toContain(secreto); // cifrado
  });

  it('el login pide el segundo factor y no acepta repetir el mismo código', async () => {
    await redis.del(`mfa:ultimo-paso:${F.contador.id}`);
    const r = await login(F.contador.email);
    expect(r.body.mfa).toBe('verificar');
    expect(r.body.accessToken).toBeUndefined();
    const codigo = codigoActual();
    const ok = await request(app).post('/api/auth/mfa/verificar').send({ desafio: r.body.desafio, codigo });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.accessToken).toBeTruthy();

    const r2 = await login(F.contador.email);
    const repetido = await request(app).post('/api/auth/mfa/verificar').send({ desafio: r2.body.desafio, codigo });
    expect(repetido.status).toBe(401);
  });

  it('un código de recuperación sirve una sola vez', async () => {
    const r = await login(F.contador.email);
    expect((await request(app).post('/api/auth/mfa/verificar').send({ desafio: r.body.desafio, codigo: F.codigos[0] })).status).toBe(200);
    const r2 = await login(F.contador.email);
    expect((await request(app).post('/api/auth/mfa/verificar').send({ desafio: r2.body.desafio, codigo: F.codigos[0] })).status).toBe(401);
  });

  it('el desafío se invalida tras 5 intentos fallidos', async () => {
    const r = await login(F.contador.email);
    for (let i = 0; i < 5; i++) await request(app).post('/api/auth/mfa/verificar').send({ desafio: r.body.desafio, codigo: '000000' });
    const sexto = await request(app).post('/api/auth/mfa/verificar').send({ desafio: r.body.desafio, codigo: F.codigos[1] });
    expect(sexto.status).toBe(401);
    expect(sexto.body.error).toMatch(/expiró|intentos/);
  });

  it('si su rol exige 2FA, no obtiene sesión hasta configurarlo', async () => {
    await prismaSystem.rol.update({ where: { id: F.roles.Asistente.id }, data: { requiereMfa: true } });
    const r = await login(F.asistente.email);
    expect(r.body.mfa).toBe('configurar');
    expect(r.body.accessToken).toBeUndefined();
    const conf = await request(app).post('/api/auth/mfa/configurar').send({ desafio: r.body.desafio });
    const act = await request(app).post('/api/auth/mfa/activar').send({ desafio: r.body.desafio, codigo: authenticator.generate(conf.body.secreto) });
    expect(act.status, JSON.stringify(act.body)).toBe(200);
    expect(act.body.accessToken).toBeTruthy();
    expect(act.body.codigosRecuperacion).toHaveLength(8);
    // Con el rol exigiéndolo, no puede desactivarlo
    const des = await request(app).post('/api/me/mfa/desactivar').set(auth(act.body.accessToken)).send({ password: PASSWORD, codigo: act.body.codigosRecuperacion[0] });
    expect(des.status).toBe(409);
  });
});
