-- CreateEnum
CREATE TYPE "TipoMovimiento" AS ENUM ('ENTRADA', 'SALIDA');

-- CreateEnum
CREATE TYPE "MotivoMovimiento" AS ENUM ('COMPRA', 'DEVOLUCION_CLIENTE', 'AJUSTE_POSITIVO', 'VENTA', 'MERMA', 'AJUSTE_NEGATIVO', 'ANULACION');

-- CreateTable
CREATE TABLE "unidades_medida" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "unidades_medida_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categorias" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "empresa_id" UUID NOT NULL,
    "nombre" TEXT NOT NULL,

    CONSTRAINT "categorias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "productos" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "empresa_id" UUID NOT NULL,
    "categoria_id" UUID,
    "unidad_id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "codigo_barras" TEXT,
    "nombre" TEXT NOT NULL,
    "descripcion" TEXT,
    "precio_referencial" DECIMAL(14,4),
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "creado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizado_en" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "productos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stocks" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "empresa_id" UUID NOT NULL,
    "sede_id" UUID NOT NULL,
    "almacen_id" UUID NOT NULL,
    "producto_id" UUID NOT NULL,
    "cantidad" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "costo_promedio" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "valor_total" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "stock_minimo" DECIMAL(18,4),
    "stock_maximo" DECIMAL(18,4),
    "actualizado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capas_costo" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" UUID NOT NULL,
    "almacen_id" UUID NOT NULL,
    "producto_id" UUID NOT NULL,
    "detalle_id" BIGINT NOT NULL,
    "cantidad_restante" DECIMAL(18,4) NOT NULL,
    "costo_unitario" DECIMAL(18,6) NOT NULL,
    "creado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "capas_costo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "correlativos" (
    "tenant_id" UUID NOT NULL,
    "empresa_id" UUID NOT NULL,
    "tipo" "TipoMovimiento" NOT NULL,
    "ultimo" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "correlativos_pkey" PRIMARY KEY ("empresa_id","tipo")
);

-- CreateTable
CREATE TABLE "movimientos" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "empresa_id" UUID NOT NULL,
    "sede_id" UUID NOT NULL,
    "almacen_id" UUID NOT NULL,
    "numero" TEXT NOT NULL,
    "tipo" "TipoMovimiento" NOT NULL,
    "motivo" "MotivoMovimiento" NOT NULL,
    "metodo_valorizacion" "MetodoValorizacion" NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fecha_documento" DATE,
    "documento_tipo" TEXT,
    "documento_serie" TEXT,
    "documento_numero" TEXT,
    "observacion" TEXT,
    "usuario_id" UUID NOT NULL,
    "anula_id" UUID,

    CONSTRAINT "movimientos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "movimiento_detalles" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" UUID NOT NULL,
    "movimiento_id" UUID NOT NULL,
    "almacen_id" UUID NOT NULL,
    "producto_id" UUID NOT NULL,
    "cantidad" DECIMAL(18,4) NOT NULL,
    "costo_unitario" DECIMAL(18,6) NOT NULL,
    "costo_total" DECIMAL(18,4) NOT NULL,
    "saldo_cantidad" DECIMAL(18,4) NOT NULL,
    "saldo_costo_unitario" DECIMAL(18,6) NOT NULL,
    "saldo_valor" DECIMAL(18,4) NOT NULL,

    CONSTRAINT "movimiento_detalles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "unidades_medida_tenant_id_codigo_key" ON "unidades_medida"("tenant_id", "codigo");

-- CreateIndex
CREATE INDEX "categorias_tenant_id_idx" ON "categorias"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "categorias_empresa_id_nombre_key" ON "categorias"("empresa_id", "nombre");

-- CreateIndex
CREATE INDEX "productos_tenant_id_idx" ON "productos"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "productos_empresa_id_sku_key" ON "productos"("empresa_id", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "productos_empresa_id_codigo_barras_key" ON "productos"("empresa_id", "codigo_barras");

-- CreateIndex
CREATE INDEX "stocks_tenant_id_idx" ON "stocks"("tenant_id");

-- CreateIndex
CREATE INDEX "stocks_empresa_id_idx" ON "stocks"("empresa_id");

-- CreateIndex
CREATE UNIQUE INDEX "stocks_almacen_id_producto_id_key" ON "stocks"("almacen_id", "producto_id");

-- CreateIndex
CREATE UNIQUE INDEX "capas_costo_detalle_id_key" ON "capas_costo"("detalle_id");

-- CreateIndex
CREATE INDEX "capas_costo_almacen_id_producto_id_id_idx" ON "capas_costo"("almacen_id", "producto_id", "id");

-- CreateIndex
CREATE INDEX "capas_costo_tenant_id_idx" ON "capas_costo"("tenant_id");

-- CreateIndex
CREATE INDEX "correlativos_tenant_id_idx" ON "correlativos"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "movimientos_anula_id_key" ON "movimientos"("anula_id");

-- CreateIndex
CREATE INDEX "movimientos_tenant_id_idx" ON "movimientos"("tenant_id");

-- CreateIndex
CREATE INDEX "movimientos_almacen_id_fecha_idx" ON "movimientos"("almacen_id", "fecha");

-- CreateIndex
CREATE UNIQUE INDEX "movimientos_empresa_id_numero_key" ON "movimientos"("empresa_id", "numero");

-- CreateIndex
CREATE INDEX "movimiento_detalles_almacen_id_producto_id_id_idx" ON "movimiento_detalles"("almacen_id", "producto_id", "id");

-- CreateIndex
CREATE INDEX "movimiento_detalles_tenant_id_idx" ON "movimiento_detalles"("tenant_id");

-- AddForeignKey
ALTER TABLE "unidades_medida" ADD CONSTRAINT "unidades_medida_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categorias" ADD CONSTRAINT "categorias_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "productos" ADD CONSTRAINT "productos_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "productos" ADD CONSTRAINT "productos_categoria_id_fkey" FOREIGN KEY ("categoria_id") REFERENCES "categorias"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "productos" ADD CONSTRAINT "productos_unidad_id_fkey" FOREIGN KEY ("unidad_id") REFERENCES "unidades_medida"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocks" ADD CONSTRAINT "stocks_almacen_id_fkey" FOREIGN KEY ("almacen_id") REFERENCES "almacenes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocks" ADD CONSTRAINT "stocks_producto_id_fkey" FOREIGN KEY ("producto_id") REFERENCES "productos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movimientos" ADD CONSTRAINT "movimientos_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movimientos" ADD CONSTRAINT "movimientos_almacen_id_fkey" FOREIGN KEY ("almacen_id") REFERENCES "almacenes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movimientos" ADD CONSTRAINT "movimientos_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movimientos" ADD CONSTRAINT "movimientos_anula_id_fkey" FOREIGN KEY ("anula_id") REFERENCES "movimientos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movimiento_detalles" ADD CONSTRAINT "movimiento_detalles_movimiento_id_fkey" FOREIGN KEY ("movimiento_id") REFERENCES "movimientos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movimiento_detalles" ADD CONSTRAINT "movimiento_detalles_producto_id_fkey" FOREIGN KEY ("producto_id") REFERENCES "productos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- Seguridad Fase 2: RLS, permisos del rol de aplicación e inmutabilidad del kardex
-- ═══════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'unidades_medida', 'categorias', 'productos', 'stocks', 'capas_costo',
    'correlativos', 'movimientos', 'movimiento_detalles'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY aislamiento_tenant ON %I USING (tenant_id = app_tenant_actual()) WITH CHECK (tenant_id = app_tenant_actual())',
      t
    );
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kardex_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      unidades_medida, categorias, productos, stocks, capas_costo, correlativos TO kardex_app;
    -- Kardex histórico: solo lectura e inserción
    GRANT SELECT, INSERT ON movimientos, movimiento_detalles TO kardex_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON movimientos, movimiento_detalles FROM kardex_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO kardex_app;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION kardex_inmutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'El kardex es inmutable: corrija con un movimiento de anulación';
END $$;

CREATE TRIGGER movimientos_inmutables
  BEFORE UPDATE OR DELETE ON movimientos FOR EACH ROW EXECUTE FUNCTION kardex_inmutable();
CREATE TRIGGER movimientos_sin_truncate
  BEFORE TRUNCATE ON movimientos FOR EACH STATEMENT EXECUTE FUNCTION kardex_inmutable();
CREATE TRIGGER detalles_inmutables
  BEFORE UPDATE OR DELETE ON movimiento_detalles FOR EACH ROW EXECUTE FUNCTION kardex_inmutable();
CREATE TRIGGER detalles_sin_truncate
  BEFORE TRUNCATE ON movimiento_detalles FOR EACH STATEMENT EXECUTE FUNCTION kardex_inmutable();

-- Coherencia: cantidades positivas y saldos nunca negativos
ALTER TABLE movimiento_detalles ADD CONSTRAINT detalle_cantidad_positiva CHECK (cantidad > 0);
ALTER TABLE stocks ADD CONSTRAINT stock_no_negativo CHECK (cantidad >= 0 AND valor_total >= 0);
ALTER TABLE capas_costo ADD CONSTRAINT capa_no_negativa CHECK (cantidad_restante >= 0);
