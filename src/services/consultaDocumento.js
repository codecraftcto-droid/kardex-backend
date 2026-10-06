import { env } from '../config/env.js';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { HttpError } from '../lib/errors.js';

/**
 * Consulta de DNI (RENIEC) y RUC (SUNAT) a través de un proveedor externo, para autocompletar
 * el registro de clientes. El token vive solo en el backend; el navegador nunca lo ve.
 * Proveedores: "decolecta" (api.decolecta.com) y "apisnetpe" (api.apis.net.pe v2).
 * Las respuestas se guardan en caché (Redis) para no pagar dos veces la misma consulta.
 */
const PROVEEDORES = {
  decolecta: {
    base: 'https://api.decolecta.com/v1',
    dni: (n) => `/reniec/dni?numero=${n}`,
    ruc: (n) => `/sunat/ruc?numero=${n}`,
  },
  apisnetpe: {
    base: 'https://api.apis.net.pe/v2',
    dni: (n) => `/reniec/dni?numero=${n}`,
    ruc: (n) => `/sunat/ruc?numero=${n}`,
  },
};
const TTL_CACHE = 7 * 24 * 3600;
const limpiar = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
const primero = (o, ...claves) => claves.map((k) => limpiar(o?.[k])).find(Boolean) ?? '';

export const consultaDisponible = () => Boolean(env.CONSULTA_DOC_PROVEEDOR && env.CONSULTA_DOC_TOKEN);

/** Normaliza la respuesta de cualquier proveedor (los nombres de campo difieren). */
export function normalizar(tipo, numero, d) {
  if (tipo === 'DNI') {
    const nombres = primero(d, 'first_name', 'nombres');
    const paterno = primero(d, 'first_last_name', 'apellidoPaterno', 'apellido_paterno');
    const materno = primero(d, 'second_last_name', 'apellidoMaterno', 'apellido_materno');
    const completo = primero(d, 'full_name', 'nombreCompleto', 'nombre_completo');
    const nombre = nombres || paterno ? [nombres, paterno, materno].filter(Boolean).join(' ') : completo;
    return { tipoDocumento: 'DNI', numeroDocumento: numero, nombre };
  }
  const ubicacion = [primero(d, 'distrito'), primero(d, 'provincia'), primero(d, 'departamento')].filter(Boolean).join(' - ');
  const direccion = primero(d, 'direccion', 'direccion_completa');
  return {
    tipoDocumento: 'RUC',
    numeroDocumento: numero,
    nombre: primero(d, 'razon_social', 'razonSocial', 'nombre'),
    direccion: direccion && ubicacion && !direccion.includes(ubicacion) ? `${direccion}, ${ubicacion}` : direccion,
    estado: primero(d, 'estado'),
    condicion: primero(d, 'condicion'),
  };
}

export async function consultarDocumento(tipo, numero) {
  if (!consultaDisponible()) throw new HttpError(503, 'La consulta a RENIEC/SUNAT no está configurada');
  const proveedor = PROVEEDORES[env.CONSULTA_DOC_PROVEEDOR];
  const clave = `consulta-doc:${tipo}:${numero}`;
  const enCache = await redis.get(clave).catch(() => null);
  if (enCache) return JSON.parse(enCache);

  const url = `${proveedor.base}${proveedor[tipo === 'DNI' ? 'dni' : 'ruc'](numero)}`;
  let r;
  try {
    r = await fetch(url, {
      headers: { Authorization: `Bearer ${env.CONSULTA_DOC_TOKEN}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    logger.warn({ err: err.message, tipo }, 'Consulta de documento: sin respuesta del proveedor');
    throw new HttpError(502, 'El servicio de consulta no respondió; registre los datos a mano');
  }
  if (r.status === 404 || r.status === 422) throw new HttpError(404, `${tipo} no encontrado`);
  if (!r.ok) {
    logger.warn({ status: r.status, tipo }, 'Consulta de documento: error del proveedor');
    throw new HttpError(502, r.status === 401 || r.status === 403 ? 'El token del servicio de consulta no es válido' : 'El servicio de consulta falló; registre los datos a mano');
  }
  const datos = normalizar(tipo, numero, await r.json());
  if (!datos.nombre) throw new HttpError(404, `${tipo} no encontrado`);
  await redis.set(clave, JSON.stringify(datos), 'EX', TTL_CACHE).catch(() => {});
  return datos;
}
