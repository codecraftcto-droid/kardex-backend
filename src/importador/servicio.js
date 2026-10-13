import { conflicto, noEncontrado, solicitudInvalida } from '../lib/errors.js';
import { leerArchivo } from './lector.js';
import { TIPOS } from './tipos.js';

/**
 * Importador (Fase 4C): validar → vista previa → aplicar. Al aplicar se vuelve a validar con los
 * datos de ese momento (alguien pudo crear un cliente o mover stock entre la vista previa y la
 * confirmación), y solo se aplican las filas que siguen siendo válidas.
 */
const resumenDe = (filas) => ({
  total: filas.length,
  validas: filas.filter((f) => !f.errores.length).length,
  conError: filas.filter((f) => f.errores.length).length,
  crear: filas.filter((f) => f.accion === 'crear').length,
  actualizar: filas.filter((f) => f.accion === 'actualizar').length,
});

export async function validarImportacion(tx, { tenantId, empresaId, usuarioId, tipo, nombreArchivo, buffer, opciones = {} }) {
  const t = TIPOS[tipo];
  if (!t) throw solicitudInvalida('Tipo de importación desconocido');
  const leidas = await leerArchivo(buffer, nombreArchivo, t.columnas);
  const ctx = { tenantId, empresaId, usuarioId, opciones };
  const v = await t.validar(tx, ctx, leidas.map((f) => ({ ...f, errores: [] })));
  const resumen = { ...resumenDe(v.filas), ...v.resumen };
  const imp = await tx.importacion.create({
    data: {
      tenantId, empresaId, tipo, nombreArchivo: nombreArchivo.slice(0, 200), opciones, usuarioId,
      // Se guardan los datos tal como vinieron: al aplicar se vuelven a validar
      filas: leidas, totalFilas: leidas.length, filasValidas: resumen.validas,
    },
  });
  return { id: imp.id, tipo, nombreArchivo, filas: v.filas, resumen, bloqueo: v.bloqueo ?? (resumen.validas ? null : 'Ninguna fila es válida') };
}

export async function aplicarImportacion(tx, { tenantId, empresaId, usuarioId, id }) {
  const imp = await tx.importacion.findUnique({ where: { id } });
  if (!imp || imp.empresaId !== empresaId) throw noEncontrado('Importación no encontrada');
  if (imp.estado !== 'VALIDADA') throw conflicto(imp.estado === 'APLICADA' ? 'Esta importación ya se aplicó' : 'Esta importación se descartó');
  const t = TIPOS[imp.tipo];
  const ctx = { tenantId, empresaId, usuarioId, opciones: imp.opciones };
  const v = await t.validar(tx, ctx, imp.filas.map((f) => ({ ...f, errores: [] })));
  if (v.bloqueo) throw conflicto(v.bloqueo);
  const validas = v.filas.filter((f) => !f.errores.length);
  if (!validas.length) throw conflicto('Ninguna fila es válida');
  const resultado = { ...(await t.aplicar(tx, ctx, validas)), omitidas: v.filas.length - validas.length };
  await tx.importacion.update({ where: { id }, data: { estado: 'APLICADA', aplicadoEn: new Date(), resultado, filasValidas: validas.length } });
  return { tipo: imp.tipo, resultado };
}

export async function descartarImportacion(tx, { empresaId, id }) {
  const imp = await tx.importacion.findUnique({ where: { id } });
  if (!imp || imp.empresaId !== empresaId) throw noEncontrado('Importación no encontrada');
  if (imp.estado !== 'VALIDADA') throw conflicto('Solo se descarta una importación sin aplicar');
  return tx.importacion.update({ where: { id }, data: { estado: 'DESCARTADA' } });
}
