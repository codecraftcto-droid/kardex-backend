import { Router } from 'express';
import { z } from 'zod';
import { autorizar } from '../../middleware/autorizar.js';
import { validar } from '../../middleware/validar.js';
import { auditar } from '../../services/auditoria.js';
import { paginacion, respuestaPaginada } from '../../lib/http.js';

const router = Router();

const filtros = z.object({
  usuarioId: z.uuid().optional(),
  empresaId: z.uuid().optional(),
  modulo: z.string().max(50).optional(),
  accion: z.string().max(80).optional(),
  desde: z.coerce.date().optional(),
  hasta: z.coerce.date().optional(),
  pagina: z.string().optional(),
  porPagina: z.string().optional(),
});

/** Con alcance estudio ve todo; con alcance empresa, solo los eventos de sus empresas. */
function whereAuditoria(perms, codigo, q) {
  const grants = perms.grants[codigo] || [];
  const deniesEstudio = (perms.denies[codigo] || []).some((a) => a.tipo === 'estudio');
  if (deniesEstudio) return null;
  const and = [];
  if (!grants.some((a) => a.tipo === 'estudio')) {
    const ids = grants.filter((a) => a.tipo === 'empresa').map((a) => a.id);
    if (!ids.length) return null;
    and.push({ empresaId: { in: ids } });
  }
  if (q.usuarioId) and.push({ usuarioId: q.usuarioId });
  if (q.empresaId) and.push({ empresaId: q.empresaId });
  if (q.modulo) and.push({ modulo: q.modulo });
  if (q.accion) and.push({ accion: { contains: q.accion } });
  if (q.desde || q.hasta) and.push({ fecha: { ...(q.desde && { gte: q.desde }), ...(q.hasta && { lte: q.hasta }) } });
  return { AND: and };
}

async function conNombres(tx, filas) {
  const ids = [...new Set(filas.map((f) => f.usuarioId).filter(Boolean))];
  const usuarios = await tx.usuario.findMany({ where: { id: { in: ids } }, select: { id: true, nombres: true, email: true } });
  const mapa = new Map(usuarios.map((u) => [u.id, u]));
  return filas.map((f) => ({ ...f, id: f.id.toString(), usuario: mapa.get(f.usuarioId) ?? null }));
}

router.get('/', autorizar('auditoria.ver'), validar(filtros, 'query'), async (req, res) => {
  const pag = paginacion(req.validQuery);
  const where = whereAuditoria(req.permisos, 'auditoria.ver', req.validQuery);
  if (!where) return res.json(respuestaPaginada([], 0, pag));
  const resultado = await req.db(async (tx) => {
    const [filas, total] = await Promise.all([
      tx.auditoria.findMany({ where, orderBy: { fecha: 'desc' }, skip: pag.skip, take: pag.take }),
      tx.auditoria.count({ where }),
    ]);
    return respuestaPaginada(await conNombres(tx, filas), total, pag);
  });
  res.json(resultado);
});

/** CSV con protección contra inyección de fórmulas en Excel. */
function celda(v) {
  let s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

router.get('/exportar', autorizar('auditoria.exportar'), validar(filtros, 'query'), async (req, res) => {
  const where = whereAuditoria(req.permisos, 'auditoria.exportar', req.validQuery) ?? { id: -1n };
  const filas = await req.db(async (tx) => {
    const datos = await conNombres(tx, await tx.auditoria.findMany({ where, orderBy: { fecha: 'desc' }, take: 10000 }));
    await auditar(tx, req, { modulo: 'auditoria', accion: 'auditoria.exportar', recurso: 'auditoria', despues: { filtros: req.validQuery, filas: datos.length } });
    return datos;
  });
  const cabecera = ['fecha', 'usuario', 'email', 'modulo', 'accion', 'recurso', 'recurso_id', 'empresa_id', 'ip', 'dispositivo', 'antes', 'despues'];
  const lineas = filas.map((f) =>
    [f.fecha.toISOString(), f.usuario?.nombres, f.usuario?.email, f.modulo, f.accion, f.recurso, f.recursoId, f.empresaId, f.ip, f.dispositivo, f.antes, f.despues]
      .map(celda)
      .join(','),
  );
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="auditoria-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('﻿' + [cabecera.join(','), ...lineas].join('\r\n'));
});

export default router;
