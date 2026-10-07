import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import argon2 from 'argon2';

const { crearApp } = await import('../src/app.js');
const { prismaSystem, prismaApp } = await import('../src/lib/prisma.js');
const { redis } = await import('../src/lib/redis.js');
const { crearEstudio } = await import('../src/services/estudios.js');
const { claveCp, conciliar, fila } = await import('../src/sire/conciliacion.js');
const { leerPropuestaRce } = await import('../src/sire/formatos.js');
const { periodoActual } = await import('../src/sire/periodos.js');
const { default: sunat } = await import('../src/sire/proveedores/sunat.js');

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
});
const PERIODO = periodoActual();
const hoy = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());

beforeAll(async () => {
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  F = await prismaSystem.$transaction(async (tx) => {
    const { tenant, roles } = await crearEstudio(tx, { nombre: `RCE-${sufijo}` });
    const empresa = await tx.empresa.create({ data: { tenantId: tenant.id, razonSocial: 'Compras SIRE SAC', ruc: '20100070970' } });
    const sede = await tx.sede.create({ data: { tenantId: tenant.id, empresaId: empresa.id, nombre: 'Oficina' } });
    const a1 = await tx.almacen.create({ data: { tenantId: tenant.id, empresaId: empresa.id, sedeId: sede.id, codigo: 'A1', nombre: 'A1' } });
    await tx.configSire.create({ data: { tenantId: tenant.id, empresaId: empresa.id, modo: 'SIMULADO' } });
    const usuario = (nombre, rol) =>
      tx.usuario.create({
        data: {
          tenantId: tenant.id, nombres: nombre, email: `${nombre}-${sufijo}@test.local`, estado: 'activo', passwordHash: hash,
          asignaciones: { create: { tenantId: tenant.id, rolId: roles[rol].id, alcanceTipo: 'estudio', alcanceId: null } },
        },
      });
    const admin = await usuario('admin', 'Administrador');
    const compra = (terceroDocumento, terceroNombre, serie, numero, subtotal, extra = {}) =>
      tx.documentoComercial.create({
        data: {
          tenantId: tenant.id, empresaId: empresa.id, sedeId: sede.id, almacenId: a1.id, tipo: 'COMPRA', estado: 'CONFIRMADO',
          terceroDocumento, terceroNombre, comprobanteTipo: 'FACTURA', serie, numero, fechaEmision: new Date(`${hoy()}T00:00:00Z`),
          subtotal, igv: subtotal * 0.18, total: subtotal * 1.18, creadoPorId: admin.id, ...extra,
        },
      });
    return {
      tenant, empresa, admin,
      asistente: await usuario('asistente', 'Asistente'),
      // Misma serie y número de dos proveedores distintos: no se confunden
      c1: await compra('20131312955', 'Proveedor Uno SAC', 'F001', '100', 100),
      c2: await compra('20512345678', 'Proveedor Dos SAC', 'F001', '100', 50),
      // Comprobante físico: no llega a SUNAT, hay que incluirlo
      fisica: await compra('20131312955', 'Proveedor Uno SAC', '0001', '555', 200),
      // Sujeta a detracción, sin depositar todavía
      spot: await compra('20512345678', 'Proveedor Dos SAC', 'F010', '77', 1000, { detraccionMonto: 120 }),
      // Proveedor del exterior: va al registro de no domiciliados
      exterior: await compra('US-998877', 'Cloud Services Inc', 'INV', '9001', 300),
    };
  });
  for (const k of ['admin', 'asistente']) T[k] = (await request(app).post('/api/auth/login').send({ email: F[k].email, password: PASSWORD })).body.accessToken;
});

afterAll(async () => {
  await Promise.all([prismaSystem.$disconnect(), prismaApp.$disconnect(), redis.quit()]);
});

describe('SIRE: compras (lógica)', () => {
  it('la clave lleva el RUC del proveedor', () => {
    expect(claveCp('01', 'f001', '00000100', '20131312955')).toBe('01-20131312955-F001-100');
    const a = fila({ tipoCp: '01', serie: 'F001', numero: 100, emisor: '20131312955', total: 118, igv: 18 });
    const b = fila({ tipoCp: '01', serie: 'F001', numero: 100, emisor: '20512345678', total: 59, igv: 9 });
    expect(conciliar([a], [b]).diferencias.map((d) => d.tipo).sort()).toEqual(['SOLO_SISTEMA', 'SOLO_SUNAT']);
  });

  it('lee el TXT de la propuesta del RCE', () => {
    const c = Array(42).fill('');
    Object.assign(c, { 0: '20100070970', 4: '03/09/2026', 6: '01', 7: 'F001', 9: '00000100', 11: '6', 12: '20131312955', 13: 'PROVEEDOR UNO SAC', 14: '100.00', 15: '18.00', 18: '10.00', 19: '1.80', 24: '129.80', 25: 'PEN' });
    const [f] = leerPropuestaRce(['RUC|...', c.join('|')].join('\n'));
    expect(f).toMatchObject({ clave: '01-20131312955-F001-100', fechaEmision: '2026-09-03', baseGravada: 110, igv: 19.8, total: 129.8, nombre: 'PROVEEDOR UNO SAC' });
  });

  it('SUNAT real: los ajustes del RCE todavía se hacen en SOL', async () => {
    await expect(sunat.aceptarPropuesta({}, { ruc: '20100070970', registro: 'RCE', periodo: '202609', ajustes: { incluir: [{}], excluir: [] } }))
      .rejects.toThrow(/Operaciones en Línea/);
  });
});

describe('SIRE: registro de compras (RCE)', () => {
  const base = `/sire/registros/RCE/${PERIODO}`;
  const resumen = async () => (await api(T.admin).get(`${base}?empresaId=${F.empresa.id}`)).body;
  const diferencias = async () => (await api(T.admin).get(`${base}/diferencias?empresaId=${F.empresa.id}`)).body.datos;

  it('antes de descargar: compras del sistema, detracción sin depositar y no domiciliados aparte', async () => {
    const r = await resumen();
    expect(r.estado).toBe('PENDIENTE');
    expect(r.sistema.cantidad).toBe(4);
    expect(r.compras).toMatchObject({ igvSinCredito: 180, noDomiciliados: 1 });
    expect(r.compras.detraccionesPendientes).toEqual([expect.objectContaining({ id: F.spot.id, serie: 'F010', numero: '77' })]);
  });

  it('descarga y concilia: lo que SUNAT trae de más y la compra física que falta', async () => {
    const d = await api(T.admin).post(`${base}/propuesta`, { empresaId: F.empresa.id });
    expect(d.status, JSON.stringify(d.body)).toBe(202);
    const r = await resumen();
    expect(r.estado).toBe('CON_DIFERENCIAS');
    expect(r.operacion.mensaje).toMatch(/3 coinciden/);
    const lista = await diferencias();
    expect(lista.map((x) => `${x.tipo}:${x.docNumero}:${x.serie}-${x.numero}`).sort()).toEqual([
      'SOLO_SISTEMA:20131312955:0001-555',
      'SOLO_SUNAT:20100047218:F005-8890',
    ]);
    expect(lista.find((x) => x.tipo === 'SOLO_SISTEMA').resoluciones).toEqual(['INCLUIDA', 'JUSTIFICADA']);
    expect(lista.find((x) => x.tipo === 'SOLO_SUNAT').resoluciones).toEqual(['ACEPTADA', 'EXCLUIDA', 'JUSTIFICADA']);
  });

  it('incluir la compra física y excluir lo que no corresponde (con motivo)', async () => {
    const lista = await diferencias();
    const deSunat = lista.find((x) => x.tipo === 'SOLO_SUNAT');
    const fisica = lista.find((x) => x.tipo === 'SOLO_SISTEMA');
    const resolver = (id, b, t = T.admin) => api(t).post(`${base}/diferencias/${id}/resolver`, { empresaId: F.empresa.id, ...b });
    expect((await resolver(deSunat.id, { resolucion: 'INCLUIDA' })).status).toBe(400);
    expect((await resolver(deSunat.id, { resolucion: 'EXCLUIDA' })).status).toBe(400);
    expect((await resolver(fisica.id, { resolucion: 'INCLUIDA' }, T.asistente)).status).toBe(403);
    expect((await resolver(deSunat.id, { resolucion: 'EXCLUIDA', nota: 'Compra personal del gerente, no es gasto de la empresa' })).body.pendientes).toBe(1);
    expect((await resolver(fisica.id, { resolucion: 'INCLUIDA' })).body.pendientes).toBe(0);
    expect((await resumen()).estado).toBe('CONCILIADO');
  });

  it('constancia de detracción: sin fecha no se acepta; con ella el IGV ya da crédito', async () => {
    expect((await api(T.admin).put(`/compras/${F.spot.id}/detraccion`, { monto: '120', constancia: '12345678' })).status).toBe(400);
    const ok = await api(T.admin).put(`/compras/${F.spot.id}/detraccion`, { monto: '120', constancia: '12345678', fecha: hoy() });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.detraccionConstancia).toBe('12345678');
    expect((await api(T.admin).get(`/compras/${F.spot.id}`)).body.acciones.detraccion).toBe(true);
    const r = await resumen();
    expect(r.compras).toMatchObject({ detraccionesPendientes: [], igvSinCredito: 0 });
  });

  it('genera el registro con los ajustes', async () => {
    const g = await api(T.admin).post(`${base}/generar`, { empresaId: F.empresa.id });
    expect(g.status, JSON.stringify(g.body)).toBe(202);
    const r = await resumen();
    expect(r.estado).toBe('GENERADO');
    expect(r.generacion.mensaje).toMatch(/2 ajuste/);
    const p = (await api(T.admin).get(`/sire/periodos?empresaId=${F.empresa.id}`)).body.periodos[0];
    expect(p).toMatchObject({ periodo: PERIODO, estadoRce: 'GENERADO', estadoRvie: 'PENDIENTE' });
  });
});
