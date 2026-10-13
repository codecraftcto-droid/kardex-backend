import { DETRACCIONES, rucValido } from '../pos/reglas.js';
import { registrarMovimiento } from '../kardex/servicio.js';
import { crearManual, periodoCerrado } from '../contabilidad/manual.js';
import { listarPlan } from '../contabilidad/servicio.js';

/**
 * Tipos de importación (Fase 4C). Cada uno define sus columnas, el permiso que exige, cómo valida
 * cada fila (errores y acción: crear / actualizar) y cómo aplica las filas válidas.
 * validar(tx, ctx, filas) → { filas: [{ numero, datos, valores, accion, errores }], resumen, bloqueo }
 */
const n2 = (v) => Math.round(Number(v) * 100) / 100;
const numero = (v) => {
  const t = String(v ?? '').trim().replace(/\s/g, '');
  if (!t) return null;
  // Acepta 1,234.56 y 1234,56
  const x = Number(/,\d{1,2}$/.test(t) && !t.includes('.') ? t.replace(',', '.') : t.replace(/,/g, ''));
  return Number.isFinite(x) ? x : NaN;
};
const siNo = (v) => ['si', 'sí', 's', 'x', '1', 'true', 'verdadero'].includes(String(v ?? '').trim().toLowerCase());
const fila = (f, valores, errores, accion) => ({ numero: f.numero, datos: f.datos, valores, errores, accion: errores.length ? 'omitir' : accion });

/** Marca como error las filas repetidas (por clave) dentro del mismo archivo */
function repetidas(filas, clave, texto) {
  const vistas = new Map();
  for (const f of filas) {
    const k = clave(f);
    if (!k) continue;
    if (vistas.has(k)) f.errores.push(`${texto} repetido en el archivo (fila ${vistas.get(k)})`);
    else vistas.set(k, f.numero);
  }
}

// ───────────── Clientes ─────────────

const TIPOS_DOC = { DNI: 'DNI', RUC: 'RUC', CE: 'CARNE_EXTRANJERIA', CARNE: 'CARNE_EXTRANJERIA', CARNE_EXTRANJERIA: 'CARNE_EXTRANJERIA', PASAPORTE: 'PASAPORTE' };

const clientes = {
  nombre: 'Clientes',
  permiso: 'clientes.cliente.crear',
  columnas: [
    { clave: 'tipo_documento', titulo: 'Tipo de documento', requerido: true, ayuda: 'DNI, RUC, CE (carné de extranjería) o PASAPORTE', texto: true },
    { clave: 'numero_documento', titulo: 'Número de documento', requerido: true, ayuda: 'DNI de 8 dígitos o RUC de 11 (se verifica el dígito)', texto: true, alias: ['documento', 'nro_documento'] },
    { clave: 'nombre', titulo: 'Nombre o razón social', requerido: true, alias: ['razon_social', 'nombre'] },
    { clave: 'direccion', titulo: 'Dirección' },
    { clave: 'email', titulo: 'Correo', alias: ['email', 'correo_electronico'] },
    { clave: 'telefono', titulo: 'Teléfono', texto: true },
    { clave: 'agente_retencion', titulo: 'Agente de retención', ayuda: 'SI si el cliente es agente de retención del IGV (si no, déjelo vacío)' },
  ],
  ejemplo: [['RUC', '20131312955', 'Cliente Ejemplo SAC', 'Av. Lima 123, Lima', 'compras@cliente.pe', '014445555', 'NO'], ['DNI', '46027897', 'Juan Pérez Ruiz', '', '', '987654321', '']],
  async validar(tx, { empresaId }, filas) {
    const existentes = new Set((await tx.cliente.findMany({ where: { empresaId }, select: { tipoDocumento: true, numeroDocumento: true } })).map((c) => `${c.tipoDocumento}|${c.numeroDocumento}`));
    const r = filas.map((f) => {
      const d = f.datos;
      const errores = [];
      const tipo = TIPOS_DOC[String(d.tipo_documento).trim().toUpperCase().replace(/\s+/g, '_')];
      const num = String(d.numero_documento).trim().toUpperCase();
      if (!tipo) errores.push('Tipo de documento: use DNI, RUC, CE o PASAPORTE');
      else if (tipo === 'DNI' && !/^\d{8}$/.test(num)) errores.push('El DNI tiene 8 dígitos');
      else if (tipo === 'RUC' && !rucValido(num)) errores.push('RUC inválido (revise los 11 dígitos)');
      else if (['CARNE_EXTRANJERIA', 'PASAPORTE'].includes(tipo) && !/^[A-Z0-9]{6,12}$/.test(num)) errores.push('Documento de 6 a 12 letras o números');
      const nombre = String(d.nombre).trim();
      if (nombre.length < 2) errores.push('Falta el nombre');
      const email = String(d.email).trim();
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errores.push('Correo inválido');
      const valores = { tipoDocumento: tipo, numeroDocumento: num, nombre: nombre.slice(0, 200), direccion: String(d.direccion).trim() || null, email: email || null, telefono: String(d.telefono).trim() || null, agenteRetencion: siNo(d.agente_retencion) };
      return fila(f, valores, errores, existentes.has(`${tipo}|${num}`) ? 'actualizar' : 'crear');
    });
    repetidas(r, (f) => f.valores.tipoDocumento && `${f.valores.tipoDocumento}|${f.valores.numeroDocumento}`, 'Documento');
    r.forEach((f) => { if (f.errores.length) f.accion = 'omitir'; });
    return { filas: r };
  },
  async aplicar(tx, { tenantId, empresaId }, filas) {
    let creados = 0;
    let actualizados = 0;
    for (const { valores: v, accion } of filas) {
      const { tipoDocumento, numeroDocumento, ...resto } = v;
      await tx.cliente.upsert({
        where: { empresaId_tipoDocumento_numeroDocumento: { empresaId, tipoDocumento, numeroDocumento } },
        create: { tenantId, empresaId, tipoDocumento, numeroDocumento, ...resto },
        update: resto,
      });
      if (accion === 'crear') creados += 1; else actualizados += 1;
    }
    return { creados, actualizados };
  },
};

// ───────────── Productos ─────────────

const AFECTACION = { GRAVADO: '10', '10': '10', EXONERADO: '20', '20': '20', INAFECTO: '30', '30': '30' };

const productos = {
  nombre: 'Productos',
  permiso: 'productos.producto.crear',
  columnas: [
    { clave: 'sku', titulo: 'Código (SKU)', requerido: true, ayuda: 'Código único del producto en la empresa', texto: true, alias: ['codigo', 'sku'] },
    { clave: 'nombre', titulo: 'Nombre', requerido: true, alias: ['descripcion', 'producto'] },
    { clave: 'unidad', titulo: 'Unidad', ayuda: 'Código SUNAT de la unidad (NIU unidad, KGM kilo, ZZ servicio…). Vacío = NIU', texto: true },
    { clave: 'categoria', titulo: 'Categoría', ayuda: 'Si no existe, se crea' },
    { clave: 'precio', titulo: 'Precio de venta', ayuda: 'Precio con IGV' },
    { clave: 'afectacion', titulo: 'Afectación IGV', ayuda: 'GRAVADO (por defecto), EXONERADO o INAFECTO' },
    { clave: 'codigo_barras', titulo: 'Código de barras', texto: true },
    { clave: 'detraccion', titulo: 'Detracción', ayuda: 'Código del bien o servicio sujeto a detracción (catálogo 54), si aplica', texto: true },
  ],
  ejemplo: [['CEM-425', 'Cemento Portland tipo I 42.5 kg', 'NIU', 'Construcción', '32.50', 'GRAVADO', '7750182001234', ''], ['SRV-MANT', 'Servicio de mantenimiento', 'ZZ', 'Servicios', '118', 'GRAVADO', '', '037']],
  async validar(tx, { tenantId, empresaId }, filas) {
    const [unidades, existentes] = await Promise.all([
      tx.unidadMedida.findMany({ where: { tenantId }, select: { id: true, codigo: true } }),
      tx.producto.findMany({ where: { empresaId }, select: { sku: true, unidadId: true, _count: { select: { detalles: true } } } }),
    ]);
    const unidad = new Map(unidades.map((u) => [u.codigo.toUpperCase(), u.id]));
    const porSku = new Map(existentes.map((p) => [p.sku.toUpperCase(), p]));
    const r = filas.map((f) => {
      const d = f.datos;
      const errores = [];
      const sku = String(d.sku).trim().toUpperCase();
      if (!sku || sku.length > 40) errores.push('Código (SKU) obligatorio, máximo 40 caracteres');
      const nombre = String(d.nombre).trim();
      if (nombre.length < 2) errores.push('Falta el nombre');
      const codUnidad = String(d.unidad || 'NIU').trim().toUpperCase();
      const unidadId = unidad.get(codUnidad);
      if (!unidadId) errores.push(`Unidad "${codUnidad}" no registrada en el estudio`);
      const precio = numero(d.precio);
      if (Number.isNaN(precio) || (precio != null && precio < 0)) errores.push('Precio inválido');
      const afectacion = AFECTACION[String(d.afectacion || 'GRAVADO').trim().toUpperCase()];
      if (!afectacion) errores.push('Afectación: GRAVADO, EXONERADO o INAFECTO');
      const detraccion = String(d.detraccion).trim() || null;
      if (detraccion && !DETRACCIONES[detraccion.padStart(3, '0')]) errores.push(`Código de detracción ${detraccion} no reconocido`);
      const existente = porSku.get(sku);
      // Cambiar la unidad de un producto que ya tiene movimientos rompería su kardex
      if (existente && unidadId && existente.unidadId !== unidadId && existente._count.detalles > 0) errores.push('El producto ya tiene movimientos: no se le puede cambiar la unidad');
      const valores = {
        sku, nombre: nombre.slice(0, 200), unidadId, categoria: String(d.categoria).trim() || null, precioReferencial: precio ?? null,
        afectacionIgv: afectacion, codigoBarras: String(d.codigo_barras).trim() || null, detraccionCodigo: detraccion ? detraccion.padStart(3, '0') : null,
      };
      return fila(f, valores, errores, existente ? 'actualizar' : 'crear');
    });
    repetidas(r, (f) => f.valores.sku, 'Código');
    r.forEach((f) => { if (f.errores.length) f.accion = 'omitir'; });
    return { filas: r };
  },
  async aplicar(tx, { tenantId, empresaId }, filas) {
    // Categorías: las que falten se crean una sola vez
    const nombres = [...new Set(filas.map((f) => f.valores.categoria).filter(Boolean))];
    const categorias = new Map((await tx.categoria.findMany({ where: { empresaId, nombre: { in: nombres } } })).map((c) => [c.nombre, c.id]));
    let categoriasCreadas = 0;
    for (const nombre of nombres.filter((x) => !categorias.has(x))) {
      categorias.set(nombre, (await tx.categoria.create({ data: { tenantId, empresaId, nombre } })).id);
      categoriasCreadas += 1;
    }
    let creados = 0;
    let actualizados = 0;
    for (const { valores: { categoria, sku, ...v }, accion } of filas) {
      const datos = { ...v, categoriaId: categoria ? categorias.get(categoria) : null };
      await tx.producto.upsert({ where: { empresaId_sku: { empresaId, sku } }, create: { tenantId, empresaId, sku, ...datos }, update: datos });
      if (accion === 'crear') creados += 1; else actualizados += 1;
    }
    return { creados, actualizados, categoriasCreadas };
  },
};

// ───────────── Inventario inicial ─────────────

const inventarioInicial = {
  nombre: 'Inventario inicial',
  permiso: 'kardex.entrada.crear',
  columnas: [
    { clave: 'almacen', titulo: 'Almacén', requerido: true, ayuda: 'Código del almacén', texto: true, alias: ['codigo_almacen'] },
    { clave: 'sku', titulo: 'Código (SKU)', requerido: true, ayuda: 'Código del producto (debe existir: impórtelo antes)', texto: true, alias: ['codigo', 'sku'] },
    { clave: 'cantidad', titulo: 'Cantidad', requerido: true },
    { clave: 'costo_unitario', titulo: 'Costo unitario', requerido: true, ayuda: 'Costo sin IGV por unidad', alias: ['costo'] },
  ],
  ejemplo: [['A1', 'CEM-425', '120', '24.50']],
  notas: [
    'El inventario inicial se registra en el kardex como una entrada de "saldo inicial" por almacén.',
    'Solo se permite para productos que aún no tienen movimientos en ese almacén.',
    'No genera asiento contable: el valor del inventario entra con el asiento de apertura (cuenta 20).',
  ],
  async validar(tx, { empresaId }, filas) {
    const [almacenes, prods] = await Promise.all([
      tx.almacen.findMany({ where: { empresaId }, select: { id: true, codigo: true, nombre: true, activo: true } }),
      tx.producto.findMany({ where: { empresaId }, select: { id: true, sku: true, nombre: true, activo: true } }),
    ]);
    const almacen = new Map(almacenes.map((a) => [a.codigo.toUpperCase(), a]));
    const producto = new Map(prods.map((p) => [p.sku.toUpperCase(), p]));
    const conMovimientos = new Set((await tx.movimientoDetalle.findMany({
      where: { almacenId: { in: almacenes.map((a) => a.id) } }, select: { almacenId: true, productoId: true }, distinct: ['almacenId', 'productoId'],
    })).map((m) => `${m.almacenId}|${m.productoId}`));
    const r = filas.map((f) => {
      const d = f.datos;
      const errores = [];
      const a = almacen.get(String(d.almacen).trim().toUpperCase());
      const p = producto.get(String(d.sku).trim().toUpperCase());
      if (!a) errores.push(`Almacén "${d.almacen}" no existe en la empresa`);
      else if (!a.activo) errores.push('El almacén está inactivo');
      if (!p) errores.push(`Producto "${d.sku}" no existe: impórtelo primero`);
      else if (!p.activo) errores.push('El producto está inactivo');
      const cantidad = numero(d.cantidad);
      const costo = numero(d.costo_unitario);
      if (!(cantidad > 0)) errores.push('Cantidad mayor que cero');
      if (!(costo > 0)) errores.push('Costo unitario mayor que cero');
      if (a && p && conMovimientos.has(`${a.id}|${p.id}`)) errores.push('El producto ya tiene movimientos en este almacén: use un ajuste, no un saldo inicial');
      const valores = { almacenId: a?.id, almacen: a ? `${a.codigo} · ${a.nombre}` : null, productoId: p?.id, producto: p?.nombre, cantidad, costoUnitario: costo, valor: cantidad > 0 && costo > 0 ? n2(cantidad * costo) : 0 };
      return fila(f, valores, errores, 'crear');
    });
    repetidas(r, (f) => f.valores.almacenId && f.valores.productoId && `${f.valores.almacenId}|${f.valores.productoId}`, 'Producto en el almacén');
    r.forEach((f) => { if (f.errores.length) f.accion = 'omitir'; });
    const validas = r.filter((f) => !f.errores.length);
    return { filas: r, resumen: { valorTotal: n2(validas.reduce((t, f) => t + f.valores.valor, 0)), almacenes: new Set(validas.map((f) => f.valores.almacenId)).size } };
  },
  async aplicar(tx, { tenantId, usuarioId }, filas) {
    const porAlmacen = new Map();
    for (const f of filas) porAlmacen.set(f.valores.almacenId, [...(porAlmacen.get(f.valores.almacenId) ?? []), f.valores]);
    const movimientos = [];
    for (const [almacenId, items] of porAlmacen) {
      const r = await registrarMovimiento(tx, {
        tenantId, almacenId, tipo: 'ENTRADA', motivo: 'SALDO_INICIAL', usuarioId, observacion: 'Inventario inicial (importado)',
        items: items.map((i) => ({ productoId: i.productoId, cantidad: String(i.cantidad), costoUnitario: String(i.costoUnitario) })),
      });
      movimientos.push(r.movimiento.numero);
    }
    return { productos: filas.length, movimientos, valorTotal: n2(filas.reduce((t, f) => t + f.valores.valor, 0)) };
  },
};

// ───────────── Asiento de apertura ─────────────

const asientoApertura = {
  nombre: 'Asiento de apertura',
  permiso: 'contabilidad.asiento.registrar',
  columnas: [
    { clave: 'cuenta', titulo: 'Cuenta', requerido: true, ayuda: 'Código de una cuenta que recibe movimientos (p. ej. 1041, 20111, 4212, 5011)', texto: true },
    { clave: 'debe', titulo: 'Debe', ayuda: 'Saldo deudor (activos)' },
    { clave: 'haber', titulo: 'Haber', ayuda: 'Saldo acreedor (pasivos y patrimonio)' },
    { clave: 'tercero_documento', titulo: 'RUC/DNI del tercero', ayuda: 'Para cuentas por cobrar y por pagar', texto: true },
    { clave: 'tercero_nombre', titulo: 'Nombre del tercero' },
    { clave: 'detalle', titulo: 'Detalle', alias: ['glosa'] },
  ],
  ejemplo: [['1041', '15000', '', '', '', 'Saldo en bancos'], ['20111', '8500', '', '', '', 'Inventario de mercaderías'], ['4212', '', '3500', '20512345678', 'Proveedor SAC', ''], ['5011', '', '20000', '', '', 'Capital social']],
  notas: [
    'Una fila por cuenta con su saldo inicial: activos al debe; pasivos y patrimonio al haber. El total del debe debe ser igual al del haber.',
    'Se registra como un asiento manual en la fecha elegida (el período debe estar abierto).',
    'El saldo de la cuenta 20 debería coincidir con el valor del inventario inicial cargado en el kardex.',
  ],
  async validar(tx, { empresaId, opciones }, filas) {
    const plan = new Map((await listarPlan(tx, empresaId)).map((c) => [c.codigo, c]));
    const r = filas.map((f) => {
      const d = f.datos;
      const errores = [];
      const cuenta = String(d.cuenta).trim();
      const c = plan.get(cuenta);
      if (!c) errores.push(`La cuenta ${cuenta} no existe en el plan`);
      else if (!c.imputable) errores.push(`La cuenta ${cuenta} tiene subcuentas: use una de ellas`);
      else if (!c.activo) errores.push(`La cuenta ${cuenta} está desactivada`);
      const debe = numero(d.debe) ?? 0;
      const haber = numero(d.haber) ?? 0;
      if (Number.isNaN(debe) || Number.isNaN(haber) || debe < 0 || haber < 0) errores.push('Importes inválidos');
      else if ((debe > 0) === (haber > 0)) errores.push('Indique el saldo al debe o al haber (solo uno)');
      const valores = {
        cuenta, cuentaNombre: c?.nombre ?? null, debe: n2(debe || 0), haber: n2(haber || 0), glosa: String(d.detalle).trim() || null,
        terceroDoc: String(d.tercero_documento).trim() || null, terceroNombre: String(d.tercero_nombre).trim() || null,
      };
      return fila(f, valores, errores, 'crear');
    });
    const debe = n2(r.reduce((t, f) => t + (f.valores.debe || 0), 0));
    const haber = n2(r.reduce((t, f) => t + (f.valores.haber || 0), 0));
    const fecha = opciones?.fecha;
    const inventario = await tx.stock.aggregate({ where: { empresaId }, _sum: { valorTotal: true } });
    const resumen = {
      debe, haber, fecha,
      cuenta20: n2(r.filter((f) => f.valores.cuenta.startsWith('20')).reduce((t, f) => t + f.valores.debe - f.valores.haber, 0)),
      inventarioKardex: n2(inventario._sum.valorTotal ?? 0),
    };
    // El asiento se registra completo o no se registra: cualquier error lo bloquea
    let bloqueo = null;
    if (r.some((f) => f.errores.length)) bloqueo = 'Corrija las filas con errores: el asiento de apertura se registra completo';
    else if (debe !== haber) bloqueo = `No cuadra: debe S/ ${debe.toFixed(2)} y haber S/ ${haber.toFixed(2)}`;
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha ?? '')) bloqueo = 'Indique la fecha del asiento de apertura';
    else if (await periodoCerrado(tx, empresaId, fecha.slice(0, 7).replace('-', ''))) bloqueo = 'El período de esa fecha está cerrado';
    return { filas: r, resumen, bloqueo };
  },
  async aplicar(tx, { tenantId, empresaId, usuarioId, opciones }, filas) {
    const a = await crearManual(tx, {
      tenantId, empresaId, usuarioId,
      datos: { fecha: opciones.fecha, glosa: 'Asiento de apertura (importado)', lineas: filas.map((f) => f.valores) },
    });
    return { asientoId: a.id, periodo: a.periodo, numero: a.numero, total: Number(a.totalDebe) };
  },
};

export const TIPOS = { CLIENTES: clientes, PRODUCTOS: productos, INVENTARIO_INICIAL: inventarioInicial, ASIENTO_APERTURA: asientoApertura };
