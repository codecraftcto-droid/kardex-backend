import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import argon2 from 'argon2';
import ExcelJS from 'exceljs';

const { crearApp } = await import('../src/app.js');
const { prismaSystem, prismaApp, withTenant } = await import('../src/lib/prisma.js');
const { redis } = await import('../src/lib/redis.js');
const { crearEstudio } = await import('../src/services/estudios.js');
const { cargarBase } = await import('../src/contabilidad/servicio.js');
const { generarPeriodo } = await import('../src/contabilidad/asientos.js');
const { periodoActual } = await import('../src/sire/periodos.js');

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
const hoy = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
const csv = (lineas) => Buffer.from(lineas.join('\n'), 'utf8').toString('base64');
async function xlsx(filas) {
  const libro = new ExcelJS.Workbook();
  const hoja = libro.addWorksheet('Datos');
  for (const f of filas) hoja.addRow(f);
  return Buffer.from(await libro.xlsx.writeBuffer()).toString('base64');
}

beforeAll(async () => {
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  F = await prismaSystem.$transaction(async (tx) => {
    const { tenant, roles } = await crearEstudio(tx, { nombre: `IMPORT-${sufijo}` });
    const empresa = await tx.empresa.create({ data: { tenantId: tenant.id, razonSocial: 'Importa SAC', ruc: '20100070970' } });
    const sede = await tx.sede.create({ data: { tenantId: tenant.id, empresaId: empresa.id, nombre: 'Central' } });
    const a1 = await tx.almacen.create({ data: { tenantId: tenant.id, empresaId: empresa.id, sedeId: sede.id, codigo: 'A1', nombre: 'Principal' } });
    const existente = await tx.cliente.create({ data: { tenantId: tenant.id, empresaId: empresa.id, tipoDocumento: 'RUC', numeroDocumento: '20131312955', nombre: 'Nombre viejo' } });
    const usuario = (nombre, rol) =>
      tx.usuario.create({
        data: {
          tenantId: tenant.id, nombres: nombre, email: `${nombre}-${sufijo}@test.local`, estado: 'activo', passwordHash: hash,
          asignaciones: { create: { tenantId: tenant.id, rolId: roles[rol].id, alcanceTipo: 'estudio', alcanceId: null } },
        },
      });
    return { tenant, empresa, a1, existente, admin: await usuario('admin', 'Administrador'), asistente: await usuario('asistente', 'Asistente') };
  });
  await withTenant(F.tenant.id, (tx) => cargarBase(tx, { tenantId: F.tenant.id, empresaId: F.empresa.id }));
  for (const k of ['admin', 'asistente']) T[k] = (await request(app).post('/api/auth/login').send({ email: F[k].email, password: PASSWORD })).body.accessToken;
});

afterAll(async () => {
  await Promise.all([prismaSystem.$disconnect(), prismaApp.$disconnect(), redis.quit()]);
});

describe('importador', () => {
  const validar = (tipo, nombreArchivo, archivo, extra = {}, t = T.admin) => api(t).post('/importaciones/validar', { empresaId: F.empresa.id, tipo, nombreArchivo, archivo, ...extra });
  const aplicar = (id, t = T.admin) => api(t).post(`/importaciones/${id}/aplicar`, {});

  it('tipos permitidos según el permiso de cada alta y plantillas descargables', async () => {
    const tipos = (await api(T.asistente).get(`/importaciones/tipos?empresaId=${F.empresa.id}`)).body;
    expect(Object.fromEntries(tipos.map((t) => [t.codigo, t.permitido]))).toEqual({ CLIENTES: true, PRODUCTOS: true, INVENTARIO_INICIAL: true, ASIENTO_APERTURA: false });
    const r = await api(T.admin).get(`/importaciones/plantilla/PRODUCTOS?empresaId=${F.empresa.id}`).buffer(true).parse((res, cb) => {
      const p = [];
      res.on('data', (c) => p.push(c));
      res.on('end', () => cb(null, Buffer.concat(p)));
    });
    expect(r.status).toBe(200);
    const libro = new ExcelJS.Workbook();
    await libro.xlsx.load(r.body);
    expect(libro.worksheets.map((h) => h.name)).toEqual(['Datos', 'Instrucciones']);
    expect(libro.getWorksheet('Datos').getRow(1).values.slice(1, 3)).toEqual(['Código (SKU)', 'Nombre']);
    expect((await api(T.asistente).get(`/importaciones/plantilla/ASIENTO_APERTURA?empresaId=${F.empresa.id}`)).status).toBe(403);
  });

  it('clientes desde CSV con ";": valida documentos, detecta repetidos y actualiza los existentes', async () => {
    const v = await validar('CLIENTES', 'clientes.csv', csv([
      'Tipo de documento;Número de documento;Nombre o razón social;Correo',
      'RUC;20131312955;Cliente Renovado SAC;compras@cliente.pe',
      'RUC;20131312956;RUC Malo SAC;',
      'DNI;1234567;DNI corto;',
      'DNI;46027897;Juan Pérez;juan@correo',
      'DNI;46027897;Juan Repetido;',
      'ce;AB123456;Extranjero Uno;',
    ]));
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    expect(v.body.resumen).toMatchObject({ total: 6, validas: 2, conError: 4, crear: 1, actualizar: 1 });
    const errores = Object.fromEntries(v.body.filas.map((f) => [f.numero, f.errores.join(' | ')]));
    expect(errores[3]).toMatch(/RUC inválido/);
    expect(errores[4]).toMatch(/8 dígitos/);
    expect(errores[5]).toMatch(/Correo inválido/);
    expect(errores[6]).toMatch(/repetido en el archivo \(fila 5\)/);
    const a = await aplicar(v.body.id);
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body.resultado).toEqual({ creados: 1, actualizados: 1, omitidas: 4 });
    expect((await prismaSystem.cliente.findUnique({ where: { id: F.existente.id } })).nombre).toBe('Cliente Renovado SAC');
    expect((await aplicar(v.body.id)).status).toBe(409);
  });

  it('productos desde Excel (encabezados en otro orden): crea categorías y rechaza unidades desconocidas', async () => {
    const v = await validar('PRODUCTOS', 'productos.xlsx', await xlsx([
      ['Nombre', 'Código (SKU)', 'Unidad', 'Categoría', 'Precio de venta', 'Detracción'],
      ['Gaseosa 500 ml', 'gas-500', 'NIU', 'Bebidas', '3.50', ''],
      ['Agua 1 L', 'AGUA-1', 'XXX', 'Bebidas', '2', ''],
      ['Mantenimiento', 'SRV-1', 'ZZ', 'Servicios', '118', '37'],
    ]));
    expect(v.body.resumen).toMatchObject({ validas: 2, conError: 1 });
    expect(v.body.filas[1].errores[0]).toMatch(/Unidad "XXX"/);
    const a = await aplicar(v.body.id);
    expect(a.body.resultado).toEqual({ creados: 2, actualizados: 0, categoriasCreadas: 2, omitidas: 1 });
    const p = await prismaSystem.producto.findUnique({ where: { empresaId_sku: { empresaId: F.empresa.id, sku: 'GAS-500' } } });
    expect(Number(p.precioReferencial)).toBe(3.5);
    expect((await prismaSystem.producto.findUnique({ where: { empresaId_sku: { empresaId: F.empresa.id, sku: 'SRV-1' } } })).detraccionCodigo).toBe('037');
  });

  it('inventario inicial: entrada de saldo inicial por almacén, una sola vez y sin asiento', async () => {
    const v = await validar('INVENTARIO_INICIAL', 'inventario.csv', csv([
      'Almacén,Código (SKU),Cantidad,Costo unitario',
      'A1,GAS-500,100,1.20',
      'A1,GAS-500,5,1.20',
      'A9,SRV-1,1,1',
      'A1,NO-EXISTE,1,1',
      'A1,SRV-1,"10","3,50"',
    ]));
    expect(v.body.resumen).toMatchObject({ validas: 2, conError: 3, valorTotal: 155 });
    const a = await aplicar(v.body.id);
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body.resultado).toMatchObject({ productos: 2, movimientos: [expect.stringMatching(/^E-/)], valorTotal: 155 });
    const mov = await prismaSystem.movimiento.findFirst({ where: { empresaId: F.empresa.id, motivo: 'SALDO_INICIAL' }, include: { detalles: true } });
    expect(mov.detalles).toHaveLength(2);
    // Una segunda carga del mismo producto ya no es "inicial"
    const otra = await validar('INVENTARIO_INICIAL', 'otra.csv', csv(['Almacén,Código (SKU),Cantidad,Costo unitario', 'A1,GAS-500,1,1']));
    expect(otra.body.filas[0].errores[0]).toMatch(/ya tiene movimientos/);
    // El saldo inicial no genera asiento (el valor entra por el asiento de apertura)
    const g = await withTenant(F.tenant.id, (tx) => generarPeriodo(tx, { tenantId: F.tenant.id, empresaId: F.empresa.id, periodo: periodoActual(), usuarioId: F.admin.id }));
    expect(g.creados).toBe(0);
  });

  it('asiento de apertura: completo y cuadrado; compara la cuenta 20 con el inventario del kardex', async () => {
    const filas = (extra = []) => [['Cuenta', 'Debe', 'Haber', 'RUC/DNI del tercero', 'Nombre del tercero'], ['1041', '1000', '', '', ''], ['20111', '155', '', '', ''], ['4212', '', '300', '20512345678', 'Proveedor SAC'], ...extra];
    const descuadrado = await validar('ASIENTO_APERTURA', 'apertura.xlsx', await xlsx(filas([['5011', '', '800']])), { opciones: { fecha: hoy() } });
    expect(descuadrado.body.bloqueo).toMatch(/No cuadra: debe S\/ 1155\.00 y haber S\/ 1100\.00/);
    expect((await aplicar(descuadrado.body.id)).status).toBe(409);
    expect((await validar('ASIENTO_APERTURA', 'a.xlsx', await xlsx(filas([['5011', '', '855']])), { opciones: { fecha: hoy() } }, T.asistente)).status).toBe(403);

    const v = await validar('ASIENTO_APERTURA', 'apertura.xlsx', await xlsx(filas([['5011', '', '855']])), { opciones: { fecha: hoy() } });
    expect(v.body.bloqueo).toBeNull();
    expect(v.body.resumen).toMatchObject({ debe: 1155, haber: 1155, cuenta20: 155, inventarioKardex: 155 });
    const a = await aplicar(v.body.id);
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const asiento = await prismaSystem.asiento.findUnique({ where: { id: a.body.resultado.asientoId }, include: { lineas: true } });
    expect([asiento.origen, asiento.glosa, Number(asiento.totalDebe)]).toEqual(['MANUAL', 'Asiento de apertura (importado)', 1155]);
    expect(asiento.lineas.find((l) => l.cuenta === '4212')).toMatchObject({ terceroDoc: '20512345678', terceroNombre: 'Proveedor SAC' });
  });

  it('archivos inválidos, descartar e historial', async () => {
    expect((await validar('CLIENTES', 'clientes.txt', csv(['x']))).body.error).toMatch(/\.xlsx o \.csv/);
    expect((await validar('CLIENTES', 'clientes.csv', csv(['Nombre', 'Sin documento']))).body.error).toMatch(/Faltan columnas.*Tipo de documento/);
    const v = await validar('CLIENTES', 'c.csv', csv(['Tipo de documento,Número de documento,Nombre o razón social', 'DNI,70707070,Ana']));
    expect((await api(T.admin).post(`/importaciones/${v.body.id}/descartar`, {})).status).toBe(204);
    expect((await aplicar(v.body.id)).status).toBe(409);
    const h = (await api(T.asistente).get(`/importaciones?empresaId=${F.empresa.id}`)).body;
    // El asistente no ve las importaciones de asientos de apertura
    expect(h.datos.some((x) => x.tipo === 'ASIENTO_APERTURA')).toBe(false);
    expect(h.datos.find((x) => x.estado === 'DESCARTADA')).toMatchObject({ tipo: 'CLIENTES', usuario: 'admin' });
  });
});
