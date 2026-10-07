import crypto from 'node:crypto';
import { desplazar, periodoActual, periodosHasta } from '../periodos.js';
import { fila } from '../conciliacion.js';

/**
 * SIRE simulado: responde como SUNAT sin conectarse, para probar el flujo completo.
 * Los registros de hace más de un mes figuran como generados; el mes anterior y el actual, pendientes.
 * Un usuario SOL que contenga "ERROR" se rechaza (para probar credenciales inválidas).
 *
 * Propuestas: se arman con lo que el sistema ya informó a SUNAT, más un comprobante que el sistema
 * no conoce, para que siempre haya algo que conciliar en las pruebas:
 *  - RVIE: comprobantes aceptados o dados de baja y ventas registradas, más una factura E001-1
 *    "emitida en el portal de SUNAT".
 *  - RCE: compras con comprobante electrónico (series que empiezan con F, B o E), más una factura
 *    F005-8890 de un proveedor que no se registró en el sistema.
 */
function verificar(cfg) {
  if (/ERROR/i.test(cfg.usuarioSol ?? '')) throw new Error('SUNAT rechazó el usuario o la clave SOL (SIMULADO)');
}

const sinOrigen = ({ comprobanteId, documentoId, estadoSunat, detraccionMonto, detraccionConstancia, ...x }) => x;

function propuestaRvie(sistema, fecha) {
  const informados = sistema.filter((x) => x.documentoId || ['ACEPTADO', 'OBSERVADO', 'ANULADO'].includes(x.estadoSunat)).map(sinOrigen);
  if (!informados.length) return [];
  const externa = fila({
    tipoCp: '01', serie: 'E001', numero: 1, fechaEmision: fecha, docTipo: '6', docNumero: '20131312955', nombre: 'CLIENTE ATENDIDO DESDE SEE-SOL SAC',
    baseGravada: 100, igv: 18, total: 118, moneda: 'PEN',
  });
  return [...informados, externa];
}

function propuestaRce(sistema, fecha) {
  // Los comprobantes físicos (serie numérica) no llegan a SUNAT: solo los electrónicos
  const electronicos = sistema.filter((x) => /^[FBE]/.test(x.serie)).map(sinOrigen);
  if (!sistema.length) return [];
  const externa = fila({
    tipoCp: '01', serie: 'F005', numero: 8890, emisor: '20100047218', fechaEmision: fecha, docTipo: '6', docNumero: '20100047218', nombre: 'PROVEEDOR NO REGISTRADO SAC',
    baseGravada: 200, igv: 36, total: 236, moneda: 'PEN',
  });
  return [...electronicos, externa];
}

export default {
  nombre: 'Simulado (pruebas, sin SUNAT)',

  async probar(cfg) {
    verificar(cfg);
    return { ok: true, mensaje: 'Conexión correcta con el SIRE (SIMULADO)' };
  },

  /** Períodos y su estado en SUNAT: [{ periodo, generado, descripcion }] */
  async periodos(cfg, { registro }) {
    verificar(cfg);
    const limite = desplazar(periodoActual(), -2);
    return periodosHasta(periodoActual(), 24).map((periodo) => {
      const generado = periodo <= limite;
      return { periodo, generado, descripcion: generado ? `${registro} generado` : 'Pendiente de generar' };
    });
  },

  /** Devuelve la propuesta al instante (sin ticket) */
  async solicitarPropuesta(cfg, { registro, periodo, sistema }) {
    verificar(cfg);
    const fecha = `${periodo.slice(0, 4)}-${periodo.slice(4)}-15`;
    return { filas: registro === 'RCE' ? propuestaRce(sistema, fecha) : propuestaRvie(sistema, fecha) };
  },

  /** Acepta la propuesta; en el RCE con los ajustes (comprobantes incluidos y excluidos) */
  async aceptarPropuesta(cfg, { periodo, ajustes }) {
    verificar(cfg);
    return { constancia: `SIM-${periodo}-${crypto.randomInt(100000, 999999)}`, ajustes: (ajustes?.incluir.length ?? 0) + (ajustes?.excluir.length ?? 0) };
  },
};
