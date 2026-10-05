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

beforeAll(async () => {
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  F = await prismaSystem.$transaction(async (tx) => {
    const { tenant, roles } = await crearEstudio(tx, { nombre: `T-${sufijo}` });
    const empresa = await tx.empresa.create({ data: { tenantId: tenant.id, razonSocial: 'Empresa T', ruc: '20' + crypto.randomInt(1e8, 1e9) } });
    const sede = await tx.sede.create({ data: { tenantId: tenant.id, empresaId: empresa.id, nombre: 'S' } });
    const [a1, a2] = await Promise.all(['A1', 'A2'].map((c) => tx.almacen.create({ data: { tenantId: tenant.id, empresaId: empresa.id, sedeId: sede.id, codigo: c, nombre: c } })));
    const unidad = await tx.unidadMedida.findFirst({ where: { tenantId: tenant.id, codigo: 'NIU' } });
    const producto = await tx.producto.create({ data: { tenantId: tenant.id, empresaId: empresa.id, sku: 'P', nombre: 'Producto', unidadId: unidad.id } });
    const usuario = (nombre, rol, alcanceTipo, alcanceId, extra = {}) =>
      tx.usuario.create({
        data: {
          tenantId: tenant.id, nombres: nombre, email: `${nombre}-${sufijo}@test.local`, estado: 'activo', passwordHash: hash, ...extra,
          asignaciones: { create: { tenantId: tenant.id, rolId: roles[rol].id, alcanceTipo, alcanceId } },
        },
      });
    return {
      empresa, a1, a2, producto,
      admin: await usuario('admin', 'Administrador', 'estudio', null),
      origen: await usuario('origen', 'Almacenero', 'almacen', a1.id),
      destino: await usuario('destino', 'Almacenero', 'almacen', a2.id),
      cliente: await usuario('cliente', 'Cliente (portal)', 'empresa', empresa.id, { tipo: 'cliente', empresaId: empresa.id }),
    };
  });
  for (const k of ['admin', 'origen', 'destino', 'cliente']) {
    const r = await request(app).post('/api/auth/login').send({ email: F[k].email, password: PASSWORD });
    T[k] = r.body.accessToken;
  }
  await request(app).post('/api/kardex/entradas').set(auth(T.admin))
    .send({ almacenId: F.a1.id, motivo: 'COMPRA', items: [{ productoId: F.producto.id, cantidad: '100', costoUnitario: '4' }] }).expect(201);
});

afterAll(async () => {
  await Promise.all([prismaSystem.$disconnect(), prismaApp.$disconnect(), redis.quit()]);
});

const stock = async (almacenId) =>
  (await prismaSystem.stock.findUnique({ where: { almacenId_productoId: { almacenId, productoId: F.producto.id } } }))?.cantidad.toString();

describe('transferencias', () => {
  let id;

  it('el almacén destino solicita; un almacenero no puede aprobar', async () => {
    const r = await request(app).post('/api/transferencias').set(auth(T.destino))
      .send({ origenAlmacenId: F.a1.id, destinoAlmacenId: F.a2.id, items: [{ productoId: F.producto.id, cantidad: '30' }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.numero).toBe('T-000001');
    id = r.body.id;
    expect((await request(app).post(`/api/transferencias/${id}/aprobar`).set(auth(T.origen))).status).toBe(403);
  });

  it('aprobación concurrente: solo una gana', async () => {
    const [a, b] = await Promise.all([1, 2].map(() => request(app).post(`/api/transferencias/${id}/aprobar`).set(auth(T.admin))));
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });

  it('despacha solo quien tiene alcance en el origen y genera la salida', async () => {
    expect((await request(app).post(`/api/transferencias/${id}/despachar`).set(auth(T.destino)).send({})).status).toBe(403);
    const r = await request(app).post(`/api/transferencias/${id}/despachar`).set(auth(T.origen)).send({});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await stock(F.a1.id)).toBe('70');
  });

  it('recibe parcial en destino al costo de origen', async () => {
    expect((await request(app).post(`/api/transferencias/${id}/recibir`).set(auth(T.origen)).send({})).status).toBe(403);
    const r = await request(app).post(`/api/transferencias/${id}/recibir`).set(auth(T.destino))
      .send({ cantidades: { [F.producto.id]: '29' }, observacion: 'una unidad dañada' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await stock(F.a2.id)).toBe('29');
    const s2 = await prismaSystem.stock.findUnique({ where: { almacenId_productoId: { almacenId: F.a2.id, productoId: F.producto.id } } });
    expect(s2.costoPromedio.toString()).toBe('4');

    const det = await request(app).get(`/api/transferencias/${id}`).set(auth(T.admin));
    expect(det.body.estado).toBe('RECIBIDA');
    expect(det.body.movimientos).toHaveLength(2);
    expect((await request(app).post(`/api/transferencias/${id}/recibir`).set(auth(T.destino)).send({})).status).toBe(409);
  });

  it('los movimientos de una transferencia no se anulan directamente', async () => {
    const det = await request(app).get(`/api/transferencias/${id}`).set(auth(T.admin));
    const r = await request(app).post(`/api/kardex/movimientos/${det.body.movimientos[0].id}/anular`).set(auth(T.admin)).send({ observacion: 'intento de anulación' });
    expect(r.status).toBe(409);
  });

  it('el solicitante puede cancelar su solicitud; otro almacenero no', async () => {
    const r = await request(app).post('/api/transferencias').set(auth(T.destino))
      .send({ origenAlmacenId: F.a1.id, destinoAlmacenId: F.a2.id, items: [{ productoId: F.producto.id, cantidad: '5' }] });
    expect((await request(app).post(`/api/transferencias/${r.body.id}/cancelar`).set(auth(T.origen)).send({ motivo: 'no corresponde' })).status).toBe(403);
    expect((await request(app).post(`/api/transferencias/${r.body.id}/cancelar`).set(auth(T.destino)).send({ motivo: 'ya no se necesita' })).status).toBe(200);
  });
});

describe('reportes y portal cliente', () => {
  const q = () => `empresaId=${F.empresa.id}`;

  it('stock consolidado (vista previa con totales)', async () => {
    const r = await request(app).get(`/api/reportes/stock?${q()}&nivel=empresa`).set(auth(T.admin));
    expect(r.status).toBe(200);
    expect(r.body.filas[0].cantidad).toBe('99');
    expect(r.body.totales.valor).toBe('396');
  });

  it('valorización a una fecha de corte usa el kardex histórico', async () => {
    const pasado = await request(app).get(`/api/reportes/valorizacion?${q()}&corte=2000-01-01`).set(auth(T.admin));
    expect(pasado.body.filas).toHaveLength(0);
    const hoy = await request(app).get(`/api/reportes/valorizacion?${q()}&corte=2100-01-01`).set(auth(T.admin));
    expect(hoy.body.totales.valor).toBe('396');
  });

  it('el almacenero no tiene reportes', async () => {
    expect((await request(app).get(`/api/reportes/stock?${q()}`).set(auth(T.origen))).status).toBe(403);
  });

  it('portal cliente: lee su stock sin costos, no registra ni exporta sin permiso', async () => {
    const r = await request(app).get(`/api/reportes/stock?${q()}`).set(auth(T.cliente));
    expect(r.status).toBe(200);
    expect(r.body.verCostos).toBe(false);
    expect(r.body.filas[0].valor).toBeUndefined();
    const e = await request(app).post('/api/kardex/entradas').set(auth(T.cliente))
      .send({ almacenId: F.a1.id, motivo: 'COMPRA', items: [{ productoId: F.producto.id, cantidad: '1', costoUnitario: '1' }] });
    expect(e.status).toBe(403);
    // La plantilla de cliente de un estudio nuevo incluye exportar
    const exp = await request(app).post('/api/reportes/exportaciones').set(auth(T.cliente))
      .send({ tipo: 'stock', formato: 'xlsx', parametros: { empresaId: F.empresa.id } });
    expect(exp.status, JSON.stringify(exp.body)).toBe(202);
  });
});
