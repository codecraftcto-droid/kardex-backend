import { Router } from 'express';
import { autorizar } from '../../middleware/autorizar.js';
import { prismaApp } from '../../lib/prisma.js';

const router = Router();

/** Catálogo global de permisos agrupado por módulo (alimenta la matriz de roles). */
router.get('/', autorizar('usuarios.roles.ver'), async (_req, res) => {
  const permisos = await prismaApp.permiso.findMany({ orderBy: { orden: 'asc' } });
  const modulos = [];
  for (const p of permisos) {
    let m = modulos.find((x) => x.modulo === p.modulo);
    if (!m) modulos.push((m = { modulo: p.modulo, permisos: [] }));
    m.permisos.push({ id: p.id, codigo: p.codigo, descripcion: p.descripcion, sensible: p.sensible, lectura: p.lectura });
  }
  res.json(modulos);
});

export default router;
