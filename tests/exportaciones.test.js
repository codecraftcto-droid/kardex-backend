import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import argon2 from 'argon2';
import ExcelJS from 'exceljs';

const { crearApp } = await import('../src/app.js');
const { prismaSystem, prismaApp } = await import('../src/lib/prisma.js');
const { redis } = await import('../src/lib/redis.js');
const { crearEstudio } = await import('../src/services/estudios.js');
const { iniciarWorkerReportes, detenerColas, procesarExportacion } = await import('../src/reportes/cola.js');

const app = crearApp();
const PASSWORD = 'Prueba123!';
const sufijo = crypto.randomBytes(4).toString('hex');
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const LINEAS = 25000;
let F;
const T = {};

/** Espera a que la exportación termine (LISTO o ERROR). */
async function esperar(token, id, ms = 60000) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) {
    const lista = await request(app).get('/api/reportes/exportaciones').set(auth(token));
    const e = lista.body.find((x) => x.id === id);
    if (['LISTO', 'ERROR'].includes(e?.estado)) return e;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('La exportación no terminó a tiempo');
}

beforeAll(async () => {
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  F = await prismaSystem.$transaction(async (tx) => {
    const { tenant, roles } = await crearEstudio(tx, { nombre: `X-${sufijo}` });
    const empresa = await tx.empresa.create({ data: { tenantId: tenant.id, razonSocial: 'Empresa X', ruc: '20' + crypto.randomInt(1e8, 1e9) } });
    const sede = await tx.sede.create({ data: { tenantId: tenant.id, empresaId: empresa.id, nombre: 'S' } });
    const almacen = await tx.almacen.create({ data: { tenantId: tenant.id, empresaId: empresa.id, sedeId: sede.id, codigo: 'A1', nombre: 'A1' } });
    const unidad = await tx.unidadMedida.findFirst({ where: { tenantId: tenant.id, codigo: 'NIU' } });
    const producto = await tx.producto.create({ data: { tenantId: tenant.id, empresaId: empresa.id, sku: 'P', nombre: 'Producto masivo', unidadId: unidad.id } });
    const usuario = (nombre, rol) =>
      tx.usuario.create({
        data: {
          tenantId: tenant.id, nombres: nombre, email: `${nombre}-${sufijo}@test.local`, estado: 'activo', passwordHash: hash,
          asignaciones: { create: { tenantId: tenant.id, rolId: roles[rol].id, alcanceTipo: 'empresa', alcanceId: empresa.id } },
        },
      });
    const contador = await usuario('contador', 'Contador');
    const otro = await usuario('otro', 'Contador');
    // Un movimiento con muchas líneas de kardex (volumen de prueba)
    const mov = await tx.movimiento.create({
      data: { tenantId: tenant.id, empresaId: empresa.id, sedeId: sede.id, almacenId: almacen.id, numero: 'E-000001', tipo: 'ENTRADA', motivo: 'COMPRA', metodoValorizacion: 'PROMEDIO', usuarioId: contador.id },
    });
    return { tenant, empresa, almacen, producto, contador, otro, mov };
  });
  for (let i = 0; i < LINEAS; i += 5000) {
    await prismaSystem.movimientoDetalle.createMany({
      data: Array.from({ length: 5000 }, (_, k) => ({
        tenantId: F.tenant.id, movimientoId: F.mov.id, almacenId: F.almacen.id, productoId: F.producto.id,
        cantidad: 1, costoUnitario: 2, costoTotal: 2, saldoCantidad: i + k + 1, saldoCostoUnitario: 2, saldoValor: (i + k + 1) * 2,
      })),
    });
  }
  T.contador = (await request(app).post('/api/auth/login').send({ email: F.contador.email, password: PASSWORD })).body.accessToken;
  T.otro = (await request(app).post('/api/auth/login').send({ email: F.otro.email, password: PASSWORD })).body.accessToken;
  await iniciarWorkerReportes();
}, 120000);

afterAll(async () => {
  await detenerColas();
  await Promise.all([prismaSystem.$disconnect(), prismaApp.$disconnect(), redis.quit()]);
});

const parametros = () => ({ empresaId: F.empresa.id, desde: '2000-01-01', hasta: '2100-01-01' });

describe('reportes grandes en segundo plano', () => {
  it('la vista previa se corta en 500 filas e informa el total', async () => {
    const r = await request(app).get('/api/reportes/movimientos').query(parametros()).set(auth(T.contador));
    expect(r.status).toBe(200);
    expect(r.body.filas).toHaveLength(500);
    expect(r.body.hayMas).toBe(true);
    expect(r.body.total).toBe(LINEAS);
    expect(r.body.totales).toBeNull();
  });

  it('exporta a Excel las 25 000 filas por lotes, con totales', async () => {
    const r = await request(app).post('/api/reportes/exportaciones').set(auth(T.contador)).send({ tipo: 'movimientos', formato: 'xlsx', parametros: parametros() });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    const e = await esperar(T.contador, r.body.id);
    expect(e.estado, e.error).toBe('LISTO');
    expect(e.filas).toBe(LINEAS);

    const archivo = await request(app).get(`/api/reportes/exportaciones/${e.id}/archivo`).set(auth(T.contador)).buffer(true)
      .parse((res, cb) => { const p = []; res.on('data', (c) => p.push(c)); res.on('end', () => cb(null, Buffer.concat(p))); });
    expect(archivo.status).toBe(200);
    const libro = new ExcelJS.Workbook();
    await libro.xlsx.load(archivo.body);
    const hoja = libro.worksheets[0];
    const ultima = hoja.getRow(hoja.rowCount);
    // título + subtítulos + vacía + cabecera + 25 000 filas + totales
    expect(ultima.getCell(2).value).toMatch(/Totales \(25000 registros\)/);
    expect(ultima.getCell(12).value).toBe(50000); // valor entrada total
  }, 90000);

  it('solo quien pidió la exportación puede descargarla', async () => {
    const lista = await request(app).get('/api/reportes/exportaciones').set(auth(T.contador));
    const id = lista.body.find((x) => x.estado === 'LISTO').id;
    expect((await request(app).get(`/api/reportes/exportaciones/${id}/archivo`).set(auth(T.otro))).status).toBe(404);
  });

  it('el PDF tiene tope de filas y sugiere Excel', async () => {
    const r = await request(app).post('/api/reportes/exportaciones').set(auth(T.contador)).send({ tipo: 'movimientos', formato: 'pdf', parametros: parametros() });
    const e = await esperar(T.contador, r.body.id);
    expect(e.estado).toBe('ERROR');
    expect(e.error).toMatch(/Expórtelo a Excel/);
  });

  it('si el usuario pierde el permiso antes de procesarse, no se genera', async () => {
    const exp = await prismaSystem.exportacionReporte.create({
      data: { tenantId: F.tenant.id, usuarioId: F.otro.id, empresaId: F.empresa.id, tipo: 'movimientos', formato: 'xlsx', parametros: parametros() },
    });
    await prismaSystem.usuarioRol.deleteMany({ where: { usuarioId: F.otro.id } });
    await procesarExportacion({ exportacionId: exp.id, tenantId: F.tenant.id });
    const final = await prismaSystem.exportacionReporte.findUnique({ where: { id: exp.id } });
    expect(final.estado).toBe('ERROR');
    expect(final.rutaArchivo).toBeNull();
  });

  it('máximo 3 exportaciones en curso por usuario', async () => {
    await prismaSystem.exportacionReporte.createMany({
      data: [1, 2, 3].map(() => ({ tenantId: F.tenant.id, usuarioId: F.contador.id, empresaId: F.empresa.id, tipo: 'stock', formato: 'xlsx', parametros: {}, estado: 'PROCESANDO' })),
    });
    const r = await request(app).post('/api/reportes/exportaciones').set(auth(T.contador)).send({ tipo: 'stock', formato: 'xlsx', parametros: { empresaId: F.empresa.id } });
    expect(r.status).toBe(429);
  });
});
