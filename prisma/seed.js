// Seed de desarrollo (idempotente): catálogo de permisos + estudio demo con dos empresas,
// productos, movimientos de kardex reales y usuarios con distintos alcances.
// Usa la conexión dueña (DATABASE_URL), que no está sujeta a RLS.
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { sincronizarCatalogo, crearEstudio, sembrarUnidades } from '../src/services/estudios.js';
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
    ruc: '20601234567',
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
    ruc: '20609876543',
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
