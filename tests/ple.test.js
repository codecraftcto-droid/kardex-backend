import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import argon2 from 'argon2';
import { unzipSync } from 'fflate';

const { crearApp } = await import('../src/app.js');
const { prismaSystem, prismaApp, withTenant } = await import('../src/lib/prisma.js');
const { redis } = await import('../src/lib/redis.js');
const { crearEstudio } = await import('../src/services/estudios.js');
const { cargarBase } = await import('../src/contabilidad/servicio.js');
const { lineasDiario, lineasInventario, nombreArchivo } = await import('../src/ple/formatos.js');
const { desplazar, periodoActual } = await import('../src/sire/periodos.js');

const app = crearApp();
const PASSWORD = 'Prueba123!';
const sufijo = crypto.randomBytes(4).toString('hex');
const auth = (t) => ({ Authorization: `Bearer ${t}` });
let F;
const T = {};
const P = periodoActual();
const api = (token) => ({
  get: (u) => request(app).get(`/api${u}`).set(auth(token)),
  post: (u, b) => request(app).post(`/api${u}`).set(auth(token)).send(b),
  binario: (u) => request(app).get(`/api${u}`).set(auth(token)).buffer(true).parse((res, cb) => {
    const p = [];
    res.on('data', (c) => p.push(c));
    res.on('end', () => cb(null, Buffer.concat(p)));
  }),
});
const hoy = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
const campos = (l) => l.split('|');

beforeAll(async () => {
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  F = await prismaSystem.$transaction(async (tx) => {
    const { tenant, roles } = await crearEstudio(tx, { nombre: `PLE-${sufijo}` });
    const empresa = await tx.empresa.create({ data: { tenantId: tenant.id, razonSocial: 'Libros PLE SAC', ruc: '20100070970' } });
    const sede = await tx.sede.create({ data: { tenantId: tenant.id, empresaId: empresa.id, nombre: 'Anexo', codigoEstablecimiento: '0001' } });
    const a1 = await tx.almacen.create({ data: { tenantId: tenant.id, empresaId: empresa.id, sedeId: sede.id, codigo: 'A1', nombre: 'A1' } });
    const unidad = await tx.unidadMedida.findFirst({ where: { tenantId: tenant.id, codigo: 'NIU' } });
    const p1 = await tx.producto.create({ data: { tenantId: tenant.id, empresaId: empresa.id, sku: 'PIÑA-1', nombre: 'Piña golden', unidadId: unidad.id } });
    const usuario = (nombre, rol) =>
      tx.usuario.create({
        data: {
          tenantId: tenant.id, nombres: nombre, email: `${nombre}-${sufijo}@test.local`, estado: 'activo', passwordHash: hash,
          asignaciones: { create: { tenantId: tenant.id, rolId: roles[rol].id, alcanceTipo: 'estudio', alcanceId: null } },
        },
      });
    return { tenant, empresa, a1, p1, admin: await usuario('admin', 'Administrador'), asistente: await usuario('asistente', 'Asistente') };
  });
  await withTenant(F.tenant.id, (tx) => cargarBase(tx, { tenantId: F.tenant.id, empresaId: F.empresa.id }));
  for (const k of ['admin', 'asistente']) T[k] = (await request(app).post('/api/auth/login').send({ email: F[k].email, password: PASSWORD })).body.accessToken;

  // Un asiento manual y dos movimientos de kardex en el período
  await api(T.admin).post('/contabilidad/asientos/manual', {
    empresaId: F.empresa.id, fecha: hoy(), glosa: 'Compra de piñas | mercado',
    lineas: [{ cuenta: '6011', debe: 100 }, { cuenta: '4212', haber: 100, terceroDoc: '20512345678', terceroNombre: 'Frutas SAC', docSerie: 'F001', docNumero: '45' }],
  }).expect(201);
  await api(T.admin).post('/kardex/entradas', {
    almacenId: F.a1.id, motivo: 'COMPRA', documentoTipo: 'FACTURA', documentoSerie: 'F001', documentoNumero: '45',
    items: [{ productoId: F.p1.id, cantidad: '40', costoUnitario: '2.5' }],
  }).expect(201);
  await api(T.admin).post('/kardex/salidas', { almacenId: F.a1.id, motivo: 'MERMA', items: [{ productoId: F.p1.id, cantidad: '3' }] }).expect(201);
});

afterAll(async () => {
  await Promise.all([prismaSystem.$disconnect(), prismaApp.$disconnect(), redis.quit()]);
});

describe('PLE: formato', () => {
  it('nombre del archivo con indicador de contenido', () => {
    expect(nombreArchivo({ ruc: '20100070970', periodo: '202609', libro: '050100', conInformacion: true })).toBe('LE2010007097020260900050100001111.txt');
    expect(nombreArchivo({ ruc: '20100070970', periodo: '202609', libro: '130100', conInformacion: false })).toBe('LE2010007097020260900130100001011.txt');
  });

  it('Diario: 21 campos por línea, separador limpio en los textos', () => {
    const [l] = lineasDiario('202609', [{ numero: 7, origen: 'MANUAL', glosa: 'Pago | luz\nseptiembre', fecha: '2026-09-15', lineas: [{ orden: 1, cuenta: '6361', debe: 50, haber: 0 }] }]);
    const c = campos(l);
    expect(c).toHaveLength(22); // 21 campos y el "|" final
    expect(c.slice(0, 4)).toEqual(['20260900', '09-0007', 'M1', '6361']);
    expect([c[12], c[15], c[17], c[18], c[20], c[21]]).toEqual(['15/09/2026', 'Pago luz septiembre', '50.00', '0.00', '1', '']);
  });

  it('Inventario: entradas, salidas y saldo con hasta 8 decimales', () => {
    const [l] = lineasInventario('202609', [{
      numero: 'E-000001', tipo: 'ENTRADA', motivo: 'COMPRA', metodoValorizacion: 'PROMEDIO', fecha: '2026-09-02', establecimiento: '0001',
      documento: { tipo: '01', serie: 'F001', numero: '9' },
      detalles: [{ sku: 'P1', nombre: 'Producto', unidad: 'NIU', cantidad: 3, costoUnitario: 3.125, costoTotal: 9.375, saldoCantidad: 3, saldoCostoUnitario: 3.125, saldoValor: 9.375 }],
    }]);
    const c = campos(l);
    expect(c).toHaveLength(28);
    expect([c[3], c[10], c[11], c[12], c[13], c[16]]).toEqual(['0001', '01', 'F001', '9', '02', '1']);
    expect(c.slice(17, 26)).toEqual(['3.00', '3.125', '9.38', '0.00', '0.00', '0.00', '3.00', '3.125', '9.38']);
  });
});

describe('PLE: libros de la empresa', () => {
  const q = `?empresaId=`;

  it('cada libro según el permiso de su fuente', async () => {
    const admin = (await api(T.admin).get(`/ple${q}${F.empresa.id}&periodo=${P}`)).body;
    expect(admin.libros.map((l) => [l.codigo, l.filas])).toEqual([['5.1', 2], ['5.3', expect.any(Number)], ['6.1', 2], ['13.1', 2]]);
    // El asistente no ve costos: el registro de inventario valorizado no le aparece
    const asistente = (await api(T.asistente).get(`/ple${q}${F.empresa.id}&periodo=${P}`)).body;
    expect(asistente.libros.map((l) => l.codigo)).toEqual(['5.1', '5.3', '6.1']);
    expect((await api(T.asistente).get(`/ple/130100${q}${F.empresa.id}&periodo=${P}`)).status).toBe(403);
    expect((await api(T.admin).get(`/ple${q}${F.empresa.id}&periodo=${desplazar(P, 1)}`)).status).toBe(400);
  });

  it('5.1 Diario y 6.1 Mayor', async () => {
    const d = (await api(T.admin).get(`/ple/050100${q}${F.empresa.id}&periodo=${P}`)).body;
    expect(d.nombreArchivo).toBe(`LE20100070970${P}00050100001111.txt`);
    expect(d.avisos[0]).toMatch(/no está cerrado/);
    const [l1, l2] = d.muestra.map(campos);
    expect([l1[2], l1[3], l1[17]]).toEqual(['M1', '6011', '100.00']);
    // Sin tipo de comprobante en la línea manual se informa 00 (otros)
    expect([l2[3], l2[7], l2[8], l2[9], l2[10], l2[11], l2[18]]).toEqual(['4212', '6', '20512345678', '00', 'F001', '45', '100.00']);
    // El Mayor ordena por cuenta
    const m = (await api(T.admin).get(`/ple/060100${q}${F.empresa.id}&periodo=${P}`)).body;
    expect(m.muestra.map((l) => campos(l)[3])).toEqual(['4212', '6011']);
  });

  it('13.1 Inventario permanente valorizado desde el kardex', async () => {
    const r = (await api(T.admin).get(`/ple/130100${q}${F.empresa.id}&periodo=${P}`)).body;
    const [entrada, merma] = r.muestra.map(campos);
    expect([entrada[3], entrada[6], entrada[10], entrada[11], entrada[13], entrada[17], entrada[19], entrada[23]]).toEqual(['0001', 'PIÑA-1', '01', 'F001', '02', '40.00', '100.00', '40.00']);
    expect([merma[13], merma[20], merma[23], merma[25]]).toEqual(['13', '3.00', '37.00', '92.50']);
    expect(r.avisos[0]).toMatch(/sin comprobante/);
  });

  it('TXT en Latin-1 y ZIP con todos los libros', async () => {
    const t = await api(T.admin).binario(`/ple/130100/txt${q}${F.empresa.id}&periodo=${P}`);
    expect(t.status).toBe(200);
    expect(t.headers['content-disposition']).toMatch(/LE20100070970\d{6}00130100001111\.txt/);
    expect(t.body.includes(0xd1)).toBe(true); // "Ñ" en Latin-1, un solo byte
    expect(t.body.toString('latin1')).toMatch(/PIÑA-1/);
    const z = await api(T.admin).binario(`/ple/zip${q}${F.empresa.id}&periodo=${P}`);
    expect(Object.keys(unzipSync(new Uint8Array(z.body))).sort()).toEqual([
      `LE20100070970${P}00050100001111.txt`, `LE20100070970${P}00050300001111.txt`, `LE20100070970${P}00060100001111.txt`, `LE20100070970${P}00130100001111.txt`,
    ]);
  });

  it('período sin movimientos: libro "sin información"', async () => {
    const r = (await api(T.admin).get(`/ple/050100${q}${F.empresa.id}&periodo=${desplazar(P, -1)}`)).body;
    expect([r.filas, r.conInformacion, r.nombreArchivo]).toEqual([0, false, `LE20100070970${desplazar(P, -1)}00050100001011.txt`]);
  });
});
