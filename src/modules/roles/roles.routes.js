import { Router } from 'express';
import { z } from 'zod';
import { autorizar, alcance } from '../../middleware/autorizar.js';
import { validar } from '../../middleware/validar.js';
import { tieneAlguno } from '../../rbac/resolver.js';
import { invalidarPermisos, usuariosConRol, verificarAdministradorRestante } from '../../rbac/servicio.js';
import { auditar } from '../../services/auditoria.js';
import { conflicto, noEncontrado, prohibido, solicitudInvalida } from '../../lib/errors.js';

const router = Router();
const ver = autorizar('usuarios.roles.ver');
const gestionar = autorizar('usuarios.roles.gestionar', { alcance: alcance.estudio() });

const esquemaRol = z.object({
  nombre: z.string().trim().min(2).max(80),
  descripcion: z.string().trim().max(255).nullish(),
  requiereMfa: z.boolean().optional(),
  permisos: z.array(z.string()).max(500),
});

const incluirPermisos = { permisos: { select: { permiso: { select: { codigo: true } } } } };
const formatear = (rol) => ({ ...rol, permisos: rol.permisos.map((p) => p.permiso.codigo) });

/** Anti-escalamiento: no se puede otorgar a un rol un permiso que el propio usuario no tiene. */
function validarSinEscalamiento(req, codigos) {
  const ajenos = codigos.filter((c) => !tieneAlguno(req.permisos, c));
  if (ajenos.length) throw prohibido(`No puede otorgar permisos que usted no tiene: ${ajenos.join(', ')}`);
}

/** Un usuario no puede modificar sus propios permisos (editar un rol que él mismo tiene). */
async function validarNoEsPropio(tx, req, rolId) {
  const propio = await tx.usuarioRol.count({ where: { rolId, usuarioId: req.user.id } });
  if (propio) throw prohibido('No puede modificar un rol que usted mismo tiene asignado');
}

async function idsPermisos(tx, codigos) {
  const unicos = [...new Set(codigos)];
  const filas = await tx.permiso.findMany({ where: { codigo: { in: unicos } }, select: { id: true, codigo: true } });
  if (filas.length !== unicos.length) {
    const validos = new Set(filas.map((f) => f.codigo));
    throw solicitudInvalida(`Permisos inexistentes: ${unicos.filter((c) => !validos.has(c)).join(', ')}`);
  }
  return filas;
}

router.get('/', ver, async (req, res) => {
  const roles = await req.db((tx) =>
    tx.rol.findMany({
      orderBy: [{ esSistema: 'desc' }, { nombre: 'asc' }],
      include: { _count: { select: { permisos: true, asignaciones: true } } },
    }),
  );
  res.json(roles);
});

router.get('/:id', ver, async (req, res) => {
  const rol = await req.db((tx) => tx.rol.findUnique({ where: { id: req.params.id }, include: incluirPermisos }));
  if (!rol) throw noEncontrado();
  res.json(formatear(rol));
});

router.post('/', gestionar, validar(esquemaRol), async (req, res) => {
  const { permisos, ...datos } = req.body;
  validarSinEscalamiento(req, permisos);
  const rol = await req.db(async (tx) => {
    const filas = await idsPermisos(tx, permisos);
    const creado = await tx.rol.create({
      data: {
        ...datos,
        tenantId: req.tenantId,
        permisos: { create: filas.map((p) => ({ permisoId: p.id, tenantId: req.tenantId })) },
      },
      include: incluirPermisos,
    });
    await auditar(tx, req, { modulo: 'usuarios', accion: 'rol.crear', recurso: 'rol', recursoId: creado.id, despues: formatear(creado) });
    return creado;
  });
  res.status(201).json(formatear(rol));
});

router.put('/:id', gestionar, validar(esquemaRol), async (req, res) => {
  const { permisos, ...datos } = req.body;
  const { rol, afectados } = await req.db(async (tx) => {
    const antes = await tx.rol.findUnique({ where: { id: req.params.id }, include: incluirPermisos });
    if (!antes) throw noEncontrado();
    await validarNoEsPropio(tx, req, antes.id);
    // Solo se validan los permisos que se AGREGAN
    const previos = new Set(formatear(antes).permisos);
    validarSinEscalamiento(req, permisos.filter((c) => !previos.has(c)));

    const filas = await idsPermisos(tx, permisos);
    await tx.rolPermiso.deleteMany({ where: { rolId: antes.id } });
    const despues = await tx.rol.update({
      where: { id: antes.id },
      data: {
        ...datos,
        permisos: { create: filas.map((p) => ({ permisoId: p.id, tenantId: req.tenantId })) },
      },
      include: incluirPermisos,
    });
    await verificarAdministradorRestante(tx);
    await auditar(tx, req, {
      modulo: 'usuarios', accion: 'rol.editar', recurso: 'rol', recursoId: antes.id,
      antes: formatear(antes), despues: formatear(despues),
    });
    return { rol: despues, afectados: await usuariosConRol(tx, antes.id) };
  });
  await invalidarPermisos(afectados);
  res.json(formatear(rol));
});

router.post(
  '/:id/clonar',
  gestionar,
  validar(z.object({ nombre: z.string().trim().min(2).max(80) })),
  async (req, res) => {
    const rol = await req.db(async (tx) => {
      const origen = await tx.rol.findUnique({ where: { id: req.params.id }, include: incluirPermisos });
      if (!origen) throw noEncontrado();
      const codigos = formatear(origen).permisos;
      validarSinEscalamiento(req, codigos);
      const filas = await idsPermisos(tx, codigos);
      const copia = await tx.rol.create({
        data: {
          tenantId: req.tenantId,
          nombre: req.body.nombre,
          descripcion: origen.descripcion,
          requiereMfa: origen.requiereMfa,
          permisos: { create: filas.map((p) => ({ permisoId: p.id, tenantId: req.tenantId })) },
        },
        include: incluirPermisos,
      });
      await auditar(tx, req, {
        modulo: 'usuarios', accion: 'rol.clonar', recurso: 'rol', recursoId: copia.id,
        antes: { origenId: origen.id }, despues: formatear(copia),
      });
      return copia;
    });
    res.status(201).json(formatear(rol));
  },
);

router.patch('/:id/estado', gestionar, validar(z.object({ activo: z.boolean() })), async (req, res) => {
  const { rol, afectados } = await req.db(async (tx) => {
    const antes = await tx.rol.findUnique({ where: { id: req.params.id } });
    if (!antes) throw noEncontrado();
    await validarNoEsPropio(tx, req, antes.id);
    const despues = await tx.rol.update({ where: { id: antes.id }, data: { activo: req.body.activo } });
    await verificarAdministradorRestante(tx);
    await auditar(tx, req, {
      modulo: 'usuarios', accion: req.body.activo ? 'rol.activar' : 'rol.desactivar', recurso: 'rol',
      recursoId: antes.id, antes, despues,
    });
    return { rol: despues, afectados: await usuariosConRol(tx, antes.id) };
  });
  await invalidarPermisos(afectados);
  res.json(rol);
});

router.delete('/:id', gestionar, async (req, res) => {
  await req.db(async (tx) => {
    const rol = await tx.rol.findUnique({
      where: { id: req.params.id },
      include: { ...incluirPermisos, _count: { select: { asignaciones: true } } },
    });
    if (!rol) throw noEncontrado();
    if (rol.esSistema) throw conflicto('Los roles del sistema no se pueden eliminar (puede clonarlos o desactivarlos)');
    if (rol._count.asignaciones) throw conflicto('El rol tiene usuarios asignados; quite las asignaciones primero');
    await tx.rol.delete({ where: { id: rol.id } });
    await auditar(tx, req, { modulo: 'usuarios', accion: 'rol.eliminar', recurso: 'rol', recursoId: rol.id, antes: formatear(rol) });
  });
  res.status(204).end();
});

export default router;
