import { Router } from 'express';
import { z } from 'zod';
import { autorizar, alcance } from '../../middleware/autorizar.js';
import { validar } from '../../middleware/validar.js';
import { whereAlcance } from '../../rbac/resolver.js';
import { invalidarPermisos } from '../../rbac/servicio.js';
import { auditar } from '../../services/auditoria.js';
import { emitir, reevaluarTenant } from '../../realtime/socket.js';
import { filtroListado, textoOpcional } from '../../lib/esquemas.js';
import { limpiarAlcances, paginacion, respuestaPaginada } from '../../lib/http.js';
import { verificarLimite } from '../../services/limites.js';

const router = Router();
const porAlmacen = alcance.almacen();

const esquema = z.object({
  codigo: z.string().trim().min(1).max(20).toUpperCase(),
  nombre: z.string().trim().min(2).max(120),
  descripcion: textoOpcional(255),
});

const incluir = {
  empresa: { select: { id: true, razonSocial: true } },
  sede: { select: { id: true, nombre: true } },
};

router.get('/', autorizar('almacenes.almacen.ver'), validar(filtroListado, 'query'), async (req, res) => {
  const alcanceWhere = whereAlcance(req.permisos, 'almacenes.almacen.ver', 'almacen');
  const pag = paginacion(req.validQuery);
  if (!alcanceWhere) return res.json(respuestaPaginada([], 0, pag));
  const { q, activo, empresaId, sedeId } = req.validQuery;
  const where = {
    AND: [
      alcanceWhere,
      empresaId ? { empresaId } : {},
      sedeId ? { sedeId } : {},
      activo ? { activo: activo === 'true' } : {},
      q ? { OR: [{ nombre: { contains: q, mode: 'insensitive' } }, { codigo: { contains: q, mode: 'insensitive' } }] } : {},
    ],
  };
  const [datos, total] = await req.db((tx) =>
    Promise.all([
      tx.almacen.findMany({ where, include: incluir, orderBy: [{ sede: { nombre: 'asc' } }, { nombre: 'asc' }], skip: pag.skip, take: pag.take }),
      tx.almacen.count({ where }),
    ]),
  );
  res.json(respuestaPaginada(datos, total, pag));
});

router.get('/:almacenId', autorizar('almacenes.almacen.ver', { alcance: porAlmacen }), async (req, res) => {
  res.json(await req.db((tx) => tx.almacen.findUnique({ where: { id: req.params.almacenId }, include: incluir })));
});

router.post(
  '/',
  autorizar('almacenes.almacen.crear', { alcance: alcance.sede('sedeId', 'body') }),
  validar(esquema.extend({ sedeId: z.uuid() })),
  async (req, res) => {
    const almacen = await req.db(async (tx) => {
      await verificarLimite(tx, req.tenantId, 'almacenes');
      const creado = await tx.almacen.create({
        data: { ...req.body, empresaId: req.recurso.empresaId, tenantId: req.tenantId },
        include: incluir,
      });
      await auditar(tx, req, { modulo: 'almacenes', accion: 'almacen.crear', recurso: 'almacen', recursoId: creado.id, empresaId: creado.empresaId, despues: creado });
      return creado;
    });
    await reevaluarTenant(req.tenantId);
    emitir('almacen:cambio', { empresaId: almacen.empresaId }, { accion: 'crear', id: almacen.id });
    res.status(201).json(almacen);
  },
);

router.put(
  '/:almacenId',
  autorizar('almacenes.almacen.editar', { alcance: porAlmacen }),
  validar(esquema.extend({ activo: z.boolean().optional() })),
  async (req, res) => {
    const almacen = await req.db(async (tx) => {
      const antes = await tx.almacen.findUnique({ where: { id: req.params.almacenId } });
      const despues = await tx.almacen.update({ where: { id: antes.id }, data: req.body, include: incluir });
      await auditar(tx, req, { modulo: 'almacenes', accion: 'almacen.editar', recurso: 'almacen', recursoId: antes.id, empresaId: antes.empresaId, antes, despues });
      return despues;
    });
    emitir('almacen:cambio', { almacenId: almacen.id }, { accion: 'editar', id: almacen.id });
    res.json(almacen);
  },
);

// Un almacén con movimientos de kardex no se puede eliminar (la FK lo impide → 409); se desactiva
router.delete('/:almacenId', autorizar('almacenes.almacen.eliminar', { alcance: porAlmacen }), async (req, res) => {
  const { almacen, afectados } = await req.db(async (tx) => {
    const almacen = await tx.almacen.findUnique({ where: { id: req.params.almacenId } });
    const afectados = await limpiarAlcances(tx, [almacen.id]);
    await tx.almacen.delete({ where: { id: almacen.id } });
    await auditar(tx, req, { modulo: 'almacenes', accion: 'almacen.eliminar', recurso: 'almacen', recursoId: almacen.id, empresaId: almacen.empresaId, antes: almacen });
    return { almacen, afectados };
  });
  await invalidarPermisos(afectados);
  emitir('almacen:cambio', { empresaId: almacen.empresaId }, { accion: 'eliminar', id: almacen.id });
  res.status(204).end();
});

export default router;
