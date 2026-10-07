/**
 * Reglas del plan de cuentas (sin acceso a BD). En el PCGE el código anida por prefijo:
 * 12 → 121 → 1212. Una cuenta es imputable (recibe movimientos) cuando no tiene hijas.
 */
export const ELEMENTOS = {
  1: 'Activo disponible y exigible', 2: 'Activo realizable', 3: 'Activo inmovilizado', 4: 'Pasivo', 5: 'Patrimonio',
  6: 'Gastos por naturaleza', 7: 'Ingresos', 8: 'Saldos intermediarios de gestión y resultado', 9: 'Contabilidad analítica de explotación',
};

export const esCodigoValido = (c) => /^[1-9]\d{1,9}$/.test(c ?? '');
export const elementoDe = (codigo) => Number(codigo[0]);

/** Acreedoras dentro de elementos deudores (correctoras de activo, utilidad) y al revés */
const EXCEPCIONES_NATURALEZA = { 19: 'ACREEDORA', 29: 'ACREEDORA', 36: 'ACREEDORA', 39: 'ACREEDORA', 592: 'DEUDORA', 709: 'DEUDORA', 74: 'DEUDORA', 891: 'ACREEDORA' };

/** Naturaleza habitual de la cuenta según el PCGE */
export function naturalezaSugerida(codigo) {
  for (let n = codigo.length; n >= 2; n -= 1) {
    const e = EXCEPCIONES_NATURALEZA[codigo.slice(0, n)];
    if (e) return e;
  }
  return [4, 5, 7].includes(elementoDe(codigo)) ? 'ACREEDORA' : 'DEUDORA';
}

/** Cuentas por cobrar y por pagar: se analizan por cliente o proveedor */
export const pideTerceroSugerido = (codigo) => ['12', '13', '14', '16', '17', '42', '43', '44', '46', '47'].includes(codigo.slice(0, 2));

/** Código de la cuenta padre dentro del plan (el prefijo existente más largo), o null */
export function padreDe(codigo, existentes) {
  for (let n = codigo.length - 1; n >= 2; n -= 1) {
    if (existentes.has(codigo.slice(0, n))) return codigo.slice(0, n);
  }
  return null;
}

/**
 * Enriquece el plan: nivel (profundidad en el árbol), padre, si es imputable y el destino
 * efectivo de las cuentas de gasto (heredado de la cuenta padre más cercana que lo tenga).
 */
export function arbol(cuentas) {
  const porCodigo = new Map(cuentas.map((c) => [c.codigo, c]));
  const codigos = new Set(porCodigo.keys());
  const hijas = new Map();
  const padre = new Map();
  for (const c of cuentas) {
    const p = padreDe(c.codigo, codigos);
    padre.set(c.codigo, p);
    if (p) hijas.set(p, (hijas.get(p) ?? 0) + 1);
  }
  const nivel = (codigo) => {
    let n = 1;
    for (let p = padre.get(codigo); p; p = padre.get(p)) n += 1;
    return n;
  };
  const destino = (codigo) => {
    for (let c = codigo; c; c = padre.get(c)) {
      const x = porCodigo.get(c);
      if (x?.destinoDebe || x?.destinoHaber) return { debe: x.destinoDebe, haber: x.destinoHaber, heredado: c !== codigo ? c : null };
    }
    return null;
  };
  return [...cuentas]
    .sort((a, b) => a.codigo.localeCompare(b.codigo))
    .map((c) => ({
      ...c,
      elemento: elementoDe(c.codigo),
      padre: padre.get(c.codigo),
      nivel: nivel(c.codigo),
      imputable: !hijas.has(c.codigo),
      hijas: hijas.get(c.codigo) ?? 0,
      destino: elementoDe(c.codigo) === 6 ? destino(c.codigo) : null,
    }));
}
