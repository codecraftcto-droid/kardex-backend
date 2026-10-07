import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import argon2 from 'argon2';

const { crearApp } = await import('../src/app.js');
const { prismaSystem, prismaApp } = await import('../src/lib/prisma.js');
const { redis } = await import('../src/lib/redis.js');
const { crearEstudio } = await import('../src/services/estudios.js');
const { invalidarPermisosEstudio } = await import('../src/rbac/servicio.js');
const { CUENTAS_OPERACION, DESTINOS_BASE, PCGE_BASE } = await import('../src/contabilidad/pcge.js');
const { arbol, naturalezaSugerida, padreDe } = await import('../src/contabilidad/reglas.js');

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
});

beforeAll(async () => {
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  F = await prismaSystem.$transaction(async (tx) => {
    const { tenant, roles } = await crearEstudio(tx, { nombre: `CONTA-${sufijo}` });
    const x = await tx.empresa.create({ data: { tenantId: tenant.id, razonSocial: 'Empresa X SAC', ruc: '20100070970' } });
    const y = await tx.empresa.create({ data: { tenantId: tenant.id, razonSocial: 'Empresa Y SAC', ruc: '20131312955' } });
    const usuario = (nombre, rol) =>
      tx.usuario.create({
        data: {
          tenantId: tenant.id, nombres: nombre, email: `${nombre}-${sufijo}@test.local`, estado: 'activo', passwordHash: hash,
          asignaciones: { create: { tenantId: tenant.id, rolId: roles[rol].id, alcanceTipo: 'estudio', alcanceId: null } },
        },
      });
    return { tenant, x, y, admin: await usuario('admin', 'Administrador'), asistente: await usuario('asistente', 'Asistente') };
  });
  for (const k of ['admin', 'asistente']) T[k] = (await request(app).post('/api/auth/login').send({ email: F[k].email, password: PASSWORD })).body.accessToken;
});

afterAll(async () => {
  await Promise.all([prismaSystem.$disconnect(), prismaApp.$disconnect(), redis.quit()]);
});

describe('PCGE base (catálogo)', () => {
  const codigos = new Set(PCGE_BASE.map(([c]) => c));
  const plan = arbol(PCGE_BASE.map(([codigo, nombre]) => ({ codigo, nombre, activo: true })));
  const imputables = new Set(plan.filter((c) => c.imputable).map((c) => c.codigo));

  it('sin códigos repetidos y cada subcuenta cuelga de una cuenta existente', () => {
    expect(codigos.size).toBe(PCGE_BASE.length);
    const huerfanas = PCGE_BASE.filter(([c]) => c.length > 2 && !padreDe(c, codigos)).map(([c]) => c);
    expect(huerfanas).toEqual([]);
  });

  it('las cuentas sugeridas por operación existen y reciben movimientos; los destinos existen', () => {
    expect(CUENTAS_OPERACION.filter(([, , , c]) => !imputables.has(c)).map(([k, , , c]) => `${k}:${c}`)).toEqual([]);
    for (const [debe, haber] of Object.values(DESTINOS_BASE)) {
      expect([imputables.has(debe), imputables.has(haber)]).toEqual([true, true]);
    }
  });

  it('naturaleza, jerarquía y destino heredado', () => {
    expect(['1011', '39', '4212', '592', '6011', '709', '891'].map(naturalezaSugerida)).toEqual(['DEUDORA', 'ACREEDORA', 'ACREEDORA', 'DEUDORA', 'DEUDORA', 'DEUDORA', 'ACREEDORA']);
    const c = (codigo) => plan.find((x) => x.codigo === codigo);
    expect(c('1212')).toMatchObject({ padre: '121', nivel: 3, imputable: true, elemento: 1 });
    expect(c('121')).toMatchObject({ imputable: false, hijas: 4 });
    const conDestinos = arbol([...plan.map(({ codigo, nombre }) => ({ codigo, nombre, destinoDebe: DESTINOS_BASE[codigo]?.[0], destinoHaber: DESTINOS_BASE[codigo]?.[1] }))]);
    expect(conDestinos.find((x) => x.codigo === '6211').destino).toEqual({ debe: '94', haber: '791', heredado: '62' });
    expect(conDestinos.find((x) => x.codigo === '6011').destino).toBeNull();
  });
});

describe('plan contable por empresa', () => {
  const plan = async (empresa = F.x) => (await api(T.admin).get(`/contabilidad/plan?empresaId=${empresa.id}`)).body.cuentas;
  const cuenta = async (codigo, empresa) => (await plan(empresa)).find((c) => c.codigo === codigo);

  it('carga el PCGE base con la configuración sugerida (una sola vez)', async () => {
    expect(await plan()).toEqual([]);
    expect((await api(T.asistente).post('/contabilidad/plan/cargar-base', { empresaId: F.x.id })).status).toBe(403);
    const r = await api(T.admin).post('/contabilidad/plan/cargar-base', { empresaId: F.x.id });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.cuentas).toBe(PCGE_BASE.length);
    expect((await api(T.admin).post('/contabilidad/plan/cargar-base', { empresaId: F.x.id })).status).toBe(409);
    const cfg = (await api(T.asistente).get(`/contabilidad/configuracion?empresaId=${F.x.id}`)).body;
    expect(cfg.operaciones.every((o) => o.codigo === o.sugerida && !o.problema)).toBe(true);
    expect(cfg.acciones.editar).toBe(false);
    expect(await cuenta('6211')).toMatchObject({ naturaleza: 'DEUDORA', destino: { debe: '94', haber: '791', heredado: '62' } });
  });

  it('crear subcuentas: con padre existente, sin duplicar y sin romper la configuración', async () => {
    const crear = (b) => api(T.admin).post('/contabilidad/plan/cuentas', { empresaId: F.x.id, ...b });
    expect((await crear({ codigo: '999', nombre: 'Costos diversos' })).body.error).toMatch(/Primero cree la cuenta 99/);
    expect((await crear({ codigo: '6365', nombre: 'Internet' })).status).toBe(409);
    expect((await crear({ codigo: '12121', nombre: 'Facturas en soles' })).body.error).toMatch(/asignada a: Cuentas por cobrar/);
    expect((await crear({ codigo: '1011', nombre: 'Caja', destinoDebe: '94', destinoHaber: '791' })).status).toBe(409);
    expect((await crear({ codigo: '1019', nombre: 'Otra caja', destinoDebe: '94', destinoHaber: '791' })).body.error).toMatch(/elemento 6/);
    const ok = await crear({ codigo: '63651', nombre: 'Internet móvil' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.naturaleza).toBe('DEUDORA');
    expect((await cuenta('6365')).imputable).toBe(false);
    expect((await cuenta('63651')).destino).toEqual({ debe: '94', haber: '791', heredado: '63' });
    // Destino propio: gastos de ventas
    const conDestino = await crear({ codigo: '6372', nombre: 'Publicidad en redes', destinoDebe: '95', destinoHaber: '791' });
    expect(conDestino.status, JSON.stringify(conDestino.body)).toBe(201);
    expect((await cuenta('6372')).destino).toEqual({ debe: '95', haber: '791', heredado: null });
  });

  it('cuentas por operación: solo cuentas imputables y activas', async () => {
    const guardar = (cuentas) => api(T.admin).put('/contabilidad/configuracion', { empresaId: F.x.id, cuentas });
    expect((await guardar({ caja: '101' })).body.error).toMatch(/subcuentas/);
    expect((await guardar({ caja: '1099' })).body.error).toMatch(/no existe/);
    expect((await guardar({ otra: '1011' })).status).toBe(400);
    const ok = await guardar({ caja: '1021', bancos: '1041', cxcFacturas: '1212' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.operaciones.find((o) => o.clave === 'caja')).toMatchObject({ codigo: '1021', cuenta: { nombre: 'Caja chica' } });
    expect(ok.body.operaciones.find((o) => o.clave === 'igvVentas').codigo).toBeNull();
    // Desactivar una cuenta en uso no se permite
    const caja = await cuenta('1021');
    expect((await api(T.admin).put(`/contabilidad/plan/cuentas/${caja.id}`, { empresaId: F.x.id, nombre: caja.nombre, activo: false })).status).toBe(409);
  });

  it('eliminar: sin subcuentas, sin uso y sin ser destino', async () => {
    const del = async (codigo) => api(T.admin).del(`/contabilidad/plan/cuentas/${(await cuenta(codigo)).id}?empresaId=${F.x.id}`);
    expect((await del('63')).body.error).toMatch(/subcuentas/);
    expect((await del('1021')).body.error).toMatch(/asignada/);
    expect((await del('95')).body.error).toMatch(/destino/);
    expect((await del('63651')).status).toBe(204);
    expect((await cuenta('6365')).imputable).toBe(true);
  });

  it('copia el plan y la configuración a otra empresa', async () => {
    const r = await api(T.admin).post('/contabilidad/plan/copiar', { empresaId: F.y.id, desdeEmpresaId: F.x.id });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.cuentas).toBe((await plan(F.x)).length);
    expect(await cuenta('6372', F.y)).toMatchObject({ destino: { debe: '95', haber: '791', heredado: null } });
    const cfg = (await api(T.admin).get(`/contabilidad/configuracion?empresaId=${F.y.id}`)).body;
    expect(cfg.operaciones.find((o) => o.clave === 'caja').codigo).toBe('1021');
    expect((await api(T.admin).post('/contabilidad/plan/copiar', { empresaId: F.y.id, desdeEmpresaId: F.x.id })).status).toBe(409);
  });

  it('es un módulo aparte', async () => {
    const plan2 = await prismaSystem.plan.create({ data: { codigo: `SIN-CONTA-${sufijo}`, nombre: 'Sin contabilidad', precioMensual: 99, modulos: ['inventario'] } });
    await prismaSystem.tenant.update({ where: { id: F.tenant.id }, data: { planId: plan2.id } });
    await invalidarPermisosEstudio(F.tenant.id);
    expect((await api(T.admin).get(`/contabilidad/plan?empresaId=${F.x.id}`)).status).toBe(403);
  });
});
