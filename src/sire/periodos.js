import { hoyLima } from '../pos/reglas.js';

/** Períodos tributarios (AAAAMM), grupos del cronograma y plazos. Sin acceso a BD. */

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Setiembre', 'Octubre', 'Noviembre', 'Diciembre'];
export const REGISTROS = { RVIE: 'Registro de Ventas e Ingresos', RCE: 'Registro de Compras' };
export const GRUPOS_CRONOGRAMA = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'BC'];

export const esPeriodo = (p) => /^\d{4}(0[1-9]|1[0-2])$/.test(p ?? '');
export const etiquetaPeriodo = (p) => `${MESES[Number(p.slice(4)) - 1]} ${p.slice(0, 4)}`;
export const periodoDe = (fechaIso) => fechaIso.slice(0, 7).replace('-', '');
export const periodoActual = (hoy = hoyLima()) => periodoDe(hoy);

export function desplazar(periodo, meses) {
  const total = Number(periodo.slice(0, 4)) * 12 + Number(periodo.slice(4)) - 1 + meses;
  return `${Math.floor(total / 12)}${String((total % 12) + 1).padStart(2, '0')}`;
}

/** Los últimos `n` períodos hasta `hasta` (incluido), del más reciente al más antiguo. */
export const periodosHasta = (hasta, n) => Array.from({ length: n }, (_, i) => desplazar(hasta, -i));

/** Grupo del cronograma: último dígito del RUC, o "BC" si es buen contribuyente / UESP. */
export const grupoCronograma = ({ ruc, buenContribuyente }) => (buenContribuyente ? 'BC' : ruc.at(-1));

/** Días calendario de `hoy` a `fecha` (ambas AAAA-MM-DD); negativo = vencido. */
export const diasHasta = (fecha, hoy = hoyLima()) => Math.round((Date.parse(fecha) - Date.parse(hoy)) / 86400000);

// ───────────── Rangos para consultar un período ─────────────

/** Fecha (Date) a AAAA-MM-DD en hora de Lima */
export const fechaLima = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(d);

/** Rango de un período para columnas con hora (timestamp): el mes en hora de Lima (UTC−5) */
export function rangoLima(periodo) {
  const s = desplazar(periodo, 1);
  return { gte: new Date(`${periodo.slice(0, 4)}-${periodo.slice(4)}-01T05:00:00Z`), lt: new Date(`${s.slice(0, 4)}-${s.slice(4)}-01T05:00:00Z`) };
}

/** Rango de un período para columnas de solo fecha (DATE) */
export function rangoFecha(periodo) {
  const s = desplazar(periodo, 1);
  return { gte: new Date(`${periodo.slice(0, 4)}-${periodo.slice(4)}-01T00:00:00Z`), lt: new Date(`${s.slice(0, 4)}-${s.slice(4)}-01T00:00:00Z`) };
}

/** Último día del período, AAAA-MM-DD */
export function finDePeriodo(periodo) {
  const s = desplazar(periodo, 1);
  return new Date(Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4)) - 1, 0)).toISOString().slice(0, 10);
}

/** Tipo de documento de identidad (catálogo 06) según el número: 11 dígitos RUC, 8 DNI */
export const docTipoPorNumero = (n) => (/^\d{11}$/.test(n ?? '') ? '6' : /^\d{8}$/.test(n ?? '') ? '1' : '0');
