import { redis } from '../../lib/redis.js';
import { logger } from '../../lib/logger.js';
import { sha256 } from '../../lib/crypto.js';
import { descifrar } from '../../services/mfa.js';
import { LECTORES, textoDeArchivo } from '../formatos.js';

/**
 * API del SIRE de SUNAT. Autenticación OAuth2 con las credenciales API de la empresa
 * (client_id / client_secret) MÁS un usuario SOL con perfil SIRE (grant_type=password).
 * El token dura ~1 hora y se guarda en caché por empresa y usuario.
 * Referencia: "Manual de Servicios Web API SIRE" de SUNAT. Las rutas y campos de respuesta
 * deben verificarse con una cuenta real antes de usar en producción.
 */
const URL_TOKEN = (clientId) => `https://api-seguridad.sunat.gob.pe/v1/clientessol/${clientId}/oauth2/token/`;
const BASE = 'https://api-sire.sunat.gob.pe/v1/contribuyente/migeigv/libros';
/** Código de libro de cada registro en el SIRE */
export const LIBROS = { RVIE: '140000', RCE: '080000' };

const claveToken = (cfg, ruc) => `sire:token:${sha256(`${cfg.clientId}:${ruc}:${cfg.usuarioSol}`)}`;
export const olvidarToken = (cfg, ruc) => redis.del(claveToken(cfg, ruc)).catch(() => {});

async function token(cfg, ruc) {
  if (!cfg.clientId || !cfg.clientSecretCifrado || !cfg.usuarioSol || !cfg.claveSolCifrada) {
    throw new Error('Faltan credenciales del SIRE: client_id, client_secret, usuario y clave SOL');
  }
  const clave = claveToken(cfg, ruc);
  const enCache = await redis.get(clave).catch(() => null);
  if (enCache) return enCache;
  const r = await fetch(URL_TOKEN(cfg.clientId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password', scope: 'https://api-sire.sunat.gob.pe',
      client_id: cfg.clientId, client_secret: descifrar(cfg.clientSecretCifrado),
      username: `${ruc}${cfg.usuarioSol}`, password: descifrar(cfg.claveSolCifrada),
    }),
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    logger.warn({ status: r.status, error: j.error, descripcion: j.error_description }, 'Token SIRE rechazado');
    throw new Error(r.status === 400 || r.status === 401
      ? 'SUNAT rechazó las credenciales del SIRE (revise client_id, client_secret, usuario y clave SOL)'
      : `SUNAT no entregó el token del SIRE (${r.status})`);
  }
  await redis.set(clave, j.access_token, 'EX', Math.max(60, (j.expires_in ?? 3600) - 120)).catch(() => {});
  return j.access_token;
}

/** GET/POST autenticado al SIRE. Si el token venció antes de tiempo, lo renueva una vez. */
export async function pedir(cfg, ruc, ruta, { metodo = 'GET', cuerpo, reintento = true, binario = false } = {}) {
  const r = await fetch(`${BASE}/${ruta}`, {
    method: metodo,
    headers: { Authorization: `Bearer ${await token(cfg, ruc)}`, Accept: 'application/json', ...(cuerpo && { 'Content-Type': 'application/json' }) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  if (r.status === 401 && reintento) {
    await olvidarToken(cfg, ruc);
    return pedir(cfg, ruc, ruta, { metodo, cuerpo, reintento: false, binario });
  }
  if (binario && r.ok) return new Uint8Array(await r.arrayBuffer());
  const j = await r.json().catch(() => null);
  if (!r.ok) {
    logger.warn({ status: r.status, ruta, j }, 'SIRE respondió con error');
    const msg = j?.msg ?? j?.message ?? j?.errors?.[0]?.msg;
    throw new Error(msg ? `SUNAT: ${msg}` : `El SIRE no respondió correctamente (${r.status})`);
  }
  return j;
}

/** "Presentado" / "Generado" en la descripción de SUNAT = registro ya generado */
const esGenerado = (texto) => /present|generad/i.test(texto ?? '');

export default {
  nombre: 'SUNAT (API SIRE)',

  async probar(cfg, { ruc }) {
    await olvidarToken(cfg, ruc);
    await pedir(cfg, ruc, `rvierce/padron/web/omisos/${LIBROS.RVIE}/periodos`);
    return { ok: true, mensaje: 'Conexión correcta con el SIRE de SUNAT' };
  },

  /** Pide la propuesta: SUNAT responde con un ticket que se consulta luego */
  async solicitarPropuesta(cfg, { ruc, registro, periodo }) {
    const ruta = registro === 'RCE'
      ? `rce/propuesta/web/propuesta/${periodo}/exportacioncomprobantepropuesta?codTipoArchivo=0&codOrigenEnvio=1`
      : `rvie/propuesta/web/propuesta/${periodo}/exportapropuesta?codTipoArchivo=0`;
    const j = await pedir(cfg, ruc, ruta);
    if (!j?.numTicket) throw new Error('SUNAT no devolvió el ticket de la propuesta');
    return { ticket: String(j.numTicket) };
  },

  /** Estado del ticket: { listo, error, archivos, codProceso } */
  async consultarTicket(cfg, { ruc, periodo, ticket }) {
    const j = await pedir(cfg, ruc, `rvierce/gestionprocesosmasivos/web/masivo/consultaestadotickets?perIni=${periodo}&perFin=${periodo}&page=1&perPage=20&numTicket=${ticket}`);
    const t = (j?.registros ?? []).find((x) => String(x.numTicket) === String(ticket)) ?? j?.registros?.[0];
    if (!t) return { listo: false };
    const desc = `${t.desEstadoProceso ?? ''}`;
    if (/error|rechaz|observ/i.test(desc)) return { listo: true, error: `SUNAT: ${desc}` };
    const listo = t.codEstadoProceso === '06' || /termin/i.test(desc);
    return {
      listo, codProceso: t.codProceso ?? null, mensaje: desc || null,
      archivos: (t.archivoReporte ?? []).map((a) => ({ nombre: a.nomArchivoReporte, tipo: a.codTipoAchivoReporte ?? a.codTipoArchivoReporte })),
    };
  },

  /** Descarga y lee el archivo de la propuesta ya procesada */
  async descargarPropuesta(cfg, { ruc, registro, periodo, ticket, codProceso, archivos }) {
    const a = archivos?.[0];
    if (!a) throw new Error('SUNAT no informó el archivo de la propuesta');
    const q = new URLSearchParams({ nomArchivoReporte: a.nombre, codTipoArchivoReporte: a.tipo ?? '', codLibro: LIBROS[registro], perTributario: periodo, codProceso: codProceso ?? '', numTicket: ticket });
    const bytes = await pedir(cfg, ruc, `rvierce/gestionprocesosmasivos/web/masivo/archivoreporte?${q}`, { binario: true });
    return LECTORES[registro](textoDeArchivo(bytes));
  },

  /** Acepta la propuesta (genera el registro): también responde con ticket */
  async aceptarPropuesta(cfg, { ruc, registro, periodo, ajustes }) {
    // Incluir o excluir comprobantes del RCE por API exige cargar un archivo con la estructura de
    // SUNAT, que aún no se verificó con una cuenta real: por ahora se hacen en SOL.
    if (registro === 'RCE' && (ajustes?.incluir.length || ajustes?.excluir.length)) {
      throw new Error('Los ajustes del RCE (incluir o excluir comprobantes) aún no se envían por API: regístrelos en SUNAT Operaciones en Línea y vuelva a descargar la propuesta');
    }
    const ruta = registro === 'RCE' ? `rce/propuesta/web/propuesta/${periodo}/aceptapropuesta` : `rvie/propuesta/web/propuesta/${periodo}/aceptapropuesta`;
    const j = await pedir(cfg, ruc, ruta, { metodo: 'POST', cuerpo: {} });
    return j?.numTicket ? { ticket: String(j.numTicket) } : { constancia: j?.numOperacion ? String(j.numOperacion) : null };
  },

  async periodos(cfg, { ruc, registro }) {
    const ejercicios = await pedir(cfg, ruc, `rvierce/padron/web/omisos/${LIBROS[registro]}/periodos`);
    return (Array.isArray(ejercicios) ? ejercicios : []).flatMap((e) =>
      (e.lisPeriodos ?? []).map((p) => ({ periodo: String(p.perTributario), generado: esGenerado(p.desEstado), descripcion: p.desEstado ?? null })),
    );
  },
};
