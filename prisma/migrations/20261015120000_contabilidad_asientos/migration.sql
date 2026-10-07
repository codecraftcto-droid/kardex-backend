-- CreateEnum
CREATE TYPE "OrigenAsiento" AS ENUM ('VENTA', 'COBRO', 'NOTA_CREDITO', 'REEMBOLSO', 'COBRANZA', 'COMPRA', 'VENTA_COMERCIAL', 'COSTO_VENTA', 'MANUAL');

-- CreateTable
CREATE TABLE "asientos" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "empresa_id" UUID NOT NULL,
    "periodo" CHAR(6) NOT NULL,
    "numero" INTEGER NOT NULL,
    "fecha" DATE NOT NULL,
    "glosa" TEXT NOT NULL,
    "origen" "OrigenAsiento" NOT NULL,
    "clave" TEXT NOT NULL,
    "comprobante_id" UUID,
    "documento_id" UUID,
    "cobranza_id" UUID,
    "movimiento_id" UUID,
    "extorno_de_id" UUID,
    "total_debe" DECIMAL(16,2) NOT NULL,
    "total_haber" DECIMAL(16,2) NOT NULL,
    "usuario_id" UUID,
    "creado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asientos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asiento_lineas" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "asiento_id" UUID NOT NULL,
    "orden" INTEGER NOT NULL,
    "cuenta" VARCHAR(10) NOT NULL,
    "debe" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "haber" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "glosa" TEXT,
    "tercero_tipo" VARCHAR(2),
    "tercero_doc" TEXT,
    "tercero_nombre" TEXT,
    "doc_tipo" VARCHAR(2),
    "doc_serie" TEXT,
    "doc_numero" TEXT,

    CONSTRAINT "asiento_lineas_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "asientos_tenant_id_idx" ON "asientos"("tenant_id");

-- CreateIndex
CREATE INDEX "asientos_empresa_id_periodo_fecha_idx" ON "asientos"("empresa_id", "periodo", "fecha");

-- CreateIndex
CREATE UNIQUE INDEX "asientos_empresa_id_clave_key" ON "asientos"("empresa_id", "clave");

-- CreateIndex
CREATE UNIQUE INDEX "asientos_empresa_id_periodo_numero_key" ON "asientos"("empresa_id", "periodo", "numero");

-- CreateIndex
CREATE INDEX "asiento_lineas_tenant_id_idx" ON "asiento_lineas"("tenant_id");

-- CreateIndex
CREATE INDEX "asiento_lineas_asiento_id_idx" ON "asiento_lineas"("asiento_id");

-- AddForeignKey
ALTER TABLE "asientos" ADD CONSTRAINT "asientos_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asientos" ADD CONSTRAINT "asientos_extorno_de_id_fkey" FOREIGN KEY ("extorno_de_id") REFERENCES "asientos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asiento_lineas" ADD CONSTRAINT "asiento_lineas_asiento_id_fkey" FOREIGN KEY ("asiento_id") REFERENCES "asientos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- Seguridad: RLS por estudio. Los asientos no se modifican: se extornan o, mientras el
-- período esté abierto, se borran para regenerarlos.
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE asientos ENABLE ROW LEVEL SECURITY;
CREATE POLICY aislamiento_tenant ON asientos
  USING (tenant_id = app_tenant_actual()) WITH CHECK (tenant_id = app_tenant_actual());
ALTER TABLE asiento_lineas ENABLE ROW LEVEL SECURITY;
CREATE POLICY aislamiento_tenant ON asiento_lineas
  USING (tenant_id = app_tenant_actual()) WITH CHECK (tenant_id = app_tenant_actual());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kardex_app') THEN
    GRANT SELECT, INSERT, DELETE ON asientos, asiento_lineas TO kardex_app;
    REVOKE UPDATE, TRUNCATE ON asientos, asiento_lineas FROM kardex_app;
  END IF;
END $$;

ALTER TABLE asientos ADD CONSTRAINT asiento_cuadra CHECK (total_debe = total_haber AND total_debe > 0);
ALTER TABLE asientos ADD CONSTRAINT asiento_periodo_valido CHECK (periodo ~ '^[0-9]{4}(0[1-9]|1[0-2])$' AND to_char(fecha, 'YYYYMM') = periodo);
ALTER TABLE asiento_lineas ADD CONSTRAINT linea_un_lado
  CHECK (debe >= 0 AND haber >= 0 AND (debe > 0) <> (haber > 0));
