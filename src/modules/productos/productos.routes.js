import { Router } from 'express';
import { z } from 'zod';
import { autorizarEnEmpresa } from '../../middleware/autorizar.js';
import { validar } from '../../middleware/validar.js';
import { auditar } from '../../services/auditoria.js';
import { emitir } from '../../realtime/socket.js';
import { paginacion, respuestaPaginada } from '../../lib/http.js';
import { textoOpcional } from '../../lib/esquemas.js';
import { conflicto, solicitudInvalida } from '../../lib/errors.js';

const router = Router();
const uuid = /^[0-9a-f-]{36}$/i;

// Productos son de toda la empresa: basta el permiso en cualquier alcance dentro de ella
const empresaDeQuery = (req) => (uuid.test(req.query.empresaId || '') ? req.query.empresaId : null);
const empresaDeBody = (req) => (uuid.test(req.body?.empresaId || '') ? req.body.empresaId : null);
const empresaDelProducto = async (req) => {
  if (!uuid.test(req.params.productoId || '')) return null;
  const p = await req.db((tx) => tx.producto.findUnique({ where: { id: req.params.productoId }, select: { empresaId: true } }));
  return p?.empresaId ?? null;
};

const incluir = {
  categoria: { select: { id: true, nombre: true } },
  unidad: { select: { id: true, codigo: true, nombre: true } },
};

const esquema = z.object({
  sku: z.string().trim().min(1).max(40).toUpperCase(),
  codigoBarras: z.string().trim().max(50).nullish().transform((v) => v || null),
  nombre: z.string().trim().min(2).max(200),
  descripcion: textoOpcional(500),
  categoriaId: z.uuid().nullish().transform((v) => v || null),
  unidadId: z.uuid(),
  precioReferencial: z.coerce.number().min(0).nullish().transform((v) => (v === undefined ? null : v)),
});

async function validarReferencias(tx, empresaId, { categoriaId, unidadId }) {
  if (!(await tx.unidadMedida.findUnique({ where: { id: unidadId } }))) throw solicitudInvalida('Unidad de medida no válida');
  if (categoriaId) {
    const c = await tx.categoria.findUnique({ where: { id: categoriaId } });
    if (!c || c.empresaId !== empresaId) throw solicitudInvalida('Categoría no válida');
  }
}

router.get(
  '/',
  autorizarEnEmpresa('productos.producto.ver', empresaDeQuery),
  validar(
    z.object({
      empresaId: z.uuid(),
      q: z.string().trim().max(100).optional(),
      categoriaId: z.uuid().optional(),
      activo: z.enum(['true', 'false']).optional(),
      pagina: z.string().optional(),
      porPagina: z.string().optional(),
    }),
    'query',
  ),
  async (req, res) => {
    const { q, categoriaId, activo } = req.validQuery;
    const pag = paginacion(req.validQuery, { maxPorPagina: 200 });
    const where = {
      empresaId: req.empresaId,
      ...(categoriaId && { categoriaId }),
      ...(activo && { activo: activo === 'true' }),
      ...(q && {
        OR: [
          { nombre: { contains: q, mode: 'insensitive' } },
          { sku: { contains: q, mode: 'insensitive' } },
          { codigoBarras: q },
        ],
      }),
    };
    const [datos, total] = await req.db((tx) =>
      Promise.all([
        tx.producto.findMany({ where, include: incluir, orderBy: { nombre: 'asc' }, skip: pag.skip, take: pag.take }),
        tx.producto.count({ where }),
      ]),
    );
    res.json(respuestaPaginada(datos, total, pag));
  },
);

/** Búsqueda exacta por código de barras o SKU (lectores de código de barras). */
router.get('/codigo/:codigo', autorizarEnEmpresa('productos.producto.ver', empresaDeQuery), async (req, res) => {
  const codigo = String(req.params.codigo).trim();
  const producto = await req.db((tx) =>
    tx.producto.findFirst({
      where: { empresaId: req.empresaId, activo: true, OR: [{ codigoBarras: codigo }, { sku: codigo.toUpperCase() }] },
      include: incluir,
    }),
  );
  if (!producto) return res.status(404).json({ error: 'Producto no encontrado' });
  res.json(producto);
});

router.get('/:productoId', autorizarEnEmpresa('productos.producto.ver', empresaDelProducto), async (req, res) => {
  res.json(await req.db((tx) => tx.producto.findUnique({ where: { id: req.params.productoId }, include: incluir })));
});

router.post(
  '/',
  autorizarEnEmpresa('productos.producto.crear', empresaDeBody),
  validar(esquema.extend({ empresaId: z.uuid() })),
  async (req, res) => {
    const producto = await req.db(async (tx) => {
      if (!(await tx.empresa.findUnique({ where: { id: req.empresaId } }))) throw solicitudInvalida('Empresa no encontrada');
      await validarReferencias(tx, req.empresaId, req.body);
      const p = await tx.producto.create({ data: { ...req.body, tenantId: req.tenantId }, include: incluir });
      await auditar(tx, req, { modulo: 'productos', accion: 'producto.crear', recurso: 'producto', recursoId: p.id, empresaId: p.empresaId, despues: p });
      return p;
    });
    emitir('producto:cambio', { empresaId: producto.empresaId }, { accion: 'crear', id: producto.id });
    res.status(201).json(producto);
  },
);

router.put(
  '/:productoId',
  autorizarEnEmpresa('productos.producto.editar', empresaDelProducto),
  validar(esquema.extend({ activo: z.boolean().optional() })),
  async (req, res) => {
    const producto = await req.db(async (tx) => {
      const antes = await tx.producto.findUnique({ where: { id: req.params.productoId } });
      await validarReferencias(tx, antes.empresaId, req.body);
      const despues = await tx.producto.update({ where: { id: antes.id }, data: req.body, include: incluir });
      await auditar(tx, req, { modulo: 'productos', accion: 'producto.editar', recurso: 'producto', recursoId: antes.id, empresaId: antes.empresaId, antes, despues });
      return despues;
    });
    emitir('producto:cambio', { empresaId: producto.empresaId }, { accion: 'editar', id: producto.id });
    res.json(producto);
  },
);

router.delete('/:productoId', autorizarEnEmpresa('productos.producto.eliminar', empresaDelProducto), async (req, res) => {
  const producto = await req.db(async (tx) => {
    const p = await tx.producto.findUnique({ where: { id: req.params.productoId }, include: { _count: { select: { detalles: true } } } });
    if (p._count.detalles) throw conflicto('El producto tiene movimientos en el kardex; desactívelo en lugar de eliminarlo');
    await tx.producto.delete({ where: { id: p.id } });
    await auditar(tx, req, { modulo: 'productos', accion: 'producto.eliminar', recurso: 'producto', recursoId: p.id, empresaId: p.empresaId, antes: p });
    return p;
  });
  emitir('producto:cambio', { empresaId: producto.empresaId }, { accion: 'eliminar', id: producto.id });
  res.status(204).end();
});

export default router;
