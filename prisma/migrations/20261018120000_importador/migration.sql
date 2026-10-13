-- CreateEnum
CREATE TYPE "TipoImportacion" AS ENUM ('CLIENTES', 'PRODUCTOS', 'INVENTARIO_INICIAL', 'ASIENTO_APERTURA');

-- CreateEnum
CREATE TYPE "EstadoImportacion" AS ENUM ('VALIDADA', 'APLICADA', 'DESCARTADA');

-- AlterEnum
ALTER TYPE "MotivoMovimiento" ADD VALUE 'SALDO_INICIAL';

-- CreateTable
CREATE TABLE "importaciones" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "empresa_id" UUID NOT NULL,
    "tipo" "TipoImportacion" NOT NULL,
    "estado" "EstadoImportacion" NOT NULL DEFAULT 'VALIDADA',
    "nombre_archivo" TEXT NOT NULL,
    "opciones" JSONB NOT NULL DEFAULT '{}',
    "filas" JSONB NOT NULL,
    "total_filas" INTEGER NOT NULL,
    "filas_validas" INTEGER NOT NULL,
    "resultado" JSONB,
    "usuario_id" UUID NOT NULL,
    "creado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "aplicado_en" TIMESTAMP(3),

    CONSTRAINT "importaciones_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "importaciones_tenant_id_idx" ON "importaciones"("tenant_id");

-- CreateIndex
CREATE INDEX "importaciones_empresa_id_creado_en_idx" ON "importaciones"("empresa_id", "creado_en");

-- AddForeignKey
ALTER TABLE "importaciones" ADD CONSTRAINT "importaciones_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE importaciones ENABLE ROW LEVEL SECURITY;
CREATE POLICY aislamiento_tenant ON importaciones
  USING (tenant_id = app_tenant_actual()) WITH CHECK (tenant_id = app_tenant_actual());
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kardex_app') THEN
    GRANT SELECT, INSERT, UPDATE ON importaciones TO kardex_app;
    REVOKE DELETE, TRUNCATE ON importaciones FROM kardex_app;
  END IF;
END $$;
