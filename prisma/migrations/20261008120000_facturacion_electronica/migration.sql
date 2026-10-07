-- CreateEnum
CREATE TYPE "ProveedorCpe" AS ENUM ('SIMULADO', 'NUBEFACT');

-- CreateEnum
CREATE TYPE "AmbienteCpe" AS ENUM ('PRUEBAS', 'PRODUCCION');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "EstadoSunat" ADD VALUE 'ENVIADO';
ALTER TYPE "EstadoSunat" ADD VALUE 'ACEPTADO';
ALTER TYPE "EstadoSunat" ADD VALUE 'OBSERVADO';
ALTER TYPE "EstadoSunat" ADD VALUE 'RECHAZADO';
ALTER TYPE "EstadoSunat" ADD VALUE 'ANULADO';

-- AlterTable
ALTER TABLE "comprobantes" ADD COLUMN     "baja_estado" TEXT,
ADD COLUMN     "baja_mensaje" TEXT,
ADD COLUMN     "baja_ticket" TEXT,
ADD COLUMN     "sunat_cdr" TEXT,
ADD COLUMN     "sunat_codigo" TEXT,
ADD COLUMN     "sunat_descripcion" TEXT,
ADD COLUMN     "sunat_enviado_en" TIMESTAMP(3),
ADD COLUMN     "sunat_hash" TEXT,
ADD COLUMN     "sunat_intentos" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "sunat_pdf" TEXT,
ADD COLUMN     "sunat_qr" TEXT,
ADD COLUMN     "sunat_ultimo_error" TEXT,
ADD COLUMN     "sunat_xml" TEXT;

-- AlterTable
ALTER TABLE "planes" ADD COLUMN     "modulos" TEXT[] DEFAULT ARRAY['inventario', 'pos', 'cxc', 'facturacion']::TEXT[];

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "modulos_adicionales" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "config_facturacion" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "empresa_id" UUID NOT NULL,
    "proveedor" "ProveedorCpe" NOT NULL DEFAULT 'SIMULADO',
    "ambiente" "AmbienteCpe" NOT NULL DEFAULT 'PRUEBAS',
    "url" TEXT,
    "token_cifrado" TEXT,
    "envio_automatico" BOOLEAN NOT NULL DEFAULT true,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "creado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizado_en" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "config_facturacion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "config_facturacion_empresa_id_key" ON "config_facturacion"("empresa_id");

-- CreateIndex
CREATE INDEX "config_facturacion_tenant_id_idx" ON "config_facturacion"("tenant_id");

-- AddForeignKey
ALTER TABLE "config_facturacion" ADD CONSTRAINT "config_facturacion_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- Seguridad: RLS por estudio y permisos del rol de aplicación
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE config_facturacion ENABLE ROW LEVEL SECURITY;
CREATE POLICY aislamiento_tenant ON config_facturacion
  USING (tenant_id = app_tenant_actual()) WITH CHECK (tenant_id = app_tenant_actual());
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kardex_app') THEN
    GRANT SELECT, INSERT, UPDATE ON config_facturacion TO kardex_app;
    REVOKE DELETE, TRUNCATE ON config_facturacion FROM kardex_app;
  END IF;
END $$;

-- Módulos válidos
ALTER TABLE planes ADD CONSTRAINT plan_modulos_validos
  CHECK (modulos <@ ARRAY['inventario', 'pos', 'cxc', 'facturacion']::text[]);
ALTER TABLE tenants ADD CONSTRAINT tenant_modulos_validos
  CHECK (modulos_adicionales <@ ARRAY['inventario', 'pos', 'cxc', 'facturacion']::text[]);
