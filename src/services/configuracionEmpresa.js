import { obtenerConfig } from '../contabilidad/servicio.js';

/**
 * Estado de configuración de una empresa: qué tiene listo y qué le falta para operar, en un solo
 * lugar (antes repartido entre Empresas, Sedes, Cajas, Facturación, SIRE y Plan contable).
 * Solo se evalúan los módulos que el estudio tiene contratados.
 * estado: 'ok' | 'pendiente' (impide operar ese módulo) | 'aviso' (funciona, pero revisar) | 'opcional'
 * accion: { tipo: 'modal' | 'ruta', destino, permiso } — qué abrir para resolverlo
 */
export async function estadoConfiguracion(tx, { empresaId, modulos }) {
  const tiene = (m) => modulos.has(m);
  const [empresa, sedes, almacenes, cajas, facturacion, sire, cuentas] = await Promise.all([
    tx.empresa.findUnique({ where: { id: empresaId } }),
    tx.sede.findMany({ where: { empresaId, activo: true }, select: { nombre: true, ubigeo: true, codigoEstablecimiento: true, direccion: true } }),
    tx.almacen.count({ where: { empresaId, activo: true } }),
    tx.caja.count({ where: { empresaId, activo: true } }),
    tx.configFacturacion.findUnique({ where: { empresaId } }),
    tx.configSire.findUnique({ where: { empresaId } }),
    tx.cuentaContable.count({ where: { empresaId } }),
  ]);
  const checks = [];
  const agregar = (c) => checks.push(c);

  // ── Base ──
  const faltanDatos = [!empresa.direccion && 'dirección fiscal'].filter(Boolean);
  agregar({
    clave: 'datos', grupo: 'Empresa', titulo: 'Datos tributarios',
    estado: faltanDatos.length ? 'pendiente' : 'ok',
    detalle: faltanDatos.length ? `Falta: ${faltanDatos.join(', ')}` : `RUC ${empresa.ruc} · ${{ GENERAL: 'Régimen General', MYPE: 'Régimen MYPE', ESPECIAL: 'Régimen Especial', NRUS: 'Nuevo RUS' }[empresa.regimenTributario]}`,
    accion: { tipo: 'modal', destino: 'datos', permiso: 'empresas.empresa.editar' },
  });
  const sinUbigeo = sedes.filter((s) => !s.ubigeo || !s.codigoEstablecimiento);
  agregar({
    clave: 'sedes', grupo: 'Empresa', titulo: 'Sedes y establecimientos',
    estado: !sedes.length ? 'pendiente' : sinUbigeo.length ? 'aviso' : 'ok',
    detalle: !sedes.length ? 'Registre al menos una sede'
      : sinUbigeo.length ? `${sinUbigeo.length} sede(s) sin ubigeo o código de establecimiento SUNAT (lo usan las guías de remisión y el PLE)` : `${sedes.length} sede(s) con ubigeo y establecimiento`,
    accion: { tipo: 'ruta', destino: '/sedes', permiso: 'sedes.sede.ver' },
  });

  // ── Inventario y caja ──
  if (tiene('inventario')) {
    agregar({
      clave: 'almacenes', grupo: 'Operación', titulo: 'Almacenes',
      estado: almacenes ? 'ok' : 'pendiente', detalle: almacenes ? `${almacenes} almacén(es) activo(s)` : 'Registre al menos un almacén',
      accion: { tipo: 'ruta', destino: '/almacenes', permiso: 'almacenes.almacen.ver' },
    });
  }
  if (tiene('pos')) {
    agregar({
      clave: 'cajas', grupo: 'Operación', titulo: 'Cajas y series',
      estado: cajas ? 'ok' : 'pendiente', detalle: cajas ? `${cajas} caja(s) con sus series de comprobantes` : 'Cree una caja con sus series para vender',
      accion: { tipo: 'ruta', destino: '/cajas', permiso: 'pos.caja.configurar' },
    });
  }

  // ── SUNAT ──
  if (tiene('facturacion')) {
    const real = facturacion && facturacion.proveedor !== 'SIMULADO';
    const ambiente = facturacion?.ambiente === 'PRODUCCION' ? 'producción' : 'pruebas';
    // Qué le falta al proveedor elegido para enviar en el ambiente elegido
    const falta = !real ? null
      : facturacion.proveedor === 'NUBEFACT' ? (!facturacion.tokenCifrado && 'Falta el token del proveedor')
        : facturacion.ambiente === 'PRODUCCION' && !facturacion.certificadoCifrado ? 'Falta el certificado digital'
          : facturacion.ambiente === 'PRODUCCION' && (!facturacion.solUsuario || !facturacion.solClaveCifrada) ? 'Falta el usuario o la clave SOL'
            : null;
    const diasCertificado = facturacion?.certificadoVence ? Math.floor((facturacion.certificadoVence - Date.now()) / 86_400_000) : null;
    const certificadoPorVencer = diasCertificado != null && diasCertificado <= 30;
    agregar({
      clave: 'facturacion', grupo: 'SUNAT', titulo: 'Facturación electrónica',
      estado: !facturacion || !facturacion.activo || falta || (certificadoPorVencer && diasCertificado < 0) ? 'pendiente' : !real || certificadoPorVencer ? 'aviso' : 'ok',
      detalle: !facturacion ? 'Sin proveedor configurado: los comprobantes no se envían a SUNAT'
        : !facturacion.activo ? 'Desactivada'
          : !real ? 'En modo simulado: los comprobantes no llegan a SUNAT'
            : falta || (certificadoPorVencer
              ? (diasCertificado < 0 ? 'El certificado digital venció: renuévelo' : `El certificado digital vence en ${diasCertificado} día(s)`)
              : `${facturacion.proveedor === 'SUNAT_DIRECTO' ? 'SUNAT directo' : facturacion.proveedor} · ${ambiente}`),
      accion: { tipo: 'modal', destino: 'facturacion', permiso: 'cpe.configuracion.editar' },
    });
    agregar({
      clave: 'detracciones', grupo: 'SUNAT', titulo: 'Cuenta de detracciones',
      estado: empresa.cuentaDetracciones ? 'ok' : 'opcional',
      detalle: empresa.cuentaDetracciones ? `Banco de la Nación ${empresa.cuentaDetracciones}` : 'Solo si vende bienes o servicios sujetos al SPOT',
      accion: { tipo: 'modal', destino: 'datos', permiso: 'empresas.empresa.editar' },
    });
  }
  if (tiene('sire')) {
    agregar({
      clave: 'sire', grupo: 'SUNAT', titulo: 'SIRE',
      estado: !sire || !sire.activo ? 'pendiente' : sire.ultimoError ? 'pendiente' : sire.modo === 'SIMULADO' ? 'aviso' : 'ok',
      detalle: !sire ? 'Sin credenciales: no se pueden descargar las propuestas de SUNAT'
        : !sire.activo ? 'Desactivado'
          : sire.ultimoError ? `Última conexión con error: ${sire.ultimoError}`
            : sire.modo === 'SIMULADO' ? 'En modo simulado: no consulta a SUNAT' : 'Conectado con SUNAT',
      accion: { tipo: 'modal', destino: 'sire', permiso: 'sire.configuracion.editar' },
    });
  }

  // ── Contabilidad ──
  if (tiene('contabilidad')) {
    agregar({
      clave: 'plan', grupo: 'Contabilidad', titulo: 'Plan contable',
      estado: cuentas ? 'ok' : 'pendiente', detalle: cuentas ? `${cuentas} cuentas` : 'Cargue el PCGE base o copie el plan de otra empresa',
      accion: { tipo: 'ruta', destino: '/contabilidad/plan', permiso: 'contabilidad.plan.ver' },
    });
    if (cuentas) {
      const cfg = await obtenerConfig(tx, empresaId);
      const malas = cfg.operaciones.filter((o) => !o.codigo || o.problema);
      agregar({
        clave: 'cuentasOperacion', grupo: 'Contabilidad', titulo: 'Cuentas por operación',
        estado: malas.length ? 'pendiente' : 'ok',
        detalle: malas.length ? `${malas.length} operación(es) sin cuenta válida: no se podrán contabilizar` : 'Todas las operaciones tienen su cuenta',
        accion: { tipo: 'ruta', destino: '/contabilidad/plan?vista=operaciones', permiso: 'contabilidad.plan.ver' },
      });
    }
  }

  const listos = checks.filter((c) => c.estado === 'ok' || c.estado === 'opcional').length;
  return { empresa: { id: empresa.id, ruc: empresa.ruc, razonSocial: empresa.razonSocial, nombreComercial: empresa.nombreComercial, activo: empresa.activo }, checks, listos, total: checks.length };
}
