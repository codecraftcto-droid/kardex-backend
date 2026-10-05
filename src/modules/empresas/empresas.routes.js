import { Router } from 'express';
import { z } from 'zod';
import { autorizar, alcance } from '../../middleware/autorizar.js';
import { validar } from '../../middleware/validar.js';
import { puede, whereAlcance } from '../../rbac/resolver.js';
import { invalidarPermisos } from '../../rbac/servicio.js';
import { auditar } from '../../services/auditoria.js';
import { emitir, reevaluarTenant } from '../../realtime/socket.js';
import { filtroListado, textoOpcional } from '../../lib/esquemas.js';
import { limpiarAlcances, paginacion, respuestaPaginada } from '../../lib/http.js';
import { conflicto, prohibido } from '../../lib/errors.js';
import { verificarLimite } from '../../services/limites.js';

const router = Router();
const porEmpresa = alcance.empresa();

const esquema = z.object({
  razonSocial: z.string().trim().min(2).max(200),
  ruc: z.string().trim().regex(/^\d{11}$/, 'El RUC debe tener 11 dígitos'),
  contacto: textoOpcional(150),
  email: z.union([z.email(), z.literal('')]).nullish().transform((v) => v || null),
  telefono: textoOpcional(30),
  direccion: textoOpcional(255),
  metodoValorizacion: z.enum(['PEPS', 'PROMEDIO']).default('PROMEDIO'),
});

router.get('/', autorizar('empresas.empresa.ver'), validar(filtroListado, 'query'), async (req, res) => {
  const alcanceWhere = whereAlcance(req.permisos, 'empresas.empresa.ver', 'empresa');
  const pag = paginacion(req.validQuery);
  if (!alcanceWhere) return res.json(respuestaPaginada([], 0, pag));
  const { q, activo } = req.validQuery;
  const where = {
    AND: [
      alcanceWhere,
      activo ? { activo: activo === 'true' } : {},
      q ? { OR: [{ razonSocial: { contains: q, mode: 'insensitive' } }, { ruc: { contains: q } }] } : {},
    ],
  };
  const [datos, total] = await req.db((tx) =>
    Promise.all([
      tx.empresa.findMany({
        where, orderBy: { razonSocial: 'asc' }, skip: pag.skip, take: pag.take,
        include: { _count: { select: { sedes: true, almacenes: true } } },
      }),
      tx.empresa.count({ where }),
    ]),
  );
  res.json(respuestaPaginada(datos, total, pag));
});

router.get('/:empresaId', autorizar('empresas.empresa.ver', { alcance: porEmpresa }), async (req, res) => {
  const empresa = await req.db((tx) =>
    tx.empresa.findUnique({
      where: { id: req.params.empresaId },
      include: { _count: { select: { sedes: true, almacenes: true } } },
    }),
  );
  res.json(empresa);
});

router.post('/', autorizar('empresas.empresa.crear', { alcance: alcance.estudio() }), validar(esquema), async (req, res) => {
  const empresa = await req.db(async (tx) => {
    await verificarLimite(tx, req.tenantId, 'empresas');
    const creada = await tx.empresa.create({ data: { ...req.body, tenantId: req.tenantId } });
    await auditar(tx, req, { modulo: 'empresas', accion: 'empresa.crear', recurso: 'empresa', recursoId: creada.id, empresaId: creada.id, despues: creada });
    return creada;
  });
  await reevaluarTenant(req.tenantId); // usuarios con alcance estudio se unen a la sala nueva
  emitir('empresa:cambio', { tenantId: req.tenantId }, { accion: 'crear', id: empresa.id });
  res.status(201).json(empresa);
});

router.put(
  '/:empresaId',
  autorizar('empresas.empresa.editar', { alcance: porEmpresa }),
  validar(esquema.extend({ activo: z.boolean().optional() })),
  async (req, res) => {
    const empresa = await req.db(async (tx) => {
      const antes = await tx.empresa.findUnique({ where: { id: req.params.empresaId } });
      // El método de valorización es un permiso sensible separado
      if (antes.metodoValorizacion !== req.body.metodoValorizacion && !puede(req.permisos, 'empresas.configuracion.editar', req.recurso)) {
        throw prohibido('No tiene permiso para cambiar el método de valorización');
      }
      if (antes.metodoValorizacion !== req.body.metodoValorizacion && (await tx.movimiento.count({ where: { empresaId: antes.id } }))) {
        throw conflicto('No se puede cambiar el método de valorización: la empresa ya tiene movimientos de kardex');
      }
      const despues = await tx.empresa.update({ where: { id: antes.id }, data: req.body });
      await auditar(tx, req, { modulo: 'empresas', accion: 'empresa.editar', recurso: 'empresa', recursoId: antes.id, empresaId: antes.id, antes, despues });
      return despues;
    });
    emitir('empresa:cambio', { empresaId: empresa.id }, { accion: 'editar', id: empresa.id });
    res.json(empresa);
  },
);

router.delete('/:empresaId', autorizar('empresas.empresa.eliminar', { alcance: porEmpresa }), async (req, res) => {
  const afectados = await req.db(async (tx) => {
    const empresa = await tx.empresa.findUnique({
      where: { id: req.params.empresaId },
      include: { _count: { select: { sedes: true, usuarios: true } } },
    });
    if (empresa._count.sedes || empresa._count.usuarios) {
      throw conflicto('La empresa tiene sedes o usuarios cliente; desactívela en lugar de eliminarla');
    }
    const usuarios = await limpiarAlcances(tx, [empresa.id]);
    await tx.empresa.delete({ where: { id: empresa.id } });
    await auditar(tx, req, { modulo: 'empresas', accion: 'empresa.eliminar', recurso: 'empresa', recursoId: empresa.id, empresaId: empresa.id, antes: empresa });
    return usuarios;
  });
  await invalidarPermisos(afectados);
  emitir('empresa:cambio', { tenantId: req.tenantId }, { accion: 'eliminar', id: req.params.empresaId });
  res.status(204).end();
});

export default router;
