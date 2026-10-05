/**
 * Catálogo base de permisos (único lugar donde se definen; se siembra en BD).
 * Convención: modulo.recurso.accion. Al agregar un módulo nuevo, se añaden aquí
 * sus permisos y aparecen automáticamente en la matriz de roles tras el seed.
 */
const ACCIONES_LECTURA = new Set(['ver', 'exportar']);

const definiciones = [
  // Administración del estudio
  ['empresas', 'empresas.empresa.ver', 'Ver empresas cliente'],
  ['empresas', 'empresas.empresa.crear', 'Crear empresas cliente'],
  ['empresas', 'empresas.empresa.editar', 'Editar empresas cliente'],
  ['empresas', 'empresas.empresa.eliminar', 'Eliminar empresas cliente'],
  ['empresas', 'empresas.configuracion.editar', 'Editar configuración de la empresa (valorización)', true],

  ['sedes', 'sedes.sede.ver', 'Ver sedes'],
  ['sedes', 'sedes.sede.crear', 'Crear sedes'],
  ['sedes', 'sedes.sede.editar', 'Editar sedes'],
  ['sedes', 'sedes.sede.eliminar', 'Eliminar sedes'],

  ['almacenes', 'almacenes.almacen.ver', 'Ver almacenes'],
  ['almacenes', 'almacenes.almacen.crear', 'Crear almacenes'],
  ['almacenes', 'almacenes.almacen.editar', 'Editar almacenes'],
  ['almacenes', 'almacenes.almacen.eliminar', 'Eliminar almacenes'],

  // Seguridad
  ['usuarios', 'usuarios.usuario.ver', 'Ver usuarios'],
  ['usuarios', 'usuarios.usuario.crear', 'Invitar usuarios'],
  ['usuarios', 'usuarios.usuario.editar', 'Editar y suspender usuarios'],
  ['usuarios', 'usuarios.roles.ver', 'Ver roles y permisos'],
  ['usuarios', 'usuarios.roles.gestionar', 'Crear/editar roles y asignar roles, alcances y excepciones', true],
  ['usuarios', 'usuarios.sesiones.gestionar', 'Cerrar sesiones de otros usuarios', true],

  ['auditoria', 'auditoria.ver', 'Consultar auditoría', true],
  ['auditoria', 'auditoria.exportar', 'Exportar auditoría', true],

  // Fase 2+: se siembran desde ya para configurar roles por adelantado
  ['productos', 'productos.producto.ver', 'Ver catálogo de productos'],
  ['productos', 'productos.producto.crear', 'Crear productos'],
  ['productos', 'productos.producto.editar', 'Editar productos'],
  ['productos', 'productos.producto.eliminar', 'Eliminar productos'],

  ['kardex', 'kardex.stock.ver', 'Ver stock'],
  ['kardex', 'kardex.entrada.crear', 'Registrar entradas'],
  ['kardex', 'kardex.salida.crear', 'Registrar salidas'],
  ['kardex', 'kardex.movimiento.anular', 'Registrar ajustes inversos', true],
  ['kardex', 'kardex.costos.ver', 'Ver costos y valorización', true],

  ['transferencia', 'transferencia.ver', 'Ver transferencias'],
  ['transferencia', 'transferencia.solicitar', 'Solicitar transferencias'],
  ['transferencia', 'transferencia.aprobar', 'Aprobar o rechazar transferencias'],
  ['transferencia', 'transferencia.despachar', 'Despachar transferencias (salida del almacén de origen)'],
  ['transferencia', 'transferencia.recibir', 'Recibir transferencias'],

  ['compras', 'compras.compra.ver', 'Ver compras'],
  ['compras', 'compras.compra.crear', 'Registrar y editar compras en borrador'],
  ['compras', 'compras.compra.aprobar', 'Confirmar compras (genera la entrada de kardex)'],
  ['compras', 'compras.compra.anular', 'Anular compras confirmadas', true],

  ['ventas', 'ventas.venta.ver', 'Ver ventas'],
  ['ventas', 'ventas.venta.crear', 'Registrar y editar ventas en borrador'],
  ['ventas', 'ventas.venta.aprobar', 'Confirmar ventas (genera la salida de kardex)'],
  ['ventas', 'ventas.venta.anular', 'Anular ventas confirmadas', true],

  ['reporte', 'reporte.stock.ver', 'Reporte de stock'],
  ['reporte', 'reporte.movimientos.ver', 'Reporte de movimientos'],
  ['reporte', 'reporte.valorizacion.ver', 'Reporte de valorización', true],
  ['reporte', 'reporte.exportar', 'Exportar reportes a Excel/PDF'],
];

export const CATALOGO_PERMISOS = definiciones.map(([modulo, codigo, descripcion, sensible = false], orden) => ({
  modulo,
  codigo,
  descripcion,
  sensible,
  lectura: ACCIONES_LECTURA.has(codigo.split('.').at(-1)),
  orden,
}));

const todos = CATALOGO_PERMISOS.map((p) => p.codigo);
const lectura = CATALOGO_PERMISOS.filter((p) => p.lectura).map((p) => p.codigo);
const sinSensibles = (codigos) =>
  codigos.filter((c) => !CATALOGO_PERMISOS.find((p) => p.codigo === c).sensible);

/** Roles plantilla que se siembran (editables) al crear un estudio. */
export const ROLES_PLANTILLA = [
  {
    nombre: 'Administrador',
    descripcion: 'Acceso total al estudio',
    requiereMfa: false,
    permisos: todos,
  },
  {
    nombre: 'Contador',
    descripcion: 'Gestión contable y operativa de las empresas asignadas',
    permisos: todos.filter(
      (c) => !['usuarios.roles.gestionar', 'usuarios.sesiones.gestionar', 'usuarios.usuario.crear', 'usuarios.usuario.editar', 'auditoria.exportar'].includes(c),
    ),
  },
  {
    nombre: 'Asistente',
    descripcion: 'Registro de operaciones sin acceso a costos',
    permisos: [
      ...sinSensibles(lectura).filter((c) => !c.startsWith('usuarios.') && !c.startsWith('auditoria.')),
      'productos.producto.crear',
      'productos.producto.editar',
      'kardex.entrada.crear',
      'kardex.salida.crear',
      'transferencia.solicitar',
      'compras.compra.crear',
      'ventas.venta.crear',
    ],
  },
  {
    nombre: 'Almacenero',
    descripcion: 'Operación diaria de almacén',
    permisos: [
      'almacenes.almacen.ver',
      'productos.producto.ver',
      'kardex.stock.ver',
      'kardex.entrada.crear',
      'kardex.salida.crear',
      'transferencia.ver',
      'transferencia.solicitar',
      'transferencia.despachar',
      'transferencia.recibir',
    ],
  },
  {
    nombre: 'Cliente (portal)',
    descripcion: 'Acceso de solo lectura de la empresa cliente',
    permisos: [
      'empresas.empresa.ver',
      'sedes.sede.ver',
      'almacenes.almacen.ver',
      'productos.producto.ver',
      'kardex.stock.ver',
      'reporte.stock.ver',
      'reporte.movimientos.ver',
      'reporte.exportar',
      'compras.compra.ver',
      'ventas.venta.ver',
    ],
  },
];

/** Permiso que identifica a un "administrador" (para la regla del último administrador). */
export const PERMISO_ADMIN = 'usuarios.roles.gestionar';
