-- CreateEnum
CREATE TYPE "TipoDocIdentidad" AS ENUM ('SIN_DOCUMENTO', 'DNI', 'CARNE_EXTRANJERIA', 'RUC', 'PASAPORTE');

-- CreateEnum
CREATE TYPE "TipoComprobante" AS ENUM ('FACTURA', 'BOLETA', 'NOTA_VENTA', 'NOTA_CREDITO');

-- CreateEnum
CREATE TYPE "EstadoComprobante" AS ENUM ('EMITIDO', 'ANULADO');

-- CreateEnum
CREATE TYPE "EstadoSunat" AS ENUM ('NO_APLICA', 'PENDIENTE');

-- CreateEnum
CREATE TYPE "MedioPago" AS ENUM ('EFECTIVO', 'TARJETA', 'YAPE', 'PLIN', 'TRANSFERENCIA', 'OTRO');

-- CreateEnum
CREATE TYPE "EstadoSesionCaja" AS ENUM ('ABIERTA', 'CERRADA');

-- AlterEnum
ALTER TYPE "TipoUsuario" ADD VALUE 'operador';

-- AlterTable
ALTER TABLE "empresas" ADD COLUMN     "nombre_comercial" TEXT;

-- AlterTable
ALTER TABLE "productos" ADD COLUMN     "afectacion_igv" TEXT NOT NULL DEFAULT '10';

-- CreateTable
CREATE TABLE "clientes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "empresa_id" UUID NOT NULL,
    "tipo_documento" "TipoDocIdentidad" NOT NULL,
    "numero_documento" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "direccion" TEXT,
    "email" TEXT,
    "telefono" TEXT,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "creado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizado_en" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clientes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cajas" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "empresa_id" UUID NOT NULL,
    "sede_id" UUID NOT NULL,
    "almacen_id" UUID NOT NULL,
    "nombre" TEXT NOT NULL,
    "serie_factura" TEXT NOT NULL,
    "serie_boleta" TEXT NOT NULL,
    "serie_nota_venta" TEXT NOT NULL,
    "serie_nota_credito_factura" TEXT NOT NULL,
    "serie_nota_credito_boleta" TEXT NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "creado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizado_en" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cajas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sesiones_caja" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "caja_id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "estado" "EstadoSesionCaja" NOT NULL DEFAULT 'ABIERTA',
    "monto_apertura" DECIMAL(14,2) NOT NULL,
    "abierta_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cerrada_en" TIMESTAMP(3),
    "efectivo_esperado" DECIMAL(14,2),
    "efectivo_declarado" DECIMAL(14,2),
    "diferencia" DECIMAL(14,2),
    "resumen" JSONB,
    "observacion" TEXT,

    CONSTRAINT "sesiones_caja_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comprobantes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "empresa_id" UUID NOT NULL,
    "sede_id" UUID NOT NULL,
    "almacen_id" UUID NOT NULL,
    "caja_id" UUID NOT NULL,
    "sesion_caja_id" UUID NOT NULL,
    "tipo" "TipoComprobante" NOT NULL,
    "serie" TEXT NOT NULL,
    "numero" INTEGER NOT NULL,
    "fecha_emision" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "moneda" TEXT NOT NULL DEFAULT 'PEN',
    "cliente_id" UUID,
    "cliente_tipo_documento" "TipoDocIdentidad" NOT NULL,
    "cliente_numero_documento" TEXT NOT NULL,
    "cliente_nombre" TEXT NOT NULL,
    "cliente_direccion" TEXT,
    "op_gravada" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "op_exonerada" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "op_inafecta" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "igv" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "descuento_total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL,
    "monto_recibido" DECIMAL(14,2),
    "vuelto" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "estado" "EstadoComprobante" NOT NULL DEFAULT 'EMITIDO',
    "estado_sunat" "EstadoSunat" NOT NULL,
    "referencia_id" UUID,
    "motivo_codigo" TEXT,
    "motivo_descripcion" TEXT,
    "movimiento_id" UUID,
    "movimiento_anulacion_id" UUID,
    "usuario_id" UUID NOT NULL,
    "anulado_por_id" UUID,
    "anulado_en" TIMESTAMP(3),
    "motivo_anulacion" TEXT,
    "observacion" TEXT,
    "creado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comprobantes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comprobante_detalles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "comprobante_id" UUID NOT NULL,
    "producto_id" UUID NOT NULL,
    "descripcion" TEXT NOT NULL,
    "unidad_codigo" TEXT NOT NULL,
    "cantidad" DECIMAL(18,4) NOT NULL,
    "precio_unitario" DECIMAL(14,4) NOT NULL,
    "valor_unitario" DECIMAL(18,6) NOT NULL,
    "descuento" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "afectacion_igv" TEXT NOT NULL,
    "valor_venta" DECIMAL(14,2) NOT NULL,
    "igv" DECIMAL(14,2) NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "comprobante_detalles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comprobante_pagos" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "comprobante_id" UUID NOT NULL,
    "medio" "MedioPago" NOT NULL,
    "monto" DECIMAL(14,2) NOT NULL,
    "referencia" TEXT,

    CONSTRAINT "comprobante_pagos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "clientes_tenant_id_idx" ON "clientes"("tenant_id");

-- CreateIndex
CREATE INDEX "clientes_empresa_id_nombre_idx" ON "clientes"("empresa_id", "nombre");

-- CreateIndex
CREATE UNIQUE INDEX "clientes_empresa_id_tipo_documento_numero_documento_key" ON "clientes"("empresa_id", "tipo_documento", "numero_documento");

-- CreateIndex
CREATE INDEX "cajas_tenant_id_idx" ON "cajas"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "cajas_empresa_id_nombre_key" ON "cajas"("empresa_id", "nombre");

-- CreateIndex
CREATE INDEX "sesiones_caja_tenant_id_idx" ON "sesiones_caja"("tenant_id");

-- CreateIndex
CREATE INDEX "sesiones_caja_caja_id_estado_idx" ON "sesiones_caja"("caja_id", "estado");

-- CreateIndex
CREATE UNIQUE INDEX "comprobantes_movimiento_id_key" ON "comprobantes"("movimiento_id");

-- CreateIndex
CREATE INDEX "comprobantes_tenant_id_idx" ON "comprobantes"("tenant_id");

-- CreateIndex
CREATE INDEX "comprobantes_empresa_id_fecha_emision_idx" ON "comprobantes"("empresa_id", "fecha_emision");

-- CreateIndex
CREATE INDEX "comprobantes_sesion_caja_id_idx" ON "comprobantes"("sesion_caja_id");

-- CreateIndex
CREATE UNIQUE INDEX "comprobantes_empresa_id_serie_numero_key" ON "comprobantes"("empresa_id", "serie", "numero");

-- CreateIndex
CREATE INDEX "comprobante_detalles_tenant_id_idx" ON "comprobante_detalles"("tenant_id");

-- CreateIndex
CREATE INDEX "comprobante_detalles_comprobante_id_idx" ON "comprobante_detalles"("comprobante_id");

-- CreateIndex
CREATE INDEX "comprobante_pagos_tenant_id_idx" ON "comprobante_pagos"("tenant_id");

-- CreateIndex
CREATE INDEX "comprobante_pagos_comprobante_id_idx" ON "comprobante_pagos"("comprobante_id");

-- AddForeignKey
ALTER TABLE "clientes" ADD CONSTRAINT "clientes_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cajas" ADD CONSTRAINT "cajas_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cajas" ADD CONSTRAINT "cajas_almacen_id_fkey" FOREIGN KEY ("almacen_id") REFERENCES "almacenes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sesiones_caja" ADD CONSTRAINT "sesiones_caja_caja_id_fkey" FOREIGN KEY ("caja_id") REFERENCES "cajas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comprobantes" ADD CONSTRAINT "comprobantes_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comprobantes" ADD CONSTRAINT "comprobantes_caja_id_fkey" FOREIGN KEY ("caja_id") REFERENCES "cajas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comprobantes" ADD CONSTRAINT "comprobantes_sesion_caja_id_fkey" FOREIGN KEY ("sesion_caja_id") REFERENCES "sesiones_caja"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comprobantes" ADD CONSTRAINT "comprobantes_cliente_id_fkey" FOREIGN KEY ("cliente_id") REFERENCES "clientes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comprobantes" ADD CONSTRAINT "comprobantes_referencia_id_fkey" FOREIGN KEY ("referencia_id") REFERENCES "comprobantes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comprobantes" ADD CONSTRAINT "comprobantes_movimiento_id_fkey" FOREIGN KEY ("movimiento_id") REFERENCES "movimientos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comprobante_detalles" ADD CONSTRAINT "comprobante_detalles_comprobante_id_fkey" FOREIGN KEY ("comprobante_id") REFERENCES "comprobantes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comprobante_detalles" ADD CONSTRAINT "comprobante_detalles_producto_id_fkey" FOREIGN KEY ("producto_id") REFERENCES "productos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comprobante_pagos" ADD CONSTRAINT "comprobante_pagos_comprobante_id_fkey" FOREIGN KEY ("comprobante_id") REFERENCES "comprobantes"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ═══════════════════════════════════════════════════════════════════
-- Seguridad: RLS por estudio y permisos del rol de aplicación
-- ═══════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['clientes', 'cajas', 'sesiones_caja', 'comprobantes', 'comprobante_detalles', 'comprobante_pagos'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY aislamiento_tenant ON %I USING (tenant_id = app_tenant_actual()) WITH CHECK (tenant_id = app_tenant_actual())',
      t
    );
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kardex_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON clientes, cajas TO kardex_app;
    GRANT SELECT, INSERT, UPDATE ON sesiones_caja, comprobantes TO kardex_app;
    -- Detalle y pagos de un comprobante: no se modifican ni se borran
    GRANT SELECT, INSERT ON comprobante_detalles, comprobante_pagos TO kardex_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON comprobante_detalles, comprobante_pagos FROM kardex_app;
    REVOKE DELETE, TRUNCATE ON comprobantes, sesiones_caja FROM kardex_app;
  END IF;
END $$;

-- Un solo turno abierto por caja
CREATE UNIQUE INDEX sesiones_caja_una_abierta ON sesiones_caja (caja_id) WHERE estado = 'ABIERTA';

-- Importes coherentes
ALTER TABLE comprobantes ADD CONSTRAINT comprobante_importes CHECK (total >= 0 AND igv >= 0 AND vuelto >= 0 AND numero > 0);
ALTER TABLE comprobante_detalles ADD CONSTRAINT comprobante_detalle_cantidad CHECK (cantidad > 0 AND precio_unitario >= 0);
ALTER TABLE productos ADD CONSTRAINT producto_afectacion_igv CHECK (afectacion_igv IN ('10', '20', '30'));

-- Los importes y la identidad de un comprobante emitido no cambian: solo su estado (anulación)
CREATE OR REPLACE FUNCTION comprobante_importes_inmutables() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.tipo, NEW.serie, NEW.numero, NEW.total, NEW.igv, NEW.op_gravada, NEW.op_exonerada, NEW.op_inafecta,
      NEW.cliente_numero_documento, NEW.cliente_nombre, NEW.fecha_emision, NEW.empresa_id)
     IS DISTINCT FROM
     (OLD.tipo, OLD.serie, OLD.numero, OLD.total, OLD.igv, OLD.op_gravada, OLD.op_exonerada, OLD.op_inafecta,
      OLD.cliente_numero_documento, OLD.cliente_nombre, OLD.fecha_emision, OLD.empresa_id) THEN
    RAISE EXCEPTION 'Un comprobante emitido no se modifica: anúlelo o emita una nota de crédito';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER comprobantes_inmutables BEFORE UPDATE ON comprobantes
  FOR EACH ROW EXECUTE FUNCTION comprobante_importes_inmutables();
