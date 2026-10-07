-- CreateEnum
CREATE TYPE "ModoSire" AS ENUM ('SIMULADO', 'SUNAT');

-- CreateEnum
CREATE TYPE "EstadoRegistroSire" AS ENUM ('PENDIENTE', 'PROPUESTA', 'CON_DIFERENCIAS', 'CONCILIADO', 'GENERADO');

-- AlterTable
ALTER TABLE "empresas" ADD COLUMN     "buen_contribuyente" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "planes" ALTER COLUMN "modulos" SET DEFAULT ARRAY['inventario', 'pos', 'cxc', 'facturacion', 'sire']::TEXT[];

-- CreateTable
CREATE TABLE "config_sire" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "empresa_id" UUID NOT NULL,
    "modo" "ModoSire" NOT NULL DEFAULT 'SIMULADO',
    "client_id" TEXT,
    "client_secret_cifrado" TEXT,
    "usuario_sol" TEXT,
    "clave_sol_cifrada" TEXT,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "ultima_conexion" TIMESTAMP(3),
    "ultimo_error" TEXT,
    "creado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizado_en" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "config_sire_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "periodos_sire" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "empresa_id" UUID NOT NULL,
    "periodo" CHAR(6) NOT NULL,
    "estado_rvie" "EstadoRegistroSire" NOT NULL DEFAULT 'PENDIENTE',
    "estado_rce" "EstadoRegistroSire" NOT NULL DEFAULT 'PENDIENTE',
    "sunat_rvie" TEXT,
    "sunat_rce" TEXT,
    "sincronizado_en" TIMESTAMP(3),
    "creado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizado_en" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "periodos_sire_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cronograma_sunat" (
    "id" UUID NOT NULL,
    "periodo" CHAR(6) NOT NULL,
    "grupo" VARCHAR(2) NOT NULL,
    "vencimiento" DATE NOT NULL,
    "actualizado_en" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cronograma_sunat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "config_sire_empresa_id_key" ON "config_sire"("empresa_id");

-- CreateIndex
CREATE INDEX "config_sire_tenant_id_idx" ON "config_sire"("tenant_id");

-- CreateIndex
CREATE INDEX "periodos_sire_tenant_id_idx" ON "periodos_sire"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "periodos_sire_empresa_id_periodo_key" ON "periodos_sire"("empresa_id", "periodo");

-- CreateIndex
CREATE UNIQUE INDEX "cronograma_sunat_periodo_grupo_key" ON "cronograma_sunat"("periodo", "grupo");

-- AddForeignKey
ALTER TABLE "config_sire" ADD CONSTRAINT "config_sire_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "periodos_sire" ADD CONSTRAINT "periodos_sire_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- Seguridad: RLS por estudio y permisos del rol de aplicación
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE config_sire ENABLE ROW LEVEL SECURITY;
CREATE POLICY aislamiento_tenant ON config_sire
  USING (tenant_id = app_tenant_actual()) WITH CHECK (tenant_id = app_tenant_actual());
ALTER TABLE periodos_sire ENABLE ROW LEVEL SECURITY;
CREATE POLICY aislamiento_tenant ON periodos_sire
  USING (tenant_id = app_tenant_actual()) WITH CHECK (tenant_id = app_tenant_actual());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kardex_app') THEN
    GRANT SELECT, INSERT, UPDATE ON config_sire, periodos_sire TO kardex_app;
    REVOKE DELETE, TRUNCATE ON config_sire, periodos_sire FROM kardex_app;
    -- El cronograma es global: la app solo lo lee; lo mantiene la plataforma
    GRANT SELECT ON cronograma_sunat TO kardex_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON cronograma_sunat FROM kardex_app;
  END IF;
END $$;

ALTER TABLE periodos_sire ADD CONSTRAINT periodo_sire_formato CHECK (periodo ~ '^[0-9]{4}(0[1-9]|1[0-2])$');
ALTER TABLE cronograma_sunat ADD CONSTRAINT cronograma_formato
  CHECK (periodo ~ '^[0-9]{4}(0[1-9]|1[0-2])$' AND grupo ~ '^([0-9]|BC)$');

-- Módulo nuevo: SIRE
ALTER TABLE planes DROP CONSTRAINT plan_modulos_validos;
ALTER TABLE planes ADD CONSTRAINT plan_modulos_validos
  CHECK (modulos <@ ARRAY['inventario', 'pos', 'cxc', 'facturacion', 'sire']::text[]);
ALTER TABLE tenants DROP CONSTRAINT tenant_modulos_validos;
ALTER TABLE tenants ADD CONSTRAINT tenant_modulos_validos
  CHECK (modulos_adicionales <@ ARRAY['inventario', 'pos', 'cxc', 'facturacion', 'sire']::text[]);
