import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import argon2 from 'argon2';

const { crearApp } = await import('../src/app.js');
const { prismaSystem, prismaApp, withTenant } = await import('../src/lib/prisma.js');
const { redis } = await import('../src/lib/redis.js');
const { crearEstudio } = await import('../src/services/estudios.js');
const { invalidarPermisosEstudio } = await import('../src/rbac/servicio.js');
const { listarPeriodos } = await import('../src/sire/servicio.js');
const { desplazar, diasHasta, grupoCronograma, periodoActual, periodosHasta } = await import('../src/sire/periodos.js');

const app = crearApp();
const PASSWORD = 'Prueba123!';
const sufijo = crypto.randomBytes(4).toString('hex');
const auth = (t) => ({ Authorization: `Bearer ${t}` });
let F;
const T = {};
const api = (token) => ({
  get: (u) => request(app).get(`/api${u}`).set(auth(token)),
  put: (u, b) => request(app).put(`/api${u}`).set(auth(token)).send(b),
  post: (u, b) => request(app).post(`/api${u}`).set(auth(token)).send(b),
});
// RUC terminado en 7 (grupo 7 del cronograma)
const RUC = '20100070970'.slice(0, 10) + '7';

beforeAll(async () => {
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  F = await prismaSystem.$transaction(async (tx) => {
    const { tenant, roles } = await crearEstudio(tx, { nombre: `SIRE-${sufijo}` });
    const empresa = await tx.empresa.create({ data: { tenantId: tenant.id, razonSocial: 'Comercial SIRE SAC', ruc: RUC } });
    const usuario = (nombre, rol) =>
      tx.usuario.create({
        data: {
          tenantId: tenant.id, nombres: nombre, email: `${nombre}-${sufijo}@test.local`, estado: 'activo', passwordHash: hash,
          asignaciones: { create: { tenantId: tenant.id, rolId: roles[rol].id, alcanceTipo: 'estudio', alcanceId: null } },
        },
      });
    return { tenant, empresa, admin: await usuario('admin', 'Administrador'), asistente: await usuario('asistente', 'Asistente'), almacenero: await usuario('almacenero', 'Almacenero') };
  });
  for (const k of ['admin', 'asistente', 'almacenero']) T[k] = (await request(app).post('/api/auth/login').send({ email: F[k].email, password: PASSWORD })).body.accessToken;
});

afterAll(async () => {
  await prismaSystem.cronogramaSunat.deleteMany({ where: { periodo: { startsWith: '2099' } } });
  await Promise.all([prismaSystem.$disconnect(), prismaApp.$disconnect(), redis.quit()]);
});

describe('SIRE: base', () => {
  it('períodos y grupos del cronograma', () => {
    expect(desplazar('202601', -1)).toBe('202512');
    expect(desplazar('202612', 1)).toBe('202701');
    expect(periodosHasta('202602', 3)).toEqual(['202602', '202601', '202512']);
    expect(grupoCronograma({ ruc: '20601234565', buenContribuyente: false })).toBe('5');
    expect(grupoCronograma({ ruc: '20601234565', buenContribuyente: true })).toBe('BC');
    expect(diasHasta('2026-10-14', '2026-10-07')).toBe(7);
    expect(diasHasta('2026-10-01', '2026-10-07')).toBe(-6);
  });

  it('es un módulo aparte: sin contratarlo no hay acceso', async () => {
    const plan = await prismaSystem.plan.create({ data: { codigo: `SIN-SIRE-${sufijo}`, nombre: 'Sin SIRE', precioMensual: 99, modulos: ['inventario', 'facturacion'] } });
    await prismaSystem.tenant.update({ where: { id: F.tenant.id }, data: { planId: plan.id } });
    await invalidarPermisosEstudio(F.tenant.id);
    expect((await api(T.admin).get(`/sire/periodos?empresaId=${F.empresa.id}`)).status).toBe(403);
    await prismaSystem.tenant.update({ where: { id: F.tenant.id }, data: { modulosAdicionales: ['sire'] } });
    await invalidarPermisosEstudio(F.tenant.id);
    expect((await api(T.admin).get(`/sire/periodos?empresaId=${F.empresa.id}`)).status).toBe(200);
  });

  it('credenciales: se guardan cifradas y nunca vuelven al navegador', async () => {
    expect((await api(T.asistente).get(`/sire/config?empresaId=${F.empresa.id}`)).status).toBe(403);
    // Con SUNAT real, sin todas las credenciales no se guarda
    const incompleta = await api(T.admin).put('/sire/config', { empresaId: F.empresa.id, modo: 'SUNAT', clientId: 'abc' });
    expect(incompleta.status).toBe(400);
    expect(incompleta.body.error).toMatch(/client_secret.*usuario SOL.*clave SOL/);

    const r = await api(T.admin).put('/sire/config', { empresaId: F.empresa.id, modo: 'SIMULADO', clientId: 'cid-1', clientSecret: 'secreto-api', usuarioSol: 'sireuser', claveSol: 'clave-sol-1' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ usuarioSol: 'SIREUSER', tieneClientSecret: true, tieneClaveSol: true });
    expect(JSON.stringify(r.body)).not.toMatch(/secreto-api|clave-sol-1/);
    const fila = await prismaSystem.configSire.findUnique({ where: { empresaId: F.empresa.id } });
    expect(fila.claveSolCifrada).not.toContain('clave-sol-1');

    // Guardar sin secretos conserva los anteriores
    const otra = await api(T.admin).put('/sire/config', { empresaId: F.empresa.id, modo: 'SIMULADO', clientId: 'cid-1', usuarioSol: 'sireuser' });
    expect(otra.body.tieneClaveSol).toBe(true);
    const aud = await prismaSystem.auditoria.findFirst({ where: { tenantId: F.tenant.id, accion: 'configuracion.editar', modulo: 'sire' }, orderBy: { fecha: 'desc' } });
    expect(aud).toBeTruthy();
    expect(JSON.stringify([aud.antes, aud.despues])).not.toMatch(/secreto-api|clave-sol-1/);
  });

  it('probar conexión deja constancia del error', async () => {
    expect((await api(T.admin).post('/sire/config/probar', { empresaId: F.empresa.id })).body.ok).toBe(true);
    await api(T.admin).put('/sire/config', { empresaId: F.empresa.id, modo: 'SIMULADO', usuarioSol: 'ERROR1' });
    const r = (await api(T.admin).post('/sire/config/probar', { empresaId: F.empresa.id })).body;
    expect(r).toMatchObject({ ok: false });
    expect(r.mensaje).toMatch(/clave SOL/);
    expect((await api(T.admin).get(`/sire/config?empresaId=${F.empresa.id}`)).body.ultimoError).toMatch(/clave SOL/);
    await api(T.admin).put('/sire/config', { empresaId: F.empresa.id, modo: 'SIMULADO', usuarioSol: 'SIREUSER' });
  });

  it('períodos: el mes en curso y los 11 anteriores; sincronizar trae lo ya generado en SUNAT', async () => {
    const r = await api(T.asistente).get(`/sire/periodos?empresaId=${F.empresa.id}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.periodos).toHaveLength(12);
    expect(r.body.periodos[0]).toMatchObject({ periodo: periodoActual(), enCurso: true, estadoRvie: 'PENDIENTE', estadoRce: 'PENDIENTE' });
    expect(r.body.empresa.grupoCronograma).toBe('7');
    // El asistente ve, pero no sincroniza
    expect(r.body.acciones).toEqual({ sincronizar: false, configurar: false });
    expect((await api(T.asistente).post('/sire/periodos/sincronizar', { empresaId: F.empresa.id })).status).toBe(403);
    expect((await api(T.almacenero).get(`/sire/periodos?empresaId=${F.empresa.id}`)).status).toBe(403);

    const s = await api(T.admin).post('/sire/periodos/sincronizar', { empresaId: F.empresa.id });
    expect(s.body.ok, JSON.stringify(s.body)).toBe(true);
    expect(s.body.mensaje).toMatch(/generados/);
    const p = (await api(T.admin).get(`/sire/periodos?empresaId=${F.empresa.id}`)).body.periodos;
    const porPeriodo = Object.fromEntries(p.map((x) => [x.periodo, x]));
    const anterior = desplazar(periodoActual(), -1);
    const antiguo = desplazar(periodoActual(), -3);
    expect([porPeriodo[anterior].estadoRvie, porPeriodo[anterior].estadoRce]).toEqual(['PENDIENTE', 'PENDIENTE']);
    expect([porPeriodo[antiguo].estadoRvie, porPeriodo[antiguo].estadoRce]).toEqual(['GENERADO', 'GENERADO']);
    expect(porPeriodo[antiguo].diasParaVencer).toBeNull();
    // Volver a sincronizar no cambia nada
    expect((await api(T.admin).post('/sire/periodos/sincronizar', { empresaId: F.empresa.id })).body.mensaje).toMatch(/sin cambios/);
  });

  it('vencimiento según el último dígito del RUC (o buen contribuyente)', async () => {
    await prismaSystem.cronogramaSunat.createMany({
      data: [
        { periodo: '209901', grupo: '7', vencimiento: new Date('2099-02-18T00:00:00Z') },
        { periodo: '209901', grupo: 'BC', vencimiento: new Date('2099-02-21T00:00:00Z') },
      ],
      skipDuplicates: true,
    });
    const leer = (empresa) => withTenant(F.tenant.id, (tx) => listarPeriodos(tx, empresa, { n: 1, hasta: '209901' }));
    const [normal] = await leer({ ...F.empresa, buenContribuyente: false });
    expect(normal).toMatchObject({ periodo: '209901', etiqueta: 'Enero 2099', vencimiento: '2099-02-18' });
    expect(normal.diasParaVencer).toBeGreaterThan(0);
    const [bc] = await leer({ ...F.empresa, buenContribuyente: true });
    expect(bc.vencimiento).toBe('2099-02-21');
  });
});
