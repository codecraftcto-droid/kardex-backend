import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import argon2 from 'argon2';
import ExcelJS from 'exceljs';

const { crearApp } = await import('../src/app.js');
const { prismaSystem, prismaApp, withTenant } = await import('../src/lib/prisma.js');
const { redis } = await import('../src/lib/redis.js');
const { crearEstudio } = await import('../src/services/estudios.js');
const { panelEstudio } = await import('../src/sire/panel.js');

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
const hoyMas = (dias) => {
  const d = new Date(`${new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date())}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d;
};

beforeAll(async () => {
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  F = await prismaSystem.$transaction(async (tx) => {
    const { tenant, roles } = await crearEstudio(tx, { nombre: `PANEL-${sufijo}` });
    const empresa = (razonSocial, ruc) => tx.empresa.create({ data: { tenantId: tenant.id, razonSocial, ruc } });
    // RUC terminado en 7 → grupo 7 del cronograma
    const a = await empresa('A Comercial SAC', '20100070977');
    const b = await empresa('B Servicios SAC', '20100070985');
    const c = await empresa('C Sin SIRE SAC', '20100070993');
    await tx.configSire.create({ data: { tenantId: tenant.id, empresaId: a.id, modo: 'SIMULADO' } });
    // Credenciales que el simulador rechaza
    await tx.configSire.create({ data: { tenantId: tenant.id, empresaId: b.id, modo: 'SIMULADO', usuarioSol: 'ERROR1' } });
    const usuario = (nombre, rol, alcanceTipo, alcanceId) =>
      tx.usuario.create({
        data: {
          tenantId: tenant.id, nombres: nombre, email: `${nombre}-${sufijo}@test.local`, estado: 'activo', passwordHash: hash,
          asignaciones: { create: { tenantId: tenant.id, rolId: roles[rol].id, alcanceTipo, alcanceId } },
        },
      });
    return {
      tenant, a, b, c,
      admin: await usuario('admin', 'Administrador', 'estudio', null),
      contadorA: await usuario('contadora', 'Contador', 'empresa', a.id),
      almacenero: await usuario('almacenero', 'Almacenero', 'estudio', null),
    };
  });
  for (const k of ['admin', 'contadorA', 'almacenero']) T[k] = (await request(app).post('/api/auth/login').send({ email: F[k].email, password: PASSWORD })).body.accessToken;
});

afterAll(async () => {
  await prismaSystem.cronogramaSunat.deleteMany({ where: { periodo: { startsWith: '2098' } } });
  await Promise.all([prismaSystem.$disconnect(), prismaApp.$disconnect(), redis.quit()]);
});

describe('SIRE: panel del estudio', () => {
  it('resumen y alertas: vencido, por vencer, con diferencias y error de conexión', async () => {
    // Cronograma de prueba (año 2098) con plazos relativos a hoy
    await prismaSystem.cronogramaSunat.deleteMany({ where: { periodo: { startsWith: '2098' } } });
    await prismaSystem.cronogramaSunat.createMany({
      data: [
        { periodo: '209801', grupo: '7', vencimiento: hoyMas(-2) },
        { periodo: '209802', grupo: '7', vencimiento: hoyMas(3) },
        { periodo: '209803', grupo: '7', vencimiento: hoyMas(30) },
      ],
    });
    await prismaSystem.periodoSire.createMany({
      data: [
        { tenantId: F.tenant.id, empresaId: F.a.id, periodo: '209801', estadoRvie: 'GENERADO' },
        { tenantId: F.tenant.id, empresaId: F.a.id, periodo: '209802', estadoRce: 'CON_DIFERENCIAS' },
      ],
    });
    await prismaSystem.configSire.update({ where: { empresaId: F.b.id }, data: { ultimoError: 'SUNAT rechazó el usuario' } });

    const p = await withTenant(F.tenant.id, (tx) => panelEstudio(tx, [F.a, F.b], { n: 3, hasta: '209803' }));
    expect(p.periodos.map((x) => x.periodo)).toEqual(['209803', '209802', '209801']);
    expect(p.resumen).toEqual({ empresas: 2, configuradas: 2, vencidos: 1, porVencer: 2, conDiferencias: 1, generados: 1 });
    expect(p.alertas.map((a) => `${a.tipo}:${a.registro ?? '-'}:${a.periodo ?? '-'}`)).toEqual([
      'VENCIDO:RCE:209801',
      'POR_VENCER:RVIE:209802',
      'POR_VENCER:RCE:209802',
      'DIFERENCIAS:RCE:209802',
      'CONEXION:-:-',
    ]);
    const a = p.empresas.find((e) => e.id === F.a.id);
    expect(a.periodos[2]).toMatchObject({ periodo: '209801', RVIE: 'GENERADO', RCE: 'PENDIENTE', diasParaVencer: -2 });
  });

  it('cada usuario ve solo sus empresas; sin permiso del SIRE no entra', async () => {
    const todo = (await api(T.admin).get('/sire/panel')).body;
    expect(todo.empresas.map((e) => e.razonSocial)).toEqual(['A Comercial SAC', 'B Servicios SAC', 'C Sin SIRE SAC']);
    expect(todo.empresas[0].periodos).toHaveLength(6);
    expect(todo.empresas[2].config).toBeNull();
    expect(todo.acciones.sincronizar).toBe(true);
    expect((await api(T.contadorA).get('/sire/panel?n=3')).body.empresas.map((e) => e.id)).toEqual([F.a.id]);
    expect((await api(T.almacenero).get('/sire/panel')).status).toBe(403);
  });

  it('sincroniza todas las empresas configuradas y deja el resultado de cada una', async () => {
    const r = await api(T.admin).post('/sire/panel/sincronizar');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ sinConfigurar: 1, conError: 1 });
    expect(r.body.resultados.map((x) => [x.empresa, x.ok])).toEqual([['A Comercial SAC', true], ['B Servicios SAC', false]]);
    expect(r.body.resultados[1].mensaje).toMatch(/clave SOL/);
  });

  it('historial: quién hizo qué, filtrado por las empresas que el usuario ve', async () => {
    const h = (await api(T.admin).get('/sire/historial')).body;
    expect(h.datos.map((x) => x.texto)).toEqual(expect.arrayContaining(['Sincronizó todas las empresas', 'Sincronizó con SUNAT']));
    expect(h.datos.find((x) => x.accion === 'periodos.sincronizar')).toMatchObject({ empresa: 'A Comercial SAC', usuario: 'admin' });
    const deA = (await api(T.contadorA).get('/sire/historial')).body;
    expect(deA.datos.every((x) => x.empresaId === F.a.id)).toBe(true);
    expect(deA.total).toBe(1);
    expect((await api(T.admin).get(`/sire/historial?empresaId=${F.b.id}`)).body.total).toBe(0);
  });

  it('exporta el panel a Excel', async () => {
    const r = await api(T.admin).get('/sire/panel/excel?n=2').buffer(true).parse((res, cb) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('end', () => cb(null, Buffer.concat(partes)));
    });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/spreadsheetml/);
    const libro = new ExcelJS.Workbook();
    await libro.xlsx.load(r.body);
    expect(libro.worksheets.map((h) => h.name)).toEqual(['Períodos', 'Alertas']);
    expect(libro.getWorksheet('Períodos').rowCount).toBe(1 + 3 * 2);
    expect(libro.getWorksheet('Períodos').getRow(2).getCell(1).value).toBe('A Comercial SAC');
  });
});
