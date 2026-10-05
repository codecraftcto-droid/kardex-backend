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

/** Login completo de plataforma: contraseña → configurar 2FA → token. */
async function entrarPlataforma(email) {
  const r = await request(app).post('/api/plataforma/auth/login').send({ email, password: PASSWORD });
  expect(r.body.mfa).toBe('configurar');
  expect(r.body.accessToken).toBeUndefined();
  const qr = await request(app).post('/api/plataforma/auth/mfa/configurar').send({ desafio: r.body.desafio });
  const act = await request(app).post('/api/plataforma/auth/mfa/activar').send({ desafio: r.body.desafio, codigo: authenticator.generate(qr.body.secreto) });
  expect(act.status, JSON.stringify(act.body)).toBe(200);
  return act.body.accessToken;
}

beforeAll(async () => {
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const plan = await prismaSystem.plan.create({ data: { codigo: `T${sufijo}`, nombre: 'Prueba', precioMensual: 100, maxEmpresas: 1, maxUsuarios: 50, maxAlmacenes: 50 } });
  F = await prismaSystem.$transaction(async (tx) => {
    const { tenant, roles } = await crearEstudio(tx, { nombre: `P-${sufijo}` });
    await tx.tenant.update({ where: { id: tenant.id }, data: { planId: plan.id } });
    const admin = await tx.usuario.create({
      data: {
        tenantId: tenant.id, nombres: 'Admin', email: `adm-${sufijo}@test.local`, estado: 'activo', passwordHash: hash,
        asignaciones: { create: { tenantId: tenant.id, rolId: roles.Administrador.id, alcanceTipo: 'estudio' } },
      },
    });
    await tx.empresa.create({ data: { tenantId: tenant.id, razonSocial: 'Única', ruc: '20' + crypto.randomInt(1e8, 1e9) } });
    return { tenant, admin, plan };
  });
  for (const [k, rol] of [['admin', 'ADMIN'], ['soporte', 'SOPORTE']]) {
    await prismaSystem.plataformaAdmin.create({ data: { email: `${k}-${sufijo}@plataforma.local`, nombres: k, rol, passwordHash: hash } });
    T[k] = await entrarPlataforma(`${k}-${sufijo}@plataforma.local`);
  }
  T.estudio = (await request(app).post('/api/auth/login').send({ email: F.admin.email, password: PASSWORD })).body.accessToken;
});

afterAll(async () => {
  await Promise.all([prismaSystem.$disconnect(), prismaApp.$disconnect(), redis.quit()]);
});

describe('plataforma: autenticación separada', () => {
  it('un token de estudio no sirve en la plataforma ni al revés', async () => {
    expect((await request(app).get('/api/plataforma/estudios').set(auth(T.estudio))).status).toBe(401);
    expect((await request(app).get('/api/me').set(auth(T.admin))).status).toBe(401);
  });

  it('las credenciales de un estudio no abren la plataforma', async () => {
    const r = await request(app).post('/api/plataforma/auth/login').send({ email: F.admin.email, password: PASSWORD });
    expect(r.status).toBe(401);
  });

  it('el rol de aplicación de los estudios no puede leer tablas de plataforma', async () => {
    await expect(prismaApp.plataformaAdmin.count()).rejects.toThrow();
  });
});

describe('plataforma: gestión de estudios', () => {
  it('SOPORTE consulta pero no suspende ni cambia planes', async () => {
    expect((await request(app).get(`/api/plataforma/estudios/${F.tenant.id}`).set(auth(T.soporte))).status).toBe(200);
    expect((await request(app).post(`/api/plataforma/estudios/${F.tenant.id}/suspender`).set(auth(T.soporte)).send({ motivo: 'falta de pago' })).status).toBe(403);
    expect((await request(app).post('/api/plataforma/facturas/generar').set(auth(T.soporte)).send({ periodo: '2026-10' })).status).toBe(403);
  });

  it('los límites del plan se aplican en el estudio', async () => {
    const r = await request(app).post('/api/empresas').set(auth(T.estudio)).send({ razonSocial: 'Segunda', ruc: '20' + crypto.randomInt(1e8, 1e9) });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/plan Prueba permite hasta 1 empresas/);
    const plan = await request(app).get('/api/me/plan').set(auth(T.estudio));
    expect(plan.body.uso.empresas).toEqual({ usados: 1, maximo: 1 });
  });

  it('la facturación mensual es idempotente y se puede registrar el pago', async () => {
    const g1 = await request(app).post('/api/plataforma/facturas/generar').set(auth(T.admin)).send({ periodo: '2030-01' });
    expect(g1.body.emitidas).toBeGreaterThan(0);
    const g2 = await request(app).post('/api/plataforma/facturas/generar').set(auth(T.admin)).send({ periodo: '2030-01' });
    expect(g2.body.emitidas).toBe(0);
    const lista = await request(app).get(`/api/plataforma/facturas?periodo=2030-01&tenantId=${F.tenant.id}`).set(auth(T.admin));
    expect(lista.body.datos[0].monto).toBe('100');
    const pago = await request(app).post(`/api/plataforma/facturas/${lista.body.datos[0].id}/pagar`).set(auth(T.admin)).send({ referencia: 'OP-12345' });
    expect(pago.body.estado).toBe('PAGADA');
  });

  it('suspender un estudio corta de inmediato el acceso; reactivar lo devuelve', async () => {
    expect((await request(app).get('/api/me').set(auth(T.estudio))).status).toBe(200);
    const s = await request(app).post(`/api/plataforma/estudios/${F.tenant.id}/suspender`).set(auth(T.admin)).send({ motivo: 'Falta de pago' });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect((await request(app).get('/api/me').set(auth(T.estudio))).status).toBe(401);
    const login = await request(app).post('/api/auth/login').send({ email: F.admin.email, password: PASSWORD });
    expect(login.body.error).toMatch(/suspendido/);

    await request(app).post(`/api/plataforma/estudios/${F.tenant.id}/reactivar`).set(auth(T.admin)).expect(200);
    expect((await request(app).post('/api/auth/login').send({ email: F.admin.email, password: PASSWORD })).status).toBe(200);
  });

  it('alta de un estudio nuevo con su administrador invitado', async () => {
    const r = await request(app).post('/api/plataforma/estudios').set(auth(T.admin)).send({
      nombre: `Nuevo ${sufijo}`, ruc: '20' + crypto.randomInt(1e8, 1e9), planId: F.plan.id,
      administrador: { nombres: 'Dueño', email: `dueno-${sufijo}@test.local` },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const d = await request(app).get(`/api/plataforma/estudios/${r.body.id}`).set(auth(T.soporte));
    expect(d.body.administradores[0].estado).toBe('pendiente');
    expect((await request(app).post(`/api/plataforma/estudios/${r.body.id}/usuarios/${d.body.administradores[0].id}/reenviar-invitacion`).set(auth(T.soporte))).status).toBe(200);
  });

  it('monitoreo y auditoría inmutable', async () => {
    const m = await request(app).get('/api/plataforma/monitoreo').set(auth(T.soporte));
    expect(m.body.servicios.baseDatos.ok).toBe(true);
    expect(m.body.servicios.redis.ok).toBe(true);
    const a = await request(app).get(`/api/plataforma/auditoria?tenantId=${F.tenant.id}`).set(auth(T.admin));
    expect(a.body.datos.map((x) => x.accion)).toEqual(expect.arrayContaining(['estudio.suspender', 'estudio.reactivar', 'factura.pagar']));
    await expect(prismaSystem.plataformaAuditoria.deleteMany({})).rejects.toThrow();
  });
});
