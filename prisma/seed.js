// Seed de desarrollo (idempotente): catálogo de permisos + estudio demo con dos empresas,
// productos, movimientos de kardex reales y usuarios con distintos alcances.
// Usa la conexión dueña (DATABASE_URL), que no está sujeta a RLS.
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { sincronizarCatalogo, crearEstudio, sembrarUnidades } from '../src/services/estudios.js';
import { cargarBase } from '../src/contabilidad/servicio.js';
import { registrarMovimiento } from '../src/kardex/servicio.js';
import * as transferencias from '../src/kardex/transferencias.js';
import * as comercial from '../src/comercial/documentos.js';
import Redis from 'ioredis';

const prisma = new PrismaClient();
const hash = (p) => argon2.hash(p, { type: argon2.argon2id });

const ADMIN_EMAIL = (process.env.SEED_ADMIN_EMAIL || 'admin@kardex.local').toLowerCase();
const DEMO_PASSWORD = 'Demo123!';

// ───────────── Datos demo ─────────────
const EMPRESAS = [
  {
    razonSocial: 'Comercial Andina S.A.C.',
    ruc: '20601234565',
    contacto: 'María Pérez',
    metodoValorizacion: 'PROMEDIO',
    sedes: [
      { nombre: 'Sede Central', direccion: 'Av. Javier Prado 1234, Lima', almacenes: [['ALM01', 'Almacén Principal'], ['ALM02', 'Almacén de Tránsito']] },
    ],
    categorias: ['Abarrotes', 'Útiles de oficina'],
    productos: [
      { sku: 'ARR-005', nombre: 'Arroz extra 5 kg', categoria: 'Abarrotes', unidad: 'NIU', codigoBarras: '7751234500011', precio: 24.9 },
      { sku: 'ACE-001', nombre: 'Aceite vegetal 1 L', categoria: 'Abarrotes', unidad: 'NIU', codigoBarras: '7751234500028', precio: 9.5 },
      { sku: 'AZU-001', nombre: 'Azúcar rubia 1 kg', categoria: 'Abarrotes', unidad: 'NIU', codigoBarras: '7751234500035', precio: 4.2 },
      { sku: 'LEC-400', nombre: 'Leche evaporada 400 g', categoria: 'Abarrotes', unidad: 'NIU', codigoBarras: '7751234500042', precio: 3.8 },
      { sku: 'PAP-A4', nombre: 'Papel bond A4 x 500', categoria: 'Útiles de oficina', unidad: 'PK', codigoBarras: '7751234500059', precio: 16 },
    ],
    // [almacén, tipo, motivo, documento, [[sku, cantidad, costo?]]]
    movimientos: [
      ['ALM01', 'ENTRADA', 'COMPRA', ['FACTURA', 'F001', '00012'], [['ARR-005', 100, 18.5], ['ACE-001', 200, 6.8], ['AZU-001', 300, 2.9], ['LEC-400', 480, 2.6], ['PAP-A4', 50, 11.5]]],
      ['ALM01', 'SALIDA', 'VENTA', ['BOLETA', 'B001', '00103'], [['ARR-005', 40], ['ACE-001', 150], ['LEC-400', 120]]],
      ['ALM01', 'ENTRADA', 'COMPRA', ['FACTURA', 'F001', '00019'], [['ARR-005', 60, 19.7], ['ACE-001', 100, 7.1]]],
      ['ALM01', 'SALIDA', 'VENTA', ['FACTURA', 'F002', '00045'], [['ARR-005', 70], ['AZU-001', 280]]],
      ['ALM01', 'SALIDA', 'MERMA', null, [['LEC-400', 12]]],
      ['ALM02', 'ENTRADA', 'COMPRA', ['FACTURA', 'F001', '00021'], [['ARR-005', 30, 19.2], ['PAP-A4', 20, 11.9]]],
    ],
    limites: [['ALM01', 'AZU-001', 50, 400], ['ALM01', 'ARR-005', 20, 200], ['ALM01', 'ACE-001', 30, 300]],
  },
  {
    razonSocial: 'Distribuidora del Sur E.I.R.L.',
    ruc: '20609876540',
    contacto: 'Jorge Quispe',
    metodoValorizacion: 'PEPS',
    sedes: [
      { nombre: 'Sede Arequipa', direccion: 'Calle Mercaderes 210, Arequipa', almacenes: [['ALM01', 'Almacén Central Arequipa']] },
      { nombre: 'Sede Cusco', direccion: 'Av. de la Cultura 845, Cusco', almacenes: [['ALM02', 'Almacén Cusco']] },
    ],
    categorias: ['Construcción', 'Ferretería', 'Pinturas'],
    productos: [
      { sku: 'CEM-425', nombre: 'Cemento Portland tipo I 42.5 kg', categoria: 'Construcción', unidad: 'NIU', codigoBarras: '7759876500017', precio: 32 },
      { sku: 'FIE-012', nombre: 'Fierro corrugado 1/2" x 9 m', categoria: 'Construcción', unidad: 'NIU', codigoBarras: '7759876500024', precio: 45 },
      { sku: 'CLA-003', nombre: 'Clavos de 3"', categoria: 'Ferretería', unidad: 'KGM', codigoBarras: '7759876500031', precio: 8 },
      { sku: 'PIN-LAT', nombre: 'Pintura látex blanca', categoria: 'Pinturas', unidad: 'GLL', codigoBarras: '7759876500048', precio: 38 },
      { sku: 'TUB-PVC', nombre: 'Tubo PVC 1/2" x 5 m', categoria: 'Ferretería', unidad: 'NIU', codigoBarras: '7759876500055', precio: 7.5 },
    ],
    movimientos: [
      ['ALM01', 'ENTRADA', 'COMPRA', ['FACTURA', 'F003', '01540'], [['CEM-425', 200, 27.5], ['FIE-012', 150, 38], ['CLA-003', 80, 5.2], ['PIN-LAT', 40, 29]]],
      ['ALM01', 'ENTRADA', 'COMPRA', ['FACTURA', 'F003', '01588'], [['CEM-425', 100, 29.9], ['PIN-LAT', 20, 31.5]]],
      // Con PEPS esta salida consume primero las 200 bolsas a 27.50 y luego 20 a 29.90
      ['ALM01', 'SALIDA', 'VENTA', ['FACTURA', 'F004', '00310'], [['CEM-425', 220], ['FIE-012', 60], ['PIN-LAT', 45]]],
      ['ALM01', 'SALIDA', 'MERMA', null, [['CLA-003', 5]]],
      ['ALM02', 'ENTRADA', 'COMPRA', ['FACTURA', 'F003', '01602'], [['CEM-425', 80, 30.2], ['TUB-PVC', 300, 4.1], ['FIE-012', 40, 39.5]]],
      ['ALM02', 'SALIDA', 'VENTA', ['BOLETA', 'B004', '00051'], [['TUB-PVC', 280], ['CEM-425', 25]]],
    ],
    limites: [['ALM01', 'CEM-425', 100, 500], ['ALM02', 'TUB-PVC', 50, 400], ['ALM01', 'PIN-LAT', 10, 80]],
  },
];

async function asegurarEstudio() {
  const admin = await prisma.usuario.findUnique({ where: { email: ADMIN_EMAIL } });
  if (admin) {
    const roles = await prisma.rol.findMany({ where: { tenantId: admin.tenantId } });
    return { tenantId: admin.tenantId, admin, roles: Object.fromEntries(roles.map((r) => [r.nombre, r])) };
  }
  return prisma.$transaction(async (tx) => {
    const { tenant, roles } = await crearEstudio(tx, { nombre: 'Estudio Contable Demo', ruc: '20123456789' });
    const creado = await tx.usuario.create({
      data: {
        tenantId: tenant.id,
        nombres: 'Administrador del Estudio',
        email: ADMIN_EMAIL,
        cargo: 'Administrador',
        estado: 'activo',
        passwordHash: await hash(process.env.SEED_ADMIN_PASSWORD || 'Admin123!'),
      },
    });
    await tx.usuarioRol.create({
      data: { tenantId: tenant.id, usuarioId: creado.id, rolId: roles.Administrador.id, alcanceTipo: 'estudio' },
    });
    console.log(`✔ Estudio demo creado. Acceso: ${ADMIN_EMAIL}`);
    return { tenantId: tenant.id, admin: creado, roles };
  });
}

/** Crea (si falta) la empresa con sus sedes, almacenes, catálogo y movimientos. */
async function asegurarEmpresa(tenantId, adminId, def) {
  return prisma.$transaction(
    async (tx) => {
      let empresa = await tx.empresa.findUnique({ where: { tenantId_ruc: { tenantId, ruc: def.ruc } } });
      if (!empresa) {
        empresa = await tx.empresa.create({
          data: { tenantId, razonSocial: def.razonSocial, ruc: def.ruc, contacto: def.contacto, metodoValorizacion: def.metodoValorizacion },
        });
      }

      const almacenes = {};
      for (const s of def.sedes) {
        let sede = await tx.sede.findUnique({ where: { empresaId_nombre: { empresaId: empresa.id, nombre: s.nombre } } });
        sede ||= await tx.sede.create({
          data: { tenantId, empresaId: empresa.id, nombre: s.nombre, direccion: s.direccion, responsableId: adminId },
        });
        for (const [codigo, nombre] of s.almacenes) {
          let alm = await tx.almacen.findUnique({ where: { empresaId_codigo: { empresaId: empresa.id, codigo } } });
          alm ||= await tx.almacen.create({ data: { tenantId, empresaId: empresa.id, sedeId: sede.id, codigo, nombre } });
          almacenes[codigo] = alm;
        }
      }

      if (await tx.producto.count({ where: { empresaId: empresa.id } })) {
        console.log(`✔ ${def.razonSocial}: ya tenía catálogo y movimientos`);
        return { empresa, almacenes };
      }

      const unidades = Object.fromEntries((await tx.unidadMedida.findMany({ where: { tenantId } })).map((u) => [u.codigo, u.id]));
      const categorias = {};
      for (const nombre of def.categorias) {
        categorias[nombre] = (await tx.categoria.create({ data: { tenantId, empresaId: empresa.id, nombre } })).id;
      }
      const productos = {};
      for (const p of def.productos) {
        productos[p.sku] = (
          await tx.producto.create({
            data: {
              tenantId, empresaId: empresa.id, sku: p.sku, nombre: p.nombre, codigoBarras: p.codigoBarras,
              categoriaId: categorias[p.categoria], unidadId: unidades[p.unidad], precioReferencial: p.precio,
            },
          })
        ).id;
      }

      // Los movimientos pasan por el MISMO motor de valorización que usa la API
      for (const [codigoAlm, tipo, motivo, doc, lineas] of def.movimientos) {
        await registrarMovimiento(tx, {
          tenantId,
          almacenId: almacenes[codigoAlm].id,
          tipo,
          motivo,
          usuarioId: adminId,
          ...(doc && { documentoTipo: doc[0], documentoSerie: doc[1], documentoNumero: doc[2] }),
          items: lineas.map(([sku, cantidad, costo]) => ({
            productoId: productos[sku],
            cantidad: String(cantidad),
            ...(costo != null && { costoUnitario: String(costo) }),
          })),
        });
      }
      for (const [codigoAlm, sku, minimo, maximo] of def.limites) {
        await tx.stock.update({
          where: { almacenId_productoId: { almacenId: almacenes[codigoAlm].id, productoId: productos[sku] } },
          data: { stockMinimo: minimo, stockMaximo: maximo },
        });
      }
      console.log(`✔ ${def.razonSocial} (${def.metodoValorizacion}): ${def.productos.length} productos, ${def.movimientos.length} movimientos`);
      return { empresa, almacenes };
    },
    { timeout: 60000 },
  );
}

async function asegurarUsuario(tenantId, { email, nombres, cargo }, asignaciones) {
  if (await prisma.usuario.findUnique({ where: { email } })) return;
  await prisma.usuario.create({
    data: {
      tenantId, email, nombres, cargo, estado: 'activo', passwordHash: await hash(DEMO_PASSWORD),
      asignaciones: { create: asignaciones.map((a) => ({ tenantId, ...a })) },
    },
  });
  console.log(`✔ Usuario demo ${email} / ${DEMO_PASSWORD}`);
}

/** Transferencias demo en distintos estados (Distribuidora del Sur: Arequipa → Cusco). */
async function asegurarTransferencias(tenantId, adminId, { empresa, almacenes }) {
  if (await prisma.transferencia.count({ where: { empresaId: empresa.id } })) return;
  await prisma.$transaction(
    async (tx) => {
      const sku = async (codigo) => (await tx.producto.findFirst({ where: { empresaId: empresa.id, sku: codigo } })).id;
      const [cemento, fierro, clavos] = await Promise.all(['CEM-425', 'FIE-012', 'CLA-003'].map(sku));
      const base = { tenantId, usuarioId: adminId, origenAlmacenId: almacenes.ALM01.id, destinoAlmacenId: almacenes.ALM02.id };

      // 1) Recibida con faltante: 30 bolsas despachadas, 28 recibidas
      const t1 = await transferencias.solicitar(tx, { ...base, observacion: 'Reposición obra Cusco', items: [{ productoId: cemento, cantidad: '30' }, { productoId: fierro, cantidad: '10' }] });
      await transferencias.aprobar(tx, { id: t1.id, usuarioId: adminId });
      await transferencias.despachar(tx, { tenantId, id: t1.id, usuarioId: adminId });
      await transferencias.recibir(tx, { tenantId, id: t1.id, usuarioId: adminId, cantidades: { [cemento]: '28' }, observacion: '2 bolsas rotas en el traslado' });
      // 2) En tránsito (despachada, falta recibir)
      const t2 = await transferencias.solicitar(tx, { ...base, items: [{ productoId: clavos, cantidad: '15' }] });
      await transferencias.aprobar(tx, { id: t2.id, usuarioId: adminId });
      await transferencias.despachar(tx, { tenantId, id: t2.id, usuarioId: adminId });
      // 3) Solicitada (pendiente de aprobación)
      await transferencias.solicitar(tx, { ...base, observacion: 'Stock para campaña', items: [{ productoId: cemento, cantidad: '20' }] });
    },
    { timeout: 60000 },
  );
  console.log('✔ Transferencias demo: recibida (con faltante), en tránsito y solicitada');
}

/** Compras y ventas demo (Comercial Andina): compra en dólares confirmada, venta confirmada y una en borrador. */
async function asegurarDocumentos(tenantId, adminId, { empresa, almacenes }) {
  if (await prisma.documentoComercial.count({ where: { empresaId: empresa.id } })) return;
  await prisma.$transaction(
    async (tx) => {
      const sku = async (codigo) => (await tx.producto.findFirst({ where: { empresaId: empresa.id, sku: codigo } })).id;
      const [arroz, aceite, azucar] = await Promise.all(['ARR-005', 'ACE-001', 'AZU-001'].map(sku));
      const base = { tenantId, usuarioId: adminId };
      const compra = await comercial.guardarBorrador(tx, {
        ...base, tipo: 'COMPRA',
        datos: {
          almacenId: almacenes.ALM01.id, terceroDocumento: '20100055237', terceroNombre: 'Alicorp S.A.A.', comprobanteTipo: 'FACTURA',
          serie: 'F002', numero: '8841', fechaEmision: new Date(), moneda: 'USD', tipoCambio: '3.7520',
          items: [{ productoId: azucar, cantidad: '400', valorUnitario: '0.78' }, { productoId: aceite, cantidad: '120', valorUnitario: '1.85' }],
        },
      });
      await comercial.confirmar(tx, { ...base, id: compra.id });
      const venta = await comercial.guardarBorrador(tx, {
        ...base, tipo: 'VENTA',
        datos: {
          almacenId: almacenes.ALM01.id, terceroDocumento: '20512345678', terceroNombre: 'Minimarket El Sol E.I.R.L.', comprobanteTipo: 'FACTURA',
          serie: 'F001', numero: '1205', fechaEmision: new Date(), moneda: 'PEN',
          items: [{ productoId: arroz, cantidad: '15', valorUnitario: '21.10' }, { productoId: azucar, cantidad: '60', valorUnitario: '3.56' }],
        },
      });
      await comercial.confirmar(tx, { ...base, id: venta.id });
      await comercial.guardarBorrador(tx, {
        ...base, tipo: 'VENTA',
        datos: {
          almacenId: almacenes.ALM01.id, terceroDocumento: '41234567', terceroNombre: 'Rosa Quispe Mamani', comprobanteTipo: 'BOLETA',
          serie: 'B001', numero: '3307', fechaEmision: new Date(), moneda: 'PEN',
          items: [{ productoId: aceite, cantidad: '6', valorUnitario: '8.05' }],
        },
      });
    },
    { timeout: 60000 },
  );
  console.log('✔ Compras y ventas demo: compra USD confirmada, venta confirmada y venta en borrador');
}

/** Planes comerciales y usuarios de plataforma de desarrollo (Módulo C). */
const PLANES = [
  { codigo: 'BASICO', nombre: 'Básico', descripcion: 'Para estudios pequeños', precioMensual: 149, maxEmpresas: 5, maxUsuarios: 5, maxAlmacenes: 10 },
  { codigo: 'PROFESIONAL', nombre: 'Profesional', descripcion: 'Para estudios en crecimiento', precioMensual: 349, maxEmpresas: 25, maxUsuarios: 20, maxAlmacenes: 60 },
  { codigo: 'CORPORATIVO', nombre: 'Corporativo', descripcion: 'Sin límites', precioMensual: 899, maxEmpresas: null, maxUsuarios: null, maxAlmacenes: null },
];

async function asegurarPlataforma(tenantId) {
  for (const p of PLANES) await prisma.plan.upsert({ where: { codigo: p.codigo }, update: {}, create: p });
  const profesional = await prisma.plan.findUnique({ where: { codigo: 'PROFESIONAL' } });
  await prisma.tenant.updateMany({ where: { id: tenantId, planId: null }, data: { planId: profesional.id, emailContacto: 'contacto@estudiodemo.pe' } });
  const usuarios = [
    { email: 'superadmin@kardex.local', nombres: 'Super Administrador', rol: 'ADMIN', password: 'Super123!' },
    { email: 'soporte@kardex.local', nombres: 'Mesa de Soporte', rol: 'SOPORTE', password: 'Soporte123!' },
  ];
  for (const u of usuarios) {
    if (await prisma.plataformaAdmin.findUnique({ where: { email: u.email } })) continue;
    await prisma.plataformaAdmin.create({ data: { email: u.email, nombres: u.nombres, rol: u.rol, passwordHash: await hash(u.password) } });
    console.log(`✔ Plataforma: ${u.email} / ${u.password} (${u.rol}); configurará 2FA en su primer ingreso`);
  }
  console.log('✔ Planes: Básico, Profesional (estudio demo) y Corporativo');
}

/** Punto de venta demo (Comercial Andina): una caja con series, clientes y un cajero operador. */
async function asegurarPuntoVenta(tenantId, roles, { empresa, almacenes }) {
  if (await prisma.caja.count({ where: { empresaId: empresa.id } })) return;
  const alm = almacenes.ALM01;
  await prisma.empresa.update({ where: { id: empresa.id }, data: { nombreComercial: 'Minimarket Andina', direccion: 'Av. Javier Prado 1234, San Isidro, Lima' } });
  await prisma.caja.create({
    data: {
      tenantId, empresaId: empresa.id, sedeId: alm.sedeId, almacenId: alm.id, nombre: 'Caja 1',
      serieFactura: 'F001', serieBoleta: 'B001', serieNotaVenta: 'NV01', serieNotaCreditoFactura: 'FC01', serieNotaCreditoBoleta: 'BC01',
    },
  });
  await prisma.cliente.createMany({
    data: [
      { tenantId, empresaId: empresa.id, tipoDocumento: 'RUC', numeroDocumento: '20131312955', nombre: 'Distribuidora Los Andes S.A.C.', direccion: 'Jr. Ucayali 456, Lima', email: 'compras@losandes.pe' },
      { tenantId, empresaId: empresa.id, tipoDocumento: 'DNI', numeroDocumento: '45678912', nombre: 'Carmen Rojas Huamán' },
    ],
  });
  if (!(await prisma.usuario.findUnique({ where: { email: 'cajero@kardex.local' } }))) {
    await prisma.usuario.create({
      data: {
        tenantId, email: 'cajero@kardex.local', nombres: 'Rosa Mendoza (cajera)', cargo: 'Cajera', tipo: 'operador', empresaId: empresa.id,
        estado: 'activo', passwordHash: await hash(DEMO_PASSWORD),
        asignaciones: { create: { tenantId, rolId: roles.Cajero.id, alcanceTipo: 'almacen', alcanceId: alm.id } },
      },
    });
  }
  console.log(`✔ Punto de venta demo: Caja 1 (F001/B001/NV01), 2 clientes y cajero@kardex.local / ${DEMO_PASSWORD}`);
}

/** Crédito demo: Carmen Rojas compra al crédito (tope S/ 500, 30 días) y tiene RUC 10 para facturas. */
async function asegurarCreditoDemo(empresa) {
  const carmen = await prisma.cliente.findFirst({ where: { empresaId: empresa.id, numeroDocumento: '45678912' } });
  if (!carmen || carmen.creditoHabilitado) return;
  await prisma.cliente.update({
    where: { id: carmen.id },
    data: { creditoHabilitado: true, limiteCredito: 500, diasCredito: 30, rucAsociado: '10456789124', telefono: '987654321' },
  });
  console.log('✔ Cliente con crédito demo: Carmen Rojas (límite S/ 500, 30 días, RUC 10456789124)');
}

/** Facturación electrónica demo: proveedor SIMULADO (responde como SUNAT, sin conexión real) */
async function asegurarFacturacionDemo(tenantId, empresa) {
  if (await prisma.configFacturacion.findUnique({ where: { empresaId: empresa.id } })) return;
  await prisma.configFacturacion.create({ data: { tenantId, empresaId: empresa.id, proveedor: 'SIMULADO', ambiente: 'PRUEBAS', envioAutomatico: true } });
  console.log('✔ Facturación electrónica demo: proveedor SIMULADO con envío automático');
}

/** Ubigeo y establecimiento de las sedes demo (puntos de partida/llegada de las guías de remisión) */
async function asegurarUbigeosDemo() {
  const datos = [
    ['Sede Central', 'Av. Javier Prado Este 1234, San Isidro, Lima', '150131', '0000'],
    ['Sede Arequipa', 'Calle Mercaderes 210, Arequipa', '040101', '0000'],
    ['Sede Cusco', 'Av. de la Cultura 845, Cusco', '080101', '0001'],
  ];
  for (const [nombre, direccion, ubigeo, codigoEstablecimiento] of datos) {
    await prisma.sede.updateMany({ where: { nombre, ubigeo: null }, data: { direccion, ubigeo, codigoEstablecimiento } });
  }
}

/** SIRE demo: conexión SIMULADA (sin SUNAT) para probar períodos y sincronización */
async function asegurarSireDemo(tenantId, empresa) {
  if (await prisma.configSire.findUnique({ where: { empresaId: empresa.id } })) return;
  await prisma.configSire.create({ data: { tenantId, empresaId: empresa.id, modo: 'SIMULADO' } });
  console.log(`✔ SIRE demo (SIMULADO): ${empresa.razonSocial}`);
}

/**
 * Cronograma de vencimientos REFERENCIAL para desarrollo: NO es el oficial. En producción lo carga
 * la plataforma (Plataforma → Cronograma SUNAT) desde la resolución que SUNAT publica cada año.
 * Patrón aproximado: desde el día 14 del mes siguiente, un día hábil más por cada grupo de dígitos.
 */
async function asegurarCronogramaReferencial() {
  if (await prisma.cronogramaSunat.count()) return;
  const desfase = { 0: 0, 1: 1, 2: 2, 3: 2, 4: 3, 5: 3, 6: 4, 7: 4, 8: 5, 9: 5, BC: 6 };
  const datos = [];
  for (const anio of [2025, 2026]) {
    for (let mes = 1; mes <= 12; mes += 1) {
      const periodo = `${anio}${String(mes).padStart(2, '0')}`;
      for (const [grupo, habiles] of Object.entries(desfase)) {
        const f = new Date(Date.UTC(mes === 12 ? anio + 1 : anio, mes % 12, 14));
        for (let n = habiles; n > 0 || [0, 6].includes(f.getUTCDay()); ) {
          f.setUTCDate(f.getUTCDate() + 1);
          if (![0, 6].includes(f.getUTCDay())) n -= 1;
        }
        datos.push({ periodo, grupo, vencimiento: f });
      }
    }
  }
  await prisma.cronogramaSunat.createMany({ data: datos });
  console.log('✔ Cronograma SUNAT REFERENCIAL 2025–2026 (reemplazar por el oficial)');
}

async function main() {
  await sincronizarCatalogo(prisma);
  console.log('✔ Catálogo de permisos sincronizado');

  const { tenantId, admin, roles } = await asegurarEstudio();
  await sembrarUnidades(prisma, tenantId);

  const resultados = [];
  for (const def of EMPRESAS) resultados.push(await asegurarEmpresa(tenantId, admin.id, def));
  const [rAndina, rSur] = resultados;

  // Contador con dos empresas: puede cambiar de empresa en el selector
  await asegurarUsuario(tenantId, { email: 'contador@kardex.local', nombres: 'Lucía Contreras Ramos', cargo: 'Contadora' }, [
    { rolId: roles.Contador.id, alcanceTipo: 'empresa', alcanceId: rAndina.empresa.id },
    { rolId: roles.Contador.id, alcanceTipo: 'empresa', alcanceId: rSur.empresa.id },
  ]);
  await asegurarTransferencias(tenantId, admin.id, rSur);
  await asegurarDocumentos(tenantId, admin.id, rAndina);
  await asegurarPlataforma(tenantId);
  const rolesActuales = Object.fromEntries((await prisma.rol.findMany({ where: { tenantId } })).map((r) => [r.nombre, r]));
  await asegurarPuntoVenta(tenantId, rolesActuales, rAndina);
  await asegurarCreditoDemo(rAndina.empresa);
  await asegurarFacturacionDemo(tenantId, rAndina.empresa);
  await asegurarFacturacionDemo(tenantId, rSur.empresa);
  await asegurarUbigeosDemo();
  await asegurarSireDemo(tenantId, rAndina.empresa);
  await asegurarSireDemo(tenantId, rSur.empresa);
  await asegurarCronogramaReferencial();
  // SIRE y Contabilidad se venden aparte de los planes: el estudio demo los tiene como adicionales
  const demo = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { modulosAdicionales: true } });
  const faltan = ['sire', 'contabilidad'].filter((m) => !demo.modulosAdicionales.includes(m));
  if (faltan.length) {
    await prisma.tenant.update({ where: { id: tenantId }, data: { modulosAdicionales: [...demo.modulosAdicionales, ...faltan] } });
    console.log(`✔ Estudio demo: módulos adicionales ${faltan.join(', ')}`);
  }
  // Plan contable PCGE base en Comercial Andina (Distribuidora del Sur queda sin plan, para probar la carga)
  if (!(await prisma.cuentaContable.count({ where: { empresaId: rAndina.empresa.id } }))) {
    const n = await cargarBase(prisma, { tenantId, empresaId: rAndina.empresa.id });
    console.log(`✔ Plan contable PCGE base: ${n} cuentas en ${rAndina.empresa.razonSocial}`);
  }

  // Portal cliente: solo lectura de su empresa (con excepción para exportar reportes)
  if (!(await prisma.usuario.findUnique({ where: { email: 'cliente@kardex.local' } }))) {
    const exportar = await prisma.permiso.findUnique({ where: { codigo: 'reporte.exportar' } });
    await prisma.usuario.create({
      data: {
        tenantId, email: 'cliente@kardex.local', nombres: 'María Pérez (Comercial Andina)', cargo: 'Gerente general',
        tipo: 'cliente', empresaId: rAndina.empresa.id, estado: 'activo', passwordHash: await hash(DEMO_PASSWORD),
        asignaciones: { create: { tenantId, rolId: roles['Cliente (portal)'].id, alcanceTipo: 'empresa', alcanceId: rAndina.empresa.id } },
        excepciones: { create: { tenantId, permisoId: exportar.id, efecto: 'allow', alcanceTipo: 'empresa', alcanceId: rAndina.empresa.id } },
      },
    });
    console.log(`✔ Usuario portal cliente cliente@kardex.local / ${DEMO_PASSWORD}`);
  }

  // Almacenero de un solo almacén: solo ve ese almacén y no ve costos
  await asegurarUsuario(tenantId, { email: 'almacenero@kardex.local', nombres: 'Pedro Huamán Ccori', cargo: 'Almacenero' }, [
    { rolId: roles.Almacenero.id, alcanceTipo: 'almacen', alcanceId: rSur.almacenes.ALM01.id },
  ]);
}

/** Los permisos pudieron cambiar (catálogo nuevo): se descarta la caché de Redis. */
async function limpiarCachePermisos() {
  const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  const claves = await redis.keys('rbac:permisos:*');
  if (claves.length) await redis.del(...claves);
  await redis.quit();
}

main()
  .then(limpiarCachePermisos)
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
