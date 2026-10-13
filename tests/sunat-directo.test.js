import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import argon2 from 'argon2';

// El servicio Laravel se reemplaza por respuestas simuladas (fetch); aquí se prueba el conector
process.env.SUNAT_SERVICIO_URL = 'http://sunat-servicio.interno';
process.env.SUNAT_SERVICIO_TOKEN = 'clave-compartida-de-pruebas-con-32-caracteres';

const { crearApp } = await import('../src/app.js');
const { prismaSystem, prismaApp } = await import('../src/lib/prisma.js');
const { redis } = await import('../src/lib/redis.js');
const { crearEstudio } = await import('../src/services/estudios.js');
const { darDeBaja, enviarComprobante } = await import('../src/cpe/servicio.js');
const { enviarGuia } = await import('../src/gre/servicio.js');
const { cuerpoComprobante } = await import('../src/cpe/proveedores/sunatDirecto.js');

const app = crearApp();
const PASSWORD = 'Prueba123!';
const sufijo = crypto.randomBytes(4).toString('hex');
const auth = (t) => ({ Authorization: `Bearer ${t}` });
let F;
let T;
const api = (u) => ({
  get: (r) => request(app).get(`/api${r}`).set(auth(T)),
  post: (r, b) => request(app).post(`/api${r}`).set(auth(T)).send(b),
  put: (r, b) => request(app).put(`/api${r}`).set(auth(T)).send(b),
});
const b64 = (s) => Buffer.from(s).toString('base64');

/** Servicio SUNAT simulado: registra cada llamada y responde según la ruta */
const llamadas = [];
let respuestas = {};
function servicioSimulado() {
  vi.stubGlobal('fetch', vi.fn(async (url, opciones) => {
    const ruta = new URL(url).pathname.replace('/v1/', '');
    const cuerpo = JSON.parse(opciones.body);
    llamadas.push({ ruta, cuerpo, autorizacion: opciones.headers.Authorization });
    const r = typeof respuestas[ruta] === 'function' ? respuestas[ruta](cuerpo) : respuestas[ruta];
    return new Response(JSON.stringify(r?.http ? r.cuerpo : r), { status: r?.http ?? 200, headers: { 'Content-Type': 'application/json' } });
  }));
}

beforeAll(async () => {
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  F = await prismaSystem.$transaction(async (tx) => {
    const { tenant, roles } = await crearEstudio(tx, { nombre: `Directo-${sufijo}` });
    await tx.tenant.update({ where: { id: tenant.id }, data: { modulosAdicionales: ['pos', 'facturacion'] } });
    const empresa = await tx.empresa.create({ data: { tenantId: tenant.id, razonSocial: 'Bodega Directa SAC', ruc: '20100070970', direccion: 'Av. Lima 1' } });
    const sede = await tx.sede.create({ data: { tenantId: tenant.id, empresaId: empresa.id, nombre: 'Tienda', direccion: 'Jr. Unión 450', ubigeo: '150101', codigoEstablecimiento: '0001' } });
    const a1 = await tx.almacen.create({ data: { tenantId: tenant.id, empresaId: empresa.id, sedeId: sede.id, codigo: 'A1', nombre: 'A1' } });
    const unidad = await tx.unidadMedida.findFirst({ where: { tenantId: tenant.id, codigo: 'NIU' } });
    const p1 = await tx.producto.create({ data: { tenantId: tenant.id, empresaId: empresa.id, sku: 'P1', nombre: 'Gaseosa 500 ml', unidadId: unidad.id, precioReferencial: 3.5 } });
    const admin = await tx.usuario.create({
      data: {
        tenantId: tenant.id, nombres: 'admin', email: `admin-directo-${sufijo}@test.local`, estado: 'activo', passwordHash: hash,
        asignaciones: { create: { tenantId: tenant.id, rolId: roles.Administrador.id, alcanceTipo: 'estudio', alcanceId: null } },
      },
    });
    return { tenant, empresa, sede, a1, p1, admin };
  });
  T = (await request(app).post('/api/auth/login').send({ email: F.admin.email, password: PASSWORD })).body.accessToken;
  await api().post('/kardex/entradas', { almacenId: F.a1.id, motivo: 'COMPRA', items: [{ productoId: F.p1.id, cantidad: '1000', costoUnitario: '2' }] }).expect(201);
  servicioSimulado();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await Promise.all([prismaSystem.$disconnect(), prismaApp.$disconnect(), redis.quit()]);
});

describe('SUNAT directo (servicio propio con Greenter)', () => {
  let caja;
  let cliente;
  const vender = (tipo, extra = {}) =>
    api().post('/pos/ventas', { cajaId: caja.id, tipo, items: [{ productoId: F.p1.id, cantidad: '2' }], pagos: [{ medio: 'EFECTIVO', monto: '7' }], ...extra });

  it('certificado y clave SOL: se guardan cifrados y nunca vuelven al navegador', async () => {
    respuestas['certificado/leer'] = { pem: '-----BEGIN PRIVATE KEY-----\nSECRETO\n-----END PRIVATE KEY-----', titular: 'BODEGA DIRECTA SAC', ruc: '20100070970', venceEn: '2028-01-31T00:00:00Z' };
    const c = await api().post('/cpe/config/certificado', { empresaId: F.empresa.id, pfx: b64('pfx-binario'), clave: 'clave-pfx' });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body).toEqual({ titular: 'BODEGA DIRECTA SAC', ruc: '20100070970', venceEn: '2028-01-31T00:00:00Z' });
    expect(llamadas.at(-1).autorizacion).toBe('Bearer clave-compartida-de-pruebas-con-32-caracteres');

    // Certificado de otro RUC: se rechaza
    respuestas['certificado/leer'] = { ...respuestas['certificado/leer'], ruc: '20999999999' };
    const otro = await api().post('/cpe/config/certificado', { empresaId: F.empresa.id, pfx: b64('pfx'), clave: '' });
    expect([otro.status, otro.body.error]).toEqual([400, expect.stringMatching(/RUC 20999999999/)]);

    const r = await api().put('/cpe/config', {
      empresaId: F.empresa.id, proveedor: 'SUNAT_DIRECTO', ambiente: 'PRODUCCION', envioAutomatico: false,
      solUsuario: 'factura1', solClave: 'clave-sol-secreta', greClientId: 'id-guias', greClientSecret: 'secreto-guias',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ solUsuario: 'FACTURA1', tieneSolClave: true, tieneCertificado: true, tieneGreSecret: true, certificadoTitular: 'BODEGA DIRECTA SAC' });
    const visible = JSON.stringify((await api().get(`/cpe/config?empresaId=${F.empresa.id}`)).body);
    for (const secreto of ['clave-sol-secreta', 'secreto-guias', 'SECRETO', 'Cifrad']) expect(visible).not.toContain(secreto);

    // La ficha de la empresa lo da por listo
    const ficha = (await api().get(`/empresas/${F.empresa.id}/configuracion`)).body;
    expect(ficha.checks.find((x) => x.clave === 'facturacion')).toMatchObject({ estado: 'ok', detalle: 'SUNAT directo · producción' });
  });

  it('probar conexión envía las credenciales descifradas al servicio', async () => {
    respuestas.probar = { ok: true, mensaje: 'Conexión con SUNAT correcta (producción)' };
    const r = await api().post('/cpe/config/probar', { empresaId: F.empresa.id });
    expect(r.body).toEqual({ ok: true, mensaje: 'Conexión con SUNAT correcta (producción)' });
    expect(llamadas.at(-1).cuerpo).toMatchObject({
      ambiente: 'PRODUCCION',
      credenciales: { ruc: '20100070970', usuarioSol: 'FACTURA1', claveSol: 'clave-sol-secreta', greClientSecret: 'secreto-guias', certificado: expect.stringContaining('SECRETO') },
    });
  });

  it('factura aceptada: guarda el XML y el CDR, y se descargan con el alcance del comprobante', async () => {
    caja = (await api().post('/pos/cajas', { nombre: 'Caja 1', almacenId: F.a1.id, serieFactura: 'F001', serieBoleta: 'B001', serieNotaVenta: 'NV01', serieNotaCreditoFactura: 'FC01', serieNotaCreditoBoleta: 'BC01' })).body;
    await api().post(`/pos/cajas/${caja.id}/abrir`, { montoApertura: '0' }).expect(201);
    cliente = (await api().post('/clientes', { empresaId: F.empresa.id, tipoDocumento: 'RUC', numeroDocumento: '20131312955', nombre: 'Cliente SAC' })).body;
    respuestas['comprobantes/enviar'] = (c) => ({
      estado: 'ACEPTADO', codigo: '0', descripcion: `La Factura numero ${c.documento.serie}-${c.documento.numero}, ha sido aceptada`, notas: [],
      nombre: `20100070970-01-${c.documento.serie}-${c.documento.numero}`, hash: 'HASH123=', xml: b64('<Invoice/>'), cdr: b64('PK-cdr'),
    });
    const f = (await vender('FACTURA', { clienteId: cliente.id })).body;
    const r = await enviarComprobante({ tenantId: F.tenant.id, comprobanteId: f.id });
    expect(r.estado).toBe('ACEPTADO');

    const doc = llamadas.at(-1).cuerpo.documento;
    expect(doc).toMatchObject({
      tipoDoc: '01', serie: 'F001', numero: 1, moneda: 'PEN', tipoOperacion: '0101', leyenda: 'SON: SIETE CON 00/100 SOLES',
      emisor: { ruc: '20100070970', direccion: 'Jr. Unión 450', ubigeo: '150101', establecimiento: '0001' },
      cliente: { tipoDoc: '6', numDoc: '20131312955' },
      totales: { gravada: 5.93, igv: 1.07, total: 7 },
      items: [{ codigo: 'P1', unidad: 'NIU', cantidad: 2, afectacion: '10' }],
    });
    expect(doc.horaEmision).toMatch(/^\d{2}:\d{2}:\d{2}$/);

    const d = (await api().get(`/pos/comprobantes/${f.id}`)).body;
    expect(d.sunatHash).toBe('HASH123=');
    expect(d.sunatQr).toMatch(/\|HASH123=\|$/);
    expect(d.sunatXml).toMatch(/^archivo:[0-9a-f-]{36}$/);
    expect(d.sunatCdr).toMatch(/^archivo:/);
    const xml = await api().get(`/cpe/archivos/${d.sunatXml.slice(8)}`);
    expect([xml.status, xml.headers['content-type'], xml.text]).toEqual([200, 'application/xml', '<Invoice/>']);
    expect(xml.headers['content-disposition']).toContain('20100070970-01-F001-1.xml');
    expect((await api().get(`/cpe/archivos/${crypto.randomUUID()}`)).status).toBe(404);
  });

  it('errores del servicio: transitorio se reintenta; datos inválidos quedan con el motivo', async () => {
    respuestas['comprobantes/enviar'] = { http: 503, cuerpo: { tipo: 'transitorio', codigo: '0109', mensaje: 'SUNAT no pudo procesar el envío (0109)' } };
    const f = (await vender('FACTURA', { clienteId: cliente.id })).body;
    await expect(enviarComprobante({ tenantId: F.tenant.id, comprobanteId: f.id })).rejects.toThrow(/0109/);

    respuestas['comprobantes/enviar'] = { http: 422, cuerpo: { tipo: 'documento', codigo: '1083', mensaje: 'SUNAT observó el documento (1083)' } };
    const r = await enviarComprobante({ tenantId: F.tenant.id, comprobanteId: f.id });
    expect([r.estado, r.error, r.mensaje]).toEqual(['PENDIENTE', true, expect.stringMatching(/1083/)]);

    // Ya registrado en SUNAT (se cortó la respuesta): se consulta el CDR en lugar de duplicar
    respuestas['comprobantes/enviar'] = { http: 409, cuerpo: { tipo: 'duplicado', codigo: '1033', mensaje: 'ya registrado' } };
    respuestas['comprobantes/consultar'] = { estado: 'ACEPTADO', codigo: '0', descripcion: 'aceptada', notas: [], cdr: b64('PK') };
    expect((await enviarComprobante({ tenantId: F.tenant.id, comprobanteId: f.id })).estado).toBe('ACEPTADO');
    expect(llamadas.at(-1).ruta).toBe('comprobantes/consultar');
  });

  it('anular: factura por comunicación de baja; boleta por resumen diario; luego se consulta el ticket', async () => {
    respuestas['comprobantes/enviar'] = (c) => ({ estado: 'ACEPTADO', codigo: '0', descripcion: 'ok', notas: [], nombre: `x-${c.documento.serie}-${c.documento.numero}`, hash: 'H', xml: b64('<x/>'), cdr: b64('PK') });
    respuestas['bajas/enviar'] = { estado: 'ENVIADO', ticket: 'T-BAJA-1', nombre: '20100070970-RA-20261012-001', xml: b64('<Voided/>') };
    respuestas['resumenes/enviar'] = { estado: 'ENVIADO', ticket: 'T-RES-1', nombre: '20100070970-RC-20261012-001', xml: b64('<Summary/>') };

    const f = (await vender('FACTURA', { clienteId: cliente.id })).body;
    await enviarComprobante({ tenantId: F.tenant.id, comprobanteId: f.id });
    await api().post(`/pos/comprobantes/${f.id}/anular`, { motivo: 'Error en el precio' }).expect(200);
    expect((await darDeBaja({ tenantId: F.tenant.id, comprobanteId: f.id, motivo: 'Error en el precio' })).estado).toBe('PENDIENTE');
    const baja = llamadas.at(-1);
    expect(baja.ruta).toBe('bajas/enviar');
    expect(baja.cuerpo.lote.detalles).toEqual([{ tipoDoc: '01', serie: 'F001', numero: f.numero, motivo: 'ERROR EN EL PRECIO' }]);

    respuestas['tickets/consultar'] = { estado: 'ACEPTADO', codigo: '0', descripcion: 'La Comunicacion de baja ha sido aceptada', notas: [], cdr: b64('PK') };
    expect((await darDeBaja({ tenantId: F.tenant.id, comprobanteId: f.id })).estado).toBe('ACEPTADA');
    expect(llamadas.at(-1).cuerpo.ticket).toBe('T-BAJA-1');
    const d = (await api().get(`/pos/comprobantes/${f.id}`)).body;
    expect([d.estadoSunat, d.bajaEstado]).toEqual(['ANULADO', 'ACEPTADA']);
    const archivos = await prismaSystem.archivoSunat.findMany({ where: { comprobanteId: f.id }, select: { tipo: true } });
    expect(archivos.map((a) => a.tipo).sort()).toEqual(['CDR', 'CDR_BAJA', 'XML', 'XML_BAJA']);

    const b = (await vender('BOLETA')).body;
    await enviarComprobante({ tenantId: F.tenant.id, comprobanteId: b.id });
    await api().post(`/pos/comprobantes/${b.id}/anular`, { motivo: 'Cliente desistió' }).expect(200);
    await darDeBaja({ tenantId: F.tenant.id, comprobanteId: b.id, motivo: 'Cliente desistió' });
    const resumen = llamadas.at(-1);
    expect(resumen.ruta).toBe('resumenes/enviar');
    expect(resumen.cuerpo.lote.detalles[0]).toMatchObject({ tipoDoc: '03', serie: 'B001', estado: '3', clienteTipo: '0', totales: { total: 7 } });
    // Correlativo propio por tipo y día
    expect([baja.cuerpo.lote.correlativo, resumen.cuerpo.lote.correlativo]).toEqual([1, 1]);
  });

  it('guía de remisión: se envía, guarda el ticket y se consulta hasta tener el CDR', async () => {
    const gr = await api().post('/guias', {
      almacenId: F.a1.id, motivo: '01', fechaTraslado: new Date().toISOString().slice(0, 10), modalidad: 'PRIVADO',
      destinatarioTipoDoc: 'RUC', destinatarioNumDoc: '20131312955', destinatarioNombre: 'Cliente SAC',
      partidaUbigeo: '150101', partidaDireccion: 'Jr. Unión 450', llegadaUbigeo: '040101', llegadaDireccion: 'Calle Mercaderes 456',
      pesoBruto: '20.5', unidadPeso: 'KGM', vehiculoPlaca: 'ABC-123',
      conductorTipoDoc: 'DNI', conductorNumDoc: '44556677', conductorNombres: 'Juan', conductorApellidos: 'Pérez', conductorLicencia: 'Q44556677',
      items: [{ productoId: F.p1.id, cantidad: '4' }],
    });
    expect(gr.status, JSON.stringify(gr.body)).toBe(201);
    respuestas['guias/enviar'] = { estado: 'ENVIADO', ticket: 'T-GUIA-9', nombre: '20100070970-09-T001-1', xml: b64('<DespatchAdvice/>') };
    expect((await enviarGuia({ tenantId: F.tenant.id, guiaId: gr.body.id })).estado).toBe('ENVIADO');
    expect(llamadas.at(-1).cuerpo.guia).toMatchObject({ modalidad: '02', placa: 'ABC123', conductor: { tipoDoc: '1', licencia: 'Q44556677' }, partida: { ubigeo: '150101' } });

    respuestas['guias/consultar'] = { estado: 'ACEPTADO', codigo: '0', descripcion: 'ACEPTADA', notas: [], cdr: b64('PK') };
    expect((await enviarGuia({ tenantId: F.tenant.id, guiaId: gr.body.id })).estado).toBe('ACEPTADO');
    expect(llamadas.at(-1).cuerpo.ticket).toBe('T-GUIA-9');
    const g = await prismaSystem.guiaRemision.findUnique({ where: { id: gr.body.id } });
    expect([g.estadoSunat, g.sunatTicket, g.sunatXml?.startsWith('archivo:'), g.sunatCdr?.startsWith('archivo:')]).toEqual(['ACEPTADO', 'T-GUIA-9', true, true]);
  });

  it('nota de crédito: referencia y motivo con el catálogo 09', () => {
    const doc = cuerpoComprobante({
      tipo: 'NOTA_CREDITO', serie: 'FC01', numero: 3, fecha: '2026-10-12', moneda: 'PEN', formaPago: 'CONTADO',
      emisor: { ruc: '20100070970', razonSocial: 'X' }, cliente: { tipoDocumento: 'RUC', numeroDocumento: '20131312955', nombre: 'C' },
      totales: { gravada: 10, exonerada: 0, inafecta: 0, igv: 1.8, total: 11.8 }, items: [],
      referencia: { tipo: 'FACTURA', serie: 'F001', numero: 1 }, motivoNotaCredito: { codigo: '7', descripcion: 'Devolución por ítem' },
    });
    expect([doc.tipoDoc, doc.referencia, doc.motivo]).toEqual(['07', { tipoDoc: '01', serie: 'F001', numero: 1 }, { codigo: '07', descripcion: 'Devolución por ítem' }]);
  });
});
