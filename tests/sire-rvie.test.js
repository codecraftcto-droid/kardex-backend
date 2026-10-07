import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import argon2 from 'argon2';
import { zipSync, strToU8 } from 'fflate';

const { crearApp } = await import('../src/app.js');
const { prismaSystem, prismaApp, withTenant } = await import('../src/lib/prisma.js');
const { redis } = await import('../src/lib/redis.js');
const { crearEstudio } = await import('../src/services/estudios.js');
const { cifrar } = await import('../src/services/mfa.js');
const { conciliar, fila, totales } = await import('../src/sire/conciliacion.js');
const { leerPropuestaRvie, textoDeArchivo } = await import('../src/sire/formatos.js');
const { avanzarOperacion, iniciarDescarga } = await import('../src/sire/registros.js');
const { desplazar, periodoActual } = await import('../src/sire/periodos.js');

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
const SERIES = { serieFactura: 'F001', serieBoleta: 'B001', serieNotaVenta: 'NV01', serieNotaCreditoFactura: 'FC01', serieNotaCreditoBoleta: 'BC01' };
const PERIODO = periodoActual();
const hoy = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());

beforeAll(async () => {
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  F = await prismaSystem.$transaction(async (tx) => {
    const { tenant, roles } = await crearEstudio(tx, { nombre: `RVIE-${sufijo}` });
    const empresa = await tx.empresa.create({ data: { tenantId: tenant.id, razonSocial: 'Ventas SIRE SAC', ruc: '20100070970' } });
    const empresa2 = await tx.empresa.create({ data: { tenantId: tenant.id, razonSocial: 'Conectada SUNAT SAC', ruc: '20131312955' } });
    const sede = await tx.sede.create({ data: { tenantId: tenant.id, empresaId: empresa.id, nombre: 'Tienda' } });
    const a1 = await tx.almacen.create({ data: { tenantId: tenant.id, empresaId: empresa.id, sedeId: sede.id, codigo: 'A1', nombre: 'A1' } });
    const unidad = await tx.unidadMedida.findFirst({ where: { tenantId: tenant.id, codigo: 'NIU' } });
    const p1 = await tx.producto.create({ data: { tenantId: tenant.id, empresaId: empresa.id, sku: 'P1', nombre: 'Gaseosa 500 ml', unidadId: unidad.id, precioReferencial: 3.5 } });
    await tx.configFacturacion.create({ data: { tenantId: tenant.id, empresaId: empresa.id, proveedor: 'SIMULADO', envioAutomatico: false } });
    await tx.configSire.create({ data: { tenantId: tenant.id, empresaId: empresa.id, modo: 'SIMULADO' } });
    await tx.configSire.create({
      data: {
        tenantId: tenant.id, empresaId: empresa2.id, modo: 'SUNAT', clientId: `cid-${sufijo}`, clientSecretCifrado: cifrar('secreto'),
        usuarioSol: 'SIREUSER', claveSolCifrada: cifrar('clave'),
      },
    });
    const usuario = (nombre, rol, alcanceTipo, alcanceId, extra = {}) =>
      tx.usuario.create({
        data: {
          tenantId: tenant.id, nombres: nombre, email: `${nombre}-${sufijo}@test.local`, estado: 'activo', passwordHash: hash, ...extra,
          asignaciones: { create: { tenantId: tenant.id, rolId: roles[rol].id, alcanceTipo, alcanceId } },
        },
      });
    return {
      tenant, empresa, empresa2, sede, a1, p1,
      admin: await usuario('admin', 'Administrador', 'estudio', null),
      asistente: await usuario('asistente', 'Asistente', 'estudio', null),
      cajero: await usuario('cajero', 'Cajero', 'almacen', a1.id, { tipo: 'operador', empresaId: empresa.id }),
    };
  });
  for (const k of ['admin', 'asistente', 'cajero']) T[k] = (await request(app).post('/api/auth/login').send({ email: F[k].email, password: PASSWORD })).body.accessToken;
  await api(T.admin).post('/kardex/entradas', { almacenId: F.a1.id, motivo: 'COMPRA', items: [{ productoId: F.p1.id, cantidad: '1000', costoUnitario: '2' }] }).expect(201);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await Promise.all([prismaSystem.$disconnect(), prismaApp.$disconnect(), redis.quit()]);
});

describe('SIRE: conciliación (lógica)', () => {
  const f = (x) => fila({ tipoCp: '01', serie: 'F001', fechaEmision: '2026-09-10', baseGravada: 100, igv: 18, total: 118, ...x });

  it('clasifica coincidencias y diferencias', () => {
    const sunat = [f({ numero: '00000001' }), f({ numero: 2, total: 120 }), f({ numero: 3, anulado: true }), f({ numero: 4 }), f({ numero: 9, anulado: true })];
    const sistema = [f({ numero: 1 }), f({ numero: 2 }), f({ numero: 3 }), f({ numero: 5 }), f({ numero: 6, anulado: true })];
    const r = conciliar(sunat, sistema);
    expect(r.coinciden).toBe(1);
    expect(r.diferencias.map((d) => `${d.tipo}:${d.clave}`).sort()).toEqual(['ESTADO:01-F001-3', 'MONTO:01-F001-2', 'SOLO_SISTEMA:01-F001-5', 'SOLO_SUNAT:01-F001-4']);
  });

  it('totales: las notas de crédito restan y los anulados no suman', () => {
    expect(totales([f({ numero: 1 }), f({ tipoCp: '07', serie: 'FC01', numero: 1, baseGravada: 10, igv: 1.8, total: 11.8 }), f({ numero: 2, anulado: true })]))
      .toEqual({ cantidad: 2, base: 90, igv: 16.2, total: 106.2 });
  });

  it('lee el TXT de la propuesta (también dentro de un ZIP)', () => {
    const c = Array(40).fill('');
    Object.assign(c, { 0: '20100070970', 1: 'VENTAS SAC', 2: '202609', 4: '15/09/2026', 6: '01', 7: 'F001', 8: '00000123', 10: '6', 11: '20131312955', 12: 'CLIENTE SAC', 14: '200.00', 16: '36.00', 25: '236.00', 26: 'PEN' });
    const nc = [...c];
    Object.assign(nc, { 6: '07', 7: 'FC01', 8: '7', 14: '-50.00', 16: '-9.00', 25: '-59.00', 29: '01', 30: 'F001', 31: '123' });
    const txt = ['RUC|Razon Social|Periodo|…', c.join('|'), nc.join('|')].join('\n');
    const filas = leerPropuestaRvie(textoDeArchivo(zipSync({ 'LE2010007097020260900014040001EXP2.txt': strToU8(txt) })));
    expect(filas).toHaveLength(2);
    expect(filas[0]).toMatchObject({ clave: '01-F001-123', fechaEmision: '2026-09-15', docNumero: '20131312955', baseGravada: 200, igv: 36, total: 236, anulado: false });
    expect(filas[1]).toMatchObject({ clave: '07-FC01-7', total: 59, refSerie: 'F001', refNumero: '123' });
  });
});

describe('SIRE: registro de ventas (RVIE)', () => {
  let factura2;
  const base = `/sire/registros/RVIE/${PERIODO}`;
  const resumen = async () => (await api(T.admin).get(`${base}?empresaId=${F.empresa.id}`)).body;

  it('prepara ventas: dos facturas (una sin enviar), una boleta y una venta registrada', async () => {
    const caja = (await api(T.admin).post('/pos/cajas', { nombre: 'Caja 1', almacenId: F.a1.id, ...SERIES })).body;
    await api(T.cajero).post(`/pos/cajas/${caja.id}/abrir`, { montoApertura: '0' }).expect(201);
    const cliente = (await api(T.cajero).post('/clientes', { empresaId: F.empresa.id, tipoDocumento: 'RUC', numeroDocumento: '20131312955', nombre: 'Cliente SAC', direccion: 'Av. Lima 1' })).body;
    const vender = (tipo, extra = {}) => api(T.cajero).post('/pos/ventas', { cajaId: caja.id, tipo, items: [{ productoId: F.p1.id, cantidad: '2' }], pagos: [{ medio: 'EFECTIVO', monto: '7' }], ...extra });
    const f1 = (await vender('FACTURA', { clienteId: cliente.id })).body;
    expect((await api(T.cajero).post(`/cpe/comprobantes/${f1.id}/enviar`)).body.estado).toBe('ACEPTADO');
    factura2 = (await vender('FACTURA', { clienteId: cliente.id })).body;
    const b = (await vender('BOLETA')).body;
    await api(T.cajero).post(`/cpe/comprobantes/${b.id}/enviar`);
    expect((await api(T.cajero).post(`/cpe/comprobantes/${b.id}/enviar`)).body.estado).toBe('ACEPTADO');
    await prismaSystem.documentoComercial.create({
      data: {
        tenantId: F.tenant.id, empresaId: F.empresa.id, sedeId: F.sede.id, almacenId: F.a1.id, tipo: 'VENTA', estado: 'CONFIRMADO',
        terceroDocumento: '20131312955', terceroNombre: 'Cliente SAC', comprobanteTipo: 'FACTURA', serie: 'F900', numero: '0015',
        fechaEmision: new Date(`${hoy()}T00:00:00Z`), subtotal: 100, igv: 18, total: 118, creadoPorId: F.admin.id,
      },
    });
    const r = await resumen();
    expect(r).toMatchObject({ estado: 'PENDIENTE', propuesta: null, etiqueta: expect.any(String) });
    expect(r.sistema.cantidad).toBe(4);
  });

  it('descarga la propuesta y la concilia: lo que solo está en SUNAT y lo que solo está en el sistema', async () => {
    expect((await api(T.asistente).post(`${base}/propuesta`, { empresaId: F.empresa.id })).status).toBe(403);
    const d = await api(T.admin).post(`${base}/propuesta`, { empresaId: F.empresa.id });
    expect(d.status, JSON.stringify(d.body)).toBe(202);
    expect(d.body).toMatchObject({ estado: 'TERMINADO', pendiente: false });

    const r = await resumen();
    expect(r.estado).toBe('CON_DIFERENCIAS');
    expect(r.propuesta.cantidad).toBe(4); // F001-1, B001-1, F900-15 y la E001-1 emitida fuera del sistema
    expect(r.diferencias).toMatchObject({ total: 2, pendientes: 2, porTipo: { SOLO_SUNAT: 1, SOLO_SISTEMA: 1 } });
    expect(r.operacion.mensaje).toMatch(/3 coinciden/);
    expect(r.acciones).toMatchObject({ descargar: true, generar: false });
    // No se genera con diferencias pendientes
    expect((await api(T.admin).post(`${base}/generar`, { empresaId: F.empresa.id })).status).toBe(409);
    // El asistente ve la conciliación
    const lista = (await api(T.asistente).get(`${base}/diferencias?empresaId=${F.empresa.id}`)).body;
    expect(lista.datos.map((x) => `${x.tipo}:${x.serie}-${x.numero}`).sort()).toEqual(['SOLO_SISTEMA:F001-2', 'SOLO_SUNAT:E001-1']);
    expect(lista.datos.find((x) => x.tipo === 'SOLO_SISTEMA')).toMatchObject({ comprobanteId: factura2.id, estadoSunatSistema: 'PENDIENTE' });
  });

  it('resolver: aceptar lo de SUNAT, justificar con nota; lo que falta en SUNAT no se "acepta"', async () => {
    const lista = (await api(T.admin).get(`${base}/diferencias?empresaId=${F.empresa.id}`)).body.datos;
    const soloSunat = lista.find((x) => x.tipo === 'SOLO_SUNAT');
    const soloSistema = lista.find((x) => x.tipo === 'SOLO_SISTEMA');
    const resolver = (id, b, t = T.admin) => api(t).post(`${base}/diferencias/${id}/resolver`, { empresaId: F.empresa.id, ...b });
    expect((await resolver(soloSistema.id, { resolucion: 'ACEPTADA' })).status).toBe(400);
    expect((await resolver(soloSistema.id, { resolucion: 'JUSTIFICADA', nota: 'x' })).status).toBe(400);
    expect((await resolver(soloSunat.id, { resolucion: 'ACEPTADA' }, T.asistente)).status).toBe(403);
    const ok = await resolver(soloSunat.id, { resolucion: 'ACEPTADA', nota: 'Factura emitida desde SEE-SOL por el cliente' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.pendientes).toBe(1);
    // Justificar y deshacer
    expect((await resolver(soloSistema.id, { resolucion: 'JUSTIFICADA', nota: 'Se enviará en el siguiente período' })).body.pendientes).toBe(0);
    expect((await resumen()).estado).toBe('CONCILIADO');
    expect((await resolver(soloSistema.id, { resolucion: 'PENDIENTE' })).body.pendientes).toBe(1);
    expect((await resumen()).estado).toBe('CON_DIFERENCIAS');
  });

  it('se corrige enviando la factura y volviendo a descargar: lo ya resuelto se conserva', async () => {
    expect((await api(T.cajero).post(`/cpe/comprobantes/${factura2.id}/enviar`)).body.estado).toBe('ACEPTADO');
    expect((await api(T.admin).post(`${base}/propuesta`, { empresaId: F.empresa.id })).body.estado).toBe('TERMINADO');
    const r = await resumen();
    expect(r.estado).toBe('CONCILIADO');
    expect(r.diferencias).toMatchObject({ total: 1, pendientes: 0 });
    const propuestas = await prismaSystem.propuestaSire.findMany({ where: { empresaId: F.empresa.id, periodo: PERIODO } });
    expect([propuestas.length, propuestas.filter((p) => p.vigente).length]).toEqual([2, 1]);

    const sunat = (await api(T.admin).get(`${base}/comprobantes?empresaId=${F.empresa.id}&origen=sunat&q=E001`)).body;
    expect(sunat.total).toBe(1);
    expect((await api(T.admin).get(`${base}/comprobantes?empresaId=${F.empresa.id}&origen=sistema`)).body.total).toBe(4);
  });

  it('genera el registro aceptando la propuesta; después ya no se modifica', async () => {
    const g = await api(T.admin).post(`${base}/generar`, { empresaId: F.empresa.id });
    expect(g.status, JSON.stringify(g.body)).toBe(202);
    const r = await resumen();
    expect(r.estado).toBe('GENERADO');
    expect(r.generacion.constancia).toMatch(/^SIM-/);
    expect(r.acciones).toEqual({ descargar: false, resolver: false, generar: false });
    expect((await api(T.admin).post(`${base}/propuesta`, { empresaId: F.empresa.id })).status).toBe(409);
    const d = (await api(T.admin).get(`${base}/diferencias?empresaId=${F.empresa.id}`)).body.datos[0];
    expect((await api(T.admin).post(`${base}/diferencias/${d.id}/resolver`, { empresaId: F.empresa.id, resolucion: 'PENDIENTE' })).status).toBe(409);
    const periodos = (await api(T.admin).get(`/sire/periodos?empresaId=${F.empresa.id}`)).body.periodos;
    expect(periodos[0]).toMatchObject({ periodo: PERIODO, estadoRvie: 'GENERADO' });
  });

  it('una sola operación en curso por período; no se trabaja un período futuro', async () => {
    const anterior = desplazar(PERIODO, -1);
    await prismaSystem.operacionSire.create({ data: { tenantId: F.tenant.id, empresaId: F.empresa.id, periodo: anterior, registro: 'RVIE', tipo: 'PROPUESTA', usuarioId: F.admin.id, ticket: 'X' } });
    const r = await api(T.admin).post(`/sire/registros/RVIE/${anterior}/propuesta`, { empresaId: F.empresa.id });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/en curso/);
    expect((await api(T.admin).get(`/sire/registros/RVIE/${desplazar(PERIODO, 1)}?empresaId=${F.empresa.id}`)).status).toBe(400);
    expect((await api(T.admin).get(`/sire/registros/OTRO/${PERIODO}?empresaId=${F.empresa.id}`)).status).toBe(404);
  });

  it('con SUNAT real: ticket → en proceso → terminado → descarga del ZIP', async () => {
    const c = Array(40).fill('');
    Object.assign(c, { 0: '20131312955', 4: '05/09/2026', 6: '03', 7: 'B001', 8: '45', 10: '1', 11: '46027897', 12: 'JUAN PEREZ', 14: '10.00', 16: '1.80', 25: '11.80', 26: 'PEN' });
    const zip = zipSync({ 'propuesta.txt': strToU8(c.join('|')) });
    let consultas = 0;
    const llamadas = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url);
      llamadas.push(u.replace(/^https:\/\/[^/]+/, ''));
      const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (u.includes('/oauth2/token')) return json({ access_token: 'tk', expires_in: 3600 });
      if (u.includes('/exportapropuesta')) return json({ numTicket: '20260000000123' });
      if (u.includes('/consultaestadotickets')) {
        consultas += 1;
        return json({ registros: [consultas < 2
          ? { numTicket: '20260000000123', codEstadoProceso: '02', desEstadoProceso: 'En proceso' }
          : { numTicket: '20260000000123', codEstadoProceso: '06', desEstadoProceso: 'Terminado', codProceso: '10', archivoReporte: [{ nomArchivoReporte: 'propuesta.zip', codTipoAchivoReporte: '01' }] }] });
      }
      if (u.includes('/archivoreporte')) return new Response(zip, { status: 200 });
      return new Response('{}', { status: 404 });
    }));
    const periodo = desplazar(PERIODO, -1);
    const db = (fn) => withTenant(F.tenant.id, fn);
    const op = await iniciarDescarga(db, { tenantId: F.tenant.id, empresaId: F.empresa2.id, periodo, registro: 'RVIE', usuarioId: F.admin.id });
    expect(await avanzarOperacion({ tenantId: F.tenant.id, operacionId: op.id })).toEqual({ estado: 'PROCESANDO', pendiente: true });
    expect(await avanzarOperacion({ tenantId: F.tenant.id, operacionId: op.id })).toEqual({ estado: 'PROCESANDO', pendiente: true });
    expect(await avanzarOperacion({ tenantId: F.tenant.id, operacionId: op.id })).toEqual({ estado: 'TERMINADO', pendiente: false });
    vi.unstubAllGlobals();

    expect(llamadas.some((l) => l.includes(`/rvie/propuesta/web/propuesta/${periodo}/exportapropuesta`))).toBe(true);
    expect(llamadas.find((l) => l.includes('/archivoreporte'))).toMatch(/codLibro=140000.*numTicket=20260000000123/);
    const guardada = await prismaSystem.propuestaSire.findFirst({ where: { empresaId: F.empresa2.id, periodo, vigente: true }, include: { detalles: true } });
    expect(guardada.cantidad).toBe(1);
    expect(guardada.detalles[0]).toMatchObject({ tipoCp: '03', serie: 'B001', numero: '45', docNumero: '46027897' });
    expect((await prismaSystem.periodoSire.findUnique({ where: { empresaId_periodo: { empresaId: F.empresa2.id, periodo } } })).estadoRvie).toBe('CON_DIFERENCIAS');
  });
});
