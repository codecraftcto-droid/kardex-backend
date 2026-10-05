import { Router } from 'express';
import { z } from 'zod';
import { autorizar, autorizarEnEmpresa, alcance } from '../../middleware/autorizar.js';
import { validar } from '../../middleware/validar.js';
import { auditar } from '../../services/auditoria.js';

const router = Router();
const uuid = /^[0-9a-f-]{36}$/i;

// ── Unidades de medida (catálogo del estudio) ──
router.get('/unidades', async (req, res) => {
  res.json(await req.db((tx) => tx.unidadMedida.findMany({ where: { activo: true }, orderBy: { nombre: 'asc' } })));
});

router.post(
  '/unidades',
  autorizar('empresas.configuracion.editar', { alcance: alcance.estudio() }),
  validar(z.object({ codigo: z.string().trim().min(1).max(10).toUpperCase(), nombre: z.string().trim().min(2).max(60) })),
  async (req, res) => {
    const unidad = await req.db(async (tx) => {
      const u = await tx.unidadMedida.create({ data: { ...req.body, tenantId: req.tenantId } });
      await auditar(tx, req, { modulo: 'configuracion', accion: 'unidad.crear', recurso: 'unidad', recursoId: u.id, despues: u });
      return u;
    });
    res.status(201).json(unidad);
  },
);

// ── Categorías de productos (por empresa) ──
const empresaDeQuery = (req) => (uuid.test(req.query.empresaId || '') ? req.query.empresaId : null);
const empresaDeBody = (req) => (uuid.test(req.body?.empresaId || '') ? req.body.empresaId : null);

router.get('/categorias', autorizarEnEmpresa('productos.producto.ver', empresaDeQuery), async (req, res) => {
  res.json(
    await req.db((tx) =>
      tx.categoria.findMany({
        where: { empresaId: req.empresaId },
        orderBy: { nombre: 'asc' },
        include: { _count: { select: { productos: true } } },
      }),
    ),
  );
});

router.post(
  '/categorias',
  autorizarEnEmpresa('productos.producto.crear', empresaDeBody),
  validar(z.object({ empresaId: z.uuid(), nombre: z.string().trim().min(2).max(80) })),
  async (req, res) => {
    const categoria = await req.db(async (tx) => {
      if (!(await tx.empresa.findUnique({ where: { id: req.body.empresaId } }))) return null;
      const c = await tx.categoria.create({ data: { ...req.body, tenantId: req.tenantId } });
      await auditar(tx, req, { modulo: 'productos', accion: 'categoria.crear', recurso: 'categoria', recursoId: c.id, empresaId: c.empresaId, despues: c });
      return c;
    });
    if (!categoria) return res.status(404).json({ error: 'Recurso no encontrado' });
    res.status(201).json(categoria);
  },
);

export default router;
