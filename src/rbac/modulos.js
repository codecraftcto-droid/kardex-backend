/**
 * Módulos que se venden por separado. Cada permiso pertenece a un módulo (o a la base, que
 * siempre está incluida). Si el estudio no tiene el módulo, sus permisos se descartan al
 * calcular los permisos efectivos: el menú, las rutas y el backend lo respetan solos.
 */
export const MODULOS = {
  inventario: { nombre: 'Inventario y kardex', descripcion: 'Productos, stock, kardex valorizado, transferencias, compras y ventas' },
  pos: { nombre: 'Punto de venta', descripcion: 'Cajas, boletas, facturas, notas de crédito, clientes' },
  cxc: { nombre: 'Crédito y cobranzas', descripcion: 'Ventas al crédito, cuotas, cobranzas y estados de cuenta' },
  facturacion: { nombre: 'Facturación electrónica SUNAT', descripcion: 'Comprobantes y guías de remisión electrónicas, validación de compras' },
  contabilidad: { nombre: 'Contabilidad', descripcion: 'Plan contable (PCGE), asientos, libros Diario y Mayor, estados financieros' },
  sire: { nombre: 'SIRE (registros de ventas y compras)', descripcion: 'Propuestas de SUNAT, conciliación y generación del RVIE y RCE, vencimientos' },
};
export const CODIGOS_MODULO = Object.keys(MODULOS);

/** Módulos de permisos (catálogo) → módulo comercial. Los no listados son la base. */
const POR_GRUPO = {
  productos: 'inventario', kardex: 'inventario', transferencia: 'inventario', compras: 'inventario', ventas: 'inventario',
  pos: 'pos', clientes: 'pos',
  cxc: 'cxc',
  cpe: 'facturacion',
  gre: 'facturacion',
  sire: 'sire',
  contabilidad: 'contabilidad',
};
/** Excepciones por código exacto */
const POR_CODIGO = {
  'reporte.stock.ver': 'inventario', 'reporte.movimientos.ver': 'inventario', 'reporte.valorizacion.ver': 'inventario',
  'reporte.ventas.ver': 'pos', 'reporte.cxc.ver': 'cxc', 'clientes.credito.configurar': 'cxc',
  'pos.venta.credito': 'cxc', 'empresas.configuracion.editar': 'inventario',
};

/** Módulo comercial al que pertenece un permiso (null = base, siempre disponible). */
export function moduloDePermiso(codigo) {
  return POR_CODIGO[codigo] ?? POR_GRUPO[codigo.split('.')[0]] ?? null;
}

/**
 * Módulos efectivos del estudio: los del plan más los adicionales.
 * Sin plan asignado (instalaciones propias, pruebas) → todos.
 */
export function modulosEfectivos(tenant) {
  if (!tenant?.plan) return new Set(CODIGOS_MODULO);
  return new Set([...(tenant.plan.modulos ?? []), ...(tenant.modulosAdicionales ?? [])]);
}

export const permisoHabilitado = (codigo, modulos) => {
  const m = moduloDePermiso(codigo);
  return !m || modulos.has(m);
};
