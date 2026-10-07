import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import argon2 from 'argon2';
import { Prisma } from '@prisma/client';

const { crearApp } = await import('../src/app.js');
const { prismaSystem, prismaApp } = await import('../src/lib/prisma.js');
const { redis } = await import('../src/lib/redis.js');
const { crearEstudio } = await import('../src/services/estudios.js');
const { cuerpoGuiaNubefact } = await import('../src/cpe/proveedores/nubefact.js');
const { hoyLima } = await import('../src/pos/reglas.js');

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
const RUC = '20100070970';

beforeAll(async () => {
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  F = await prismaSystem.$transaction(async (tx) => {
    const { tenant, roles } = await crearEstudio(tx, { nombre: `GRE-${sufijo}` });
    const empresa = await tx.empresa.create({ data: { tenantId: tenant.id, razonSocial: 'Distribuidora Guías SAC', ruc: RUC } });
    const s1 = await tx.sede.create({ data: { tenantId: tenant.id, empresaId: empresa.id, nombre: 'Central', direccion: 'Av. Argentina 123, Cercado', ubigeo: '150101', codigoEstablecimiento: '0000' } });
    const s2 = await tx.sede.create({ data: { tenantId: tenant.id, empresaId: empresa.id, nombre: 'Norte', direccion: 'Av. Túpac Amaru 900, Comas', ubigeo: '150110', codigoEstablecimiento: '0001' } });
    const a1 = await tx.almacen.create({ data: { tenantId: tenant.id, empresaId: empresa.id, sedeId: s1.id, codigo: 'A1', nombre: 'Principal' } });
    const a2 = await tx.almacen.create({ data: { tenantId: tenant.id, empresaId: empresa.id, sedeId: s2.id, codigo: 'A2', nombre: 'Norte' } });
    const unidad = await tx.unidadMedida.findFirst({ where: { tenantId: tenant.id, codigo: 'NIU' } });
    const p1 = await tx.producto.create({ data: { tenantId: tenant.id, empresaId: empresa.id, sku: 'CEM', nombre: 'Cemento 42.5 kg', unidadId: unidad.id, precioReferencial: 30 } });
    await tx.configFacturacion.create({ data: { tenantId: tenant.id, empresaId: empresa.id, proveedor: 'SIMULADO', envioAutomatico: false } });
    const usuario = (nombre, rol, alcanceTipo, alcanceId) =>
      tx.usuario.create({
        data: {
          tenantId: tenant.id, nombres: nombre, email: `${nombre}-${sufijo}@test.local`, estado: 'activo', passwordHash: hash,
          asignaciones: { create: { tenantId: tenant.id, rolId: roles[rol].id, alcanceTipo, alcanceId } },
        },
      });
    return {
      tenant, empresa, a1, a2, p1,
      admin: await usuario('admin', 'Administrador', 'estudio', null),
      alm1: await usuario('alm1', 'Almacenero', 'almacen', a1.id),
      alm2: await usuario('alm2', 'Almacenero', 'almacen', a2.id),
    };
  });
  for (const k of ['admin', 'alm1', 'alm2']) T[k] = (await request(app).post('/api/auth/login').send({ email: F[k].email, password: PASSWORD })).body.accessToken;
  await api(T.admin).post('/kardex/entradas', { almacenId: F.a1.id, motivo: 'COMPRA', items: [{ productoId: F.p1.id, cantidad: '500', costoUnitario: '25' }] }).expect(201);
});

afterAll(async () => {
  await Promise.all([prismaSystem.$disconnect(), prismaApp.$disconnect(), redis.quit()]);
});

describe('guía de remisión electrónica', () => {
  let guia;
  const privado = { modalidad: 'PRIVADO', conductorTipoDoc: 'DNI', conductorNumDoc: '46027897', conductorNombres: 'Juan', conductorApellidos: 'Pérez Ruiz', conductorLicencia: 'Q46027897', vehiculoPlaca: 'ABC-123' };

  it('desde una transferencia: punto de partida y llegada de cada sede, destinatario la propia empresa', async () => {
    const t = (await api(T.admin).post('/transferencias', { origenAlmacenId: F.a1.id, destinoAlmacenId: F.a2.id, items: [{ productoId: F.p1.id, cantidad: '40' }] })).body;
    await api(T.admin).post(`/transferencias/${t.id}/aprobar`).expect(200);
    await api(T.alm1).post(`/transferencias/${t.id}/despachar`, { items: [{ productoId: F.p1.id, cantidad: '40' }] });
    const b = await api(T.alm1).get(`/guias/preparar?desde=transferencia&id=${t.id}`);
    expect(b.status, JSON.stringify(b.body)).toBe(200);
    expect(b.body).toMatchObject({
      motivo: '04', destinatarioNumDoc: RUC, partidaUbigeo: '150101', llegadaUbigeo: '150110', partidaEstablecimiento: '0000', llegadaEstablecimiento: '0001',
      items: [{ descripcion: 'Cemento 42.5 kg', cantidad: '40' }], guiasPrevias: 0,
    });

    // Validaciones: falta el conductor / placa en transporte privado; peso cero
    const incompleta = await api(T.alm1).post('/guias', { ...b.body, modalidad: 'PRIVADO', pesoBruto: 1700 });
    expect(incompleta.status).toBe(400);
    expect(incompleta.body.error).toMatch(/Conductor|conductor/);
    expect((await api(T.alm1).post('/guias', { ...b.body, ...privado, pesoBruto: 0 })).status).toBe(400);

    const r = await api(T.alm1).post('/guias', { ...b.body, ...privado, pesoBruto: 1700, bultos: 40 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect([r.body.serie, r.body.numero]).toEqual(['T001', 1]);
    guia = r.body;
    const d = (await api(T.alm1).get(`/guias/${guia.id}`)).body;
    expect([d.vehiculoPlaca, d.motivoTexto, d.estadoSunat]).toEqual(['ABC123', 'Traslado entre establecimientos de la misma empresa', 'PENDIENTE']);
  });

  it('se envía a SUNAT (por ticket: enviada y luego aceptada) y no se puede alterar', async () => {
    expect((await api(T.alm1).post(`/guias/${guia.id}/enviar`)).body.estado).toBe('ENVIADO');
    expect((await api(T.alm1).post(`/guias/${guia.id}/enviar`)).body.estado).toBe('ACEPTADO');
    const d = (await api(T.alm1).get(`/guias/${guia.id}`)).body;
    expect(d.sunatHash).toBeTruthy();
    expect(d.qr).toMatch(/^data:image\/png/);
    expect(d.acciones).toEqual({ enviar: false, anular: false });
    await expect(prismaSystem.guiaRemision.update({ where: { id: guia.id }, data: { pesoBruto: 1 } })).rejects.toThrow(/no se modifica/);
    expect((await api(T.alm1).post(`/guias/${guia.id}/anular`, { motivo: 'no salió el camión' })).status).toBe(409);
  });

  it('cada almacenero ve solo las guías que salen de su almacén', async () => {
    expect((await api(T.alm2).get(`/guias/${guia.id}`)).status).toBe(404);
    expect((await api(T.alm2).get(`/guias?empresaId=${F.empresa.id}`)).body.total).toBe(0);
    expect((await api(T.alm1).get(`/guias?empresaId=${F.empresa.id}`)).body.total).toBe(1);
  });

  it('transporte público con transportista; traslado a la misma dirección no se permite', async () => {
    const base = {
      almacenId: F.a1.id, fechaTraslado: hoyLima(), motivo: '04', destinatarioTipoDoc: 'RUC', destinatarioNumDoc: RUC, destinatarioNombre: 'Distribuidora Guías SAC',
      partidaUbigeo: '150101', partidaDireccion: 'Av. Argentina 123, Cercado', llegadaUbigeo: '150101', llegadaDireccion: 'Av. Argentina 123, Cercado',
      pesoBruto: 50, items: [{ productoId: F.p1.id, cantidad: '2' }],
      modalidad: 'PUBLICO', transportistaRuc: '20131312955', transportistaNombre: 'Transportes Rápidos SAC',
    };
    const misma = await api(T.admin).post('/guias', base);
    expect(misma.status).toBe(400);
    expect(misma.body.error).toMatch(/misma dirección/);
    const ok = await api(T.admin).post('/guias', { ...base, llegadaUbigeo: '150110', llegadaDireccion: 'Av. Túpac Amaru 900, Comas' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    // Sin enviar todavía: se puede anular
    expect((await api(T.admin).post(`/guias/${ok.body.id}/anular`, { motivo: 'Se reprogramó el traslado' })).status).toBe(200);
    expect((await api(T.admin).post(`/guias/${ok.body.id}/enviar`)).body.mensaje).toMatch(/anulada/);
  });

  it('formato Nubefact de la guía', () => {
    const D = (v) => new Prisma.Decimal(v);
    const c = cuerpoGuiaNubefact({
      serie: 'T001', numero: 5, fecha: '2026-10-07', fechaTraslado: '2026-10-08', motivo: '01', modalidad: 'PRIVADO',
      destinatario: { tipoDocumento: 'RUC', numeroDocumento: '20131312955', nombre: 'Cliente SAC' },
      partida: { ubigeo: '150101', direccion: 'Av. A 1', establecimiento: '0000' }, llegada: { ubigeo: '150110', direccion: 'Av. B 2', establecimiento: null },
      pesoBruto: D('120.5'), unidadPeso: 'KGM', bultos: 3, vehiculoPlaca: 'ABC123',
      conductor: { tipoDocumento: 'DNI', numeroDocumento: '46027897', nombres: 'Juan', apellidos: 'Pérez', licencia: 'Q46027897' },
      documentoRelacionado: { tipo: '01', serie: 'F001', numero: '12' },
      items: [{ codigo: 'CEM', descripcion: 'Cemento', unidad: 'NIU', cantidad: D('4') }],
    });
    expect(c).toMatchObject({
      operacion: 'generar_guia', tipo_de_comprobante: 7, motivo_de_traslado: '01', tipo_de_transporte: '02', fecha_de_inicio_de_traslado: '08-10-2026',
      peso_bruto_total: 120.5, transportista_placa_numero: 'ABC123', conductor_numero_licencia: 'Q46027897', punto_de_llegada_ubigeo: '150110',
      documento_relacionado: [{ tipo: '01', serie: 'F001', numero: '12' }],
    });
  });
});
