import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import argon2 from 'argon2';
import { Prisma } from '@prisma/client';

const { crearApp } = await import('../src/app.js');
const { prismaSystem, prismaApp } = await import('../src/lib/prisma.js');
const { redis } = await import('../src/lib/redis.js');
const { crearEstudio } = await import('../src/services/estudios.js');
const { darDeBaja } = await import('../src/cpe/servicio.js');
const { cuerpoNubefact, nubefact } = await import('../src/cpe/proveedores/nubefact.js');
const { invalidarPermisosEstudio } = await import('../src/rbac/servicio.js');

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

beforeAll(async () => {
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  F = await prismaSystem.$transaction(async (tx) => {
    const { tenant, roles } = await crearEstudio(tx, { nombre: `CPE-${sufijo}` });
    const empresa = await tx.empresa.create({ data: { tenantId: tenant.id, razonSocial: 'Bodega SUNAT', ruc: '20100070970' } });
    const sede = await tx.sede.create({ data: { tenantId: tenant.id, empresaId: empresa.id, nombre: 'Tienda' } });
    const a1 = await tx.almacen.create({ data: { tenantId: tenant.id, empresaId: empresa.id, sedeId: sede.id, codigo: 'A1', nombre: 'A1' } });
    const unidad = await tx.unidadMedida.findFirst({ where: { tenantId: tenant.id, codigo: 'NIU' } });
    const p1 = await tx.producto.create({ data: { tenantId: tenant.id, empresaId: empresa.id, sku: 'P1', nombre: 'Gaseosa 500 ml', unidadId: unidad.id, precioReferencial: 3.5 } });
    const usuario = (nombre, rol, alcanceTipo, alcanceId, extra = {}) =>
      tx.usuario.create({
        data: {
          tenantId: tenant.id, nombres: nombre, email: `${nombre}-${sufijo}@test.local`, estado: 'activo', passwordHash: hash, ...extra,
          asignaciones: { create: { tenantId: tenant.id, rolId: roles[rol].id, alcanceTipo, alcanceId } },
        },
      });
    return {
      tenant, empresa, a1, p1,
      admin: await usuario('admin', 'Administrador', 'estudio', null),
      cajero: await usuario('cajero', 'Cajero', 'almacen', a1.id, { tipo: 'operador', empresaId: empresa.id }),
    };
  });
  for (const k of ['admin', 'cajero']) T[k] = (await request(app).post('/api/auth/login').send({ email: F[k].email, password: PASSWORD })).body.accessToken;
  await api(T.admin).post('/kardex/entradas', { almacenId: F.a1.id, motivo: 'COMPRA', items: [{ productoId: F.p1.id, cantidad: '1000', costoUnitario: '2' }] }).expect(201);
});

afterAll(async () => {
  await Promise.all([prismaSystem.$disconnect(), prismaApp.$disconnect(), redis.quit()]);
});

describe('facturación electrónica', () => {
  let caja;
  let clienteRuc;

  it('los módulos del plan habilitan o quitan permisos al instante', async () => {
    const plan = await prismaSystem.plan.create({ data: { codigo: `SOLO-INV-${sufijo}`, nombre: 'Solo inventario', precioMensual: 99, modulos: ['inventario'] } });
    await prismaSystem.tenant.update({ where: { id: F.tenant.id }, data: { planId: plan.id } });
    await invalidarPermisosEstudio(F.tenant.id);
    const me = (await api(T.admin).get('/me')).body;
    expect(me.modulos).toEqual(['inventario']);
    expect(Object.keys((await api(T.admin).get('/me/permisos')).body.grants).some((c) => c.startsWith('pos.'))).toBe(false);
    expect((await api(T.admin).get(`/pos/cajas?empresaId=${F.empresa.id}`)).status).toBe(403);

    // Se contrata el punto de venta y la facturación aparte del plan
    await prismaSystem.tenant.update({ where: { id: F.tenant.id }, data: { modulosAdicionales: ['pos', 'facturacion'] } });
    await invalidarPermisosEstudio(F.tenant.id);
    expect((await api(T.admin).get('/me')).body.modulos.sort()).toEqual(['facturacion', 'inventario', 'pos']);
    expect((await api(T.admin).get(`/pos/cajas?empresaId=${F.empresa.id}`)).status).toBe(200);
    // Crédito y cobranzas sigue sin contratarse
    expect((await api(T.admin).get(`/cxc/clientes?empresaId=${F.empresa.id}`)).status).toBe(403);
  });

  it('configuración por empresa: el token se guarda cifrado y nunca vuelve al navegador', async () => {
    expect((await api(T.cajero).get(`/cpe/config?empresaId=${F.empresa.id}`)).status).toBe(403);
    const r = await api(T.admin).put('/cpe/config', { empresaId: F.empresa.id, proveedor: 'SIMULADO', ambiente: 'PRUEBAS', token: 'secreto-123', envioAutomatico: false });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.tieneToken).toBe(true);
    expect(JSON.stringify(r.body)).not.toContain('secreto-123');
    const fila = await prismaSystem.configFacturacion.findUnique({ where: { empresaId: F.empresa.id } });
    expect(fila.tokenCifrado).not.toContain('secreto-123');
    // Guardar sin token conserva el anterior
    await api(T.admin).put('/cpe/config', { empresaId: F.empresa.id, proveedor: 'SIMULADO', ambiente: 'PRUEBAS', envioAutomatico: false }).expect(200);
    expect((await api(T.admin).get(`/cpe/config?empresaId=${F.empresa.id}`)).body.tieneToken).toBe(true);
    expect((await api(T.admin).post('/cpe/config/probar', { empresaId: F.empresa.id })).body.ok).toBe(true);
  });

  it('factura aceptada con hash y QR oficial; boleta enviada y luego aceptada; nota de venta no aplica', async () => {
    caja = (await api(T.admin).post('/pos/cajas', { nombre: 'Caja 1', almacenId: F.a1.id, ...SERIES })).body;
    await api(T.cajero).post(`/pos/cajas/${caja.id}/abrir`, { montoApertura: '0' }).expect(201);
    clienteRuc = (await api(T.cajero).post('/clientes', { empresaId: F.empresa.id, tipoDocumento: 'RUC', numeroDocumento: '20131312955', nombre: 'Cliente SAC', direccion: 'Av. Lima 1' })).body;
    const vender = (tipo, extra = {}) =>
      api(T.cajero).post('/pos/ventas', { cajaId: caja.id, tipo, items: [{ productoId: F.p1.id, cantidad: '2' }], pagos: [{ medio: 'EFECTIVO', monto: '7' }], ...extra });

    const f = (await vender('FACTURA', { clienteId: clienteRuc.id })).body;
    expect((await api(T.cajero).get(`/pos/comprobantes/${f.id}`)).body.estadoSunat).toBe('PENDIENTE');
    const env = await api(T.cajero).post(`/cpe/comprobantes/${f.id}/enviar`);
    expect(env.status, JSON.stringify(env.body)).toBe(200);
    expect(env.body.estado).toBe('ACEPTADO');
    const d = (await api(T.cajero).get(`/pos/comprobantes/${f.id}`)).body;
    expect(d.sunatHash).toBeTruthy();
    expect(d.sunatQr).toMatch(/^20100070970\|01\|F001\|00000001\|1\.07\|7\.00\|\d{4}-\d{2}-\d{2}\|6\|20131312955\|.+\|$/);
    // Reenviar algo ya aceptado no lo duplica
    expect((await api(T.cajero).post(`/cpe/comprobantes/${f.id}/enviar`)).body.mensaje).toMatch(/Ya tiene respuesta/);

    const b = (await vender('BOLETA')).body;
    expect((await api(T.cajero).post(`/cpe/comprobantes/${b.id}/enviar`)).body.estado).toBe('ENVIADO');
    expect((await api(T.cajero).post(`/cpe/comprobantes/${b.id}/enviar`)).body.estado).toBe('ACEPTADO');

    const nv = (await vender('NOTA_VENTA')).body;
    expect((await api(T.cajero).post(`/cpe/comprobantes/${nv.id}/enviar`)).body.estado).toBe('NO_APLICA');
  });

  it('SUNAT rechaza: queda registrado el código y el motivo', async () => {
    const c = (await api(T.cajero).post('/clientes', { empresaId: F.empresa.id, tipoDocumento: 'RUC', numeroDocumento: '10460278975', nombre: 'Comercial RECHAZO EIRL' })).body;
    const f = (await api(T.cajero).post('/pos/ventas', { cajaId: caja.id, tipo: 'FACTURA', clienteId: c.id, items: [{ productoId: F.p1.id, cantidad: '1' }], pagos: [{ medio: 'EFECTIVO', monto: '3.5' }] })).body;
    const r = (await api(T.cajero).post(`/cpe/comprobantes/${f.id}/enviar`)).body;
    expect(r.estado).toBe('RECHAZADO');
    const d = (await api(T.cajero).get(`/pos/comprobantes/${f.id}`)).body;
    expect([d.sunatCodigo, d.sunatDescripcion]).toEqual(['2017', expect.stringMatching(/no existe/)]);
  });

  it('anular una factura aceptada comunica la baja a SUNAT; si nunca se envió, no se envía', async () => {
    const f = (await api(T.cajero).post('/pos/ventas', { cajaId: caja.id, tipo: 'FACTURA', clienteId: clienteRuc.id, items: [{ productoId: F.p1.id, cantidad: '1' }], pagos: [{ medio: 'EFECTIVO', monto: '3.5' }] })).body;
    await api(T.cajero).post(`/cpe/comprobantes/${f.id}/enviar`).expect(200);
    await api(T.admin).post(`/pos/comprobantes/${f.id}/anular`, { motivo: 'Error en el precio' }).expect(200);
    // (la cola la procesa sola; aquí se invoca directo)
    expect((await darDeBaja({ tenantId: F.tenant.id, comprobanteId: f.id, motivo: 'Error en el precio' })).estado).toBe('ACEPTADA');
    const d = (await api(T.admin).get(`/pos/comprobantes/${f.id}`)).body;
    expect([d.estado, d.estadoSunat, d.bajaEstado]).toEqual(['ANULADO', 'ANULADO', 'ACEPTADA']);

    const g = (await api(T.cajero).post('/pos/ventas', { cajaId: caja.id, tipo: 'FACTURA', clienteId: clienteRuc.id, items: [{ productoId: F.p1.id, cantidad: '1' }], pagos: [{ medio: 'EFECTIVO', monto: '3.5' }] })).body;
    await api(T.admin).post(`/pos/comprobantes/${g.id}/anular`, { motivo: 'Cliente desistió' }).expect(200);
    expect((await api(T.cajero).post(`/cpe/comprobantes/${g.id}/enviar`)).body.mensaje).toMatch(/Anulado antes de enviarse/);
  });

  it('resumen de estados para el aviso de pendientes', async () => {
    const r = (await api(T.cajero).get(`/cpe/resumen?empresaId=${F.empresa.id}`)).body;
    expect(r.porEstado).toMatchObject({ ACEPTADO: 2, RECHAZADO: 1, ANULADO: 1, PENDIENTE: 1 });
    expect([r.configurada, r.puedeConfigurar, r.puedeEnviar]).toEqual([true, false, true]);
  });
});

describe('SUNAT parte B: detracción, retención y validación de compras', () => {
  let caja;
  let cliente;
  let servicio;
  const vender = (extra) => api(T.cajero).post('/pos/ventas', { cajaId: caja.id, tipo: 'FACTURA', clienteId: cliente.id, ...extra });

  beforeAll(async () => {
    caja = (await api(T.admin).get(`/pos/cajas?empresaId=${F.empresa.id}`)).body[0];
    cliente = (await api(T.cajero).get(`/clientes?empresaId=${F.empresa.id}&q=20131312955`)).body.datos[0];
    const unidad = await prismaSystem.unidadMedida.findFirst({ where: { tenantId: F.tenant.id, codigo: 'NIU' } });
    servicio = await prismaSystem.producto.create({
      data: { tenantId: F.tenant.id, empresaId: F.empresa.id, sku: 'SRV1', nombre: 'Mantenimiento de equipos', unidadId: unidad.id, precioReferencial: 1180, detraccionCodigo: '037' },
    });
    await api(T.admin).post('/kardex/entradas', { almacenId: F.a1.id, motivo: 'COMPRA', items: [{ productoId: servicio.id, cantidad: '10', costoUnitario: '500' }] }).expect(201);
  });

  it('factura sujeta a detracción: exige la cuenta del Banco de la Nación y se cobra el neto', async () => {
    const sinCuenta = await vender({ items: [{ productoId: servicio.id, cantidad: '1' }], pagos: [{ medio: 'TRANSFERENCIA', monto: '1038' }] });
    expect(sinCuenta.status).toBe(409);
    expect(sinCuenta.body.error).toMatch(/cuenta de detracciones/);
    await prismaSystem.empresa.update({ where: { id: F.empresa.id }, data: { cuentaDetracciones: '00-123-456789' } });

    // 1180 × 12 % = 141.60 → se deposita redondeado: 142; el cliente paga 1038
    expect((await vender({ items: [{ productoId: servicio.id, cantidad: '1' }], pagos: [{ medio: 'TRANSFERENCIA', monto: '1180' }] })).status).toBe(400);
    const r = await vender({ items: [{ productoId: servicio.id, cantidad: '1' }], pagos: [{ medio: 'TRANSFERENCIA', monto: '1038' }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const d = (await api(T.cajero).get(`/pos/comprobantes/${r.body.id}`)).body;
    expect([d.total, d.detraccionCodigo, d.detraccionPorcentaje, d.detraccionMonto, d.retencionMonto]).toEqual(['1180', '037', '12', '142', '0']);
    // La detracción no se puede alterar después
    await expect(prismaSystem.comprobante.update({ where: { id: d.id }, data: { detraccionMonto: 0 } })).rejects.toThrow(/no se modifica/);
  });

  it('retención del 3 % a un cliente agente de retención; la boleta no se ve afectada', async () => {
    await api(T.admin).put(`/clientes/${cliente.id}`, { tipoDocumento: 'RUC', numeroDocumento: cliente.numeroDocumento, nombre: cliente.nombre, agenteRetencion: true }).expect(200);
    // 250 × 3.50 = 875 → retención 26.25 → a cobrar 848.75
    const r = await vender({ items: [{ productoId: F.p1.id, cantidad: '250' }], pagos: [{ medio: 'EFECTIVO', monto: '848.75' }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const d = (await api(T.cajero).get(`/pos/comprobantes/${r.body.id}`)).body;
    expect([d.retencionMonto, d.detraccionMonto]).toEqual(['26.25', '0']);
    // Empresa exceptuada (buen contribuyente): no hay retención
    await prismaSystem.empresa.update({ where: { id: F.empresa.id }, data: { exceptuadoRetencion: true } });
    const sin = await vender({ items: [{ productoId: F.p1.id, cantidad: '250' }], pagos: [{ medio: 'EFECTIVO', monto: '875' }] });
    expect(sin.status, JSON.stringify(sin.body)).toBe(201);
    await prismaSystem.empresa.update({ where: { id: F.empresa.id }, data: { exceptuadoRetencion: false } });
    const b = await api(T.cajero).post('/pos/ventas', { cajaId: caja.id, tipo: 'BOLETA', clienteId: cliente.id, items: [{ productoId: servicio.id, cantidad: '1' }], pagos: [{ medio: 'EFECTIVO', monto: '1180' }] });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
  });

  it('documento al proveedor con la detracción', async () => {
    const c = await prismaSystem.comprobante.findFirst({ where: { empresaId: F.empresa.id, detraccionMonto: { gt: 0 } }, include: { detalles: true, cuotas: true, referencia: true } });
    const { documentoNeutro } = await import('../src/cpe/documento.js');
    const cuerpo = cuerpoNubefact(documentoNeutro(c, { ruc: '20100070970', cuentaDetracciones: '00-123-456789' }));
    expect(cuerpo).toMatchObject({ sunat_transaction: 30, detraccion: true, detraccion_tipo: 37, detraccion_porcentaje: 12, detraccion_total: 142, total: 1180 });
  });

  it('compras: se valida el comprobante del proveedor en SUNAT antes de registrarlo', async () => {
    const compra = (serie) => api(T.admin).post('/compras', {
      almacenId: F.a1.id, terceroDocumento: '20131312955', terceroNombre: 'Proveedor SAC', comprobanteTipo: 'FACTURA',
      serie, numero: String(Math.floor(Math.random() * 99999) + 1), fechaEmision: '2026-10-01', items: [{ productoId: F.p1.id, cantidad: '10', valorUnitario: '2' }],
    });
    const falsa = (await compra('X001')).body;
    const r = await api(T.admin).post(`/compras/${falsa.id}/confirmar`, {});
    expect(r.status).toBe(409);
    expect(r.body.detalles).toMatchObject({ codigo: 'VALIDACION_SUNAT', estado: 'NO_EXISTE' });
    expect((await api(T.admin).get(`/compras/${falsa.id}`)).body).toMatchObject({ estado: 'BORRADOR', validacionEstado: 'NO_EXISTE' });
    // Se puede confirmar a conciencia (queda auditado)
    expect((await api(T.admin).post(`/compras/${falsa.id}/confirmar`, { forzar: true })).status).toBe(200);

    const buena = (await compra('F001')).body;
    const v = await api(T.admin).post(`/compras/${buena.id}/validar-sunat`);
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect(v.body).toMatchObject({ estado: 'VALIDO', rucEstado: 'ACTIVO', rucCondicion: 'HABIDO' });
    expect((await api(T.admin).post(`/compras/${buena.id}/confirmar`, {})).status).toBe(200);
  });
});

describe('conector Nubefact', () => {
  const D = (v) => new Prisma.Decimal(v);
  const doc = {
    emisor: { ruc: '20100070970' }, tipo: 'NOTA_CREDITO', serie: 'FC01', numero: 3, fecha: '2026-10-06', moneda: 'PEN',
    cliente: { tipoDocumento: 'RUC', numeroDocumento: '20131312955', nombre: 'Cliente SAC', direccion: 'Av. Lima 1' },
    totales: { gravada: D('10'), exonerada: D('5'), inafecta: D('0'), igv: D('1.8'), total: D('16.8'), descuentos: D('0') },
    items: [
      { codigo: 'P1', descripcion: 'Gaseosa', unidad: 'NIU', cantidad: D('3'), valorUnitario: D('3.3333333333'), precioUnitario: D('3.9333333333'), valorVenta: D('10'), igv: D('1.8'), total: D('11.8'), afectacion: '10' },
      { codigo: 'P2', descripcion: 'Arroz', unidad: 'NIU', cantidad: D('1'), valorUnitario: D('5'), precioUnitario: D('5'), valorVenta: D('5'), igv: D('0'), total: D('5'), afectacion: '20' },
    ],
    formaPago: 'CREDITO', montoCredito: D('16.8'), cuotas: [{ numero: 1, monto: D('16.8'), fecha: '2026-11-05' }],
    referencia: { tipo: 'FACTURA', serie: 'F001', numero: 10 }, motivoNotaCredito: { codigo: '07', descripcion: 'Devolución por ítem' },
  };

  it('traduce montos, IGV por línea, crédito y la referencia de la nota de crédito', () => {
    const c = cuerpoNubefact(doc);
    expect(c).toMatchObject({
      operacion: 'generar_comprobante', tipo_de_comprobante: 3, serie: 'FC01', numero: 3, fecha_de_emision: '06-10-2026',
      cliente_tipo_de_documento: '6', total_gravada: 10, total_exonerada: 5, total_igv: 1.8, total: 16.8,
      documento_que_se_modifica_tipo: 1, documento_que_se_modifica_serie: 'F001', documento_que_se_modifica_numero: 10, tipo_de_nota_de_credito: 7,
      condiciones_de_pago: 'CRÉDITO', venta_al_credito: [{ cuota: 1, fecha_de_pago: '05-11-2026', importe: 16.8 }],
    });
    expect(c.items.map((i) => [i.tipo_de_igv, i.subtotal, i.igv, i.total])).toEqual([[1, 10, 1.8, 11.8], [8, 5, 0, 5]]);
  });

  it('interpreta las respuestas: aceptado, rechazado, pendiente y caída (reintento)', async () => {
    const cfg = { url: 'https://api.nubefact.test/ruta', token: 'tk' };
    const responder = (status, json) => vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify(json), { status }));
    responder(200, { aceptada_por_sunat: true, sunat_description: 'Aceptada', sunat_responsecode: '0', codigo_hash: 'H', cadena_para_codigo_qr: 'Q', enlace_del_cdr: 'cdr' });
    expect(await nubefact.enviar(cfg, doc)).toMatchObject({ estado: 'ACEPTADO', hash: 'H', qr: 'Q', cdr: 'cdr' });
    responder(200, { aceptada_por_sunat: false, sunat_responsecode: '2800', sunat_description: 'Tipo de documento no válido' });
    expect(await nubefact.enviar(cfg, doc)).toMatchObject({ estado: 'RECHAZADO', codigo: '2800' });
    responder(200, { aceptada_por_sunat: false });
    expect((await nubefact.enviar(cfg, doc)).estado).toBe('ENVIADO');
    responder(503, {});
    await expect(nubefact.enviar(cfg, doc)).rejects.toThrow(/reintentará/);
    responder(200, { errors: 'Token inválido', codigo: 10 });
    await expect(nubefact.enviar(cfg, doc)).rejects.toThrow(/Token inválido/);
    vi.restoreAllMocks();
  });
});
