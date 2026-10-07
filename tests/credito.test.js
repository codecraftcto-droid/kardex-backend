import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import argon2 from 'argon2';

const { crearApp } = await import('../src/app.js');
const { prismaSystem, prismaApp } = await import('../src/lib/prisma.js');
const { redis } = await import('../src/lib/redis.js');
const { crearEstudio } = await import('../src/services/estudios.js');
const { normalizar } = await import('../src/services/consultaDocumento.js');

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
const SERIES = { serieFactura: 'F001', serieBoleta: 'B001', serieNotaVenta: 'NV01', serieNotaCreditoFactura: 'FC01', serieNotaCreditoBoleta: 'BC01' };
const enDias = (n) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

beforeAll(async () => {
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  F = await prismaSystem.$transaction(async (tx) => {
    const { tenant, roles } = await crearEstudio(tx, { nombre: `CXC-${sufijo}` });
    const empresa = await tx.empresa.create({ data: { tenantId: tenant.id, razonSocial: 'Ferretería Crédito', ruc: '20100070970' } });
    const sede = await tx.sede.create({ data: { tenantId: tenant.id, empresaId: empresa.id, nombre: 'Tienda' } });
    const a1 = await tx.almacen.create({ data: { tenantId: tenant.id, empresaId: empresa.id, sedeId: sede.id, codigo: 'A1', nombre: 'A1' } });
    const unidad = await tx.unidadMedida.findFirst({ where: { tenantId: tenant.id, codigo: 'NIU' } });
    const prod = (sku, precio) => tx.producto.create({ data: { tenantId: tenant.id, empresaId: empresa.id, sku, nombre: `Producto ${sku}`, unidadId: unidad.id, precioReferencial: precio } });
    const usuario = (nombre, rol, alcanceTipo, alcanceId, extra = {}) =>
      tx.usuario.create({
        data: {
          tenantId: tenant.id, nombres: nombre, email: `${nombre}-${sufijo}@test.local`, estado: 'activo', passwordHash: hash, ...extra,
          asignaciones: { create: { tenantId: tenant.id, rolId: roles[rol].id, alcanceTipo, alcanceId } },
        },
      });
    return {
      tenant, empresa, a1, p1: await prod('P1', 10), p2: await prod('P2', 50),
      admin: await usuario('admin', 'Administrador', 'estudio', null),
      cajero: await usuario('cajero', 'Cajero', 'almacen', a1.id, { tipo: 'operador', empresaId: empresa.id }),
      asistente: await usuario('asistente', 'Asistente', 'empresa', empresa.id),
    };
  });
  for (const k of ['admin', 'cajero', 'asistente']) T[k] = (await request(app).post('/api/auth/login').send({ email: F[k].email, password: PASSWORD })).body.accessToken;
  await api(T.admin).post('/kardex/entradas', {
    almacenId: F.a1.id, motivo: 'COMPRA', items: [{ productoId: F.p1.id, cantidad: '500', costoUnitario: '5' }, { productoId: F.p2.id, cantidad: '100', costoUnitario: '30' }],
  }).expect(201);
});

afterAll(async () => {
  await Promise.all([prismaSystem.$disconnect(), prismaApp.$disconnect(), redis.quit()]);
});

describe('descuentos, crédito y cobranzas', () => {
  let caja;
  let turno;
  let cliente;
  let credito;

  it('prepara la caja (tope 5 %) y el turno del cajero', async () => {
    const r = await api(T.admin).post('/pos/cajas', { nombre: 'Caja 1', almacenId: F.a1.id, ...SERIES });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    caja = r.body;
    expect(caja.descuentoMaximo).toBe('5');
    turno = (await api(T.cajero).post(`/pos/cajas/${caja.id}/abrir`, { montoApertura: '50' }).expect(201)).body;
  });

  it('descuento en % por línea y global prorrateado, dentro del tope', async () => {
    const r = await api(T.cajero).post('/pos/ventas', {
      cajaId: caja.id, tipo: 'NOTA_VENTA',
      items: [{ productoId: F.p1.id, cantidad: '10', descuentoPorcentaje: '2' }, { productoId: F.p2.id, cantidad: '1' }],
      descuentoGlobal: { tipo: 'MONTO', valor: '3' },
      pagos: [{ medio: 'EFECTIVO', monto: '200' }],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    // 100 − 2 % = 98; +50 = 148; − 3 global = 145
    expect(r.body.total).toBe('145');
    const d = (await api(T.cajero).get(`/pos/comprobantes/${r.body.id}`)).body;
    expect(d.descuentoGlobal).toBe('3');
    expect(d.descuentoTotal).toBe('5');
    // 3 prorrateado según importe: 98/148 → 1.99 (+2 de la línea) y 50/148 → 1.01
    expect(d.detalles.map((x) => x.descuento).sort()).toEqual(['1.01', '3.99']);
    expect(d.autorizacion).toBeNull();
  });

  it('un descuento (o bajar el precio) sobre el tope exige autorización de un supervisor de un solo uso', async () => {
    const venta = (extra = {}) => ({
      cajaId: caja.id, tipo: 'NOTA_VENTA', items: [{ productoId: F.p2.id, cantidad: '1', precioUnitario: '40' }], pagos: [{ medio: 'EFECTIVO', monto: '40' }], ...extra,
    });
    const sin = await api(T.cajero).post('/pos/ventas', venta());
    expect(sin.status).toBe(403);
    expect(sin.body.detalles).toEqual({ codigo: 'AUTORIZACION_REQUERIDA', tipo: 'DESCUENTO' });
    expect(sin.body.error).toMatch(/20\.00 %/);

    // Credenciales malas o de alguien sin el permiso: mismo mensaje
    const mala = await api(T.cajero).post('/pos/autorizaciones', { cajaId: caja.id, tipo: 'DESCUENTO', email: F.admin.email, password: 'otra-cosa' });
    expect(mala.status).toBe(403);
    const sinPermiso = await api(T.cajero).post('/pos/autorizaciones', { cajaId: caja.id, tipo: 'DESCUENTO', email: F.asistente.email, password: PASSWORD });
    expect(sinPermiso.status).toBe(403);
    expect(sinPermiso.body.error).toBe(mala.body.error);

    const ok = await api(T.cajero).post('/pos/autorizaciones', { cajaId: caja.id, tipo: 'DESCUENTO', email: F.admin.email, password: PASSWORD });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.supervisor).toBe('admin');
    const v = await api(T.cajero).post('/pos/ventas', venta({ autorizaciones: [ok.body.token] }));
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    const d = (await api(T.cajero).get(`/pos/comprobantes/${v.body.id}`)).body;
    expect(d.autorizadoPor).toBe('admin');
    expect(d.autorizacion).toMatch(/Descuento 20\.00 %/);
    // El pase ya se usó
    expect((await api(T.cajero).post('/pos/ventas', venta({ autorizaciones: [ok.body.token] }))).status).toBe(400);
  });

  it('el cajero registra clientes pero no les da crédito; el administrador sí', async () => {
    const base = { empresaId: F.empresa.id, tipoDocumento: 'DNI', numeroDocumento: '46027897', nombre: 'Juan Pérez', rucAsociado: '10460278975' };
    expect((await api(T.cajero).post('/clientes', { ...base, creditoHabilitado: true, limiteCredito: '100' })).status).toBe(403);
    const mal = await api(T.cajero).post('/clientes', { ...base, rucAsociado: '20100070970' });
    expect(mal.status).toBe(400);
    const c = await api(T.cajero).post('/clientes', base);
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    // Editar sin tocar el crédito sí puede
    expect((await api(T.cajero).put(`/clientes/${c.body.id}`, { ...base, telefono: '999888777', creditoHabilitado: false, limiteCredito: null, diasCredito: 30 })).status).toBe(200);
    const u = await api(T.admin).put(`/clientes/${c.body.id}`, { ...base, creditoHabilitado: true, limiteCredito: '200', diasCredito: 15 });
    expect(u.status, JSON.stringify(u.body)).toBe(200);
    cliente = u.body;
    // Se encuentra también por su RUC asociado
    expect((await api(T.cajero).get(`/clientes?empresaId=${F.empresa.id}&q=1046027`)).body.datos.map((x) => x.id)).toEqual([cliente.id]);
  });

  it('factura a una persona con DNI usando su RUC asociado', async () => {
    const r = await api(T.cajero).post('/pos/ventas', { cajaId: caja.id, tipo: 'FACTURA', clienteId: cliente.id, items: [{ productoId: F.p1.id, cantidad: '1' }], pagos: [{ medio: 'EFECTIVO', monto: '10' }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const d = (await api(T.cajero).get(`/pos/comprobantes/${r.body.id}`)).body;
    expect([d.clienteTipoDocumento, d.clienteNumeroDocumento, d.clienteNombre]).toEqual(['RUC', '10460278975', 'Juan Pérez']);
  });

  it('venta al crédito con inicial y cuotas; reglas de cliente y de cuotas', async () => {
    const venta = (extra) => ({ cajaId: caja.id, tipo: 'BOLETA', formaPago: 'CREDITO', items: [{ productoId: F.p2.id, cantidad: '2' }], ...extra });
    expect((await api(T.cajero).post('/pos/ventas', venta({}))).body.error).toMatch(/cliente registrado/);
    const todo = await api(T.cajero).post('/pos/ventas', venta({ clienteId: cliente.id, pagos: [{ medio: 'EFECTIVO', monto: '100' }] }));
    expect(todo.body.error).toMatch(/contado/);
    const malas = await api(T.cajero).post('/pos/ventas', venta({ clienteId: cliente.id, cuotas: [{ monto: '50', fechaVencimiento: enDias(10) }] }));
    expect(malas.body.error).toMatch(/deben sumar S\/ 100\.00/);

    const r = await api(T.cajero).post('/pos/ventas', venta({
      clienteId: cliente.id, pagos: [{ medio: 'EFECTIVO', monto: '20' }],
      cuotas: [{ monto: '40', fechaVencimiento: enDias(15) }, { monto: '40', fechaVencimiento: enDias(30) }],
    }));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect([r.body.formaPago, r.body.montoCredito]).toEqual(['CREDITO', '80']);
    credito = r.body;
    const d = (await api(T.cajero).get(`/pos/comprobantes/${credito.id}`)).body;
    expect(d.saldoPendiente).toBe('80');
    expect(d.cuotas.map((c) => [c.numero, c.monto, c.pendiente])).toEqual([[1, '40', '40'], [2, '40', '40']]);
  });

  it('pasar el límite de crédito exige autorización', async () => {
    const r = await api(T.cajero).post('/pos/ventas', { cajaId: caja.id, tipo: 'BOLETA', formaPago: 'CREDITO', clienteId: cliente.id, items: [{ productoId: F.p2.id, cantidad: '3' }] });
    expect(r.status).toBe(403);
    expect(r.body.detalles.tipo).toBe('CREDITO');
    expect(r.body.error).toMatch(/límite/);
    const disp = (await api(T.cajero).get(`/cxc/clientes/${cliente.id}/credito`)).body;
    expect([disp.deuda, disp.disponible, disp.vencido]).toEqual(['80', '120', '0']);
  });

  it('cobranza: el efectivo va por caja y entra al arqueo; no se cobra de más', async () => {
    const sinCaja = await api(T.cajero).post('/cxc/cobranzas', { comprobanteId: credito.id, monto: '10', medio: 'EFECTIVO' });
    expect(sinCaja.status).toBe(400);
    expect((await api(T.cajero).post('/cxc/cobranzas', { comprobanteId: credito.id, monto: '81', medio: 'YAPE' })).status).toBe(400);
    const k = await api(T.cajero).post('/cxc/cobranzas', { comprobanteId: credito.id, monto: '50', medio: 'EFECTIVO', cajaId: caja.id });
    expect(k.status, JSON.stringify(k.body)).toBe(201);
    expect([k.body.numero, k.body.saldoPendiente]).toEqual([1, '30']);
    const recibo = (await api(T.cajero).get(`/cxc/cobranzas/${k.body.id}`)).body;
    expect([recibo.saldoAnterior, recibo.saldoDespues]).toEqual(['80', '30']);
    // 50 cubren la cuota 1 completa (40) y 10 de la cuota 2
    expect(recibo.cuotasPagadas.map((q) => [q.numero, q.paga, q.queda])).toEqual([[1, '40', '0'], [2, '10', '30']]);

    const d = (await api(T.cajero).get(`/pos/comprobantes/${credito.id}`)).body;
    // Los 50 pagaron la cuota 1 y 10 de la cuota 2
    expect(d.cuotas.map((c) => c.pendiente)).toEqual(['0', '30']);
    const live = (await api(T.cajero).get(`/pos/sesiones/${turno.id}`)).body;
    expect(live.resumen.cobranzas).toEqual({ cantidad: 1, total: '50.00' });
    expect(live.resumen.ventasCredito).toBe('80.00');

    // La cobranza no se edita en la base: solo se anula
    await expect(prismaSystem.cobranza.update({ where: { id: k.body.id }, data: { monto: 1 } })).rejects.toThrow(/no se modifica/);
  });

  it('no se anula una venta con cobranzas; anulada la cobranza, la deuda vuelve', async () => {
    expect((await api(T.admin).post(`/pos/comprobantes/${credito.id}/anular`, { motivo: 'cliente desistió' })).status).toBe(409);
    const k = (await api(T.admin).get(`/cxc/cobranzas?empresaId=${F.empresa.id}`)).body.datos[0];
    expect((await api(T.cajero).post(`/cxc/cobranzas/${k.id}/anular`, { motivo: 'monto equivocado' })).status).toBe(403);
    expect((await api(T.admin).post(`/cxc/cobranzas/${k.id}/anular`, { motivo: 'monto equivocado' })).status).toBe(200);
    expect((await api(T.admin).get(`/pos/comprobantes/${credito.id}`)).body.saldoPendiente).toBe('80');
    // Volvemos a cobrar 50 para seguir
    await api(T.cajero).post('/cxc/cobranzas', { comprobanteId: credito.id, monto: '50', medio: 'YAPE', referencia: 'OP-9' }).expect(201);
  });

  it('la nota de crédito sobre una venta al crédito rebaja la deuda antes de reembolsar', async () => {
    // El admin abre su propio turno en otra caja para emitir la NC (no tiene turno en Caja 1)
    const c2 = (await api(T.admin).post('/pos/cajas', { nombre: 'Caja 2', almacenId: F.a1.id, serieFactura: 'F002', serieBoleta: 'B002', serieNotaVenta: 'NV02', serieNotaCreditoFactura: 'FC02', serieNotaCreditoBoleta: 'BC02' })).body;
    await api(T.admin).post(`/pos/cajas/${c2.id}/abrir`, { montoApertura: '0' }).expect(201);
    // Devuelve 1 de 2 unidades (S/ 50): saldo 30 → 0; se reembolsan 20
    const nc = await api(T.admin).post('/pos/notas-credito', { cajaId: c2.id, comprobanteId: credito.id, motivoCodigo: '07', items: [{ productoId: F.p2.id, cantidad: '1' }], medioReembolso: 'EFECTIVO' });
    expect(nc.status, JSON.stringify(nc.body)).toBe(201);
    expect([nc.body.total, nc.body.aplicadoASaldo]).toEqual(['50', '30']);
    const d = (await api(T.admin).get(`/pos/comprobantes/${nc.body.id}`)).body;
    expect(d.pagos.map((p) => [p.medio, p.monto])).toEqual([['EFECTIVO', '-20']]);
    expect((await api(T.admin).get(`/pos/comprobantes/${credito.id}`)).body.saldoPendiente).toBe('0');
    // Anular la NC (mismo turno) devuelve la deuda
    await api(T.admin).post(`/pos/comprobantes/${nc.body.id}/anular`, { motivo: 'nota emitida por error' }).expect(200);
    expect((await api(T.admin).get(`/pos/comprobantes/${credito.id}`)).body.saldoPendiente).toBe('30');
  });

  it('con cuotas vencidas, un nuevo crédito exige autorización; estado de cuenta y antigüedad', async () => {
    // Simula el paso del tiempo: la cuota 2 venció hace 40 días
    await prismaSystem.comprobanteCuota.updateMany({ where: { comprobanteId: credito.id, numero: 2 }, data: { fechaVencimiento: new Date(`${enDias(-40)}T00:00:00Z`) } });
    const venta = { cajaId: caja.id, tipo: 'NOTA_VENTA', formaPago: 'CREDITO', clienteId: cliente.id, items: [{ productoId: F.p1.id, cantidad: '1' }] };
    const r = await api(T.cajero).post('/pos/ventas', venta);
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/vencidos/);
    const aut = (await api(T.cajero).post('/pos/autorizaciones', { cajaId: caja.id, tipo: 'CREDITO', email: F.admin.email, password: PASSWORD }).expect(201)).body;
    const ok = await api(T.cajero).post('/pos/ventas', { ...venta, autorizaciones: [aut.token] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);

    const resumen = (await api(T.admin).get(`/cxc/clientes?empresaId=${F.empresa.id}`)).body;
    expect(resumen.datos).toHaveLength(1);
    expect([resumen.datos[0].saldo, resumen.datos[0].vencido, resumen.datos[0].d31_60, resumen.datos[0].porVencer]).toEqual(['40', '30', '30', '10']);
    const ec = (await api(T.admin).get(`/cxc/clientes/${cliente.id}`)).body;
    expect([ec.resumen.deuda, ec.resumen.vencido, ec.resumen.disponible]).toEqual(['40', '30', '160']);
    expect(ec.movimientos.at(-1).saldo).toBe('40');
    // El cajero ve el estado de cuenta (cxc.cuenta.ver) pero no puede anular cobranzas
    expect((await api(T.cajero).get(`/cxc/clientes/${cliente.id}`)).body.acciones).toEqual({ cobrar: true, anular: false });
  });

  it('el arqueo suma las cobranzas en efectivo; los reportes de cuentas por cobrar y cobranzas', async () => {
    const live = (await api(T.cajero).get(`/pos/sesiones/${turno.id}`)).body;
    // 50 apertura + 145 + 40 + 10 + 20 inicial (efectivo de ventas) ; la cobranza en efectivo se anuló
    expect(live.efectivoEsperado).toBe('265.00');
    const cxc = await api(T.admin).get(`/reportes/cxc?empresaId=${F.empresa.id}`);
    expect(cxc.status, JSON.stringify(cxc.body)).toBe(200);
    expect(cxc.body.totales.saldo).toBe('40');
    const cob = await api(T.admin).get(`/reportes/cobranzas?empresaId=${F.empresa.id}&desde=2000-01-01&hasta=2100-01-01`);
    expect(cob.status, JSON.stringify(cob.body)).toBe(200);
    expect(cob.body.filas.map((f) => [f.numero, f.monto, f.estado])).toEqual([[1, '0', 'Anulada'], [2, '50', 'Vigente']]);
  });

  it('consulta RENIEC/SUNAT: sin token configurado no está disponible; normaliza proveedores', async () => {
    expect((await api(T.cajero).get('/clientes/consulta/disponible')).body).toEqual({ disponible: false });
    expect((await api(T.cajero).get(`/clientes/consulta?empresaId=${F.empresa.id}&tipo=DNI&numero=46027897`)).status).toBe(503);
    expect(normalizar('DNI', '46027897', { first_name: 'JUAN', first_last_name: 'PEREZ', second_last_name: 'LOPEZ' }).nombre).toBe('JUAN PEREZ LOPEZ');
    expect(normalizar('DNI', '46027897', { nombres: 'ANA', apellidoPaterno: 'RUIZ', apellidoMaterno: 'DIAZ' }).nombre).toBe('ANA RUIZ DIAZ');
    const ruc = normalizar('RUC', '20100070970', { razon_social: 'EMPRESA SAC', direccion: 'AV. LIMA 1', distrito: 'LIMA', provincia: 'LIMA', departamento: 'LIMA', estado: 'ACTIVO', condicion: 'HABIDO' });
    expect(ruc).toMatchObject({ nombre: 'EMPRESA SAC', direccion: 'AV. LIMA 1, LIMA - LIMA - LIMA', estado: 'ACTIVO', condicion: 'HABIDO' });
  });

  it('panel de inicio: ventas del día (NC restan), movimientos y cuentas por cobrar dentro del alcance', async () => {
    const r = await api(T.admin).get(`/panel?empresaId=${F.empresa.id}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const cs = await prismaSystem.comprobante.findMany({ where: { empresaId: F.empresa.id, estado: 'EMITIDO' } });
    const esperado = cs.reduce((s, c) => s + (c.tipo === 'NOTA_CREDITO' ? -1 : 1) * Number(c.total), 0);
    expect(Number(r.body.ventas.hoy)).toBeCloseTo(esperado, 2);
    expect(r.body.ventas.serie).toHaveLength(14);
    expect(r.body.ventas.comprobantesHoy).toBe(cs.filter((c) => c.tipo !== 'NOTA_CREDITO').length);
    expect(r.body.movimientos.serie.at(-1).salidas).toBeGreaterThan(0);
    expect(r.body.cxc).toMatchObject({ saldo: '40', clientes: 1, clientesVencidos: 1 });
  });

  it('crear usuario con su rol inicial; un rol incompatible no deja el usuario a medias', async () => {
    const roles = (await api(T.admin).get('/roles')).body;
    const rol = (n) => roles.find((r) => r.nombre === n);
    expect([rol('Cajero').aptoOperador, rol('Contador').aptoOperador, rol('Cliente (portal)').aptoCliente]).toEqual([true, false, true]);

    const base = (n, extra) => ({ nombres: n, email: `${n.toLowerCase()}-${sufijo}@test.local`, ...extra });
    const ok = await api(T.admin).post('/usuarios', base('Vendedora', {
      tipo: 'operador', empresaId: F.empresa.id, asignacion: { rolId: rol('Cajero').id, alcanceTipo: 'almacen', alcanceId: F.a1.id },
    }));
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const det = (await api(T.admin).get(`/usuarios/${ok.body.id}`)).body;
    expect(det.asignaciones.map((a) => [a.rol.nombre, a.alcanceTipo])).toEqual([['Cajero', 'almacen']]);

    const malo = await api(T.admin).post('/usuarios', base('Intruso', {
      tipo: 'operador', empresaId: F.empresa.id, asignacion: { rolId: rol('Contador').id, alcanceTipo: 'empresa', alcanceId: F.empresa.id },
    }));
    expect(malo.status).toBe(400);
    expect(await prismaSystem.usuario.count({ where: { email: `intruso-${sufijo}@test.local` } })).toBe(0);
    // Quien no gestiona roles no puede asignarlos al invitar
    expect((await api(T.cajero).post('/usuarios', base('Otro', { asignacion: { rolId: rol('Cajero').id, alcanceTipo: 'estudio' } }))).status).toBe(403);
  });
});
