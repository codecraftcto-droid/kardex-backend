-- AlterEnum
ALTER TYPE "ProveedorCpe" ADD VALUE 'SUNAT_DIRECTO';

-- AlterTable
ALTER TABLE "config_facturacion" ADD COLUMN     "certificado_cifrado" TEXT,
ADD COLUMN     "certificado_titular" TEXT,
ADD COLUMN     "certificado_vence" TIMESTAMP(3),
ADD COLUMN     "gre_client_id" TEXT,
ADD COLUMN     "gre_client_secret_cifrado" TEXT,
ADD COLUMN     "sol_clave_cifrada" TEXT,
ADD COLUMN     "sol_usuario" TEXT;

-- AlterTable
ALTER TABLE "guias_remision" ADD COLUMN     "sunat_ticket" TEXT;

-- CreateTable
CREATE TABLE "archivos_sunat" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "empresa_id" UUID NOT NULL,
    "comprobante_id" UUID,
    "guia_id" UUID,
    "tipo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "contenido" BYTEA NOT NULL,
    "creado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "archivos_sunat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "archivos_sunat_tenant_id_idx" ON "archivos_sunat"("tenant_id");

-- CreateIndex
CREATE INDEX "archivos_sunat_comprobante_id_idx" ON "archivos_sunat"("comprobante_id");

-- CreateIndex
CREATE INDEX "archivos_sunat_guia_id_idx" ON "archivos_sunat"("guia_id");

-- Archivos de SUNAT: solo se agregan (constancia); nunca se modifican ni borran desde la app
ALTER TABLE "archivos_sunat" ADD CONSTRAINT "archivos_sunat_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "archivos_sunat" ADD CONSTRAINT "archivos_sunat_comprobante_id_fkey" FOREIGN KEY ("comprobante_id") REFERENCES "comprobantes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "archivos_sunat" ADD CONSTRAINT "archivos_sunat_guia_id_fkey" FOREIGN KEY ("guia_id") REFERENCES "guias_remision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "archivos_sunat" ADD CONSTRAINT "archivos_sunat_tipo_check" CHECK (tipo IN ('XML', 'CDR', 'XML_BAJA', 'CDR_BAJA'));
ALTER TABLE "archivos_sunat" ADD CONSTRAINT "archivos_sunat_origen_check" CHECK (num_nonnulls(comprobante_id, guia_id) = 1);

ALTER TABLE archivos_sunat ENABLE ROW LEVEL SECURITY;
CREATE POLICY aislamiento_tenant ON archivos_sunat
  USING (tenant_id = app_tenant_actual()) WITH CHECK (tenant_id = app_tenant_actual());
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kardex_app') THEN
    GRANT SELECT, INSERT ON archivos_sunat TO kardex_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON archivos_sunat FROM kardex_app;
  END IF;
END $$;
