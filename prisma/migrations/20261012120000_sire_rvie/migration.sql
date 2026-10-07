-- CreateEnum
CREATE TYPE "RegistroSire" AS ENUM ('RVIE', 'RCE');

-- CreateEnum
CREATE TYPE "TipoOperacionSire" AS ENUM ('PROPUESTA', 'ACEPTACION');

-- CreateEnum
CREATE TYPE "EstadoOperacionSire" AS ENUM ('PROCESANDO', 'TERMINADO', 'ERROR');

-- CreateEnum
CREATE TYPE "TipoDiferenciaSire" AS ENUM ('SOLO_SUNAT', 'SOLO_SISTEMA', 'MONTO', 'ESTADO');

-- CreateEnum
CREATE TYPE "ResolucionDiferencia" AS ENUM ('PENDIENTE', 'ACEPTADA', 'JUSTIFICADA');

-- CreateTable
CREATE TABLE "operaciones_sire" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "empresa_id" UUID NOT NULL,
    "periodo" CHAR(6) NOT NULL,
    "registro" "RegistroSire" NOT NULL,
    "tipo" "TipoOperacionSire" NOT NULL,
    "estado" "EstadoOperacionSire" NOT NULL DEFAULT 'PROCESANDO',
    "ticket" TEXT,
    "cod_proceso" TEXT,
    "intentos" INTEGER NOT NULL DEFAULT 0,
    "mensaje" TEXT,
    "constancia" TEXT,
    "usuario_id" UUID NOT NULL,
    "creado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "terminado_en" TIMESTAMP(3),

    CONSTRAINT "operaciones_sire_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "propuestas_sire" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "empresa_id" UUID NOT NULL,
    "periodo" CHAR(6) NOT NULL,
    "registro" "RegistroSire" NOT NULL,
    "operacion_id" UUID,
    "vigente" BOOLEAN NOT NULL DEFAULT true,
    "cantidad" INTEGER NOT NULL DEFAULT 0,
    "total_base" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "total_igv" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "descargada_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "propuestas_sire_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "propuestas_sire_detalle" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "propuesta_id" UUID NOT NULL,
    "tipo_cp" VARCHAR(2) NOT NULL,
    "serie" TEXT NOT NULL,
    "numero" TEXT NOT NULL,
    "fecha_emision" DATE NOT NULL,
    "doc_tipo" VARCHAR(2),
    "doc_numero" TEXT,
    "nombre" TEXT,
    "base_gravada" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "igv" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "exonerado" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "inafecto" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "otros" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "moneda" VARCHAR(3) NOT NULL DEFAULT 'PEN',
    "anulado" BOOLEAN NOT NULL DEFAULT false,
    "ref_tipo" VARCHAR(2),
    "ref_serie" TEXT,
    "ref_numero" TEXT,

    CONSTRAINT "propuestas_sire_detalle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diferencias_sire" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "propuesta_id" UUID NOT NULL,
    "tipo" "TipoDiferenciaSire" NOT NULL,
    "clave" TEXT NOT NULL,
    "tipo_cp" VARCHAR(2) NOT NULL,
    "serie" TEXT NOT NULL,
    "numero" TEXT NOT NULL,
    "fecha_emision" DATE,
    "nombre" TEXT,
    "total_sunat" DECIMAL(14,2),
    "total_sistema" DECIMAL(14,2),
    "igv_sunat" DECIMAL(14,2),
    "igv_sistema" DECIMAL(14,2),
    "comprobante_id" UUID,
    "documento_id" UUID,
    "estado_sunat_sistema" TEXT,
    "resolucion" "ResolucionDiferencia" NOT NULL DEFAULT 'PENDIENTE',
    "nota" TEXT,
    "resuelto_por_id" UUID,
    "resuelto_en" TIMESTAMP(3),

    CONSTRAINT "diferencias_sire_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "operaciones_sire_tenant_id_idx" ON "operaciones_sire"("tenant_id");

-- CreateIndex
CREATE INDEX "operaciones_sire_empresa_id_periodo_registro_idx" ON "operaciones_sire"("empresa_id", "periodo", "registro");

-- CreateIndex
CREATE UNIQUE INDEX "propuestas_sire_operacion_id_key" ON "propuestas_sire"("operacion_id");

-- CreateIndex
CREATE INDEX "propuestas_sire_tenant_id_idx" ON "propuestas_sire"("tenant_id");

-- CreateIndex
CREATE INDEX "propuestas_sire_empresa_id_periodo_registro_vigente_idx" ON "propuestas_sire"("empresa_id", "periodo", "registro", "vigente");

-- CreateIndex
CREATE INDEX "propuestas_sire_detalle_tenant_id_idx" ON "propuestas_sire_detalle"("tenant_id");

-- CreateIndex
CREATE INDEX "propuestas_sire_detalle_propuesta_id_idx" ON "propuestas_sire_detalle"("propuesta_id");

-- CreateIndex
CREATE INDEX "diferencias_sire_tenant_id_idx" ON "diferencias_sire"("tenant_id");

-- CreateIndex
CREATE INDEX "diferencias_sire_propuesta_id_resolucion_idx" ON "diferencias_sire"("propuesta_id", "resolucion");

-- AddForeignKey
ALTER TABLE "operaciones_sire" ADD CONSTRAINT "operaciones_sire_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "propuestas_sire" ADD CONSTRAINT "propuestas_sire_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "propuestas_sire" ADD CONSTRAINT "propuestas_sire_operacion_id_fkey" FOREIGN KEY ("operacion_id") REFERENCES "operaciones_sire"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "propuestas_sire_detalle" ADD CONSTRAINT "propuestas_sire_detalle_propuesta_id_fkey" FOREIGN KEY ("propuesta_id") REFERENCES "propuestas_sire"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diferencias_sire" ADD CONSTRAINT "diferencias_sire_propuesta_id_fkey" FOREIGN KEY ("propuesta_id") REFERENCES "propuestas_sire"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- Seguridad: RLS por estudio. Nada se borra: las propuestas anteriores quedan como historial.
-- ═══════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['operaciones_sire', 'propuestas_sire', 'propuestas_sire_detalle', 'diferencias_sire'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY aislamiento_tenant ON %I USING (tenant_id = app_tenant_actual()) WITH CHECK (tenant_id = app_tenant_actual())', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kardex_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO kardex_app', t);
      EXECUTE format('REVOKE DELETE, TRUNCATE ON %I FROM kardex_app', t);
    END IF;
  END LOOP;
END $$;

ALTER TABLE operaciones_sire ADD CONSTRAINT operacion_sire_periodo CHECK (periodo ~ '^[0-9]{4}(0[1-9]|1[0-2])$');
ALTER TABLE diferencias_sire ADD CONSTRAINT diferencia_justificada_con_nota
  CHECK (resolucion <> 'JUSTIFICADA' OR length(trim(coalesce(nota, ''))) >= 5);
-- Una sola propuesta vigente por empresa, período y registro
CREATE UNIQUE INDEX propuesta_sire_vigente ON propuestas_sire (empresa_id, periodo, registro) WHERE vigente;
-- Una sola operación en curso por empresa, período y registro
CREATE UNIQUE INDEX operacion_sire_en_curso ON operaciones_sire (empresa_id, periodo, registro) WHERE estado = 'PROCESANDO';
