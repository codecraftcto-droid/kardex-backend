import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import argon2 from 'argon2';

const { crearApp } = await import('../src/app.js');
const { prismaSystem, prismaApp, withTenant } = await import('../src/lib/prisma.js');
const { redis } = await import('../src/lib/redis.js');
const { crearEstudio } = await import('../src/services/estudios.js');
const { cargarBase } = await import('../src/contabilidad/servicio.js');
const { desplazar, periodoActual } = await import('../src/sire/periodos.js');

const app = crearApp();
const PASSWORD = 'Prueba123!';
const sufijo = crypto.randomBytes(4).toString('hex');
const auth = (t) => ({ Authorization: `Bearer ${t}` });
let F;
const T = {};
const V = {};
const api = (token) => ({
  get: (u) => request(app).get(`/api${u}`).set(auth(token)),
  post: (u, b) => request(app).post(`/api${u}`).set(auth(token)).send(b),
  put: (u, b) => request(app).put(`/api${u}`).set(auth(token)).send(b),
});
const SERIES = { serieFactura: 'F001', serieBoleta: 'B001', serieNotaVenta: 'NV01', serieNotaCreditoFactura: 'FC01', serieNotaCreditoBoleta: 'BC01' };
const PERIODO = periodoActual();
const hoy = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());

/** Asiento por clave, con sus líneas como "cuenta D|H monto" */
async function asiento(clave) {
  const a = await prismaSystem.asiento.findUnique({ where: { empresaId_clave: { empresaId: F.empresa.id, clave } }, include: { lineas: { orderBy: { orden: 'asc' } } } });
  return a && { ...a, resumen: a.lineas.map((l) => `${l.cuenta} ${Number(l.debe) ? `D ${Number(l.debe).toFixed(2)}` : `H ${Number(l.haber).toFixed(2)}`}`) };
}

beforeAll(async () => {
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  F = await prismaSystem.$transaction(async (tx) => {
    const { tenant, roles } = await crearEstudio(tx, { nombre: `ASIENTOS-${sufijo}` });
    const empresa = await tx.empresa.create({ data: { tenantId: tenant.id, razonSocial: 'Asientos SAC', ruc: '20100070970' } });
    const sede = await tx.sede.create({ data: { tenantId: tenant.id, empresaId: empresa.id, nombre: 'Tienda' } });
    const a1 = await tx.almacen.create({ data: { tenantId: tenant.id, empresaId: empresa.id, sedeId: sede.id, codigo: 'A1', nombre: 'A1' } });
    const niu = await tx.unidadMedida.findFirst({ where: { tenantId: tenant.id, codigo: 'NIU' } });
    const zz = await tx.unidadMedida.findFirst({ where: { tenantId: tenant.id, codigo: 'ZZ' } });
    const p1 = await tx.producto.create({ data: { tenantId: tenant.id, empresaId: empresa.id, sku: 'P1', nombre: 'Polo', unidadId: niu.id, precioReferencial: 11.8 } });
    const s1 = await tx.producto.create({ data: { tenantId: tenant.id, empresaId: empresa.id, sku: 'S1', nombre: 'Instalación', unidadId: zz.id, precioReferencial: 118 } });
    await tx.configFacturacion.create({ data: { tenantId: tenant.id, empresaId: empresa.id, proveedor: 'SIMULADO', envioAutomatico: false } });
    const usuario = (nombre, rol, alcanceTipo, alcanceId, extra = {}) =>
      tx.usuario.create({
        data: {
          tenantId: tenant.id, nombres: nombre, email: `${nombre}-${sufijo}@test.local`, estado: 'activo', passwordHash: hash, ...extra,
          asignaciones: { create: { tenantId: tenant.id, rolId: roles[rol].id, alcanceTipo, alcanceId } },
        },
      });
    return {
      tenant, empresa, sede, a1, p1, s1,
      admin: await usuario('admin', 'Administrador', 'estudio', null),
      asistente: await usuario('asistente', 'Asistente', 'estudio', null),
      cajero: await usuario('cajero', 'Cajero', 'almacen', a1.id, { tipo: 'operador', empresaId: empresa.id }),
    };
  });
  await withTenant(F.tenant.id, (tx) => cargarBase(tx, { tenantId: F.tenant.id, empresaId: F.empresa.id }));
  for (const k of ['admin', 'asistente', 'cajero']) T[k] = (await request(app).post('/api/auth/login').send({ email: F[k].email, password: PASSWORD })).body.accessToken;
  await api(T.admin).post('/kardex/entradas', { almacenId: F.a1.id, motivo: 'COMPRA', items: [{ productoId: F.p1.id, cantidad: '100', costoUnitario: '4' }, { productoId: F.s1.id, cantidad: '100', costoUnitario: '1' }] }).expect(201);

  // Operaciones del período
  const caja = (await api(T.admin).post('/pos/cajas', { nombre: 'Caja 1', almacenId: F.a1.id, ...SERIES })).body;
  await api(T.cajero).post(`/pos/cajas/${caja.id}/abrir`, { montoApertura: '0' }).expect(201);
  const cliente = (await api(T.cajero).post('/clientes', { empresaId: F.empresa.id, tipoDocumento: 'RUC', numeroDocumento: '20131312955', nombre: 'Cliente SAC', direccion: 'Av. Lima 1' })).body;
  await api(T.admin).put(`/clientes/${cliente.id}`, { empresaId: F.empresa.id, tipoDocumento: 'RUC', numeroDocumento: '20131312955', nombre: 'Cliente SAC', direccion: 'Av. Lima 1', creditoHabilitado: true, limiteCredito: '500', diasCredito: 30 }).expect(200);
  const vender = async (b) => {
    const r = await api(T.cajero).post('/pos/ventas', { cajaId: caja.id, ...b });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body;
  };
  V.caja = caja;
  V.b1 = await vender({ tipo: 'BOLETA', items: [{ productoId: F.p1.id, cantidad: '2' }], pagos: [{ medio: 'EFECTIVO', monto: '30' }] });
  V.f1 = await vender({ tipo: 'FACTURA', clienteId: cliente.id, items: [{ productoId: F.p1.id, cantidad: '1' }, { productoId: F.s1.id, cantidad: '1' }], pagos: [{ medio: 'TARJETA', monto: '100' }, { medio: 'EFECTIVO', monto: '29.80' }] });
  V.f2 = await vender({ tipo: 'FACTURA', formaPago: 'CREDITO', clienteId: cliente.id, items: [{ productoId: F.p1.id, cantidad: '1' }] });
  const k = await api(T.cajero).post('/cxc/cobranzas', { comprobanteId: V.f2.id, monto: '5', medio: 'YAPE' });
  expect(k.status, JSON.stringify(k.body)).toBe(201);
  V.cobranza = k.body;
  // La nota de crédito la emite el administrador desde su propio turno
  const rc2 = await api(T.admin).post('/pos/cajas', { nombre: 'Caja 2', almacenId: F.a1.id, serieFactura: 'F002', serieBoleta: 'B002', serieNotaVenta: 'NV02', serieNotaCreditoFactura: 'FC02', serieNotaCreditoBoleta: 'BC02' });
  expect(rc2.status, JSON.stringify(rc2.body)).toBe(201);
  const caja2 = rc2.body;
  await api(T.admin).post(`/pos/cajas/${caja2.id}/abrir`, { montoApertura: '0' }).expect(201);
  const nc = await api(T.admin).post('/pos/notas-credito', { cajaId: caja2.id, comprobanteId: V.f1.id, motivoCodigo: '07', items: [{ productoId: F.p1.id, cantidad: '1' }] });
  expect(nc.status, JSON.stringify(nc.body)).toBe(201);
  V.nc = nc.body.comprobante ?? nc.body;
  const an = await api(T.admin).post(`/pos/comprobantes/${V.b1.id}/anular`, { motivo: 'Error en la venta' });
  expect(an.status, JSON.stringify(an.body)).toBe(200);
  V.compra = await prismaSystem.documentoComercial.create({
    data: {
      tenantId: F.tenant.id, empresaId: F.empresa.id, sedeId: F.sede.id, almacenId: F.a1.id, tipo: 'COMPRA', estado: 'CONFIRMADO',
      terceroDocumento: '20512345678', terceroNombre: 'Importadora SAC', comprobanteTipo: 'FACTURA', serie: 'F010', numero: '77',
      fechaEmision: new Date(`${hoy()}T00:00:00Z`), moneda: 'USD', tipoCambio: 3.8, subtotal: 100, igv: 18, total: 118, creadoPorId: F.admin.id,
    },
  });
});

afterAll(async () => {
  await Promise.all([prismaSystem.$disconnect(), prismaApp.$disconnect(), redis.quit()]);
});

describe('asientos automáticos', () => {
  const base = `?empresaId=`;
  const resumen = async () => (await api(T.admin).get(`/contabilidad/asientos/resumen${base}${F.empresa.id}&periodo=${PERIODO}`)).body;
  const generar = (ruta = 'generar') => api(T.admin).post(`/contabilidad/asientos/${ruta}`, { empresaId: F.empresa.id, periodo: PERIODO });

  it('antes de contabilizar: todo pendiente; el asistente ve pero no contabiliza', async () => {
    const r = await resumen();
    expect(r.asientos).toBe(0);
    expect(r.errores).toEqual([]);
    // Los extornos de la boleta anulada llevan el origen del asiento que revierten
    expect(r.pendientes.map((p) => p.origen).sort()).toEqual([
      'COBRANZA', 'COBRO', 'COBRO', 'COBRO', 'COMPRA', 'COSTO_VENTA', 'COSTO_VENTA', 'COSTO_VENTA', 'COSTO_VENTA', 'COSTO_VENTA',
      'NOTA_CREDITO', 'REEMBOLSO', 'VENTA', 'VENTA', 'VENTA', 'VENTA',
    ]);
    expect((await api(T.asistente).get(`/contabilidad/asientos/resumen${base}${F.empresa.id}&periodo=${PERIODO}`)).status).toBe(200);
    expect((await api(T.asistente).post('/contabilidad/asientos/generar', { empresaId: F.empresa.id, periodo: PERIODO })).status).toBe(403);
    expect((await api(T.admin).get(`/contabilidad/asientos/resumen${base}${F.empresa.id}&periodo=${desplazar(PERIODO, 1)}`)).status).toBe(400);
  });

  it('contabiliza el período: ventas, cobros, costo, nota de crédito, cobranza, compra en dólares y extornos', async () => {
    const r = await generar();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.errores).toEqual([]);
    expect(r.body.creados).toBe(16);

    expect((await asiento(`VENTA:${V.f1.id}`)).resumen).toEqual(['1212 D 129.80', '40111 H 19.80', '70111 H 10.00', '7041 H 100.00']);
    expect((await asiento(`COBRO:${V.f1.id}`)).resumen).toEqual(['1041 D 100.00', '1011 D 29.80', '1212 H 129.80']);
    expect((await asiento(`VENTA:${V.f2.id}`)).resumen).toEqual(['1212 D 11.80', '40111 H 1.80', '70111 H 10.00']);
    expect(await asiento(`COBRO:${V.f2.id}`)).toBeNull();
    expect((await asiento(`COBRANZA:${V.cobranza.id}`)).resumen).toEqual(['1041 D 5.00', '1212 H 5.00']);
    expect((await asiento(`NC:${V.nc.id}`)).resumen).toEqual(['7091 D 10.00', '40111 D 1.80', '1212 H 11.80']);
    expect((await asiento(`REEMBOLSO:${V.nc.id}`)).resumen).toEqual(['1212 D 11.80', '1011 H 11.80']);
    expect((await asiento(`COMPRA:${V.compra.id}`)).resumen).toEqual(['6011 D 380.00', '40111 D 68.40', '4212 H 448.40', '20111 D 380.00', '6111 H 380.00']);

    // Boleta anulada: venta, cobro y costo con sus extornos
    const venta = await asiento(`VENTA:${V.b1.id}`);
    expect(venta.resumen).toEqual(['1212 D 23.60', '40111 H 3.60', '70111 H 20.00']);
    const extorno = await asiento(`VENTA:${V.b1.id}:EXTORNO`);
    expect(extorno.resumen).toEqual(['1212 H 23.60', '40111 D 3.60', '70111 D 20.00']);
    expect(extorno.extornoDeId).toBe(venta.id);
    expect(await asiento(`COBRO:${V.b1.id}:EXTORNO`)).not.toBeNull();
    const costos = await prismaSystem.asiento.findMany({ where: { empresaId: F.empresa.id, origen: 'COSTO_VENTA' }, include: { lineas: true } });
    expect(costos).toHaveLength(5); // B1, F1 (polo + servicio), F2, devolución de la NC, extorno de B1
    expect(costos.find((a) => a.clave.endsWith(':EXTORNO')).lineas.map((l) => `${l.cuenta} ${Number(l.debe) ? 'D' : 'H'}`)).toEqual(['69111 H', '20111 D']);

    // El cliente de la factura queda en la línea de la cuenta por cobrar
    const l = (await asiento(`VENTA:${V.f1.id}`)).lineas[0];
    expect(l).toMatchObject({ terceroTipo: '6', terceroDoc: '20131312955', docTipo: '01', docSerie: 'F001' });

    const s = await resumen();
    expect([s.asientos, s.pendientes.length, Number(s.totalDebe) === Number(s.totalHaber)]).toEqual([16, 0, true]);

    // Numeración en orden: la venta antes que su cobro, su costo y la cobranza posterior
    const n = async (clave) => (await asiento(clave)).numero;
    expect(await n(`VENTA:${V.f1.id}`)).toBeLessThan(await n(`COBRO:${V.f1.id}`));
    expect(await n(`VENTA:${V.f2.id}`)).toBeLessThan(await n(`COBRANZA:${V.cobranza.id}`));
    expect(await n(`VENTA:${V.b1.id}`)).toBeLessThan(await n(`VENTA:${V.b1.id}:EXTORNO`));
  });

  it('es idempotente; una cuenta sin configurar deja la operación pendiente con el motivo', async () => {
    expect((await generar()).body.creados).toBe(0);
    const cfg = (await prismaSystem.configContable.findUnique({ where: { empresaId: F.empresa.id } })).cuentas;
    const { caja, ...sinCaja } = cfg;
    await api(T.admin).put('/contabilidad/configuracion', { empresaId: F.empresa.id, cuentas: sinCaja }).expect(200);
    await api(T.cajero).post('/pos/ventas', { cajaId: V.caja.id, tipo: 'BOLETA', items: [{ productoId: F.p1.id, cantidad: '1' }], pagos: [{ medio: 'EFECTIVO', monto: '11.80' }] }).expect(201);
    const r = (await generar()).body;
    expect(r.creados).toBe(2); // venta y costo
    expect(r.errores).toEqual([expect.objectContaining({ origen: 'COBRO', error: expect.stringMatching(/Falta configurar la cuenta de "Caja/) })]);
    expect((await resumen()).errores).toHaveLength(1);
    await api(T.admin).put('/contabilidad/configuracion', { empresaId: F.empresa.id, cuentas: cfg }).expect(200);
    expect((await generar()).body).toEqual({ creados: 1, errores: [] });
  });

  it('regenerar: vuelve a numerar desde 1 y produce lo mismo', async () => {
    const antes = await prismaSystem.asiento.count({ where: { empresaId: F.empresa.id, periodo: PERIODO } });
    const r = await generar('regenerar');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect([r.body.eliminados, r.body.creados]).toEqual([antes, antes]);
    const numeros = (await prismaSystem.asiento.findMany({ where: { empresaId: F.empresa.id, periodo: PERIODO }, select: { numero: true }, orderBy: { numero: 'asc' } })).map((a) => a.numero);
    expect(numeros).toEqual(Array.from({ length: antes }, (_, i) => i + 1));
  });

  it('listado y detalle con nombres de cuenta y enlace al origen', async () => {
    const lista = (await api(T.asistente).get(`/contabilidad/asientos${base}${F.empresa.id}&periodo=${PERIODO}&origen=COMPRA`)).body;
    expect(lista.total).toBe(1);
    const d = (await api(T.asistente).get(`/contabilidad/asientos/${lista.datos[0].id}${base}${F.empresa.id}`)).body;
    expect(d.lineas[0]).toMatchObject({ cuenta: '6011', cuentaNombre: 'Mercaderías manufacturadas' });
    expect(d.enlace).toEqual({ texto: 'Ver compra', ruta: `/compras/${V.compra.id}` });
    expect((await api(T.asistente).get(`/contabilidad/asientos${base}${F.empresa.id}&periodo=${PERIODO}&q=4212`)).body.total).toBe(1);
  });
});
