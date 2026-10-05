import { Prisma } from '@prisma/client';
import { conflicto, noEncontrado, solicitudInvalida } from '../lib/errors.js';
import { D, costoPromedio, entrada, salidaACosto, salidaPEPS, salidaPromedio } from './valorizacion.js';

export const MOTIVOS = {
  ENTRADA: ['COMPRA', 'DEVOLUCION_CLIENTE', 'AJUSTE_POSITIVO'],
  SALIDA: ['VENTA', 'MERMA', 'AJUSTE_NEGATIVO'],
};
const PREFIJO = { ENTRADA: 'E', SALIDA: 'S', TRANSFERENCIA: 'T' };
const MOTIVOS_TRANSFERENCIA = ['TRANSFERENCIA_SALIDA', 'TRANSFERENCIA_ENTRADA'];

/** Siguiente número correlativo de la empresa, atómico (INSERT … ON CONFLICT … RETURNING). */
export async function siguienteNumero(tx, { tenantId, empresaId, tipo }) {
  const [fila] = await tx.$queryRaw`
    INSERT INTO correlativos (tenant_id, empresa_id, tipo, ultimo)
    VALUES (${tenantId}::uuid, ${empresaId}::uuid, ${tipo}, 1)
    ON CONFLICT (empresa_id, tipo) DO UPDATE SET ultimo = correlativos.ultimo + 1
    RETURNING ultimo`;
  return `${PREFIJO[tipo]}-${String(fila.ultimo).padStart(6, '0')}`;
}

/**
 * Bloquea (SELECT … FOR UPDATE) las filas de stock de los productos, creándolas si no
 * existen. Se bloquean en orden de productoId para evitar interbloqueos.
 */
async function bloquearStocks(tx, almacen, productoIds) {
  const ordenados = [...productoIds].sort();
  await tx.stock.createMany({
    data: ordenados.map((productoId) => ({
      tenantId: almacen.tenantId, empresaId: almacen.empresaId, sedeId: almacen.sedeId, almacenId: almacen.id, productoId,
    })),
    skipDuplicates: true,
  });
  for (const productoId of ordenados) {
    await tx.$queryRaw`SELECT id FROM stocks WHERE almacen_id = ${almacen.id}::uuid AND producto_id = ${productoId}::uuid FOR UPDATE`;
  }
  const filas = await tx.stock.findMany({ where: { almacenId: almacen.id, productoId: { in: ordenados } } });
  return new Map(filas.map((s) => [s.productoId, s]));
}

const capasDisponibles = (tx, almacenId, productoId) =>
  tx.capaCosto.findMany({
    where: { almacenId, productoId, cantidadRestante: { gt: 0 } },
    orderBy: { id: 'asc' },
  });

/**
 * Registra un movimiento completo y actualiza el kardex en UNA transacción.
 *
 * items: [{ productoId, cantidad, costoUnitario?, revertir? }]
 *   - costoUnitario: obligatorio en compras; en otras entradas se usa el costo promedio vigente.
 *   - revertir: solo para anulaciones ({ detalleId, costoUnitario }) — salida a un costo/capa concretos.
 */
export async function registrarMovimiento(tx, datos) {
  const { tenantId, almacenId, tipo, motivo, items, usuarioId, anulaId = null, transferenciaId = null } = datos;
  if (!items?.length) throw solicitudInvalida('El movimiento debe tener al menos un producto');

  const almacen = await tx.almacen.findUnique({
    where: { id: almacenId },
    include: { empresa: { select: { id: true, metodoValorizacion: true, activo: true } } },
  });
  if (!almacen) throw noEncontrado('Almacén no encontrado');
  if (!anulaId && (!almacen.activo || !almacen.empresa.activo)) throw conflicto('El almacén o la empresa están inactivos');
  const metodo = almacen.empresa.metodoValorizacion;

  const ids = items.map((i) => i.productoId);
  if (new Set(ids).size !== ids.length) throw solicitudInvalida('Hay productos repetidos en el movimiento');
  const productos = await tx.producto.findMany({ where: { id: { in: ids }, empresaId: almacen.empresaId } });
  if (productos.length !== ids.length) throw solicitudInvalida('Algún producto no existe o no pertenece a la empresa');
  const productoDe = new Map(productos.map((p) => [p.id, p]));
  if (!anulaId) {
    const inactivo = productos.find((p) => !p.activo);
    if (inactivo) throw conflicto(`El producto ${inactivo.nombre} está inactivo`);
  }

  const stocks = await bloquearStocks(tx, almacen, ids);
  const movimiento = await tx.movimiento.create({
    data: {
      tenantId,
      empresaId: almacen.empresaId,
      sedeId: almacen.sedeId,
      almacenId,
      numero: await siguienteNumero(tx, { tenantId, empresaId: almacen.empresaId, tipo }),
      tipo,
      motivo,
      metodoValorizacion: metodo,
      fechaDocumento: datos.fechaDocumento ?? null,
      documentoTipo: datos.documentoTipo ?? null,
      documentoSerie: datos.documentoSerie ?? null,
      documentoNumero: datos.documentoNumero ?? null,
      observacion: datos.observacion ?? null,
      usuarioId,
      anulaId,
      transferenciaId,
    },
  });

  const alertas = [];
  for (const item of items) {
    const stock = stocks.get(item.productoId);
    const saldo = { cantidad: D(stock.cantidad), valor: D(stock.valorTotal) };
    const cantidad = D(item.cantidad);
    if (cantidad.lte(0)) throw solicitudInvalida('Las cantidades deben ser mayores que cero');

    let r;
    let consumos = [];
    if (tipo === 'ENTRADA') {
      const costo = item.costoUnitario ?? (saldo.cantidad.gt(0) ? costoPromedio(saldo) : D(stock.costoPromedio));
      r = entrada(saldo, cantidad, costo);
    } else if (item.revertir && metodo === 'PEPS') {
      // Anulación de una entrada PEPS: se retira de SU capa, que debe seguir intacta
      const capa = await tx.capaCosto.findUnique({ where: { detalleId: item.revertir.detalleId } });
      if (!capa || D(capa.cantidadRestante).lt(cantidad)) {
        throw conflicto(`La entrada de ${productoDe.get(item.productoId).nombre} ya fue consumida; registre un ajuste negativo`);
      }
      r = salidaACosto(saldo, cantidad, capa.costoUnitario);
      consumos = [{ id: capa.id, restante: D(capa.cantidadRestante).sub(cantidad) }];
    } else if (item.revertir) {
      r = salidaACosto(saldo, cantidad, item.revertir.costoUnitario);
    } else if (metodo === 'PEPS') {
      r = salidaPEPS(saldo, await capasDisponibles(tx, almacenId, item.productoId), cantidad);
      consumos = r.consumos;
    } else {
      r = salidaPromedio(saldo, cantidad);
    }

    const saldoCostoUnitario = r.saldo.cantidad.gt(0) ? costoPromedio(r.saldo) : r.costoUnitario;
    const detalle = await tx.movimientoDetalle.create({
      data: {
        tenantId,
        movimientoId: movimiento.id,
        almacenId,
        productoId: item.productoId,
        cantidad,
        costoUnitario: r.costoUnitario,
        costoTotal: r.costoTotal,
        saldoCantidad: r.saldo.cantidad,
        saldoCostoUnitario,
        saldoValor: r.saldo.valor,
      },
    });

    if (metodo === 'PEPS') {
      if (tipo === 'ENTRADA') {
        await tx.capaCosto.create({
          data: { tenantId, almacenId, productoId: item.productoId, detalleId: detalle.id, cantidadRestante: cantidad, costoUnitario: r.costoUnitario },
        });
      }
      for (const c of consumos) await tx.capaCosto.update({ where: { id: c.id }, data: { cantidadRestante: c.restante } });
    }

    const actualizado = await tx.stock.update({
      where: { id: stock.id },
      data: { cantidad: r.saldo.cantidad, valorTotal: r.saldo.valor, costoPromedio: saldoCostoUnitario },
    });

    if (actualizado.stockMinimo != null && D(actualizado.cantidad).lt(actualizado.stockMinimo)) {
      alertas.push({
        productoId: item.productoId,
        producto: productoDe.get(item.productoId).nombre,
        almacenId,
        almacen: almacen.nombre,
        cantidad: actualizado.cantidad.toString(),
        stockMinimo: actualizado.stockMinimo.toString(),
      });
    }
  }

  return { movimiento, alertas, almacen };
}

/**
 * Anula un movimiento registrando el movimiento INVERSO (el original nunca se modifica).
 * - Entrada → salida al mismo costo (en PEPS, de la misma capa; falla si ya se consumió).
 * - Salida  → entrada al costo con que salió.
 */
export async function anularMovimiento(tx, { tenantId, movimientoId, usuarioId, observacion, desdeDocumento = false }) {
  const original = await tx.movimiento.findUnique({
    where: { id: movimientoId },
    include: { detalles: true, anuladoPor: { select: { numero: true } }, documentoComercial: { select: { tipo: true } } },
  });
  if (!original) throw noEncontrado();
  if (original.motivo === 'ANULACION') throw conflicto('Una anulación no se puede anular; registre un nuevo movimiento');
  if (original.documentoComercial && !desdeDocumento) {
    throw conflicto(`Este movimiento proviene de una ${original.documentoComercial.tipo === 'COMPRA' ? 'compra' : 'venta'}; anúlela desde el documento`);
  }
  if (MOTIVOS_TRANSFERENCIA.includes(original.motivo)) {
    throw conflicto('Los movimientos de una transferencia no se anulan aquí; registre un ajuste o una transferencia de retorno');
  }
  if (original.anuladoPor) throw conflicto(`El movimiento ya fue anulado por ${original.anuladoPor.numero}`);

  const tipo = original.tipo === 'ENTRADA' ? 'SALIDA' : 'ENTRADA';
  const items = original.detalles.map((d) =>
    tipo === 'SALIDA'
      ? { productoId: d.productoId, cantidad: d.cantidad, revertir: { detalleId: d.id, costoUnitario: d.costoUnitario } }
      : { productoId: d.productoId, cantidad: d.cantidad, costoUnitario: d.costoUnitario },
  );
  try {
    return await registrarMovimiento(tx, {
      tenantId,
      almacenId: original.almacenId,
      tipo,
      motivo: 'ANULACION',
      items,
      usuarioId,
      anulaId: original.id,
      observacion: observacion || `Anulación de ${original.numero}`,
      documentoTipo: original.documentoTipo,
      documentoSerie: original.documentoSerie,
      documentoNumero: original.documentoNumero,
    });
  } catch (err) {
    // Dos anulaciones simultáneas: la restricción única de anula_id rechaza la segunda
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw conflicto('El movimiento ya fue anulado');
    }
    throw err;
  }
}

/** Quita los campos de costo cuando el usuario no tiene `kardex.costos.ver`. */
const CAMPOS_COSTO = ['costoUnitario', 'costoTotal', 'saldoCostoUnitario', 'saldoValor', 'costoPromedio', 'valorTotal'];
export function sinCostos(obj) {
  const copia = { ...obj };
  for (const c of CAMPOS_COSTO) delete copia[c];
  return copia;
}
