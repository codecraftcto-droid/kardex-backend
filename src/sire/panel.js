import { REGISTROS, diasHasta, etiquetaPeriodo, grupoCronograma, periodoActual, periodosHasta } from './periodos.js';

/**
 * Panel del estudio (Fase 2D): todas las empresas que el usuario ve, con el avance de sus
 * registros SIRE de los últimos `n` períodos y las alertas (vencidos, por vencer, diferencias,
 * conexión con error). Todo en pocas consultas, sin importar cuántas empresas haya.
 */
export const DIAS_POR_VENCER = 5;

export async function panelEstudio(tx, empresas, { n = 6, hasta = periodoActual() } = {}) {
  const periodos = periodosHasta(hasta, n);
  const ids = empresas.map((e) => e.id);
  const grupos = [...new Set(empresas.map(grupoCronograma))];
  const [filas, configs, cronograma] = await Promise.all([
    tx.periodoSire.findMany({ where: { empresaId: { in: ids }, periodo: { in: periodos } } }),
    tx.configSire.findMany({ where: { empresaId: { in: ids } }, select: { empresaId: true, modo: true, activo: true, ultimaConexion: true, ultimoError: true } }),
    tx.cronogramaSunat.findMany({ where: { periodo: { in: periodos }, grupo: { in: grupos } } }),
  ]);
  const fila = new Map(filas.map((f) => [`${f.empresaId}|${f.periodo}`, f]));
  const config = new Map(configs.map((c) => [c.empresaId, c]));
  const venc = new Map(cronograma.map((c) => [`${c.grupo}|${c.periodo}`, c.vencimiento.toISOString().slice(0, 10)]));
  const actual = periodoActual();

  const alertas = [];
  const resumen = { empresas: empresas.length, configuradas: 0, vencidos: 0, porVencer: 0, conDiferencias: 0, generados: 0 };

  const lista = empresas.map((e) => {
    const cfg = config.get(e.id) ?? null;
    if (cfg?.activo) resumen.configuradas += 1;
    if (cfg?.ultimoError) alertas.push({ tipo: 'CONEXION', gravedad: 'media', empresaId: e.id, empresa: e.razonSocial, texto: `Error de conexión con el SIRE: ${cfg.ultimoError}` });
    const grupo = grupoCronograma(e);
    const ps = periodos.map((periodo) => {
      const f = fila.get(`${e.id}|${periodo}`);
      const vencimiento = venc.get(`${grupo}|${periodo}`) ?? null;
      const dias = vencimiento ? diasHasta(vencimiento) : null;
      const p = { periodo, enCurso: periodo === actual, vencimiento, diasParaVencer: dias, RVIE: f?.estadoRvie ?? 'PENDIENTE', RCE: f?.estadoRce ?? 'PENDIENTE' };
      for (const registro of ['RVIE', 'RCE']) {
        const estado = p[registro];
        const base = { empresaId: e.id, empresa: e.razonSocial, registro, periodo, etiqueta: etiquetaPeriodo(periodo), vencimiento, dias };
        if (estado === 'GENERADO') {
          resumen.generados += 1;
          continue;
        }
        if (estado === 'CON_DIFERENCIAS') {
          resumen.conDiferencias += 1;
          alertas.push({ ...base, tipo: 'DIFERENCIAS', gravedad: 'media', texto: `${REGISTROS[registro]} con diferencias por resolver` });
        }
        // El mes en curso todavía no vence; sin cronograma no hay plazo que vigilar
        if (dias == null || p.enCurso) continue;
        if (dias < 0) {
          resumen.vencidos += 1;
          alertas.push({ ...base, tipo: 'VENCIDO', gravedad: 'alta', texto: `${REGISTROS[registro]} vencido hace ${-dias} día(s) sin generar` });
        } else if (dias <= DIAS_POR_VENCER) {
          resumen.porVencer += 1;
          alertas.push({ ...base, tipo: 'POR_VENCER', gravedad: 'alta', texto: `${REGISTROS[registro]} vence ${dias === 0 ? 'hoy' : `en ${dias} día(s)`}` });
        }
      }
      return p;
    });
    return {
      id: e.id, ruc: e.ruc, razonSocial: e.razonSocial, grupoCronograma: grupo,
      config: cfg && { modo: cfg.modo, activo: cfg.activo, ultimaConexion: cfg.ultimaConexion, ultimoError: cfg.ultimoError },
      periodos: ps,
    };
  });

  // Lo más urgente primero: vencidos (el más atrasado arriba), por vencer, diferencias, conexión
  const ORDEN = { VENCIDO: 0, POR_VENCER: 1, DIFERENCIAS: 2, CONEXION: 3 };
  alertas.sort((a, b) => ORDEN[a.tipo] - ORDEN[b.tipo] || (a.dias ?? 0) - (b.dias ?? 0) || a.empresa.localeCompare(b.empresa));
  return { periodos: periodos.map((p) => ({ periodo: p, etiqueta: etiquetaPeriodo(p), enCurso: p === actual })), empresas: lista, alertas, resumen };
}
