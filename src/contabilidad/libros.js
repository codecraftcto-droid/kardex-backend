/**
 * Libro Diario y Libro Mayor (Fase 3C). Importes en soles.
 * Saldo anterior del Mayor: las cuentas de balance (elementos 1 a 5) arrastran todo lo anterior;
 * las de resultados y analíticas (6 a 9) solo lo del mismo año (se cierran cada ejercicio).
 */
const n = (v) => Math.round(Number(v ?? 0) * 100) / 100;

/** Diario del período: asientos en orden de número con sus líneas, paginado por asiento */
export async function libroDiario(tx, { empresaId, periodo, skip = 0, take = 50 }) {
  const where = { empresaId, periodo };
  const [asientos, total, sumas] = await Promise.all([
    tx.asiento.findMany({ where, orderBy: { numero: 'asc' }, skip, take, include: { lineas: { orderBy: { orden: 'asc' } } } }),
    tx.asiento.count({ where }),
    tx.asiento.aggregate({ where, _sum: { totalDebe: true, totalHaber: true } }),
  ]);
  const cuentas = new Map((await tx.cuentaContable.findMany({
    where: { empresaId, codigo: { in: [...new Set(asientos.flatMap((a) => a.lineas.map((l) => l.cuenta)))] } }, select: { codigo: true, nombre: true },
  })).map((c) => [c.codigo, c.nombre]));
  return {
    asientos: asientos.map((a) => ({
      id: a.id, numero: a.numero, fecha: a.fecha.toISOString().slice(0, 10), glosa: a.glosa, origen: a.origen,
      lineas: a.lineas.map((l) => ({ ...l, debe: n(l.debe), haber: n(l.haber), cuentaNombre: cuentas.get(l.cuenta) ?? null })),
    })),
    total,
    totales: { debe: n(sumas._sum.totalDebe), haber: n(sumas._sum.totalHaber) },
  };
}

/** Mayor resumido: por cuenta, saldo anterior, movimientos del período y saldo final */
export async function mayorResumen(tx, { empresaId, periodo }) {
  const inicioAnio = `${periodo.slice(0, 4)}01`;
  const filas = await tx.$queryRaw`
    SELECT l.cuenta,
      SUM(CASE WHEN a.periodo < ${periodo} AND (left(l.cuenta, 1) IN ('1','2','3','4','5') OR a.periodo >= ${inicioAnio}) THEN l.debe - l.haber ELSE 0 END) AS anterior,
      SUM(CASE WHEN a.periodo = ${periodo} THEN l.debe ELSE 0 END) AS debe,
      SUM(CASE WHEN a.periodo = ${periodo} THEN l.haber ELSE 0 END) AS haber,
      COUNT(*) FILTER (WHERE a.periodo = ${periodo}) AS movimientos
    FROM asiento_lineas l JOIN asientos a ON a.id = l.asiento_id
    WHERE a.empresa_id = ${empresaId}::uuid AND a.periodo <= ${periodo}
    GROUP BY l.cuenta
    ORDER BY l.cuenta`;
  const nombres = new Map((await tx.cuentaContable.findMany({ where: { empresaId }, select: { codigo: true, nombre: true, naturaleza: true } })).map((c) => [c.codigo, c]));
  const cuentas = filas
    .map((f) => {
      const anterior = n(f.anterior);
      const debe = n(f.debe);
      const haber = n(f.haber);
      return {
        cuenta: f.cuenta, nombre: nombres.get(f.cuenta)?.nombre ?? null, naturaleza: nombres.get(f.cuenta)?.naturaleza ?? null,
        anterior, debe, haber, saldo: n(anterior + debe - haber), movimientos: Number(f.movimientos),
      };
    })
    // Sin movimientos en el período ni saldo, la cuenta no aparece
    .filter((c) => c.movimientos > 0 || c.anterior !== 0);
  const suma = (k) => n(cuentas.reduce((s, c) => s + c[k], 0));
  return { cuentas, totales: { anterior: suma('anterior'), debe: suma('debe'), haber: suma('haber'), saldo: suma('saldo') } };
}

/** Mayor de una cuenta: saldo anterior y cada movimiento del período con el saldo acumulado */
export async function mayorCuenta(tx, { empresaId, periodo, cuenta }) {
  const inicioAnio = `${periodo.slice(0, 4)}01`;
  const deBalance = ['1', '2', '3', '4', '5'].includes(cuenta[0]);
  const [previo] = await tx.$queryRaw`
    SELECT COALESCE(SUM(l.debe - l.haber), 0) AS saldo
    FROM asiento_lineas l JOIN asientos a ON a.id = l.asiento_id
    WHERE a.empresa_id = ${empresaId}::uuid AND l.cuenta = ${cuenta} AND a.periodo < ${periodo}
      AND (${deBalance}::boolean OR a.periodo >= ${inicioAnio})`;
  const lineas = await tx.asientoLinea.findMany({
    where: { cuenta, asiento: { empresaId, periodo } },
    include: { asiento: { select: { id: true, numero: true, fecha: true, glosa: true, origen: true } } },
    orderBy: [{ asiento: { numero: 'asc' } }, { orden: 'asc' }],
  });
  const c = await tx.cuentaContable.findUnique({ where: { empresaId_codigo: { empresaId, codigo: cuenta } }, select: { codigo: true, nombre: true, naturaleza: true } });
  let saldo = n(previo.saldo);
  const anterior = saldo;
  const movimientos = lineas.map((l) => {
    saldo = n(saldo + Number(l.debe) - Number(l.haber));
    return {
      asientoId: l.asiento.id, numero: l.asiento.numero, fecha: l.asiento.fecha.toISOString().slice(0, 10), glosa: l.glosa || l.asiento.glosa, origen: l.asiento.origen,
      tercero: l.terceroNombre, documento: l.docSerie ? `${l.docSerie}-${l.docNumero}` : null, debe: n(l.debe), haber: n(l.haber), saldo,
    };
  });
  return {
    cuenta: c ?? { codigo: cuenta, nombre: null }, anterior, movimientos,
    totales: { debe: n(movimientos.reduce((s, m) => s + m.debe, 0)), haber: n(movimientos.reduce((s, m) => s + m.haber, 0)), saldo },
  };
}
