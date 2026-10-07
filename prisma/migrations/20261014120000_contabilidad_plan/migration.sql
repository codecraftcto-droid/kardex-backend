-- CreateEnum
CREATE TYPE "NaturalezaCuenta" AS ENUM ('DEUDORA', 'ACREEDORA');

-- AlterTable
ALTER TABLE "planes" ALTER COLUMN "modulos" SET DEFAULT ARRAY['inventario', 'pos', 'cxc', 'facturacion', 'sire', 'contabilidad']::TEXT[];

-- CreateTable
CREATE TABLE "cuentas_contables" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "empresa_id" UUID NOT NULL,
    "codigo" VARCHAR(10) NOT NULL,
    "nombre" TEXT NOT NULL,
    "naturaleza" "NaturalezaCuenta" NOT NULL,
    "pide_tercero" BOOLEAN NOT NULL DEFAULT false,
    "destino_debe" VARCHAR(10),
    "destino_haber" VARCHAR(10),
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "creado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizado_en" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cuentas_contables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "config_contable" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "empresa_id" UUID NOT NULL,
    "cuentas" JSONB NOT NULL DEFAULT '{}',
    "actualizado_en" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "config_contable_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cuentas_contables_tenant_id_idx" ON "cuentas_contables"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "cuentas_contables_empresa_id_codigo_key" ON "cuentas_contables"("empresa_id", "codigo");

-- CreateIndex
CREATE UNIQUE INDEX "config_contable_empresa_id_key" ON "config_contable"("empresa_id");

-- CreateIndex
CREATE INDEX "config_contable_tenant_id_idx" ON "config_contable"("tenant_id");

-- AddForeignKey
ALTER TABLE "cuentas_contables" ADD CONSTRAINT "cuentas_contables_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "config_contable" ADD CONSTRAINT "config_contable_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- Seguridad: RLS por estudio. Las cuentas se pueden eliminar (si no tienen hijas ni uso).
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE cuentas_contables ENABLE ROW LEVEL SECURITY;
CREATE POLICY aislamiento_tenant ON cuentas_contables
  USING (tenant_id = app_tenant_actual()) WITH CHECK (tenant_id = app_tenant_actual());
ALTER TABLE config_contable ENABLE ROW LEVEL SECURITY;
CREATE POLICY aislamiento_tenant ON config_contable
  USING (tenant_id = app_tenant_actual()) WITH CHECK (tenant_id = app_tenant_actual());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kardex_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON cuentas_contables TO kardex_app;
    GRANT SELECT, INSERT, UPDATE ON config_contable TO kardex_app;
    REVOKE TRUNCATE ON cuentas_contables, config_contable FROM kardex_app;
    REVOKE DELETE ON config_contable FROM kardex_app;
  END IF;
END $$;

ALTER TABLE cuentas_contables ADD CONSTRAINT cuenta_codigo_valido CHECK (codigo ~ '^[1-9][0-9]{1,9}$');
ALTER TABLE cuentas_contables ADD CONSTRAINT cuenta_destinos_validos
  CHECK ((destino_debe IS NULL OR destino_debe ~ '^9[0-9]{1,9}$') AND (destino_haber IS NULL OR destino_haber ~ '^79[0-9]{0,8}$'));

-- Módulo nuevo: Contabilidad
ALTER TABLE planes DROP CONSTRAINT plan_modulos_validos;
ALTER TABLE planes ADD CONSTRAINT plan_modulos_validos
  CHECK (modulos <@ ARRAY['inventario', 'pos', 'cxc', 'facturacion', 'sire', 'contabilidad']::text[]);
ALTER TABLE tenants DROP CONSTRAINT tenant_modulos_validos;
ALTER TABLE tenants ADD CONSTRAINT tenant_modulos_validos
  CHECK (modulos_adicionales <@ ARRAY['inventario', 'pos', 'cxc', 'facturacion', 'sire', 'contabilidad']::text[]);
