import { Router } from 'express';
import { z } from 'zod';
import QRCode from 'qrcode';
import { rateLimit } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { redis } from '../../lib/redis.js';
import { sha256, tokenAleatorio } from '../../lib/crypto.js';
import { verificarPassword } from '../../services/password.js';
import { autorizar } from '../../middleware/autorizar.js';
import { validar } from '../../middleware/validar.js';
import { obtenerPermisos } from '../../rbac/servicio.js';
import { puede, puedeDentroDeEmpresa, tieneAlguno, whereAlcance } from '../../rbac/resolver.js';
import { auditar } from '../../services/auditoria.js';
import { emitir } from '../../realtime/socket.js';
import { paginacion, respuestaPaginada } from '../../lib/http.js';
import { textoOpcional } from '../../lib/esquemas.js';
import { conflicto, noEncontrado, prohibido, solicitudInvalida } from '../../lib/errors.js';
import * as pos from '../../pos/servicio.js';
import { encolarBaja, encolarEnvio } from '../../cpe/cola.js';
import { ELECTRONICOS } from '../../cpe/servicio.js';
import { CODIGO_COMPROBANTE, CODIGO_DOC, NOMBRE_COMPROBANTE, estadoCuotas, montoEnLetras } from '../../pos/reglas.js';

/**
 * Punto de venta. El alcance de cajas, turnos y comprobantes es el ALMACÉN de la caja:
 * un cajero con rol en un almacén solo opera las cajas de ese almacén.
 */
const router = Router();
const uuidRe = /^[0-9a-f-]{36}$/i;
const decimal = (dec) =>
  z.union([z.string(), z.number()]).transform((v) => String(v).trim())
    .pipe(z.string().regex(new RegExp(`^\\d{1,12}(\\.\\d{1,${dec}})?$`), `Número inválido (máximo ${dec} decimales)`));

const recurso = (x) => ({ empresaId: x.empresaId, sedeId: x.sedeId, almacenId: x.almacenId });

/** Carga un registro con alcance de almacén y valida el permiso (404 si no lo ve). */
async function cargar(req, modelo, id, codigo, include) {
  // Sin el permiso en ningún alcance → 403; con permiso pero fuera de su alcance → 404
  if (!tieneAlguno(req.permisos, codigo)) throw prohibido();
  if (!uuidRe.test(id || '')) throw noEncontrado();
  const x = await req.db((tx) => tx[modelo].findUnique({ where: { id }, include }));
  const r = modelo === 'sesionCaja' ? x && recurso(x.caja) : x && recurso(x);
  if (!x || !puede(req.permisos, codigo, r)) throw noEncontrado();
  return x;
}
const conPermisos = async (req, _res, next) => {
  req.permisos = await obtenerPermisos(req.user);
  next();
};

/** Envío automático a SUNAT si la empresa lo tiene activado (en segundo plano: no frena la venta) */
async function enviarSiCorresponde(req, c) {
  if (!ELECTRONICOS.includes(c.tipo)) return;
  const cfg = await req.db((tx) => tx.configFacturacion.findUnique({ where: { empresaId: c.empresaId }, select: { activo: true, envioAutomatico: true } }));
  if (cfg?.activo && cfg.envioAutomatico) await encolarEnvio(req.tenantId, c.id);
}

function notificarVenta(c, kardex) {
  emitir('pos:comprobante', { almacenId: c.almacenId }, { id: c.id, tipo: c.tipo, serie: c.serie, numero: c.numero, cajaId: c.cajaId });
  if (kardex) {
    const m = kardex.movimiento;
    emitir('kardex:movimiento', { almacenId: m.almacenId }, { id: m.id, numero: m.numero, tipo: m.tipo, motivo: m.motivo, almacenId: m.almacenId });
    for (const a of kardex.alertas ?? []) emitir('stock:alerta', { almacenId: a.almacenId }, a);
  }
}

// ═════════════ Cajas (configuración) ═════════════

const serie = (re, msg) => z.string().trim().toUpperCase().regex(re, msg);
const esquemaCaja = z
  .object({
    nombre: z.string().trim().min(2).max(60),
    almacenId: z.uuid(),
    serieFactura: serie(/^F[A-Z0-9]{3}$/, 'Serie de factura: F + 3 caracteres (p. ej. F001)'),
    serieBoleta: serie(/^B[A-Z0-9]{3}$/, 'Serie de boleta: B + 3 caracteres (p. ej. B001)'),
    serieNotaVenta: serie(/^[A-Z0-9]{2,4}$/, 'Serie de nota de venta: 2 a 4 caracteres (p. ej. NV01)'),
    serieNotaCreditoFactura: serie(/^F[A-Z0-9]{3}$/, 'Serie de NC de factura: F + 3 caracteres (p. ej. FC01)'),
    serieNotaCreditoBoleta: serie(/^B[A-Z0-9]{3}$/, 'Serie de NC de boleta: B + 3 caracteres (p. ej. BC01)'),
    descuentoMaximo: decimal(2).refine((v) => Number(v) <= 100, 'El tope de descuento va de 0 a 100 %').optional(),
    activo: z.boolean().optional(),
  })
  .refine((v) => new Set([v.serieFactura, v.serieBoleta, v.serieNotaVenta, v.serieNotaCreditoFactura, v.serieNotaCreditoBoleta]).size === 5, {
    message: 'Las cinco series deben ser distintas', path: ['serieFactura'],
  });
const SERIES = ['serieFactura', 'serieBoleta', 'serieNotaVenta', 'serieNotaCreditoFactura', 'serieNotaCreditoBoleta'];

/** Una serie no puede repetirse en otra caja de la misma empresa (la numeración es por serie). */
async function validarSeriesUnicas(tx, empresaId, datos, excluirId) {
  const otras = await tx.caja.findMany({ where: { empresaId, ...(excluirId && { id: { not: excluirId } }) } });
  const usadas = new Map(otras.flatMap((c) => SERIES.map((s) => [c[s], c.nombre])));
  for (const s of SERIES) if (usadas.has(datos[s])) throw conflicto(`La serie ${datos[s]} ya la usa la caja "${usadas.get(datos[s])}"`);
}

router.get('/cajas', conPermisos, validar(z.object({ empresaId: z.uuid() }), 'query'), async (req, res) => {
  const codigos = ['pos.venta.crear', 'pos.caja.ver', 'pos.caja.configurar'];
  if (!codigos.some((c) => tieneAlguno(req.permisos, c))) throw prohibido();
  const cajas = await req.db((tx) =>
    tx.caja.findMany({
      where: { empresaId: req.validQuery.empresaId },
      include: {
        almacen: { select: { codigo: true, nombre: true, sede: { select: { nombre: true } } } },
        // Datos tributarios para calcular detracción / retención en la caja
        empresa: { select: { cuentaDetracciones: true, exceptuadoRetencion: true } },
        sesiones: { where: { estado: 'ABIERTA' }, select: { id: true, usuarioId: true, abiertaEn: true, montoApertura: true } },
      },
      orderBy: { nombre: 'asc' },
    }),
  );
  const usuarios = await req.db((tx) =>
    tx.usuario.findMany({ where: { id: { in: cajas.flatMap((c) => c.sesiones.map((s) => s.usuarioId)) } }, select: { id: true, nombres: true } }),
  );
  const nombre = new Map(usuarios.map((u) => [u.id, u.nombres]));
  res.json(
    cajas
      .filter((c) => codigos.some((cod) => puede(req.permisos, cod, recurso(c))))
      .map(({ sesiones, ...c }) => {
        const s = sesiones.at(0);
        return {
          ...c,
          turno: s ? { ...s, usuario: nombre.get(s.usuarioId), esMio: s.usuarioId === req.user.id } : null,
          acciones: {
            vender: puede(req.permisos, 'pos.venta.crear', recurso(c)),
            configurar: puede(req.permisos, 'pos.caja.configurar', recurso(c)),
            credito: puede(req.permisos, 'pos.venta.credito', recurso(c)),
            autorizaDescuento: puede(req.permisos, 'pos.descuento.autorizar', recurso(c)),
            autorizaCredito: puedeDentroDeEmpresa(req.permisos, 'cxc.credito.autorizar', c.empresaId),
          },
        };
      }),
  );
});

router.post('/cajas', conPermisos, validar(esquemaCaja), async (req, res) => {
  const caja = await req.db(async (tx) => {
    const a = await tx.almacen.findUnique({ where: { id: req.body.almacenId } });
    if (!a || !puede(req.permisos, 'pos.caja.configurar', { empresaId: a.empresaId, sedeId: a.sedeId, almacenId: a.id })) throw noEncontrado('Almacén no encontrado');
    await validarSeriesUnicas(tx, a.empresaId, req.body);
    const { activo, ...datos } = req.body;
    const c = await tx.caja.create({ data: { ...datos, tenantId: req.tenantId, empresaId: a.empresaId, sedeId: a.sedeId } });
    await auditar(tx, req, { modulo: 'pos', accion: 'caja.crear', recurso: 'caja', recursoId: c.id, empresaId: c.empresaId, despues: c });
    return c;
  });
  res.status(201).json(caja);
});

router.put('/cajas/:id', conPermisos, validar(esquemaCaja), async (req, res) => {
  const antes = await cargar(req, 'caja', req.params.id, 'pos.caja.configurar');
  const caja = await req.db(async (tx) => {
    if (req.body.almacenId !== antes.almacenId) throw conflicto('El almacén de una caja no se cambia; cree otra caja');
    await validarSeriesUnicas(tx, antes.empresaId, req.body, antes.id);
    // Cambiar una serie con comprobantes emitidos rompería la correlación: se permite solo si no se usó
    const usadas = await tx.comprobante.groupBy({ by: ['serie'], where: { cajaId: antes.id } });
    for (const { serie: s } of usadas) {
      const campo = SERIES.find((k) => antes[k] === s);
      if (campo && req.body[campo] !== s) throw conflicto(`La serie ${s} ya tiene comprobantes emitidos y no se puede cambiar`);
    }
    const despues = await tx.caja.update({ where: { id: antes.id }, data: req.body });
    await auditar(tx, req, { modulo: 'pos', accion: 'caja.editar', recurso: 'caja', recursoId: antes.id, empresaId: antes.empresaId, antes, despues });
    return despues;
  });
  res.json(caja);
});

// ═════════════ Turnos ═════════════

router.post('/cajas/:id/abrir', conPermisos, validar(z.object({ montoApertura: decimal(2) })), async (req, res) => {
  const caja = await cargar(req, 'caja', req.params.id, 'pos.venta.crear');
  const turno = await req.db(async (tx) => {
    const t = await pos.abrirTurno(tx, { tenantId: req.tenantId, cajaId: caja.id, usuarioId: req.user.id, montoApertura: req.body.montoApertura });
    await auditar(tx, req, { modulo: 'pos', accion: 'turno.abrir', recurso: 'sesion_caja', recursoId: t.id, empresaId: caja.empresaId, despues: { caja: caja.nombre, montoApertura: req.body.montoApertura } });
    return t;
  });
  emitir('pos:turno', { almacenId: caja.almacenId }, { cajaId: caja.id, estado: 'ABIERTA' });
  res.status(201).json(turno);
});

async function datosTurno(req, sesion) {
  const r = await req.db((tx) => pos.resumenTurno(tx, sesion.id));
  const usuario = await req.db((tx) => tx.usuario.findUnique({ where: { id: sesion.usuarioId }, select: { nombres: true } }));
  const fuente = sesion.estado === 'CERRADA' && sesion.resumen ? sesion.resumen : {
    porMedio: Object.fromEntries(Object.entries(r.porMedio).map(([k, v]) => [k, v.toFixed(2)])),
    porTipo: Object.fromEntries(Object.entries(r.porTipo).map(([k, v]) => [k, { cantidad: v.cantidad, total: v.total.toFixed(2) }])),
    anulados: r.anulados,
    ventasNetas: r.ventasNetas.toFixed(2),
    ventasCredito: r.ventasCredito.toFixed(2),
    cobranzas: { cantidad: r.cobranzas.cantidad, total: r.cobranzas.total.toFixed(2) },
  };
  return {
    ...sesion,
    usuario: usuario?.nombres,
    esMio: sesion.usuarioId === req.user.id,
    resumen: fuente,
    efectivoEsperado: sesion.efectivoEsperado ?? r.efectivoEsperado.toFixed(2),
  };
}

router.get('/sesiones/:id', conPermisos, async (req, res) => {
  if (!uuidRe.test(req.params.id)) throw noEncontrado();
  const s = await req.db((tx) =>
    tx.sesionCaja.findUnique({
      where: { id: req.params.id },
      include: {
        caja: {
          include: {
            empresa: { select: { razonSocial: true, ruc: true, nombreComercial: true, direccion: true } },
            almacen: { select: { nombre: true, sede: { select: { nombre: true, direccion: true } } } },
          },
        },
      },
    }),
  );
  // Lo ve quien abrió el turno o quien supervisa cajas en ese almacén
  const visible = s && ((s.usuarioId === req.user.id && puede(req.permisos, 'pos.venta.crear', recurso(s.caja))) || puede(req.permisos, 'pos.caja.ver', recurso(s.caja)));
  if (!visible) throw noEncontrado();
  res.json(await datosTurno(req, s));
});

router.post(
  '/sesiones/:id/cerrar',
  conPermisos,
  validar(z.object({ efectivoDeclarado: decimal(2), observacion: textoOpcional(500) })),
  async (req, res) => {
    const s = await cargar(req, 'sesionCaja', req.params.id, 'pos.venta.crear', { caja: true });
    const cerrado = await req.db(async (tx) => {
      const c = await pos.cerrarTurno(tx, {
        sesionId: s.id, usuarioId: req.user.id, puedeCerrarAjeno: puede(req.permisos, 'pos.caja.configurar', recurso(s.caja)),
        efectivoDeclarado: req.body.efectivoDeclarado, observacion: req.body.observacion,
      });
      await auditar(tx, req, {
        modulo: 'pos', accion: 'turno.cerrar', recurso: 'sesion_caja', recursoId: s.id, empresaId: s.caja.empresaId,
        despues: { esperado: c.efectivoEsperado, declarado: c.efectivoDeclarado, diferencia: c.diferencia },
      });
      return c;
    });
    emitir('pos:turno', { almacenId: s.caja.almacenId }, { cajaId: s.cajaId, estado: 'CERRADA' });
    res.json(cerrado);
  },
);

router.get(
  '/sesiones',
  autorizar('pos.caja.ver'),
  validar(z.object({ empresaId: z.uuid(), cajaId: z.uuid().optional(), estado: z.enum(['ABIERTA', 'CERRADA']).optional(), pagina: z.string().optional(), porPagina: z.string().optional() }), 'query'),
  async (req, res) => {
    const pag = paginacion(req.validQuery);
    const alcance = whereAlcance(req.permisos, 'pos.caja.ver', 'registro');
    if (!alcance) return res.json(respuestaPaginada([], 0, pag));
    const { empresaId, cajaId, estado } = req.validQuery;
    const where = { caja: { AND: [alcance, { empresaId }] }, ...(cajaId && { cajaId }), ...(estado && { estado }) };
    const [datos, total] = await req.db((tx) =>
      Promise.all([
        tx.sesionCaja.findMany({ where, include: { caja: { select: { nombre: true } } }, orderBy: { abiertaEn: 'desc' }, skip: pag.skip, take: pag.take }),
        tx.sesionCaja.count({ where }),
      ]),
    );
    const usuarios = await req.db((tx) => tx.usuario.findMany({ where: { id: { in: datos.map((d) => d.usuarioId) } }, select: { id: true, nombres: true } }));
    const nombre = new Map(usuarios.map((u) => [u.id, u.nombres]));
    res.json(respuestaPaginada(datos.map((d) => ({ ...d, usuario: nombre.get(d.usuarioId) })), total, pag));
  },
);

// ═════════════ Autorización de supervisor ═════════════

/**
 * Un supervisor autoriza en la caja del cajero (con su correo y contraseña) un descuento sobre
 * el tope o un crédito fuera de límite. Se entrega un pase de UN SOLO USO, válido 5 minutos,
 * atado a esa caja y a ese cajero. Las credenciales nunca viajan con la venta.
 */
const limiteAutorizacion = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => `${req.user.id}`,
  message: { error: 'Demasiados intentos de autorización, espere unos minutos' },
  store: new RedisStore({ sendCommand: (...args) => redis.call(...args), prefix: 'rl:pos-autorizacion:' }),
});
const PERMISO_AUTORIZA = { DESCUENTO: 'pos.descuento.autorizar', CREDITO: 'cxc.credito.autorizar' };
const TTL_AUTORIZACION = 300;
const claveAutorizacion = (token) => `pos:autorizacion:${sha256(token)}`;

router.post(
  '/autorizaciones',
  conPermisos,
  limiteAutorizacion,
  validar(z.object({ cajaId: z.uuid(), tipo: z.enum(['DESCUENTO', 'CREDITO']), email: z.string().trim().toLowerCase().max(254), password: z.string().min(1).max(128) })),
  async (req, res) => {
    const caja = await cargar(req, 'caja', req.body.cajaId, 'pos.venta.crear');
    const { tipo, email, password } = req.body;
    const sup = await req.db((tx) => tx.usuario.findUnique({ where: { email }, select: { id: true, nombres: true, estado: true, passwordHash: true, bloqueadoHasta: true } }));
    const valido = await verificarPassword(sup?.passwordHash, password);
    const activo = sup && valido && sup.estado === 'activo' && !(sup.bloqueadoHasta && sup.bloqueadoHasta > new Date());
    const permisos = activo ? await obtenerPermisos({ id: sup.id, tenantId: req.tenantId }) : null;
    const autoriza = permisos && (tipo === 'DESCUENTO' ? puede(permisos, PERMISO_AUTORIZA.DESCUENTO, recurso(caja)) : puedeDentroDeEmpresa(permisos, PERMISO_AUTORIZA.CREDITO, caja.empresaId));
    if (!autoriza) {
      await req.db((tx) => auditar(tx, req, { modulo: 'pos', accion: 'autorizacion.rechazada', recurso: 'caja', recursoId: caja.id, empresaId: caja.empresaId, despues: { tipo, supervisor: email } }));
      // Mensaje único: no revela si el correo existe ni si la contraseña era correcta
      throw prohibido('Credenciales incorrectas o el usuario no puede autorizar esta operación');
    }
    const token = tokenAleatorio();
    await redis.set(claveAutorizacion(token), JSON.stringify({ supervisorId: sup.id, nombre: sup.nombres, tipo, cajaId: caja.id, usuarioId: req.user.id }), 'EX', TTL_AUTORIZACION);
    await req.db((tx) => auditar(tx, req, { modulo: 'pos', accion: 'autorizacion.otorgada', recurso: 'caja', recursoId: caja.id, empresaId: caja.empresaId, despues: { tipo, supervisor: sup.nombres } }));
    res.status(201).json({ token, tipo, supervisor: sup.nombres, expiraEnSegundos: TTL_AUTORIZACION });
  },
);

/** Lee los pases de autorización de la venta (deben ser de esta caja y este cajero). */
async function leerAutorizaciones(req, tokens = []) {
  if (!tokens.length) return null;
  const tipos = [];
  let supervisorId = null;
  let nombre = null;
  for (const t of tokens) {
    const raw = await redis.get(claveAutorizacion(t));
    const a = raw && JSON.parse(raw);
    if (!a || a.cajaId !== req.body.cajaId || a.usuarioId !== req.user.id) throw solicitudInvalida('La autorización venció o no es válida: pídala de nuevo');
    tipos.push(a.tipo);
    supervisorId = a.supervisorId;
    nombre = a.nombre;
  }
  return { supervisorId, nombre, tipos };
}

// ═════════════ Ventas ═════════════

const medio = z.enum(['EFECTIVO', 'TARJETA', 'YAPE', 'PLIN', 'TRANSFERENCIA', 'OTRO']);
const fechaISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (AAAA-MM-DD)');
const esquemaVenta = z.object({
  cajaId: z.uuid(),
  tipo: z.enum(['FACTURA', 'BOLETA', 'NOTA_VENTA']),
  clienteId: z.uuid().nullish(),
  observacion: textoOpcional(300),
  items: z
    .array(
      z.object({
        productoId: z.uuid(), cantidad: decimal(4), precioUnitario: decimal(4).optional(),
        descuento: decimal(2).optional(), descuentoPorcentaje: decimal(2).optional(),
      }),
    )
    .min(1, 'Agregue al menos un producto')
    .max(300),
  descuentoGlobal: z.object({ tipo: z.enum(['MONTO', 'PORCENTAJE']), valor: decimal(2) }).nullish(),
  formaPago: z.enum(['CONTADO', 'CREDITO']).default('CONTADO'),
  cuotas: z.array(z.object({ monto: decimal(2), fechaVencimiento: fechaISO })).max(36).nullish(),
  pagos: z.array(z.object({ medio, monto: decimal(2), referencia: textoOpcional(60) })).max(6).default([]),
  autorizaciones: z.array(z.string().max(100)).max(2).optional(),
});

router.post('/ventas', conPermisos, validar(esquemaVenta), async (req, res) => {
  const caja = await cargar(req, 'caja', req.body.cajaId, 'pos.venta.crear');
  const { autorizaciones, ...venta } = req.body;
  const autorizacion = await leerAutorizaciones(req, autorizaciones);
  const permisos = {
    credito: puede(req.permisos, 'pos.venta.credito', recurso(caja)),
    autorizaDescuento: puede(req.permisos, 'pos.descuento.autorizar', recurso(caja)),
    autorizaCredito: puedeDentroDeEmpresa(req.permisos, 'cxc.credito.autorizar', caja.empresaId),
  };
  const r = await req.db(
    async (tx) => {
      const v = await pos.vender(tx, { ...venta, tenantId: req.tenantId, usuarioId: req.user.id, permisos, autorizacion });
      await auditar(tx, req, {
        modulo: 'pos', accion: 'venta.emitir', recurso: 'comprobante', recursoId: v.comprobante.id, empresaId: caja.empresaId,
        despues: {
          comprobante: `${v.comprobante.serie}-${v.comprobante.numero}`, total: v.comprobante.total, cliente: v.comprobante.clienteNombre,
          formaPago: v.comprobante.formaPago, ...(v.comprobante.autorizacion && { autorizacion: v.comprobante.autorizacion, autorizadoPor: autorizacion?.nombre ?? req.user.id }),
        },
      });
      return v;
    },
    { timeout: 20000 },
  );
  // Los pases de autorización son de un solo uso
  if (autorizaciones?.length) await redis.del(...autorizaciones.map(claveAutorizacion));
  notificarVenta(r.comprobante, r.kardex);
  await enviarSiCorresponde(req, r.comprobante);
  if (r.comprobante.formaPago === 'CREDITO') emitir('cxc:cambio', { empresaId: caja.empresaId }, { clienteId: r.comprobante.clienteId });
  res.status(201).json({
    id: r.comprobante.id, serie: r.comprobante.serie, numero: r.comprobante.numero, total: r.comprobante.total, vuelto: r.comprobante.vuelto,
    formaPago: r.comprobante.formaPago, montoCredito: r.comprobante.montoCredito,
  });
});

// ═════════════ Comprobantes ═════════════

router.get(
  '/comprobantes',
  autorizar('pos.venta.ver'),
  validar(
    z.object({
      empresaId: z.uuid(),
      tipo: z.enum(['FACTURA', 'BOLETA', 'NOTA_VENTA', 'NOTA_CREDITO']).optional(),
      estado: z.enum(['EMITIDO', 'ANULADO']).optional(),
      estadoSunat: z.enum(['PENDIENTE', 'ENVIADO', 'ACEPTADO', 'OBSERVADO', 'RECHAZADO', 'ANULADO']).optional(),
      cajaId: z.uuid().optional(),
      sesionCajaId: z.uuid().optional(),
      desde: z.coerce.date().optional(),
      hasta: z.coerce.date().optional(),
      q: z.string().trim().max(60).optional(),
      pagina: z.string().optional(),
      porPagina: z.string().optional(),
    }),
    'query',
  ),
  async (req, res) => {
    const pag = paginacion(req.validQuery);
    const alcance = whereAlcance(req.permisos, 'pos.venta.ver', 'registro');
    if (!alcance) return res.json(respuestaPaginada([], 0, pag));
    const { empresaId, tipo, estado, estadoSunat, cajaId, sesionCajaId, desde, hasta, q } = req.validQuery;
    const numero = q && /^\d+$/.test(q.split('-').at(-1)) ? Number(q.split('-').at(-1)) : null;
    const where = {
      AND: [
        alcance,
        { empresaId },
        tipo ? { tipo } : {},
        estado ? { estado } : {},
        estadoSunat ? { estadoSunat } : {},
        cajaId ? { cajaId } : {},
        sesionCajaId ? { sesionCajaId } : {},
        desde || hasta ? { fechaEmision: { ...(desde && { gte: desde }), ...(hasta && { lte: hasta }) } } : {},
        q
          ? { OR: [{ clienteNombre: { contains: q, mode: 'insensitive' } }, { clienteNumeroDocumento: { startsWith: q } }, ...(numero ? [{ numero }] : [])] }
          : {},
      ],
    };
    const [datos, total] = await req.db((tx) =>
      Promise.all([
        tx.comprobante.findMany({ where, include: { caja: { select: { nombre: true } } }, orderBy: { fechaEmision: 'desc' }, skip: pag.skip, take: pag.take }),
        tx.comprobante.count({ where }),
      ]),
    );
    res.json(respuestaPaginada(datos, total, pag));
  },
);

/** Contenido del QR de la representación impresa (formato SUNAT; sin hash hasta firmar). */
function textoQR(c, empresa) {
  return [
    empresa.ruc, CODIGO_COMPROBANTE[c.tipo], c.serie, String(c.numero).padStart(8, '0'),
    Number(c.igv).toFixed(2), Number(c.total).toFixed(2), c.fechaEmision.toISOString().slice(0, 10),
    CODIGO_DOC[c.clienteTipoDocumento], c.clienteNumeroDocumento === '-' ? '' : c.clienteNumeroDocumento, '',
  ].join('|');
}

router.get('/comprobantes/:id', conPermisos, async (req, res) => {
  const c = await cargar(req, 'comprobante', req.params.id, 'pos.venta.ver', {
    detalles: { orderBy: { id: 'asc' } },
    pagos: true,
    empresa: { select: { razonSocial: true, nombreComercial: true, ruc: true, direccion: true, cuentaDetracciones: true } },
    caja: { select: { nombre: true, almacen: { select: { nombre: true, sede: { select: { nombre: true, direccion: true } } } } } },
    sesion: { select: { estado: true, usuarioId: true } },
    referencia: { select: { id: true, tipo: true, serie: true, numero: true, fechaEmision: true } },
    notasCredito: { select: { id: true, serie: true, numero: true, estado: true, total: true, aplicadoASaldo: true } },
    movimiento: { select: { id: true, numero: true } },
    cuotas: { orderBy: { numero: 'asc' } },
    cobranzas: { orderBy: { numero: 'asc' }, select: { id: true, numero: true, fecha: true, medio: true, monto: true, estado: true, referencia: true } },
  });
  const [cajero, autorizador] = await req.db((tx) =>
    Promise.all([
      tx.usuario.findUnique({ where: { id: c.usuarioId }, select: { nombres: true } }),
      c.autorizadoPorId ? tx.usuario.findUnique({ where: { id: c.autorizadoPorId }, select: { nombres: true } }) : null,
    ]),
  );
  const r = recurso(c);
  const esElectronico = c.tipo !== 'NOTA_VENTA';
  res.json({
    ...c,
    nombreTipo: NOMBRE_COMPROBANTE[c.tipo],
    codigoTipo: CODIGO_COMPROBANTE[c.tipo] ?? null,
    numeroCompleto: `${c.serie}-${String(c.numero).padStart(8, '0')}`,
    montoEnLetras: montoEnLetras(c.total, c.moneda),
    cajero: cajero?.nombres,
    autorizadoPor: autorizador?.nombres ?? null,
    cuotas: c.formaPago === 'CREDITO' ? estadoCuotas(c.cuotas, c.montoCredito, c.estado === 'ANULADO' ? c.montoCredito : c.saldoPendiente) : [],
    // QR oficial (con el hash que devuelve SUNAT/proveedor) cuando ya existe; si no, el provisional
    qr: esElectronico ? await QRCode.toDataURL(c.sunatQr || textoQR(c, c.empresa), { margin: 1, width: 180 }) : null,
    acciones: {
      anular: c.estado === 'EMITIDO' && c.sesion.estado === 'ABIERTA' && !c.notasCredito.some((n) => n.estado === 'EMITIDO')
        && !c.cobranzas.some((k) => k.estado === 'VIGENTE') && puede(req.permisos, 'pos.venta.anular', r),
      notaCredito: c.estado === 'EMITIDO' && ['FACTURA', 'BOLETA'].includes(c.tipo) && puede(req.permisos, 'pos.notacredito.crear', r),
      cobrar: c.estado === 'EMITIDO' && c.formaPago === 'CREDITO' && Number(c.saldoPendiente) > 0 && puedeDentroDeEmpresa(req.permisos, 'cxc.cobranza.crear', c.empresaId),
    },
  });
});

router.post('/comprobantes/:id/anular', conPermisos, validar(z.object({ motivo: z.string().trim().min(5, 'Indique el motivo').max(300) })), async (req, res) => {
  const c = await cargar(req, 'comprobante', req.params.id, 'pos.venta.anular');
  const r = await req.db(
    async (tx) => {
      const x = await pos.anular(tx, { comprobanteId: c.id, usuarioId: req.user.id, tenantId: req.tenantId, motivo: req.body.motivo });
      await auditar(tx, req, {
        modulo: 'pos', accion: 'comprobante.anular', recurso: 'comprobante', recursoId: c.id, empresaId: c.empresaId,
        antes: { estado: 'EMITIDO' }, despues: { estado: 'ANULADO', motivo: req.body.motivo },
      });
      return x;
    },
    { timeout: 20000 },
  );
  notificarVenta(c, r.kardex);
  // Ya estaba en SUNAT: se comunica la baja. Si nunca se envió, no hay nada que comunicar.
  if (c.sunatEnviadoEn && ['ACEPTADO', 'OBSERVADO', 'ENVIADO'].includes(c.estadoSunat)) await encolarBaja(req.tenantId, c.id, req.body.motivo);
  if (c.formaPago === 'CREDITO' || c.tipo === 'NOTA_CREDITO') emitir('cxc:cambio', { empresaId: c.empresaId }, { clienteId: c.clienteId });
  res.json({ id: c.id, estado: 'ANULADO' });
});

router.post(
  '/notas-credito',
  conPermisos,
  validar(
    z.object({
      cajaId: z.uuid(),
      comprobanteId: z.uuid(),
      motivoCodigo: z.enum(Object.keys(pos.MOTIVOS_NC)),
      motivoDescripcion: textoOpcional(200),
      medioReembolso: z.enum(['EFECTIVO', 'TARJETA', 'YAPE', 'PLIN', 'TRANSFERENCIA', 'OTRO']).default('EFECTIVO'),
      items: z.array(z.object({ productoId: z.uuid(), cantidad: decimal(4) })).max(300).optional(),
    }),
  ),
  async (req, res) => {
    const caja = await cargar(req, 'caja', req.body.cajaId, 'pos.notacredito.crear');
    const original = await cargar(req, 'comprobante', req.body.comprobanteId, 'pos.notacredito.crear');
    const r = await req.db(
      async (tx) => {
        const x = await pos.notaCredito(tx, { ...req.body, tenantId: req.tenantId, usuarioId: req.user.id });
        await auditar(tx, req, {
          modulo: 'pos', accion: 'notacredito.emitir', recurso: 'comprobante', recursoId: x.comprobante.id, empresaId: caja.empresaId,
          despues: { nota: `${x.comprobante.serie}-${x.comprobante.numero}`, sobre: `${original.serie}-${original.numero}`, total: x.comprobante.total, motivo: req.body.motivoCodigo },
        });
        return x;
      },
      { timeout: 20000 },
    );
    notificarVenta(r.comprobante, r.kardex);
    await enviarSiCorresponde(req, r.comprobante);
    if (Number(r.comprobante.aplicadoASaldo) > 0) emitir('cxc:cambio', { empresaId: caja.empresaId }, { clienteId: r.comprobante.clienteId });
    res.status(201).json({ id: r.comprobante.id, serie: r.comprobante.serie, numero: r.comprobante.numero, total: r.comprobante.total, aplicadoASaldo: r.comprobante.aplicadoASaldo });
  },
);

export default router;
