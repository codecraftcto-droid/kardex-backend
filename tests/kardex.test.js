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
let F, tokenAdmin, tokenAlm, tokenAsis;

async function login(email) {
  const r = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.accessToken;
}

beforeAll(async () => {
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  F = await prismaSystem.$transaction(async (tx) => {
    const { tenant, roles } = await crearEstudio(tx, { nombre: `K-${sufijo}` });
    const usuario = (nombre, rol, alcanceTipo, alcanceId) =>
      tx.usuario.create({
        data: {
          tenantId: tenant.id, nombres: nombre, email: `${nombre}-${sufijo}@test.local`, estado: 'activo', passwordHash: hash,
          asignaciones: { create: { tenantId: tenant.id, rolId: roles[rol].id, alcanceTipo, alcanceId } },
        },
      });
    const empresa = await tx.empresa.create({ data: { tenantId: tenant.id, razonSocial: 'Empresa K', ruc: '20' + crypto.randomInt(1e8, 1e9), metodoValorizacion: 'PEPS' } });
    const sede = await tx.sede.create({ data: { tenantId: tenant.id, empresaId: empresa.id, nombre: 'S' } });
    const a1 = await tx.almacen.create({ data: { tenantId: tenant.id, empresaId: empresa.id, sedeId: sede.id, codigo: 'A1', nombre: 'A1' } });
    const a2 = await tx.almacen.create({ data: { tenantId: tenant.id, empresaId: empresa.id, sedeId: sede.id, codigo: 'A2', nombre: 'A2' } });
    const unidad = await tx.unidadMedida.findFirst({ where: { tenantId: tenant.id, codigo: 'NIU' } });
    const producto = await tx.producto.create({ data: { tenantId: tenant.id, empresaId: empresa.id, sku: 'P1', nombre: 'Producto 1', unidadId: unidad.id } });
    return {
      empresa, a1, a2, producto,
      admin: await usuario('admin', 'Administrador', 'estudio', null),
      alm: await usuario('alm', 'Almacenero', 'almacen', a1.id),
      asis: await usuario('asis', 'Asistente', 'empresa', empresa.id),
    };
  });
  [tokenAdmin, tokenAlm, tokenAsis] = await Promise.all([F.admin, F.alm, F.asis].map((u) => login(u.email)));
});

afterAll(async () => {
  await Promise.all([prismaSystem.$disconnect(), prismaApp.$disconnect(), redis.quit()]);
});

const entrada = (token, almacenId, items, motivo = 'COMPRA') =>
  request(app).post('/api/kardex/entradas').set(auth(token)).send({ almacenId, motivo, items });
const salida = (token, almacenId, items, motivo = 'VENTA') =>
  request(app).post('/api/kardex/salidas').set(auth(token)).send({ almacenId, motivo, items });

describe('kardex', () => {
  it('registra entradas y salidas PEPS con correlativo', async () => {
    const e1 = await entrada(tokenAdmin, F.a1.id, [{ productoId: F.producto.id, cantidad: '10', costoUnitario: '5' }]);
    expect(e1.status, JSON.stringify(e1.body)).toBe(201);
    expect(e1.body.numero).toBe('E-000001');
    await entrada(tokenAdmin, F.a1.id, [{ productoId: F.producto.id, cantidad: '10', costoUnitario: '7' }]).expect(201);
    const s1 = await salida(tokenAdmin, F.a1.id, [{ productoId: F.producto.id, cantidad: '15' }]);
    expect(s1.status).toBe(201);

    const k = await request(app).get(`/api/kardex/producto/${F.producto.id}?almacenId=${F.a1.id}`).set(auth(tokenAdmin));
    const ultima = k.body.datos.at(-1);
    expect(ultima.costoTotal).toBe('85'); // 10×5 + 5×7
    expect(ultima.saldoCantidad).toBe('5');
    expect(ultima.saldoValor).toBe('35');
  });

  it('las compras exigen costo y no se permite stock negativo', async () => {
    expect((await entrada(tokenAdmin, F.a1.id, [{ productoId: F.producto.id, cantidad: '1' }])).status).toBe(400);
    const r = await salida(tokenAdmin, F.a1.id, [{ productoId: F.producto.id, cantidad: '999' }]);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/Stock insuficiente/);
  });

  it('el almacenero opera solo en su almacén y no ve costos', async () => {
    expect((await salida(tokenAlm, F.a1.id, [{ productoId: F.producto.id, cantidad: '1' }])).status).toBe(201);
    expect((await salida(tokenAlm, F.a2.id, [{ productoId: F.producto.id, cantidad: '1' }])).status).toBe(404);

    const stock = await request(app).get(`/api/kardex/stock?empresaId=${F.empresa.id}`).set(auth(tokenAlm));
    expect(stock.body.datos.every((s) => s.almacenId === F.a1.id)).toBe(true);
    expect(stock.body.datos[0].valorTotal).toBeUndefined();
    expect(stock.body.resumen.valorTotal).toBeNull();

    // El catálogo de productos sí lo ve aunque su rol es solo de un almacén
    const prods = await request(app).get(`/api/productos?empresaId=${F.empresa.id}`).set(auth(tokenAlm));
    expect(prods.status).toBe(200);
    expect(prods.body.total).toBe(1);
  });

  it('el asistente registra pero no puede anular', async () => {
    const r = await entrada(tokenAsis, F.a2.id, [{ productoId: F.producto.id, cantidad: '4', costoUnitario: '6' }]);
    expect(r.status).toBe(201);
    expect((await request(app).post(`/api/kardex/movimientos/${r.body.id}/anular`).set(auth(tokenAsis)).send({ observacion: 'error de digitación' })).status).toBe(403);
  });

  it('anula con movimiento inverso, una sola vez, y el kardex es inmutable', async () => {
    const e = await entrada(tokenAdmin, F.a2.id, [{ productoId: F.producto.id, cantidad: '3', costoUnitario: '9' }]);
    const an = await request(app).post(`/api/kardex/movimientos/${e.body.id}/anular`).set(auth(tokenAdmin)).send({ observacion: 'factura duplicada' });
    expect(an.status, JSON.stringify(an.body)).toBe(201);
    expect(an.body.numero).toMatch(/^S-/);

    const det = await request(app).get(`/api/kardex/movimientos/${e.body.id}`).set(auth(tokenAdmin));
    expect(det.body.anuladoPor.numero).toBe(an.body.numero);
    const otra = await request(app).post(`/api/kardex/movimientos/${e.body.id}/anular`).set(auth(tokenAdmin)).send({ observacion: 'de nuevo, por error' });
    expect(otra.status).toBe(409);

    const stock = await prismaSystem.stock.findUnique({ where: { almacenId_productoId: { almacenId: F.a2.id, productoId: F.producto.id } } });
    expect(stock.cantidad.toString()).toBe('4');
    await expect(prismaSystem.movimiento.update({ where: { id: e.body.id }, data: { observacion: 'x' } })).rejects.toThrow();
  });

  it('no permite anular una entrada PEPS ya consumida', async () => {
    const e = await entrada(tokenAdmin, F.a2.id, [{ productoId: F.producto.id, cantidad: '2', costoUnitario: '8' }]);
    await salida(tokenAdmin, F.a2.id, [{ productoId: F.producto.id, cantidad: '6' }]).expect(201);
    const an = await request(app).post(`/api/kardex/movimientos/${e.body.id}/anular`).set(auth(tokenAdmin)).send({ observacion: 'prueba consumida' });
    expect(an.status).toBe(409);
  });

  it('salidas concurrentes no dejan stock negativo', async () => {
    await entrada(tokenAdmin, F.a1.id, [{ productoId: F.producto.id, cantidad: '20', costoUnitario: '5' }]).expect(201);
    const antes = await prismaSystem.stock.findUnique({ where: { almacenId_productoId: { almacenId: F.a1.id, productoId: F.producto.id } } });
    const n = Number(antes.cantidad);
    const r = await Promise.all(Array.from({ length: 6 }, () => salida(tokenAdmin, F.a1.id, [{ productoId: F.producto.id, cantidad: String(n / 4) }])));
    expect(r.filter((x) => x.status === 201).length).toBe(4);
    const despues = await prismaSystem.stock.findUnique({ where: { almacenId_productoId: { almacenId: F.a1.id, productoId: F.producto.id } } });
    expect(despues.cantidad.toString()).toBe('0');
  });

  it('bloquea el cambio de método de valorización con movimientos', async () => {
    const r = await request(app).put(`/api/empresas/${F.empresa.id}`).set(auth(tokenAdmin))
      .send({ razonSocial: 'Empresa K', ruc: F.empresa.ruc, metodoValorizacion: 'PROMEDIO' });
    expect(r.status).toBe(409);
  });
});
