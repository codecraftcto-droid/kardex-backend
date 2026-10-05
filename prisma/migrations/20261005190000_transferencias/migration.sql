-- CreateEnum
CREATE TYPE "EstadoTransferencia" AS ENUM ('SOLICITADA', 'APROBADA', 'RECHAZADA', 'DESPACHADA', 'RECIBIDA', 'CANCELADA');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MotivoMovimiento" ADD VALUE 'TRANSFERENCIA_SALIDA';
ALTER TYPE "MotivoMovimiento" ADD VALUE 'TRANSFERENCIA_ENTRADA';

-- AlterTable
-- Conserva los correlativos existentes: conversión de enum a texto (no DROP/ADD)
ALTER TABLE "correlativos" ALTER COLUMN "tipo" TYPE TEXT USING "tipo"::text;

-- AlterTable
ALTER TABLE "movimientos" ADD COLUMN     "transferencia_id" UUID;

-- CreateTable
CREATE TABLE "transferencias" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "empresa_id" UUID NOT NULL,
    "numero" TEXT NOT NULL,
    "estado" "EstadoTransferencia" NOT NULL DEFAULT 'SOLICITADA',
    "origen_almacen_id" UUID NOT NULL,
    "origen_sede_id" UUID NOT NULL,
    "destino_almacen_id" UUID NOT NULL,
    "destino_sede_id" UUID NOT NULL,
    "observacion" TEXT,
    "solicitado_por_id" UUID NOT NULL,
    "solicitado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "aprobado_por_id" UUID,
    "aprobado_en" TIMESTAMP(3),
    "rechazado_por_id" UUID,
    "rechazado_en" TIMESTAMP(3),
    "despachado_por_id" UUID,
    "despachado_en" TIMESTAMP(3),
    "recibido_por_id" UUID,
    "recibido_en" TIMESTAMP(3),
    "cancelado_por_id" UUID,
    "cancelado_en" TIMESTAMP(3),
    "motivo_cierre" TEXT,
    "actualizado_en" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transferencias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transferencia_detalles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "transferencia_id" UUID NOT NULL,
    "producto_id" UUID NOT NULL,
    "cantidad_solicitada" DECIMAL(18,4) NOT NULL,
    "cantidad_despachada" DECIMAL(18,4),
    "cantidad_recibida" DECIMAL(18,4),
    "costo_unitario" DECIMAL(18,6),

    CONSTRAINT "transferencia_detalles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "transferencias_tenant_id_idx" ON "transferencias"("tenant_id");

-- CreateIndex
CREATE INDEX "transferencias_origen_almacen_id_estado_idx" ON "transferencias"("origen_almacen_id", "estado");

-- CreateIndex
CREATE INDEX "transferencias_destino_almacen_id_estado_idx" ON "transferencias"("destino_almacen_id", "estado");

-- CreateIndex
CREATE UNIQUE INDEX "transferencias_empresa_id_numero_key" ON "transferencias"("empresa_id", "numero");

-- CreateIndex
CREATE INDEX "transferencia_detalles_tenant_id_idx" ON "transferencia_detalles"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "transferencia_detalles_transferencia_id_producto_id_key" ON "transferencia_detalles"("transferencia_id", "producto_id");

-- AddForeignKey
ALTER TABLE "movimientos" ADD CONSTRAINT "movimientos_transferencia_id_fkey" FOREIGN KEY ("transferencia_id") REFERENCES "transferencias"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transferencias" ADD CONSTRAINT "transferencias_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transferencias" ADD CONSTRAINT "transferencias_origen_almacen_id_fkey" FOREIGN KEY ("origen_almacen_id") REFERENCES "almacenes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transferencias" ADD CONSTRAINT "transferencias_destino_almacen_id_fkey" FOREIGN KEY ("destino_almacen_id") REFERENCES "almacenes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transferencias" ADD CONSTRAINT "transferencias_solicitado_por_id_fkey" FOREIGN KEY ("solicitado_por_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transferencia_detalles" ADD CONSTRAINT "transferencia_detalles_transferencia_id_fkey" FOREIGN KEY ("transferencia_id") REFERENCES "transferencias"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transferencia_detalles" ADD CONSTRAINT "transferencia_detalles_producto_id_fkey" FOREIGN KEY ("producto_id") REFERENCES "productos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ═══════════════════════════════════════════════════════════════════
-- Seguridad Fase 3: RLS y permisos del rol de aplicación
-- ═══════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['transferencias', 'transferencia_detalles'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY aislamiento_tenant ON %I USING (tenant_id = app_tenant_actual()) WITH CHECK (tenant_id = app_tenant_actual())',
      t
    );
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kardex_app') THEN
    GRANT SELECT, INSERT, UPDATE ON transferencias, transferencia_detalles TO kardex_app;
    REVOKE DELETE, TRUNCATE ON transferencias, transferencia_detalles FROM kardex_app;
  END IF;
END $$;

ALTER TABLE transferencias ADD CONSTRAINT transferencia_almacenes_distintos CHECK (origen_almacen_id <> destino_almacen_id);
ALTER TABLE transferencia_detalles ADD CONSTRAINT transferencia_cantidades CHECK (
  cantidad_solicitada > 0
  AND (cantidad_despachada IS NULL OR cantidad_despachada >= 0)
  AND (cantidad_recibida IS NULL OR (cantidad_recibida >= 0 AND cantidad_recibida <= cantidad_despachada))
);
