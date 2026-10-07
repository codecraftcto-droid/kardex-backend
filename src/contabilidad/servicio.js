import { conflicto, noEncontrado, solicitudInvalida } from '../lib/errors.js';
import { CLAVES_OPERACION, CUENTAS_OPERACION, DESTINOS_BASE, PCGE_BASE } from './pcge.js';
import { arbol, elementoDe, esCodigoValido, naturalezaSugerida, padreDe, pideTerceroSugerido } from './reglas.js';

/**
 * Plan contable por empresa (Fase 3A) y cuentas por operación para los asientos automáticos.
 * Reglas: el código anida por prefijo; una cuenta con hijas no recibe movimientos; una cuenta
 * asignada a una operación debe seguir siendo imputable y activa.
 */
export async function listarPlan(tx, empresaId) {
  return arbol(await tx.cuentaContable.findMany({ where: { empresaId } }));
}

/** Configuración sugerida: solo las cuentas sugeridas que existen e imputan en este plan */
function sugeridas(plan) {
  const imputables = new Set(plan.filter((c) => c.imputable && c.activo).map((c) => c.codigo));
  return Object.fromEntries(CUENTAS_OPERACION.filter(([, , , codigo]) => imputables.has(codigo)).map(([clave, , , codigo]) => [clave, codigo]));
}

async function asegurarVacio(tx, empresaId) {
  if (await tx.cuentaContable.count({ where: { empresaId } })) throw conflicto('La empresa ya tiene plan contable');
}

/** Carga el PCGE base y la configuración sugerida */
export async function cargarBase(tx, { tenantId, empresaId }) {
  await asegurarVacio(tx, empresaId);
  await tx.cuentaContable.createMany({
    data: PCGE_BASE.map(([codigo, nombre]) => ({
      tenantId, empresaId, codigo, nombre, naturaleza: naturalezaSugerida(codigo), pideTercero: pideTerceroSugerido(codigo),
      destinoDebe: DESTINOS_BASE[codigo]?.[0] ?? null, destinoHaber: DESTINOS_BASE[codigo]?.[1] ?? null,
    })),
  });
  const plan = await listarPlan(tx, empresaId);
  await tx.configContable.upsert({ where: { empresaId }, create: { tenantId, empresaId, cuentas: sugeridas(plan) }, update: { cuentas: sugeridas(plan) } });
  return plan.length;
}

/** Copia el plan (y su configuración) de otra empresa del estudio */
export async function copiarPlan(tx, { tenantId, empresaId, desdeEmpresaId }) {
  if (empresaId === desdeEmpresaId) throw solicitudInvalida('Elija otra empresa');
  await asegurarVacio(tx, empresaId);
  const origen = await tx.cuentaContable.findMany({ where: { empresaId: desdeEmpresaId } });
  if (!origen.length) throw solicitudInvalida('La empresa de origen no tiene plan contable');
  await tx.cuentaContable.createMany({
    data: origen.map(({ codigo, nombre, naturaleza, pideTercero, destinoDebe, destinoHaber, activo }) => ({ tenantId, empresaId, codigo, nombre, naturaleza, pideTercero, destinoDebe, destinoHaber, activo })),
  });
  const cfg = await tx.configContable.findUnique({ where: { empresaId: desdeEmpresaId } });
  const cuentas = cfg?.cuentas ?? sugeridas(await listarPlan(tx, empresaId));
  await tx.configContable.upsert({ where: { empresaId }, create: { tenantId, empresaId, cuentas }, update: { cuentas } });
  return origen.length;
}

/** Operaciones que usan una cuenta (no se le puede quitar la condición de imputable ni desactivar) */
async function operacionesQueUsan(tx, empresaId, codigo) {
  const cfg = await tx.configContable.findUnique({ where: { empresaId } });
  return Object.entries(cfg?.cuentas ?? {}).filter(([, c]) => c === codigo).map(([clave]) => CUENTAS_OPERACION.find(([k]) => k === clave)?.[2] ?? clave);
}

async function validarDestinos(tx, empresaId, codigo, { destinoDebe, destinoHaber }) {
  if (!destinoDebe && !destinoHaber) return;
  if (elementoDe(codigo) !== 6) throw solicitudInvalida('Solo las cuentas de gasto (elemento 6) tienen cuentas de destino');
  if (!destinoDebe || !destinoHaber) throw solicitudInvalida('Indique ambas cuentas de destino (debe y haber)');
  if (!destinoDebe.startsWith('9')) throw solicitudInvalida('El destino al debe es una cuenta del elemento 9');
  if (!destinoHaber.startsWith('79')) throw solicitudInvalida('El destino al haber es una cuenta 79');
  const n = await tx.cuentaContable.count({ where: { empresaId, codigo: { in: [destinoDebe, destinoHaber] } } });
  if (n < 2) throw solicitudInvalida('Las cuentas de destino deben existir en el plan');
}

export async function crearCuenta(tx, { tenantId, empresaId, datos }) {
  const { codigo } = datos;
  if (!esCodigoValido(codigo)) throw solicitudInvalida('El código tiene de 2 a 10 dígitos y no empieza con 0');
  const existentes = new Set((await tx.cuentaContable.findMany({ where: { empresaId }, select: { codigo: true } })).map((c) => c.codigo));
  if (existentes.has(codigo)) throw conflicto(`La cuenta ${codigo} ya existe`);
  const padre = padreDe(codigo, existentes);
  if (codigo.length > 2 && !padre) throw solicitudInvalida(`Primero cree la cuenta ${codigo.slice(0, 2)}`);
  // La cuenta padre deja de recibir movimientos: no puede estar asignada a una operación
  if (padre) {
    const usos = await operacionesQueUsan(tx, empresaId, padre);
    if (usos.length) throw conflicto(`La cuenta ${padre} está asignada a: ${usos.join(', ')}. Cambie esa configuración antes de crearle subcuentas`);
  }
  await validarDestinos(tx, empresaId, codigo, datos);
  return tx.cuentaContable.create({
    data: {
      tenantId, empresaId, codigo, nombre: datos.nombre,
      naturaleza: datos.naturaleza ?? naturalezaSugerida(codigo), pideTercero: datos.pideTercero ?? pideTerceroSugerido(codigo),
      destinoDebe: datos.destinoDebe ?? null, destinoHaber: datos.destinoHaber ?? null,
    },
  });
}

export async function editarCuenta(tx, { empresaId, id, datos }) {
  const c = await tx.cuentaContable.findUnique({ where: { id } });
  if (!c || c.empresaId !== empresaId) throw noEncontrado('Cuenta no encontrada');
  if (datos.activo === false && c.activo) {
    const usos = await operacionesQueUsan(tx, empresaId, c.codigo);
    if (usos.length) throw conflicto(`La cuenta está asignada a: ${usos.join(', ')}. Cambie esa configuración antes de desactivarla`);
  }
  await validarDestinos(tx, empresaId, c.codigo, datos);
  return tx.cuentaContable.update({
    where: { id },
    data: { nombre: datos.nombre, naturaleza: datos.naturaleza, pideTercero: datos.pideTercero, destinoDebe: datos.destinoDebe ?? null, destinoHaber: datos.destinoHaber ?? null, activo: datos.activo },
  });
}

export async function eliminarCuenta(tx, { empresaId, id }) {
  const c = await tx.cuentaContable.findUnique({ where: { id } });
  if (!c || c.empresaId !== empresaId) throw noEncontrado('Cuenta no encontrada');
  if (await tx.cuentaContable.count({ where: { empresaId, codigo: { startsWith: c.codigo, not: c.codigo } } })) throw conflicto('Tiene subcuentas: elimínelas primero');
  const usos = await operacionesQueUsan(tx, empresaId, c.codigo);
  if (usos.length) throw conflicto(`La cuenta está asignada a: ${usos.join(', ')}`);
  if (await tx.cuentaContable.count({ where: { empresaId, OR: [{ destinoDebe: c.codigo }, { destinoHaber: c.codigo }] } })) {
    throw conflicto('Es cuenta de destino de otras cuentas de gasto');
  }
  await tx.cuentaContable.delete({ where: { id } });
  return c;
}

// ───────────── Cuentas por operación ─────────────

export async function obtenerConfig(tx, empresaId) {
  const [cfg, plan] = await Promise.all([tx.configContable.findUnique({ where: { empresaId } }), listarPlan(tx, empresaId)]);
  const cuentas = cfg?.cuentas ?? {};
  const porCodigo = new Map(plan.map((c) => [c.codigo, c]));
  return {
    operaciones: CUENTAS_OPERACION.map(([clave, grupo, nombre, sugerida]) => {
      const codigo = cuentas[clave] ?? null;
      const c = codigo ? porCodigo.get(codigo) : null;
      return {
        clave, grupo, nombre, sugerida, codigo, cuenta: c ? { codigo: c.codigo, nombre: c.nombre } : null,
        // Una cuenta configurada que ya no sirve (se le crearon subcuentas, se desactivó o eliminó)
        problema: codigo && (!c ? 'La cuenta ya no existe' : !c.imputable ? 'Tiene subcuentas: elija una de ellas' : !c.activo ? 'Está desactivada' : null),
      };
    }),
    tienePlan: plan.length > 0,
    sugeridas: sugeridas(plan),
  };
}

export async function guardarConfig(tx, { tenantId, empresaId, cuentas }) {
  const desconocidas = Object.keys(cuentas).filter((k) => !CLAVES_OPERACION.includes(k));
  if (desconocidas.length) throw solicitudInvalida(`Operación desconocida: ${desconocidas.join(', ')}`);
  const plan = new Map((await listarPlan(tx, empresaId)).map((c) => [c.codigo, c]));
  const limpias = {};
  for (const [clave, codigo] of Object.entries(cuentas)) {
    if (!codigo) continue;
    const c = plan.get(codigo);
    const nombre = CUENTAS_OPERACION.find(([k]) => k === clave)[2];
    if (!c) throw solicitudInvalida(`${nombre}: la cuenta ${codigo} no existe en el plan`);
    if (!c.imputable) throw solicitudInvalida(`${nombre}: la cuenta ${codigo} tiene subcuentas; elija una de ellas`);
    if (!c.activo) throw solicitudInvalida(`${nombre}: la cuenta ${codigo} está desactivada`);
    limpias[clave] = codigo;
  }
  return tx.configContable.upsert({ where: { empresaId }, create: { tenantId, empresaId, cuentas: limpias }, update: { cuentas: limpias } });
}
