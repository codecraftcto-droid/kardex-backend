import { cifrar } from '../services/mfa.js';
import { MODOS_SIRE } from './proveedores/index.js';
import { olvidarToken } from './proveedores/sunat.js';
import { diasHasta, etiquetaPeriodo, grupoCronograma, periodoActual, periodosHasta } from './periodos.js';

/**
 * SIRE (Fase 2A): credenciales por empresa, períodos tributarios con su vencimiento y
 * sincronización del estado de los registros con SUNAT. Las llamadas a SUNAT se hacen FUERA
 * de las transacciones: primero se lee la configuración, luego se consulta, luego se guarda.
 */

/** Configuración visible: los secretos nunca salen del servidor, solo se indica si existen. */
export function configPublica(cfg) {
  if (!cfg) return null;
  const { clientSecretCifrado, claveSolCifrada, ...resto } = cfg;
  return { ...resto, tieneClientSecret: Boolean(clientSecretCifrado), tieneClaveSol: Boolean(claveSolCifrada) };
}

export async function guardarConfig(tx, { tenantId, empresaId, clientSecret, claveSol, ...datos }, ruc) {
  // Los secretos solo se reemplazan si llegan; vacío = conservar el actual
  const secretos = {
    ...(clientSecret && { clientSecretCifrado: cifrar(clientSecret) }),
    ...(claveSol && { claveSolCifrada: cifrar(claveSol) }),
  };
  const antes = await tx.configSire.findUnique({ where: { empresaId } });
  if (antes) await olvidarToken(antes, ruc);
  return tx.configSire.upsert({
    where: { empresaId },
    create: { tenantId, empresaId, ...datos, ...secretos },
    update: { ...datos, ...secretos, ultimoError: null },
  });
}

/** Prueba la conexión con la configuración guardada y deja constancia del resultado. */
export async function probarConexion(db, empresa) {
  const cfg = await db((tx) => tx.configSire.findUnique({ where: { empresaId: empresa.id } }));
  if (!cfg) return { ok: false, mensaje: 'Primero guarde la configuración del SIRE' };
  let r;
  try {
    r = await MODOS_SIRE[cfg.modo].probar(cfg, { ruc: empresa.ruc });
  } catch (e) {
    r = { ok: false, mensaje: e.message };
  }
  await db((tx) => tx.configSire.update({
    where: { id: cfg.id },
    data: r.ok ? { ultimaConexion: new Date(), ultimoError: null } : { ultimoError: r.mensaje.slice(0, 500) },
  }));
  return r;
}

/** Vencimientos del cronograma para la empresa: Map periodo → 'AAAA-MM-DD' */
async function vencimientos(tx, empresa, periodos) {
  const filas = await tx.cronogramaSunat.findMany({ where: { periodo: { in: periodos }, grupo: grupoCronograma(empresa) } });
  return new Map(filas.map((f) => [f.periodo, f.vencimiento.toISOString().slice(0, 10)]));
}

/**
 * Los últimos `n` períodos de la empresa (el mes en curso incluido), con vencimiento y avance.
 * Un período sin fila en la BD está pendiente en ambos registros.
 */
export async function listarPeriodos(tx, empresa, { n = 12, hasta = periodoActual() } = {}) {
  const lista = periodosHasta(hasta, n);
  const [filas, venc] = await Promise.all([
    tx.periodoSire.findMany({ where: { empresaId: empresa.id, periodo: { in: lista } } }),
    vencimientos(tx, empresa, lista),
  ]);
  const porPeriodo = new Map(filas.map((f) => [f.periodo, f]));
  const actual = periodoActual();
  return lista.map((periodo) => {
    const f = porPeriodo.get(periodo);
    const vencimiento = venc.get(periodo) ?? null;
    const completo = f?.estadoRvie === 'GENERADO' && f?.estadoRce === 'GENERADO';
    return {
      periodo,
      etiqueta: etiquetaPeriodo(periodo),
      enCurso: periodo === actual,
      vencimiento,
      diasParaVencer: vencimiento && !completo ? diasHasta(vencimiento) : null,
      estadoRvie: f?.estadoRvie ?? 'PENDIENTE',
      estadoRce: f?.estadoRce ?? 'PENDIENTE',
      sunatRvie: f?.sunatRvie ?? null,
      sunatRce: f?.sunatRce ?? null,
      sincronizadoEn: f?.sincronizadoEn ?? null,
    };
  });
}

/**
 * Trae de SUNAT el estado de ambos registros y lo guarda. Un registro que SUNAT da por
 * generado queda GENERADO; los demás conservan el avance local (nunca se retrocede).
 */
export async function sincronizar(db, { tenantId, empresa, n = 24 }) {
  const cfg = await db((tx) => tx.configSire.findUnique({ where: { empresaId: empresa.id } }));
  if (!cfg?.activo) return { ok: false, mensaje: 'Configure y active el SIRE de la empresa' };
  const modo = MODOS_SIRE[cfg.modo];
  let rvie, rce;
  try {
    [rvie, rce] = await Promise.all([modo.periodos(cfg, { ruc: empresa.ruc, registro: 'RVIE' }), modo.periodos(cfg, { ruc: empresa.ruc, registro: 'RCE' })]);
  } catch (e) {
    await db((tx) => tx.configSire.update({ where: { id: cfg.id }, data: { ultimoError: e.message.slice(0, 500) } }));
    return { ok: false, mensaje: e.message };
  }
  const vigentes = new Set(periodosHasta(periodoActual(), n));
  const porPeriodo = new Map();
  for (const [registro, lista] of [['Rvie', rvie], ['Rce', rce]]) {
    for (const p of lista.filter((x) => vigentes.has(x.periodo))) {
      porPeriodo.set(p.periodo, { ...porPeriodo.get(p.periodo), [registro]: p });
    }
  }
  const ahora = new Date();
  let generados = 0;
  await db(async (tx) => {
    const existentes = new Map((await tx.periodoSire.findMany({ where: { empresaId: empresa.id, periodo: { in: [...porPeriodo.keys()] } } })).map((f) => [f.periodo, f]));
    for (const [periodo, r] of porPeriodo) {
      const f = existentes.get(periodo);
      const datos = { sincronizadoEn: ahora };
      for (const k of ['Rvie', 'Rce']) {
        if (!r[k]) continue;
        datos[`sunat${k}`] = r[k].descripcion?.slice(0, 200) ?? null;
        if (r[k].generado) {
          datos[`estado${k}`] = 'GENERADO';
          if (f?.[`estado${k}`] !== 'GENERADO') generados += 1;
        }
      }
      await tx.periodoSire.upsert({
        where: { empresaId_periodo: { empresaId: empresa.id, periodo } },
        create: { tenantId, empresaId: empresa.id, periodo, ...datos },
        update: datos,
      });
    }
    await tx.configSire.update({ where: { id: cfg.id }, data: { ultimaConexion: ahora, ultimoError: null } });
  });
  return {
    ok: true,
    mensaje: generados ? `Sincronizado con SUNAT: ${generados} registro(s) figuran como generados` : 'Sincronizado con SUNAT: sin cambios',
    periodos: porPeriodo.size,
  };
}
