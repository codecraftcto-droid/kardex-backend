-- CreateEnum
CREATE TYPE "RegimenTributario" AS ENUM ('GENERAL', 'MYPE', 'ESPECIAL', 'NRUS');

-- AlterTable
ALTER TABLE "empresas" ADD COLUMN     "regimen_tributario" "RegimenTributario" NOT NULL DEFAULT 'GENERAL';

-- CreateTable
CREATE TABLE "declaraciones_mensuales" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "empresa_id" UUID NOT NULL,
    "periodo" CHAR(6) NOT NULL,
    "numero_orden" TEXT NOT NULL,
    "fecha_presentacion" DATE NOT NULL,
    "datos" JSONB NOT NULL,
    "igv_pagado" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "renta_pagada" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "saldo_favor_siguiente" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "usuario_id" UUID NOT NULL,
    "creado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizado_en" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "declaraciones_mensuales_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "declaraciones_mensuales_tenant_id_idx" ON "declaraciones_mensuales"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "declaraciones_mensuales_empresa_id_periodo_key" ON "declaraciones_mensuales"("empresa_id", "periodo");

-- AddForeignKey
ALTER TABLE "declaraciones_mensuales" ADD CONSTRAINT "declaraciones_mensuales_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE declaraciones_mensuales ENABLE ROW LEVEL SECURITY;
CREATE POLICY aislamiento_tenant ON declaraciones_mensuales
  USING (tenant_id = app_tenant_actual()) WITH CHECK (tenant_id = app_tenant_actual());
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kardex_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON declaraciones_mensuales TO kardex_app;
    REVOKE TRUNCATE ON declaraciones_mensuales FROM kardex_app;
  END IF;
END $$;
ALTER TABLE declaraciones_mensuales ADD CONSTRAINT declaracion_periodo_formato CHECK (periodo ~ '^[0-9]{4}(0[1-9]|1[0-2])$');
