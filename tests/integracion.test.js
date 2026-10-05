import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import argon2 from 'argon2';

// Importaciones dinámicas: tests/env.js debe fijar las variables antes de cargar la app
const { crearApp } = await import('../src/app.js');
const { prismaSystem, prismaApp } = await import('../src/lib/prisma.js');
const { redis } = await import('../src/lib/redis.js');
const { crearEstudio } = await import('../src/services/estudios.js');

const app = crearApp();
const PASSWORD = 'Prueba123!';
const sufijo = crypto.randomBytes(4).toString('hex');
let hash;

async function crearUsuario(tenantId, nombre, extra = {}) {
  return prismaSystem.usuario.create({
    data: { tenantId, nombres: nombre, email: `${nombre}-${sufijo}@test.local`, estado: 'activo', passwordHash: hash, ...extra },
  });
}

/** Estudio con admin, una empresa, una sede y dos almacenes. */
async function crearFixture(nombre) {
  return prismaSystem.$transaction(async (tx) => {
    const { tenant, roles } = await crearEstudio(tx, { nombre });
    const admin = await tx.usuario.create({
      data: { tenantId: tenant.id, nombres: 'Admin', email: `admin-${nombre}-${sufijo}@test.local`.toLowerCase(), estado: 'activo', passwordHash: hash },
    });
    await tx.usuarioRol.create({ data: { tenantId: tenant.id, usuarioId: admin.id, rolId: roles.Administrador.id, alcanceTipo: 'estudio' } });
    const empresa = await tx.empresa.create({ data: { tenantId: tenant.id, razonSocial: `Empresa ${nombre}`, ruc: '20' + crypto.randomInt(1e8, 1e9) } });
    const sede = await tx.sede.create({ data: { tenantId: tenant.id, empresaId: empresa.id, nombre: 'Sede' } });
    const [a1, a2] = await Promise.all(
      ['A1', 'A2'].map((codigo) =>
        tx.almacen.create({ data: { tenantId: tenant.id, empresaId: empresa.id, sedeId: sede.id, codigo, nombre: codigo } }),
      ),
    );
    return { tenant, roles, admin, empresa, sede, a1, a2 };
  });
}

async function login(email) {
  const r = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { token: r.body.accessToken, cookie: r.headers['set-cookie'] };
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });

let A, B, tokenA;

beforeAll(async () => {
  hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  A = await crearFixture(`A-${sufijo}`);
  B = await crearFixture(`B-${sufijo}`);
  tokenA = (await login(A.admin.email)).token;
});

afterAll(async () => {
  await Promise.all([prismaSystem.$disconnect(), prismaApp.$disconnect(), redis.quit()]);
});

describe('aislamiento entre estudios (tenants)', () => {
  it('no lista ni revela empresas de otro estudio', async () => {
    const lista = await request(app).get('/api/empresas').set(auth(tokenA));
    expect(lista.status).toBe(200);
    expect(lista.body.datos.map((e) => e.id)).toEqual([A.empresa.id]);

    const ajena = await request(app).get(`/api/empresas/${B.empresa.id}`).set(auth(tokenA));
    expect(ajena.status).toBe(404);
  });

  it('no puede crear sedes en una empresa de otro estudio', async () => {
    const r = await request(app).post('/api/sedes').set(auth(tokenA)).send({ empresaId: B.empresa.id, nombre: 'Intrusa' });
    expect(r.status).toBe(404);
  });

  it('no puede asignar roles de otro estudio', async () => {
    const u = await crearUsuario(A.tenant.id, 'u-roles-ajenos');
    const r = await request(app)
      .post(`/api/usuarios/${u.id}/asignaciones`)
      .set(auth(tokenA))
      .send({ rolId: B.roles.Contador.id, alcanceTipo: 'estudio' });
    expect(r.status).toBe(404);
  });

  it('RLS: sin tenant fijado la conexión de aplicación no ve filas', async () => {
    expect(await prismaApp.empresa.count()).toBe(0);
  });
});

describe('RBAC con alcances', () => {
  let almacenero, tokenAlm;

  beforeAll(async () => {
    almacenero = await crearUsuario(A.tenant.id, 'almacenero');
    const r = await request(app)
      .post(`/api/usuarios/${almacenero.id}/asignaciones`)
      .set(auth(tokenA))
      .send({ rolId: A.roles.Almacenero.id, alcanceTipo: 'almacen', alcanceId: A.a1.id });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    tokenAlm = (await login(almacenero.email)).token;
  });

  it('el almacenero solo ve su almacén', async () => {
    const r = await request(app).get('/api/almacenes').set(auth(tokenAlm));
    expect(r.body.datos.map((a) => a.id)).toEqual([A.a1.id]);
    expect((await request(app).get(`/api/almacenes/${A.a2.id}`).set(auth(tokenAlm))).status).toBe(404);
    expect((await request(app).get(`/api/almacenes/${A.a1.id}`).set(auth(tokenAlm))).status).toBe(200);
  });

  it('sin el permiso en ningún alcance recibe 403', async () => {
    expect((await request(app).post('/api/empresas').set(auth(tokenAlm)).send({ razonSocial: 'X', ruc: '20111111111' })).status).toBe(403);
    expect((await request(app).get('/api/usuarios').set(auth(tokenAlm))).status).toBe(403);
  });

  it('el selector de contexto muestra la empresa de su almacén', async () => {
    const r = await request(app).get('/api/me/contexto').set(auth(tokenAlm));
    expect(r.body.empresas.map((e) => e.id)).toEqual([A.empresa.id]);
  });

  it('una excepción deny se aplica de inmediato (caché invalidada)', async () => {
    const r = await request(app)
      .post(`/api/usuarios/${almacenero.id}/excepciones`)
      .set(auth(tokenA))
      .send({ permiso: 'almacenes.almacen.ver', efecto: 'deny', alcanceTipo: 'almacen', alcanceId: A.a1.id });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await request(app).get(`/api/almacenes/${A.a1.id}`).set(auth(tokenAlm))).status).toBe(404);

    await request(app).delete(`/api/usuarios/${almacenero.id}/excepciones/${r.body.id}`).set(auth(tokenA)).expect(204);
    expect((await request(app).get(`/api/almacenes/${A.a1.id}`).set(auth(tokenAlm))).status).toBe(200);
  });

  it('la suspensión cierra las sesiones activas de inmediato', async () => {
    const u = await crearUsuario(A.tenant.id, 'a-suspender');
    await request(app).post(`/api/usuarios/${u.id}/asignaciones`).set(auth(tokenA))
      .send({ rolId: A.roles.Almacenero.id, alcanceTipo: 'almacen', alcanceId: A.a1.id }).expect(201);
    const { token } = await login(u.email);
    expect((await request(app).get('/api/me').set(auth(token))).status).toBe(200);

    await request(app).patch(`/api/usuarios/${u.id}/estado`).set(auth(tokenA)).send({ estado: 'suspendido' }).expect(200);
    expect((await request(app).get('/api/me').set(auth(token))).status).toBe(401);
    expect((await request(app).post('/api/auth/login').send({ email: u.email, password: PASSWORD })).status).toBe(401);
  });
});

describe('reglas anti-escalamiento', () => {
  it('no puede modificar sus propios permisos', async () => {
    const r = await request(app)
      .post(`/api/usuarios/${A.admin.id}/asignaciones`)
      .set(auth(tokenA))
      .send({ rolId: A.roles.Contador.id, alcanceTipo: 'estudio' });
    expect(r.status).toBe(403);
    const rol = await request(app).put(`/api/roles/${A.roles.Administrador.id}`).set(auth(tokenA))
      .send({ nombre: 'Administrador', permisos: [] });
    expect(rol.status).toBe(403);
  });

  it('no puede otorgar permisos que no tiene ni asignar roles fuera de su alcance', async () => {
    // Gestor de la empresa: puede gestionar roles, pero solo dentro de su empresa y sin ver costos
    const crear = await request(app).post('/api/roles').set(auth(tokenA)).send({
      nombre: `Gestor ${sufijo}`,
      permisos: ['usuarios.roles.gestionar', 'usuarios.roles.ver', 'almacenes.almacen.ver'],
    });
    expect(crear.status, JSON.stringify(crear.body)).toBe(201);
    const gestor = await crearUsuario(A.tenant.id, 'gestor');
    await request(app).post(`/api/usuarios/${gestor.id}/asignaciones`).set(auth(tokenA))
      .send({ rolId: crear.body.id, alcanceTipo: 'empresa', alcanceId: A.empresa.id }).expect(201);
    const { token } = await login(gestor.email);
    const objetivo = await crearUsuario(A.tenant.id, 'objetivo');

    // Rol con permisos que el gestor no tiene → 403
    const r1 = await request(app).post('/api/roles').set(auth(token)).send({ nombre: `Escala ${sufijo}`, permisos: ['kardex.costos.ver'] });
    expect(r1.status).toBe(403);

    // Asignar Almacenero (tiene permisos que el gestor no posee) → 403
    const r2 = await request(app).post(`/api/usuarios/${objetivo.id}/asignaciones`).set(auth(token))
      .send({ rolId: A.roles.Almacenero.id, alcanceTipo: 'almacen', alcanceId: A.a1.id });
    expect(r2.status).toBe(403);

    // Asignar a nivel estudio (fuera de su alcance) → 404
    const r3 = await request(app).post(`/api/usuarios/${objetivo.id}/asignaciones`).set(auth(token))
      .send({ rolId: crear.body.id, alcanceTipo: 'estudio' });
    expect(r3.status).toBe(404);
  });

  it('un usuario cliente solo recibe permisos de lectura sobre su empresa', async () => {
    const cliente = await crearUsuario(A.tenant.id, 'cliente', { tipo: 'cliente', empresaId: A.empresa.id });
    const mal = await request(app).post(`/api/usuarios/${cliente.id}/asignaciones`).set(auth(tokenA))
      .send({ rolId: A.roles.Contador.id, alcanceTipo: 'empresa', alcanceId: A.empresa.id });
    expect(mal.status).toBe(400);
    const bien = await request(app).post(`/api/usuarios/${cliente.id}/asignaciones`).set(auth(tokenA))
      .send({ rolId: A.roles['Cliente (portal)'].id, alcanceTipo: 'empresa', alcanceId: A.empresa.id });
    expect(bien.status).toBe(201);
  });

  it('los roles del sistema no se eliminan', async () => {
    expect((await request(app).delete(`/api/roles/${A.roles.Contador.id}`).set(auth(tokenA))).status).toBe(409);
  });
});

describe('sesiones y auditoría', () => {
  it('rota el refresh token y detecta reutilización', async () => {
    const { cookie } = await login(A.admin.email);
    const r1 = await request(app).post('/api/auth/refresh').set('X-Requested-With', 'XMLHttpRequest').set('Cookie', cookie);
    expect(r1.status).toBe(200);
    // Reutilizar el token anterior invalida la sesión
    const r2 = await request(app).post('/api/auth/refresh').set('X-Requested-With', 'XMLHttpRequest').set('Cookie', cookie);
    expect(r2.status).toBe(401);
    const r3 = await request(app).post('/api/auth/refresh').set('X-Requested-With', 'XMLHttpRequest').set('Cookie', r1.headers['set-cookie']);
    expect(r3.status).toBe(401);
  });

  it('refresh sin cabecera XHR es rechazado (CSRF)', async () => {
    expect((await request(app).post('/api/auth/refresh')).status).toBe(403);
  });

  it('registra la auditoría y es inmutable', async () => {
    const r = await request(app).get('/api/auditoria?modulo=usuarios').set(auth(tokenA));
    expect(r.status).toBe(200);
    expect(r.body.total).toBeGreaterThan(0);
    await expect(prismaSystem.auditoria.deleteMany({ where: { tenantId: A.tenant.id } })).rejects.toThrow();
  });
});
