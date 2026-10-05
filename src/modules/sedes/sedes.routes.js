import { Router } from 'express';
import { z } from 'zod';
import { autorizar, alcance } from '../../middleware/autorizar.js';
import { validar } from '../../middleware/validar.js';
import { whereAlcance } from '../../rbac/resolver.js';
import { invalidarPermisos } from '../../rbac/servicio.js';
import { auditar } from '../../services/auditoria.js';
import { emitir } from '../../realtime/socket.js';
import { filtroListado, textoOpcional } from '../../lib/esquemas.js';
import { limpiarAlcances, paginacion, respuestaPaginada } from '../../lib/http.js';
import { conflicto, solicitudInvalida } from '../../lib/errors.js';

const router = Router();
const porSede = alcance.sede();

const esquema = z.object({
  nombre: z.string().trim().min(2).max(120),
  direccion: textoOpcional(255),
  responsableId: z.uuid().nullish().transform((v) => v || null),
});

const incluir = {
  empresa: { select: { id: true, razonSocial: true } },
  responsable: { select: { id: true, nombres: true } },
  _count: { select: { almacenes: true } },
};

async function validarResponsable(tx, responsableId) {
  if (!responsableId) return;
  const u = await tx.usuario.findUnique({ where: { id: responsableId }, select: { tipo: true, estado: true } });
  if (!u || u.tipo !== 'interno' || u.estado === 'suspendido') throw solicitudInvalida('Responsable no válido');
}

router.get('/', autorizar('sedes.sede.ver'), validar(filtroListado, 'query'), async (req, res) => {
  const alcanceWhere = whereAlcance(req.permisos, 'sedes.sede.ver', 'sede');
  const pag = paginacion(req.validQuery);
  if (!alcanceWhere) return res.json(respuestaPaginada([], 0, pag));
  const { q, activo, empresaId } = req.validQuery;
  const where = {
    AND: [
      alcanceWhere,
      empresaId ? { empresaId } : {},
      activo ? { activo: activo === 'true' } : {},
      q ? { nombre: { contains: q, mode: 'insensitive' } } : {},
    ],
  };
  const [datos, total] = await req.db((tx) =>
    Promise.all([
      tx.sede.findMany({ where, include: incluir, orderBy: { nombre: 'asc' }, skip: pag.skip, take: pag.take }),
      tx.sede.count({ where }),
    ]),
  );
  res.json(respuestaPaginada(datos, total, pag));
});

router.get('/:sedeId', autorizar('sedes.sede.ver', { alcance: porSede }), async (req, res) => {
  res.json(await req.db((tx) => tx.sede.findUnique({ where: { id: req.params.sedeId }, include: incluir })));
});

router.post(
  '/',
  autorizar('sedes.sede.crear', { alcance: alcance.empresa('empresaId', 'body') }),
  validar(esquema.extend({ empresaId: z.uuid() })),
  async (req, res) => {
    const sede = await req.db(async (tx) => {
      await validarResponsable(tx, req.body.responsableId);
      const creada = await tx.sede.create({ data: { ...req.body, tenantId: req.tenantId }, include: incluir });
      await auditar(tx, req, { modulo: 'sedes', accion: 'sede.crear', recurso: 'sede', recursoId: creada.id, empresaId: creada.empresaId, despues: creada });
      return creada;
    });
    emitir('sede:cambio', { empresaId: sede.empresaId }, { accion: 'crear', id: sede.id });
    res.status(201).json(sede);
  },
);

router.put(
  '/:sedeId',
  autorizar('sedes.sede.editar', { alcance: porSede }),
  validar(esquema.extend({ activo: z.boolean().optional() })),
  async (req, res) => {
    const sede = await req.db(async (tx) => {
      await validarResponsable(tx, req.body.responsableId);
      const antes = await tx.sede.findUnique({ where: { id: req.params.sedeId } });
      const despues = await tx.sede.update({ where: { id: antes.id }, data: req.body, include: incluir });
      await auditar(tx, req, { modulo: 'sedes', accion: 'sede.editar', recurso: 'sede', recursoId: antes.id, empresaId: antes.empresaId, antes, despues });
      return despues;
    });
    emitir('sede:cambio', { empresaId: sede.empresaId }, { accion: 'editar', id: sede.id });
    res.json(sede);
  },
);

router.delete('/:sedeId', autorizar('sedes.sede.eliminar', { alcance: porSede }), async (req, res) => {
  const { sede, afectados } = await req.db(async (tx) => {
    const sede = await tx.sede.findUnique({ where: { id: req.params.sedeId }, include: { _count: { select: { almacenes: true } } } });
    if (sede._count.almacenes) throw conflicto('La sede tiene almacenes; elimínelos o desactive la sede');
    const afectados = await limpiarAlcances(tx, [sede.id]);
    await tx.sede.delete({ where: { id: sede.id } });
    await auditar(tx, req, { modulo: 'sedes', accion: 'sede.eliminar', recurso: 'sede', recursoId: sede.id, empresaId: sede.empresaId, antes: sede });
    return { sede, afectados };
  });
  await invalidarPermisos(afectados);
  emitir('sede:cambio', { empresaId: sede.empresaId }, { accion: 'eliminar', id: sede.id });
  res.status(204).end();
});

export default router;
