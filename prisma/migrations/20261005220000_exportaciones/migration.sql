-- CreateEnum
CREATE TYPE "EstadoExportacion" AS ENUM ('PENDIENTE', 'PROCESANDO', 'LISTO', 'ERROR', 'EXPIRADO');

-- CreateTable
CREATE TABLE "exportaciones_reporte" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "empresa_id" UUID NOT NULL,
    "tipo" TEXT NOT NULL,
    "formato" TEXT NOT NULL,
    "parametros" JSONB NOT NULL,
    "titulo" TEXT,
    "estado" "EstadoExportacion" NOT NULL DEFAULT 'PENDIENTE',
    "progreso" INTEGER NOT NULL DEFAULT 0,
    "filas" INTEGER,
    "nombre_archivo" TEXT,
    "ruta_archivo" TEXT,
    "tamano_bytes" INTEGER,
    "error" TEXT,
    "creado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "iniciado_en" TIMESTAMP(3),
    "terminado_en" TIMESTAMP(3),
    "expira_en" TIMESTAMP(3),

    CONSTRAINT "exportaciones_reporte_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "exportaciones_reporte_tenant_id_idx" ON "exportaciones_reporte"("tenant_id");

-- CreateIndex
CREATE INDEX "exportaciones_reporte_usuario_id_creado_en_idx" ON "exportaciones_reporte"("usuario_id", "creado_en");

-- CreateIndex
CREATE INDEX "exportaciones_reporte_estado_expira_en_idx" ON "exportaciones_reporte"("estado", "expira_en");


ALTER TABLE exportaciones_reporte ENABLE ROW LEVEL SECURITY;
CREATE POLICY aislamiento_tenant ON exportaciones_reporte
  USING (tenant_id = app_tenant_actual()) WITH CHECK (tenant_id = app_tenant_actual());
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kardex_app') THEN
    GRANT SELECT, INSERT, UPDATE ON exportaciones_reporte TO kardex_app;
  END IF;
END $$;
ALTER TABLE exportaciones_reporte ADD CONSTRAINT exportacion_progreso CHECK (progreso BETWEEN 0 AND 100);
