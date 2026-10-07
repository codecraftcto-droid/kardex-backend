/**
 * Plan Contable General Empresarial (PCGE, versión modificada 2019) — base para empresas
 * comerciales y de servicios: todas las cuentas de 2 dígitos de los elementos 1 a 9 y las
 * subcuentas y divisionarias de uso habitual. Cada estudio lo copia a sus empresas y lo amplía.
 * Revisar con el contador antes de usar en producción.
 *
 * [código, nombre]. La naturaleza, el elemento y si es imputable se calculan (ver reglas.js).
 */
export const PCGE_BASE = [
  // ── Elemento 1: Activo disponible y exigible ──
  ['10', 'Efectivo y equivalentes de efectivo'],
  ['101', 'Caja'], ['1011', 'Caja'],
  ['102', 'Fondos fijos'], ['1021', 'Caja chica'],
  ['103', 'Efectivo en tránsito'],
  ['104', 'Cuentas corrientes en instituciones financieras'], ['1041', 'Cuentas corrientes operativas'], ['1042', 'Cuentas corrientes para fines específicos'],
  ['106', 'Depósitos en instituciones financieras'], ['1061', 'Depósitos de ahorro'], ['1062', 'Depósitos a plazo'],
  ['107', 'Fondos sujetos a restricción'], ['1071', 'Fondos sujetos a restricción (detracciones)'],
  ['12', 'Cuentas por cobrar comerciales – terceros'],
  ['121', 'Facturas, boletas y otros comprobantes por cobrar'], ['1211', 'No emitidas'], ['1212', 'Emitidas en cartera'], ['1213', 'En cobranza'], ['1214', 'En descuento'],
  ['122', 'Anticipos de clientes'],
  ['123', 'Letras por cobrar'], ['1231', 'En cartera'], ['1232', 'En cobranza'], ['1233', 'En descuento'],
  ['13', 'Cuentas por cobrar comerciales – relacionadas'],
  ['14', 'Cuentas por cobrar al personal, a los accionistas (socios), directores y gerentes'],
  ['141', 'Personal'], ['1411', 'Préstamos'], ['1412', 'Adelanto de remuneraciones'], ['1413', 'Entregas a rendir cuenta'],
  ['142', 'Accionistas (o socios)'],
  ['16', 'Cuentas por cobrar diversas – terceros'],
  ['162', 'Reclamaciones a terceros'], ['165', 'Venta de activo inmovilizado'], ['168', 'Otras cuentas por cobrar diversas'],
  ['17', 'Cuentas por cobrar diversas – relacionadas'],
  ['18', 'Servicios y otros contratados por anticipado'],
  ['181', 'Costos financieros'], ['182', 'Seguros'], ['183', 'Alquileres'], ['189', 'Otros gastos contratados por anticipado'],
  ['19', 'Estimación de cuentas de cobranza dudosa'],
  ['191', 'Cuentas por cobrar comerciales – terceros'],

  // ── Elemento 2: Activo realizable ──
  ['20', 'Mercaderías'],
  ['201', 'Mercaderías'], ['2011', 'Mercaderías manufacturadas'], ['20111', 'Costo'],
  ['21', 'Productos terminados'], ['211', 'Productos manufacturados'],
  ['22', 'Subproductos, desechos y desperdicios'],
  ['23', 'Productos en proceso'],
  ['24', 'Materias primas'], ['241', 'Materias primas para productos manufacturados'],
  ['25', 'Materiales auxiliares, suministros y repuestos'], ['251', 'Materiales auxiliares'], ['252', 'Suministros'], ['253', 'Repuestos'],
  ['26', 'Envases y embalajes'], ['261', 'Envases'], ['262', 'Embalajes'],
  ['27', 'Activos no corrientes mantenidos para la venta'],
  ['28', 'Inventarios por recibir'], ['281', 'Mercaderías'],
  ['29', 'Desvalorización de inventarios'], ['291', 'Mercaderías'],

  // ── Elemento 3: Activo inmovilizado ──
  ['30', 'Inversiones mobiliarias'],
  ['31', 'Propiedades de inversión'],
  ['32', 'Activos por derecho de uso'],
  ['33', 'Propiedades, planta y equipo'],
  ['331', 'Terrenos'], ['332', 'Edificaciones'], ['333', 'Maquinarias y equipos de explotación'], ['334', 'Unidades de transporte'],
  ['335', 'Muebles y enseres'], ['336', 'Equipos diversos'], ['3361', 'Equipo para procesamiento de información'], ['3369', 'Otros equipos'],
  ['339', 'Obras en curso'],
  ['34', 'Intangibles'], ['343', 'Programas de computadora (software)'],
  ['35', 'Activos biológicos'],
  ['36', 'Desvalorización de activo inmovilizado'],
  ['37', 'Activo diferido'], ['371', 'Impuesto a la renta diferido'],
  ['38', 'Otros activos'],
  ['39', 'Depreciación, amortización y agotamiento acumulados'],
  ['391', 'Depreciación acumulada'], ['3913', 'Propiedades, planta y equipo – costo'], ['392', 'Amortización acumulada'],

  // ── Elemento 4: Pasivo ──
  ['40', 'Tributos, contraprestaciones y aportes al sistema de pensiones y de salud por pagar'],
  ['401', 'Gobierno central'],
  ['4011', 'Impuesto general a las ventas'], ['40111', 'IGV – Cuenta propia'], ['40112', 'IGV – Servicios prestados por no domiciliados'],
  ['40113', 'IGV – Régimen de percepciones'], ['40114', 'IGV – Régimen de retenciones'],
  ['4017', 'Impuesto a la renta'], ['40171', 'Renta de tercera categoría'], ['40172', 'Renta de cuarta categoría'], ['40173', 'Renta de quinta categoría'],
  ['403', 'Instituciones públicas'], ['4031', 'ESSALUD'], ['4032', 'ONP'],
  ['407', 'Administradoras de fondos de pensiones'],
  ['41', 'Remuneraciones y participaciones por pagar'],
  ['411', 'Remuneraciones por pagar'], ['4111', 'Sueldos y salarios por pagar'], ['4114', 'Gratificaciones por pagar'], ['4115', 'Vacaciones por pagar'],
  ['415', 'Beneficios sociales de los trabajadores por pagar'], ['4151', 'Compensación por tiempo de servicio'],
  ['42', 'Cuentas por pagar comerciales – terceros'],
  ['421', 'Facturas, boletas y otros comprobantes por pagar'], ['4211', 'No emitidas'], ['4212', 'Emitidas'],
  ['422', 'Anticipos a proveedores'],
  ['423', 'Letras por pagar'],
  ['424', 'Honorarios por pagar'],
  ['43', 'Cuentas por pagar comerciales – relacionadas'],
  ['44', 'Cuentas por pagar a los accionistas (socios), directores y gerentes'],
  ['45', 'Obligaciones financieras'], ['451', 'Préstamos de instituciones financieras y otras entidades'], ['4511', 'Instituciones financieras'],
  ['46', 'Cuentas por pagar diversas – terceros'], ['469', 'Otras cuentas por pagar diversas'],
  ['47', 'Cuentas por pagar diversas – relacionadas'],
  ['48', 'Provisiones'],
  ['49', 'Pasivo diferido'],

  // ── Elemento 5: Patrimonio ──
  ['50', 'Capital'], ['501', 'Capital social'], ['5011', 'Acciones'], ['5012', 'Participaciones'],
  ['51', 'Acciones de inversión'],
  ['52', 'Capital adicional'],
  ['56', 'Resultados no realizados'],
  ['57', 'Excedente de revaluación'],
  ['58', 'Reservas'], ['582', 'Legal'],
  ['59', 'Resultados acumulados'], ['591', 'Utilidades no distribuidas'], ['592', 'Pérdidas acumuladas'],

  // ── Elemento 6: Gastos por naturaleza ──
  ['60', 'Compras'],
  ['601', 'Mercaderías'], ['6011', 'Mercaderías manufacturadas'],
  ['602', 'Materias primas'], ['603', 'Materiales auxiliares, suministros y repuestos'], ['604', 'Envases y embalajes'],
  ['609', 'Costos vinculados con las compras'], ['6091', 'Costos vinculados con las compras de mercaderías'], ['60911', 'Transporte'], ['60912', 'Seguros'],
  ['61', 'Variación de inventarios'],
  ['611', 'Mercaderías'], ['6111', 'Mercaderías manufacturadas'],
  ['612', 'Materias primas'], ['613', 'Materiales auxiliares, suministros y repuestos'],
  ['62', 'Gastos de personal, directores y gerentes'],
  ['621', 'Remuneraciones'], ['6211', 'Sueldos y salarios'], ['6214', 'Gratificaciones'], ['6215', 'Vacaciones'],
  ['627', 'Seguridad, previsión social y otras contribuciones'], ['6271', 'Régimen de prestaciones de salud'],
  ['629', 'Beneficios sociales de los trabajadores'], ['6291', 'Compensación por tiempo de servicio'],
  ['63', 'Gastos de servicios prestados por terceros'],
  ['631', 'Transporte, correos y gastos de viaje'], ['6311', 'Transporte'], ['6312', 'Correos'],
  ['632', 'Asesoría y consultoría'], ['6321', 'Administrativa'], ['6322', 'Legal y tributaria'], ['6323', 'Auditoría y contable'],
  ['634', 'Mantenimiento y reparaciones'],
  ['635', 'Alquileres'],
  ['636', 'Servicios básicos'], ['6361', 'Energía eléctrica'], ['6363', 'Agua'], ['6364', 'Teléfono'], ['6365', 'Internet'],
  ['637', 'Publicidad, publicaciones, relaciones públicas'],
  ['639', 'Otros servicios prestados por terceros'],
  ['64', 'Gastos por tributos'], ['641', 'Gobierno central'], ['643', 'Gobierno local'],
  ['65', 'Otros gastos de gestión'], ['651', 'Seguros'], ['656', 'Suministros'], ['659', 'Otros gastos de gestión'],
  ['66', 'Pérdida por medición de activos no financieros al valor razonable'],
  ['67', 'Gastos financieros'], ['671', 'Gastos en operaciones de endeudamiento y otros'], ['673', 'Intereses por préstamos y otras obligaciones'],
  ['675', 'Descuentos concedidos por pronto pago'], ['676', 'Diferencia de cambio'],
  ['68', 'Valuación y deterioro de activos y provisiones'], ['681', 'Depreciación'], ['684', 'Valuación de activos'], ['686', 'Provisiones'],
  ['69', 'Costo de ventas'], ['691', 'Mercaderías'], ['6911', 'Mercaderías manufacturadas'], ['69111', 'Terceros'],

  // ── Elemento 7: Ingresos ──
  ['70', 'Ventas'],
  ['701', 'Mercaderías'], ['7011', 'Mercaderías manufacturadas'], ['70111', 'Terceros'],
  ['702', 'Productos terminados'],
  ['704', 'Prestación de servicios'], ['7041', 'Terceros'],
  ['709', 'Devoluciones sobre ventas'], ['7091', 'Mercaderías – terceros'],
  ['73', 'Descuentos, rebajas y bonificaciones obtenidos'], ['731', 'Descuentos, rebajas y bonificaciones obtenidos'],
  ['74', 'Descuentos, rebajas y bonificaciones concedidos'], ['741', 'Descuentos, rebajas y bonificaciones concedidos'],
  ['75', 'Otros ingresos de gestión'], ['759', 'Otros ingresos de gestión'],
  ['76', 'Ganancia por medición de activos no financieros al valor razonable'],
  ['77', 'Ingresos financieros'], ['772', 'Rendimientos ganados'], ['773', 'Descuentos obtenidos por pronto pago'], ['776', 'Diferencia en cambio'],
  ['78', 'Cargas cubiertas por provisiones'],
  ['79', 'Cargas imputables a cuentas de costos y gastos'], ['791', 'Cargas imputables a cuentas de costos y gastos'],

  // ── Elemento 8: Saldos intermediarios de gestión y determinación del resultado ──
  ['80', 'Margen comercial'],
  ['81', 'Producción del ejercicio'],
  ['82', 'Valor agregado'],
  ['83', 'Excedente bruto (insuficiencia bruta) de explotación'],
  ['84', 'Resultado de explotación'],
  ['85', 'Resultado antes de participaciones e impuestos'],
  ['88', 'Impuesto a la renta'], ['881', 'Impuesto a la renta – corriente'], ['882', 'Impuesto a la renta – diferido'],
  ['89', 'Determinación del resultado del ejercicio'], ['891', 'Utilidad'], ['892', 'Pérdida'],

  // ── Elemento 9: Contabilidad analítica de explotación (a definir por la empresa) ──
  ['92', 'Costo de producción'],
  ['94', 'Gastos administrativos'],
  ['95', 'Gastos de ventas'],
  ['97', 'Gastos financieros'],
];

/** Cuentas de destino (amarre) de las cuentas de gasto: debe → elemento 9, haber → 79 */
export const DESTINOS_BASE = {
  62: ['94', '791'], 63: ['94', '791'], 64: ['94', '791'], 65: ['94', '791'], 68: ['94', '791'],
  67: ['97', '791'],
};

/**
 * Cuentas por operación: de dónde sale cada lado de los asientos automáticos (fase 3B).
 * [clave, grupo, nombre, código sugerido]
 */
export const CUENTAS_OPERACION = [
  ['cxcFacturas', 'Ventas', 'Cuentas por cobrar (facturas y boletas emitidas)', '1212'],
  ['ventasMercaderias', 'Ventas', 'Ventas de mercaderías', '70111'],
  ['ventasServicios', 'Ventas', 'Ventas de servicios', '7041'],
  ['devolucionesVentas', 'Ventas', 'Devoluciones sobre ventas (notas de crédito)', '7091'],
  ['descuentosConcedidos', 'Ventas', 'Descuentos concedidos', '741'],
  ['igvVentas', 'Tributos', 'IGV de las ventas', '40111'],
  ['igvCompras', 'Tributos', 'IGV de las compras (crédito fiscal)', '40111'],
  ['retencionIgv', 'Tributos', 'Retenciones de IGV sufridas', '40114'],
  ['cxpFacturas', 'Compras', 'Cuentas por pagar (facturas recibidas)', '4212'],
  ['comprasMercaderias', 'Compras', 'Compras de mercaderías', '6011'],
  ['caja', 'Caja y bancos', 'Caja (cobros en efectivo)', '1011'],
  ['bancos', 'Caja y bancos', 'Bancos (tarjetas, transferencias, billeteras)', '1041'],
  ['detracciones', 'Caja y bancos', 'Cuenta de detracciones (Banco de la Nación)', '1071'],
  ['mercaderias', 'Inventarios', 'Mercaderías (inventario)', '20111'],
  ['variacionMercaderias', 'Inventarios', 'Variación de inventarios de mercaderías', '6111'],
  ['costoVentas', 'Inventarios', 'Costo de ventas de mercaderías', '69111'],
];
export const CLAVES_OPERACION = CUENTAS_OPERACION.map(([clave]) => clave);
