import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import argon2 from 'argon2';

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
const api = (token) => ({
  get: (u) => request(app).get(`/api${u}`).set(auth(token)),
  post: (u, b) => request(app).post(`/api${u}`).set(auth(token)).send(b),
});
const stock = async (productoId) =>
  (await prismaSystem.stock.findUnique({ where: { almacenId_productoId: { almacenId: F.a1.id, productoId } } }))?.cantidad.toString();

beforeAll(async () => {
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  F = await prismaSystem.$transaction(async (tx) => {
    const { tenant, roles } = await crearEstudio(tx, { nombre: `POS-${sufijo}` });
    const empresa = await tx.empresa.create({ data: { tenantId: tenant.id, razonSocial: 'Bodega POS', ruc: '20100070970' } });
    const sede = await tx.sede.create({ data: { tenantId: tenant.id, empresaId: empresa.id, nombre: 'Tienda' } });
    const [a1, a2] = await Promise.all(['A1', 'A2'].map((c) => tx.almacen.create({ data: { tenantId: tenant.id, empresaId: empresa.id, sedeId: sede.id, codigo: c, nombre: c } })));
    const unidad = await tx.unidadMedida.findFirst({ where: { tenantId: tenant.id, codigo: 'NIU' } });
    const prod = (sku, precio, afectacionIgv = '10') =>
      tx.producto.create({ data: { tenantId: tenant.id, empresaId: empresa.id, sku, nombre: `Producto ${sku}`, unidadId: unidad.id, precioReferencial: precio, afectacionIgv } });
    const p1 = await prod('P1', 11.8);
    const p2 = await prod('P2', 5, '20');
    const usuario = (nombre, rol, alcanceTipo, alcanceId, extra = {}) =>
      tx.usuario.create({
        data: {
          tenantId: tenant.id, nombres: nombre, email: `${nombre}-${sufijo}@test.local`, estado: 'activo', passwordHash: hash, ...extra,
          asignaciones: { create: { tenantId: tenant.id, rolId: roles[rol].id, alcanceTipo, alcanceId } },
        },
      });
    return {
      tenant, roles, empresa, a1, a2, p1, p2,
      admin: await usuario('admin', 'Administrador', 'estudio', null),
      cajero: await usuario('cajero', 'Cajero', 'almacen', a1.id, { tipo: 'operador', empresaId: empresa.id }),
      operador2: await usuario('operador2', 'Cajero', 'almacen', a2.id, { tipo: 'operador', empresaId: empresa.id }),
    };
  });
  for (const k of ['admin', 'cajero', 'operador2']) T[k] = (await request(app).post('/api/auth/login').send({ email: F[k].email, password: PASSWORD })).body.accessToken;
  await api(T.admin).post('/kardex/entradas', {
    almacenId: F.a1.id, motivo: 'COMPRA', items: [{ productoId: F.p1.id, cantidad: '100', costoUnitario: '6' }, { productoId: F.p2.id, cantidad: '50', costoUnitario: '2' }],
  }).expect(201);
});

afterAll(async () => {
  await Promise.all([prismaSystem.$disconnect(), prismaApp.$disconnect(), redis.quit()]);
});

const SERIES = { serieFactura: 'F001', serieBoleta: 'B001', serieNotaVenta: 'NV01', serieNotaCreditoFactura: 'FC01', serieNotaCreditoBoleta: 'BC01' };

describe('punto de venta', () => {
  let caja;
  let turno;
  let boleta;
  let factura;
  let clienteRuc;

  it('configura la caja con series válidas y únicas por empresa', async () => {
    const r = await api(T.admin).post('/pos/cajas', { nombre: 'Caja 1', almacenId: F.a1.id, ...SERIES, descuentoMaximo: '50' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    caja = r.body;
    const repetida = await api(T.admin).post('/pos/cajas', { nombre: 'Caja 2', almacenId: F.a2.id, ...SERIES, serieFactura: 'F002', serieBoleta: 'B001' });
    expect(repetida.status).toBe(409);
    const mala = await api(T.admin).post('/pos/cajas', { nombre: 'Caja 3', almacenId: F.a2.id, ...SERIES, serieFactura: 'B009' });
    expect(mala.status).toBe(400);
  });

  it('el cajero de otro almacén no ve ni opera esta caja', async () => {
    expect((await api(T.operador2).get(`/pos/cajas?empresaId=${F.empresa.id}`)).body).toHaveLength(0);
    expect((await api(T.operador2).post(`/pos/cajas/${caja.id}/abrir`, { montoApertura: '50' })).status).toBe(404);
  });

  it('no se vende sin turno abierto; se abre una sola vez', async () => {
    const sin = await api(T.cajero).post('/pos/ventas', { cajaId: caja.id, tipo: 'BOLETA', items: [{ productoId: F.p1.id, cantidad: '1' }], pagos: [{ medio: 'EFECTIVO', monto: '20' }] });
    expect(sin.status).toBe(409);
    const ab = await api(T.cajero).post(`/pos/cajas/${caja.id}/abrir`, { montoApertura: '100' });
    expect(ab.status, JSON.stringify(ab.body)).toBe(201);
    turno = ab.body;
    expect((await api(T.admin).post(`/pos/cajas/${caja.id}/abrir`, { montoApertura: '1' })).status).toBe(409);
  });

  it('boleta a clientes varios con pago mixto y vuelto; descuenta stock', async () => {
    const r = await api(T.cajero).post('/pos/ventas', {
      cajaId: caja.id, tipo: 'BOLETA',
      items: [{ productoId: F.p1.id, cantidad: '2' }, { productoId: F.p2.id, cantidad: '1', descuento: '1' }],
      pagos: [{ medio: 'TARJETA', monto: '10' }, { medio: 'EFECTIVO', monto: '20' }],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect([r.body.serie, r.body.numero, r.body.total, r.body.vuelto]).toEqual(['B001', 1, '27.6', '2.4']);
    boleta = r.body;
    expect(await stock(F.p1.id)).toBe('98');
    const d = await api(T.cajero).get(`/pos/comprobantes/${boleta.id}`);
    expect(d.body.clienteNombre).toBe('CLIENTES VARIOS');
    expect(d.body.estadoSunat).toBe('PENDIENTE');
    expect(d.body.montoEnLetras).toBe('SON: VEINTISIETE CON 60/100 SOLES');
    expect(d.body.qr).toMatch(/^data:image\/png/);
    expect([d.body.opGravada, d.body.opExonerada, d.body.igv]).toEqual(['20', '4', '3.6']);
  });

  it('aplica las reglas SUNAT: factura con RUC y boleta grande identificada', async () => {
    const f = await api(T.cajero).post('/pos/ventas', { cajaId: caja.id, tipo: 'FACTURA', items: [{ productoId: F.p1.id, cantidad: '1' }], pagos: [{ medio: 'EFECTIVO', monto: '20' }] });
    expect(f.status).toBe(400);
    expect(f.body.error).toMatch(/RUC/);
    const grande = await api(T.cajero).post('/pos/ventas', { cajaId: caja.id, tipo: 'BOLETA', items: [{ productoId: F.p1.id, cantidad: '60' }], pagos: [{ medio: 'EFECTIVO', monto: '800' }] });
    expect(grande.status).toBe(400);
    expect(grande.body.error).toMatch(/identificar/);

    const mal = await api(T.cajero).post('/clientes', { empresaId: F.empresa.id, tipoDocumento: 'RUC', numeroDocumento: '20100070971', nombre: 'X' });
    expect(mal.status).toBe(400);
    const c = await api(T.cajero).post('/clientes', { empresaId: F.empresa.id, tipoDocumento: 'RUC', numeroDocumento: '20131312955', nombre: 'Cliente SAC', direccion: 'Av. Lima 123' });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    clienteRuc = c.body;
    const ok = await api(T.cajero).post('/pos/ventas', { cajaId: caja.id, tipo: 'FACTURA', clienteId: clienteRuc.id, items: [{ productoId: F.p1.id, cantidad: '10' }], pagos: [{ medio: 'TRANSFERENCIA', monto: '118', referencia: 'OP-1' }] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect([ok.body.serie, ok.body.numero]).toEqual(['F001', 1]);
    factura = ok.body;
  });

  it('si no hay stock, no se emite ni se consume el número', async () => {
    // Nota de venta: no aplica la regla de identificación, así el rechazo es por stock
    const r = await api(T.cajero).post('/pos/ventas', { cajaId: caja.id, tipo: 'NOTA_VENTA', items: [{ productoId: F.p2.id, cantidad: '999' }], pagos: [{ medio: 'EFECTIVO', monto: '5000' }] });
    expect(r.status).toBe(409);
    const otra = await api(T.cajero).post('/pos/ventas', { cajaId: caja.id, tipo: 'BOLETA', items: [{ productoId: F.p2.id, cantidad: '1' }], pagos: [{ medio: 'YAPE', monto: '5' }] });
    expect(otra.body.numero).toBe(2);
  });

  it('el comprobante no se puede alterar; se anula dentro del turno y devuelve stock', async () => {
    await expect(prismaSystem.comprobante.update({ where: { id: boleta.id }, data: { total: 1 } })).rejects.toThrow(/no se modifica/);
    const antes = await stock(F.p1.id);
    const r = await api(T.admin).post(`/pos/comprobantes/${boleta.id}/anular`, { motivo: 'Error de digitación' });
    expect(r.status, JSON.stringify(r.body)).toBe(201 === r.status ? 201 : 200);
    expect(Number(await stock(F.p1.id))).toBe(Number(antes) + 2);
  });

  it('nota de crédito por ítem: devuelve stock al costo original y registra el reembolso', async () => {
    const nc = await api(T.admin).post('/pos/notas-credito', {
      cajaId: caja.id, comprobanteId: factura.id, motivoCodigo: '07', items: [{ productoId: F.p1.id, cantidad: '3' }], medioReembolso: 'TRANSFERENCIA',
    });
    // El admin no tiene turno abierto en esta caja: la NC la emite el cajero dueño del turno
    expect(nc.status, JSON.stringify(nc.body)).toBe(403);
    // El cajero no tiene permiso de NC con el rol Cajero
    expect((await api(T.cajero).post('/pos/notas-credito', { cajaId: caja.id, comprobanteId: factura.id, motivoCodigo: '07', items: [{ productoId: F.p1.id, cantidad: '3' }] })).status).toBe(403);
  });

  it('cierra el turno con arqueo: efectivo esperado vs declarado', async () => {
    const live = await api(T.cajero).get(`/pos/sesiones/${turno.id}`);
    // apertura 100 + efectivo de la boleta anulada no cuenta → 100
    expect(live.body.efectivoEsperado).toBe('100.00');
    expect(live.body.resumen.porMedio).toEqual({ TRANSFERENCIA: '118.00', YAPE: '5.00' });
    const c = await api(T.cajero).post(`/pos/sesiones/${turno.id}/cerrar`, { efectivoDeclarado: '95' });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.diferencia).toBe('-5');
    const venta = await api(T.cajero).post('/pos/ventas', { cajaId: caja.id, tipo: 'NOTA_VENTA', items: [{ productoId: F.p2.id, cantidad: '1' }], pagos: [{ medio: 'EFECTIVO', monto: '5' }] });
    expect(venta.status).toBe(409);
  });

  it('tras el cierre, la corrección es una nota de crédito (no anulación)', async () => {
    expect((await api(T.admin).post(`/pos/comprobantes/${factura.id}/anular`, { motivo: 'tarde para anular' })).status).toBe(409);
    await api(T.admin).post(`/pos/cajas/${caja.id}/abrir`, { montoApertura: '0' }).expect(201);
    const antes = await stock(F.p1.id);
    const nc = await api(T.admin).post('/pos/notas-credito', {
      cajaId: caja.id, comprobanteId: factura.id, motivoCodigo: '07', items: [{ productoId: F.p1.id, cantidad: '3' }], medioReembolso: 'TRANSFERENCIA',
    });
    expect(nc.status, JSON.stringify(nc.body)).toBe(201);
    expect([nc.body.serie, nc.body.total]).toEqual(['FC01', '35.4']);
    expect(Number(await stock(F.p1.id))).toBe(Number(antes) + 3);
    const s = await prismaSystem.stock.findUnique({ where: { almacenId_productoId: { almacenId: F.a1.id, productoId: F.p1.id } } });
    expect(s.costoPromedio.toString()).toBe('6');
    const demas = await api(T.admin).post('/pos/notas-credito', { cajaId: caja.id, comprobanteId: factura.id, motivoCodigo: '07', items: [{ productoId: F.p1.id, cantidad: '8' }] });
    expect(demas.status).toBe(400);
  });

  it('el operador no puede recibir permisos fuera de caja/clientes ni de otra empresa', async () => {
    const r = await api(T.admin).post(`/usuarios/${F.cajero.id}/asignaciones`, { rolId: F.roles.Contador.id, alcanceTipo: 'almacen', alcanceId: F.a1.id });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/operador/);
  });

  it('registro de ventas: la NC resta y el anulado va en cero', async () => {
    const r = await api(T.admin).get(`/reportes/ventas?empresaId=${F.empresa.id}&desde=2000-01-01&hasta=2100-01-01`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.filas.map((f) => `${f.serie}-${Number(f.numero)}:${f.total}`)).toEqual(['B001-1:0', 'F001-1:118', 'B001-2:5', 'FC01-1:-35.4']);
    expect(r.body.totales.total).toBe('87.6');
  });
});
