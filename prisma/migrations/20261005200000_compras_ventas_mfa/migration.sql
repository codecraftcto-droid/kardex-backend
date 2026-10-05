-- CreateEnum
CREATE TYPE "TipoDocumentoComercial" AS ENUM ('COMPRA', 'VENTA');

-- CreateEnum
CREATE TYPE "EstadoDocumento" AS ENUM ('BORRADOR', 'CONFIRMADO', 'ANULADO');

-- CreateEnum
CREATE TYPE "Moneda" AS ENUM ('PEN', 'USD');

-- CreateTable
CREATE TABLE "documentos_comerciales" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "empresa_id" UUID NOT NULL,
    "sede_id" UUID NOT NULL,
    "almacen_id" UUID NOT NULL,
    "tipo" "TipoDocumentoComercial" NOT NULL,
    "estado" "EstadoDocumento" NOT NULL DEFAULT 'BORRADOR',
    "tercero_documento" TEXT NOT NULL,
    "tercero_nombre" TEXT NOT NULL,
    "comprobante_tipo" TEXT NOT NULL,
    "serie" TEXT NOT NULL,
    "numero" TEXT NOT NULL,
    "fecha_emision" DATE NOT NULL,
    "moneda" "Moneda" NOT NULL DEFAULT 'PEN',
    "tipo_cambio" DECIMAL(10,4) NOT NULL DEFAULT 1,
    "observacion" TEXT,
    "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "igv" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "creado_por_id" UUID NOT NULL,
    "confirmado_por_id" UUID,
    "confirmado_en" TIMESTAMP(3),
    "anulado_por_id" UUID,
    "anulado_en" TIMESTAMP(3),
    "motivo_anulacion" TEXT,
    "movimiento_id" UUID,
    "movimiento_anulacion_id" UUID,
    "creado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizado_en" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "documentos_comerciales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documento_comercial_detalles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "documento_id" UUID NOT NULL,
    "producto_id" UUID NOT NULL,
    "cantidad" DECIMAL(18,4) NOT NULL,
    "valor_unitario" DECIMAL(18,6) NOT NULL,
    "afecto_igv" BOOLEAN NOT NULL DEFAULT true,
    "subtotal" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "documento_comercial_detalles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mfa_codigos_recuperacion" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "codigo_hash" TEXT NOT NULL,
    "usado_en" TIMESTAMP(3),

    CONSTRAINT "mfa_codigos_recuperacion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "documentos_comerciales_movimiento_id_key" ON "documentos_comerciales"("movimiento_id");

-- CreateIndex
CREATE INDEX "documentos_comerciales_tenant_id_idx" ON "documentos_comerciales"("tenant_id");

-- CreateIndex
CREATE INDEX "documentos_comerciales_empresa_id_tipo_fecha_emision_idx" ON "documentos_comerciales"("empresa_id", "tipo", "fecha_emision");

-- CreateIndex
CREATE UNIQUE INDEX "documentos_comerciales_empresa_id_tipo_tercero_documento_co_key" ON "documentos_comerciales"("empresa_id", "tipo", "tercero_documento", "comprobante_tipo", "serie", "numero");

-- CreateIndex
CREATE INDEX "documento_comercial_detalles_tenant_id_idx" ON "documento_comercial_detalles"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "documento_comercial_detalles_documento_id_producto_id_key" ON "documento_comercial_detalles"("documento_id", "producto_id");

-- CreateIndex
CREATE INDEX "mfa_codigos_recuperacion_usuario_id_idx" ON "mfa_codigos_recuperacion"("usuario_id");

-- CreateIndex
CREATE INDEX "mfa_codigos_recuperacion_tenant_id_idx" ON "mfa_codigos_recuperacion"("tenant_id");

-- AddForeignKey
ALTER TABLE "documentos_comerciales" ADD CONSTRAINT "documentos_comerciales_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documentos_comerciales" ADD CONSTRAINT "documentos_comerciales_almacen_id_fkey" FOREIGN KEY ("almacen_id") REFERENCES "almacenes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documentos_comerciales" ADD CONSTRAINT "documentos_comerciales_movimiento_id_fkey" FOREIGN KEY ("movimiento_id") REFERENCES "movimientos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documento_comercial_detalles" ADD CONSTRAINT "documento_comercial_detalles_documento_id_fkey" FOREIGN KEY ("documento_id") REFERENCES "documentos_comerciales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documento_comercial_detalles" ADD CONSTRAINT "documento_comercial_detalles_producto_id_fkey" FOREIGN KEY ("producto_id") REFERENCES "productos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mfa_codigos_recuperacion" ADD CONSTRAINT "mfa_codigos_recuperacion_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ═══════════════════════════════════════════════════════════════════
-- Seguridad Fase 4: RLS y permisos del rol de aplicación
-- ═══════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['documentos_comerciales', 'documento_comercial_detalles', 'mfa_codigos_recuperacion'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY aislamiento_tenant ON %I USING (tenant_id = app_tenant_actual()) WITH CHECK (tenant_id = app_tenant_actual())',
      t
    );
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kardex_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON documentos_comerciales, documento_comercial_detalles, mfa_codigos_recuperacion TO kardex_app;
  END IF;
END $$;

ALTER TABLE documento_comercial_detalles ADD CONSTRAINT documento_detalle_valores CHECK (cantidad > 0 AND valor_unitario >= 0);
ALTER TABLE documentos_comerciales ADD CONSTRAINT documento_tipo_cambio CHECK (tipo_cambio > 0);

-- Un documento confirmado o anulado no se puede borrar (sí los borradores)
CREATE OR REPLACE FUNCTION documento_sin_borrado() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.estado <> 'BORRADOR' THEN
    RAISE EXCEPTION 'Solo se pueden eliminar documentos en borrador';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER documentos_sin_borrado BEFORE DELETE ON documentos_comerciales
  FOR EACH ROW EXECUTE FUNCTION documento_sin_borrado();
