import { conflicto, solicitudInvalida } from '../lib/errors.js';
import { siguienteValor } from '../kardex/servicio.js';
import { listarPlan } from './servicio.js';
import { exigirAbierto } from './manual.js';

/**
 * Estados financieros (Fase 3D): hoja de trabajo, estado de situación financiera, estado de
 * resultados por naturaleza y por función, y asiento de cierre del ejercicio.
 *
 * Saldos: las cuentas de balance (1 a 5) acumulan toda la historia; las de resultados (6 a 9) solo
 * el año. Los resultados excluyen el asiento de CIERRE (si no, diciembre daría cero).
 *
 * Costo de ventas en línea: la compra va a 60 con destino 20/61 (que se anulan) y la venta carga 69.
 * Por eso, "por naturaleza" el consumo de mercaderías es 60 + 61 + 69.
 */
const n = (v) => Math.round(Number(v ?? 0) * 100) / 100;
const deBalance = (c) => ['1', '2', '3', '4', '5'].includes(c[0]);

/** Saldos (debe, haber) por cuenta imputable */
async function saldos(tx, empresaId, { hasta, desde = null, soloResultados = false, sinCierre = false }) {
  const inicioAnio = `${hasta.slice(0, 4)}01`;
  const filas = await tx.$queryRaw`
    SELECT l.cuenta, SUM(l.debe) AS debe, SUM(l.haber) AS haber
    FROM asiento_lineas l JOIN asientos a ON a.id = l.asiento_id
    WHERE a.empresa_id = ${empresaId}::uuid AND a.periodo <= ${hasta}
      AND (${desde}::text IS NULL OR a.periodo >= ${desde}::text)
      AND (left(l.cuenta, 1) IN ('1','2','3','4','5') OR a.periodo >= ${inicioAnio})
      AND (NOT ${soloResultados}::boolean OR left(l.cuenta, 1) NOT IN ('1','2','3','4','5'))
      AND (NOT ${sinCierre}::boolean OR a.origen <> 'CIERRE')
    GROUP BY l.cuenta`;
  return filas.map((f) => ({ cuenta: f.cuenta, debe: n(f.debe), haber: n(f.haber) }));
}

/** Resultados de años anteriores que no se cerraron (siguen en las cuentas 6 a 9) */
async function resultadosAnterioresSinCerrar(tx, empresaId, periodo) {
  const [f] = await tx.$queryRaw`
    SELECT COALESCE(SUM(l.haber - l.debe), 0) AS r
    FROM asiento_lineas l JOIN asientos a ON a.id = l.asiento_id
    WHERE a.empresa_id = ${empresaId}::uuid AND a.periodo < ${`${periodo.slice(0, 4)}01`} AND left(l.cuenta, 1) IN ('6','7','8','9')`;
  return n(f.r);
}

/** Suma (haber − debe) de las cuentas que empiezan con alguno de los prefijos: ingresos +, gastos − */
const neto = (lista, prefijos, excluir = []) =>
  n(lista.filter((s) => prefijos.some((p) => s.cuenta.startsWith(p)) && !excluir.some((p) => s.cuenta.startsWith(p))).reduce((t, s) => t + s.haber - s.debe, 0));

// ───────────── Estado de resultados ─────────────

const POR_FUNCION = [
  { texto: 'Ventas netas', prefijos: ['70', '74'] },
  { texto: 'Costo de ventas', prefijos: ['69'] },
  { subtotal: 'Utilidad bruta' },
  { texto: 'Gastos de administración', prefijos: ['94'] },
  { texto: 'Gastos de ventas', prefijos: ['95'] },
  { texto: 'Otros gastos por función', prefijos: ['90', '91', '93', '96', '98', '99'] },
  { texto: 'Otros ingresos de gestión', prefijos: ['73', '75', '76', '78'] },
  { subtotal: 'Resultado de operación' },
  { texto: 'Ingresos financieros', prefijos: ['77'] },
  { texto: 'Gastos financieros', prefijos: ['97'] },
  { subtotal: 'Resultado antes de impuesto a la renta' },
  { texto: 'Impuesto a la renta', prefijos: ['88'] },
  { total: 'Resultado del ejercicio' },
];
const POR_NATURALEZA = [
  { texto: 'Ventas netas', prefijos: ['70', '74'] },
  { texto: 'Consumo de mercaderías e insumos', prefijos: ['60', '61', '69'] },
  { subtotal: 'Margen comercial' },
  { texto: 'Gastos de personal', prefijos: ['62'] },
  { texto: 'Servicios prestados por terceros', prefijos: ['63'] },
  { texto: 'Tributos', prefijos: ['64'] },
  { texto: 'Otros gastos de gestión', prefijos: ['65', '66'] },
  { texto: 'Valuación y deterioro de activos y provisiones', prefijos: ['68'] },
  { texto: 'Otros ingresos de gestión', prefijos: ['73', '75', '76', '78'] },
  { subtotal: 'Resultado de explotación' },
  { texto: 'Ingresos financieros', prefijos: ['77'] },
  { texto: 'Gastos financieros', prefijos: ['67'] },
  { subtotal: 'Resultado antes de impuesto a la renta' },
  { texto: 'Impuesto a la renta', prefijos: ['88'] },
  { total: 'Resultado del ejercicio' },
];

function armarResultado(formato, lista) {
  let acumulado = 0;
  return formato.map((f) => {
    if (f.prefijos) {
      const importe = neto(lista, f.prefijos);
      acumulado = n(acumulado + importe);
      return { texto: f.texto, cuentas: f.prefijos, importe };
    }
    return { texto: f.subtotal ?? f.total, importe: acumulado, subtotal: Boolean(f.subtotal), total: Boolean(f.total) };
  });
}

export async function estadoResultados(tx, { empresaId, periodo }) {
  const [mes, anio] = await Promise.all([
    saldos(tx, empresaId, { hasta: periodo, desde: periodo, soloResultados: true, sinCierre: true }),
    saldos(tx, empresaId, { hasta: periodo, soloResultados: true, sinCierre: true }),
  ]);
  const estado = (lista) => {
    const funcion = armarResultado(POR_FUNCION, lista);
    const naturaleza = armarResultado(POR_NATURALEZA, lista);
    return { funcion, naturaleza, resultado: naturaleza.at(-1).importe, resultadoFuncion: funcion.at(-1).importe };
  };
  const a = estado(anio);
  // Si las cuentas de gasto no tienen destino al elemento 9, "por función" no las ve
  const gastosNaturaleza = -neto(anio, ['62', '63', '64', '65', '66', '67', '68']);
  const gastosFuncion = -neto(anio, ['9'], ['92']);
  const avisos = [];
  if (Math.abs(a.resultado - a.resultadoFuncion) > 0.009) {
    avisos.push(`El resultado por función (S/ ${a.resultadoFuncion.toFixed(2)}) no coincide con el de naturaleza (S/ ${a.resultado.toFixed(2)}): `
      + `hay S/ ${n(gastosNaturaleza - gastosFuncion).toFixed(2)} de gastos sin destino al elemento 9. Revise las cuentas de destino en el plan contable.`);
  }
  return { mes: estado(mes), acumulado: a, avisos };
}

// ───────────── Estado de situación financiera ─────────────

/** Rubros por prefijo de cuenta (gana el prefijo más largo). Los activos se muestran en positivo si son deudores. */
const RUBROS = [
  { grupo: 'activoCorriente', texto: 'Efectivo y equivalentes de efectivo', prefijos: ['10'] },
  { grupo: 'activoCorriente', texto: 'Cuentas por cobrar comerciales (neto)', prefijos: ['12', '13', '19'] },
  { grupo: 'activoCorriente', texto: 'Otras cuentas por cobrar', prefijos: ['14', '16', '17'] },
  { grupo: 'activoCorriente', texto: 'Inventarios (neto)', prefijos: ['20', '21', '22', '23', '24', '25', '26', '27', '28', '29'] },
  { grupo: 'activoCorriente', texto: 'Servicios y otros contratados por anticipado', prefijos: ['18'] },
  { grupo: 'activoNoCorriente', texto: 'Inversiones mobiliarias e inmobiliarias', prefijos: ['30', '31'] },
  { grupo: 'activoNoCorriente', texto: 'Propiedades, planta y equipo (neto)', prefijos: ['32', '33', '36', '39'] },
  { grupo: 'activoNoCorriente', texto: 'Intangibles (neto)', prefijos: ['34', '392'] },
  { grupo: 'activoNoCorriente', texto: 'Activos biológicos', prefijos: ['35'] },
  { grupo: 'activoNoCorriente', texto: 'Activo diferido y otros activos', prefijos: ['37', '38'] },
  { grupo: 'pasivoCorriente', texto: 'Tributos y aportes por pagar', prefijos: ['40'], tributos: true },
  { grupo: 'pasivoCorriente', texto: 'Remuneraciones y participaciones por pagar', prefijos: ['41'] },
  { grupo: 'pasivoCorriente', texto: 'Cuentas por pagar comerciales', prefijos: ['42', '43'] },
  { grupo: 'pasivoCorriente', texto: 'Obligaciones financieras', prefijos: ['45'] },
  { grupo: 'pasivoCorriente', texto: 'Otras cuentas por pagar', prefijos: ['44', '46', '47'] },
  { grupo: 'pasivoCorriente', texto: 'Provisiones', prefijos: ['48'] },
  { grupo: 'pasivoNoCorriente', texto: 'Pasivo diferido', prefijos: ['49'] },
  { grupo: 'patrimonio', texto: 'Capital', prefijos: ['50'] },
  { grupo: 'patrimonio', texto: 'Acciones de inversión', prefijos: ['51'] },
  { grupo: 'patrimonio', texto: 'Capital adicional', prefijos: ['52'] },
  { grupo: 'patrimonio', texto: 'Resultados no realizados', prefijos: ['56'] },
  { grupo: 'patrimonio', texto: 'Excedente de revaluación', prefijos: ['57'] },
  { grupo: 'patrimonio', texto: 'Reservas', prefijos: ['58'] },
  { grupo: 'patrimonio', texto: 'Resultados acumulados', prefijos: ['59'], acumulados: true },
];
/** Cuentas de balance que no calzan en ningún rubro: van a "otros" de su elemento */
const OTROS = { 1: ['activoCorriente', 'Otros activos corrientes'], 2: ['activoCorriente', 'Otros activos corrientes'], 3: ['activoNoCorriente', 'Otros activos no corrientes'], 4: ['pasivoCorriente', 'Otros pasivos'], 5: ['patrimonio', 'Otras partidas patrimoniales'] };
const ACTIVOS = ['activoCorriente', 'activoNoCorriente'];

function rubroDe(cuenta) {
  let mejor = null;
  for (const r of RUBROS) for (const p of r.prefijos) if (cuenta.startsWith(p) && (!mejor || p.length > mejor.largo)) mejor = { r, largo: p.length };
  return mejor?.r ?? null;
}

export async function situacionFinanciera(tx, { empresaId, periodo }) {
  const [lista, anteriores] = await Promise.all([saldos(tx, empresaId, { hasta: periodo }), resultadosAnterioresSinCerrar(tx, empresaId, periodo)]);
  const grupos = { activoCorriente: new Map(), activoNoCorriente: new Map(), pasivoCorriente: new Map(), pasivoNoCorriente: new Map(), patrimonio: new Map() };
  const sumar = (grupo, texto, importe, cuenta) => {
    const g = grupos[grupo];
    const x = g.get(texto) ?? { texto, importe: 0, cuentas: [] };
    x.importe = n(x.importe + importe);
    x.cuentas.push(cuenta);
    g.set(texto, x);
  };
  let tributos = 0;
  const cuentasTributos = [];
  for (const s of lista.filter((x) => deBalance(x.cuenta))) {
    const r = rubroDe(s.cuenta);
    const [grupo, texto] = r ? [r.grupo, r.texto] : OTROS[s.cuenta[0]];
    if (r?.tributos) {
      tributos = n(tributos + s.debe - s.haber);
      cuentasTributos.push(s.cuenta);
      continue;
    }
    // Activos: deudor positivo. Pasivo y patrimonio: acreedor positivo.
    sumar(grupo, texto, ACTIVOS.includes(grupo) ? s.debe - s.haber : s.haber - s.debe, s.cuenta);
  }
  // La 40 con saldo deudor (IGV a favor, pagos a cuenta) es un activo; acreedora, un pasivo
  if (tributos > 0) sumar('activoCorriente', 'Tributos por recuperar', tributos, '40');
  else if (tributos < 0) sumar('pasivoCorriente', 'Tributos y aportes por pagar', -tributos, '40');

  const resultadoEjercicio = n(-lista.filter((s) => !deBalance(s.cuenta)).reduce((t, s) => t + s.debe - s.haber, 0));
  if (anteriores) sumar('patrimonio', 'Resultados acumulados', anteriores, '6-9 de años anteriores');
  sumar('patrimonio', 'Resultado del ejercicio', resultadoEjercicio, '6-9');

  const orden = (g) => {
    const textos = RUBROS.filter((r) => r.grupo === g).map((r) => r.texto);
    return [...grupos[g].values()].filter((x) => x.importe !== 0 || x.texto === 'Resultado del ejercicio')
      .sort((a, b) => (textos.indexOf(a.texto) + 1 || 99) - (textos.indexOf(b.texto) + 1 || 99));
  };
  const total = (g) => n(orden(g).reduce((t, x) => t + x.importe, 0));
  const e = {
    activoCorriente: orden('activoCorriente'), activoNoCorriente: orden('activoNoCorriente'),
    pasivoCorriente: orden('pasivoCorriente'), pasivoNoCorriente: orden('pasivoNoCorriente'), patrimonio: orden('patrimonio'),
  };
  const totales = {
    activoCorriente: total('activoCorriente'), activoNoCorriente: total('activoNoCorriente'),
    pasivoCorriente: total('pasivoCorriente'), pasivoNoCorriente: total('pasivoNoCorriente'), patrimonio: total('patrimonio'),
  };
  totales.activo = n(totales.activoCorriente + totales.activoNoCorriente);
  totales.pasivo = n(totales.pasivoCorriente + totales.pasivoNoCorriente);
  totales.pasivoPatrimonio = n(totales.pasivo + totales.patrimonio);
  // Saldos contrarios a su naturaleza: casi siempre falta un asiento (p. ej. el inventario inicial)
  const avisos = [];
  const inventarios = e.activoCorriente.find((x) => x.texto === 'Inventarios (neto)');
  if (inventarios && inventarios.importe < 0) {
    avisos.push(`Los inventarios tienen saldo negativo (S/ ${inventarios.importe.toFixed(2)}): las ventas descuentan al costo un stock que no entró a la contabilidad. `
      + 'Registre el inventario inicial con un asiento de apertura (20 a 50/59) y las compras desde el módulo de Compras, no como entradas directas al kardex.');
  }
  const efectivo = e.activoCorriente.find((x) => x.texto === 'Efectivo y equivalentes de efectivo');
  if (efectivo && efectivo.importe < 0) avisos.push(`El efectivo tiene saldo negativo (S/ ${efectivo.importe.toFixed(2)}): revise el saldo inicial de caja y bancos.`);
  return {
    ...e, totales, resultadoEjercicio, resultadosAnterioresSinCerrar: anteriores, avisos,
    cuadra: Math.abs(totales.activo - totales.pasivoPatrimonio) < 0.01,
  };
}

// ───────────── Hoja de trabajo ─────────────

/** Columnas de resultados: naturaleza 60–69, 70–78, 88; función 69, 70–78, 88, 9 (sin 92) */
const enNaturaleza = (c) => c[0] === '6' || (c[0] === '7' && !c.startsWith('79')) || c.startsWith('88');
const enFuncion = (c) => c.startsWith('69') || (c[0] === '7' && !c.startsWith('79')) || c.startsWith('88') || (c[0] === '9' && !c.startsWith('92'));

export async function hojaDeTrabajo(tx, { empresaId, periodo, nivel = 2 }) {
  const [lista, plan, anteriores] = await Promise.all([
    saldos(tx, empresaId, { hasta: periodo, sinCierre: true }), listarPlan(tx, empresaId), resultadosAnterioresSinCerrar(tx, empresaId, periodo),
  ]);
  const nombres = new Map(plan.map((c) => [c.codigo, c.nombre]));
  const agrupadas = new Map();
  for (const s of lista) {
    const codigo = nivel === 2 ? s.cuenta.slice(0, 2) : s.cuenta;
    const x = agrupadas.get(codigo) ?? { cuenta: codigo, nombre: nombres.get(codigo) ?? null, debe: 0, haber: 0 };
    x.debe = n(x.debe + s.debe);
    x.haber = n(x.haber + s.haber);
    agrupadas.set(codigo, x);
  }
  // Los resultados de años anteriores sin cierre siguen en las cuentas 6–9 de esos años (que aquí no
  // entran): se muestran como una partida patrimonial para que las sumas cuadren
  if (anteriores) {
    agrupadas.set('59*', { cuenta: '59*', nombre: 'Resultados de ejercicios anteriores sin cerrar', debe: anteriores < 0 ? -anteriores : 0, haber: anteriores > 0 ? anteriores : 0 });
  }
  const filas = [...agrupadas.values()].sort((a, b) => a.cuenta.localeCompare(b.cuenta)).map((f) => {
    const saldo = n(f.debe - f.haber);
    const deudor = saldo > 0 ? saldo : 0;
    const acreedor = saldo < 0 ? -saldo : 0;
    const balance = deBalance(f.cuenta);
    return {
      ...f, deudor, acreedor,
      activo: balance ? deudor : 0, pasivo: balance ? acreedor : 0,
      perdidaNaturaleza: enNaturaleza(f.cuenta) ? deudor : 0, gananciaNaturaleza: enNaturaleza(f.cuenta) ? acreedor : 0,
      perdidaFuncion: enFuncion(f.cuenta) ? deudor : 0, gananciaFuncion: enFuncion(f.cuenta) ? acreedor : 0,
    };
  });
  const COLS = ['debe', 'haber', 'deudor', 'acreedor', 'activo', 'pasivo', 'perdidaNaturaleza', 'gananciaNaturaleza', 'perdidaFuncion', 'gananciaFuncion'];
  const totales = Object.fromEntries(COLS.map((k) => [k, n(filas.reduce((t, f) => t + f[k], 0))]));
  return {
    filas, totales,
    resultado: {
      inventario: n(totales.activo - totales.pasivo),
      naturaleza: n(totales.gananciaNaturaleza - totales.perdidaNaturaleza),
      funcion: n(totales.gananciaFuncion - totales.perdidaFuncion),
    },
    resultadosAnterioresSinCerrar: anteriores,
  };
}

// ───────────── Cierre del ejercicio ─────────────

/**
 * Asiento de cierre del ejercicio (31/12): salda las cuentas de resultados (6, 7, 9 y 80–88) contra
 * la 891 (utilidad) o la 892 (pérdida). Se puede volver a generar mientras diciembre esté abierto.
 */
export async function cerrarEjercicio(tx, { tenantId, empresaId, anio, usuarioId }) {
  const periodo = `${anio}12`;
  await exigirAbierto(tx, empresaId, periodo);
  const clave = `CIERRE:${anio}`;
  const previo = await tx.asiento.findUnique({ where: { empresaId_clave: { empresaId, clave } } });
  if (previo) await tx.asiento.delete({ where: { id: previo.id } });

  const lista = (await saldos(tx, empresaId, { hasta: periodo, soloResultados: true, sinCierre: true })).filter((s) => !s.cuenta.startsWith('89'));
  const lineas = lista
    .map((s) => ({ cuenta: s.cuenta, saldo: n(s.debe - s.haber) }))
    .filter((s) => s.saldo !== 0)
    .map((s) => (s.saldo > 0 ? { cuenta: s.cuenta, debe: 0, haber: s.saldo } : { cuenta: s.cuenta, debe: -s.saldo, haber: 0 }));
  if (!lineas.length) throw conflicto(`No hay saldos en las cuentas de resultados de ${anio}`);
  const resultado = n(lineas.reduce((t, l) => t + l.debe - l.haber, 0)); // positivo = ganancia
  const plan = new Map((await listarPlan(tx, empresaId)).map((c) => [c.codigo, c]));
  const cuenta = resultado >= 0 ? '891' : '892';
  if (!plan.get(cuenta)?.imputable) throw solicitudInvalida(`La cuenta ${cuenta} (${resultado >= 0 ? 'utilidad' : 'pérdida'}) debe existir en el plan y recibir movimientos`);
  if (resultado !== 0) lineas.push(resultado > 0 ? { cuenta, debe: 0, haber: resultado } : { cuenta, debe: -resultado, haber: 0 });
  const total = n(lineas.reduce((t, l) => t + l.debe, 0));
  const asiento = await tx.asiento.create({
    data: {
      tenantId, empresaId, periodo, numero: await siguienteValor(tx, { tenantId, empresaId, clave: `ASIENTO:${periodo}` }),
      fecha: new Date(`${anio}-12-31T00:00:00Z`), glosa: `Cierre del ejercicio ${anio}: ${resultado >= 0 ? 'utilidad' : 'pérdida'} de S/ ${Math.abs(resultado).toFixed(2)}`,
      origen: 'CIERRE', clave, totalDebe: total, totalHaber: total, usuarioId,
      lineas: { create: lineas.map((l, i) => ({ tenantId, orden: i + 1, ...l })) },
    },
  });
  return { asiento, resultado, regenerado: Boolean(previo) };
}
