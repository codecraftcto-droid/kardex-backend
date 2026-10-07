-- CreateTable
CREATE TABLE "periodos_contables" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "empresa_id" UUID NOT NULL,
    "periodo" CHAR(6) NOT NULL,
    "cerrado" BOOLEAN NOT NULL DEFAULT false,
    "cerrado_en" TIMESTAMP(3),
    "cerrado_por_id" UUID,
    "reabierto_en" TIMESTAMP(3),
    "motivo_reapertura" TEXT,
    "actualizado_en" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "periodos_contables_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "periodos_contables_tenant_id_idx" ON "periodos_contables"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "periodos_contables_empresa_id_periodo_key" ON "periodos_contables"("empresa_id", "periodo");

-- AddForeignKey
ALTER TABLE "periodos_contables" ADD CONSTRAINT "periodos_contables_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE periodos_contables ENABLE ROW LEVEL SECURITY;
CREATE POLICY aislamiento_tenant ON periodos_contables
  USING (tenant_id = app_tenant_actual()) WITH CHECK (tenant_id = app_tenant_actual());
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kardex_app') THEN
    GRANT SELECT, INSERT, UPDATE ON periodos_contables TO kardex_app;
    REVOKE DELETE, TRUNCATE ON periodos_contables FROM kardex_app;
  END IF;
END $$;
ALTER TABLE periodos_contables ADD CONSTRAINT periodo_contable_formato CHECK (periodo ~ '^[0-9]{4}(0[1-9]|1[0-2])$');

-- Un período cerrado no admite asientos nuevos ni borrar los existentes (defensa en la base de datos)
CREATE OR REPLACE FUNCTION asiento_periodo_abierto() RETURNS trigger AS $$
DECLARE
  a asientos%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN a := OLD; ELSE a := NEW; END IF;
  IF EXISTS (SELECT 1 FROM periodos_contables p WHERE p.empresa_id = a.empresa_id AND p.periodo = a.periodo AND p.cerrado) THEN
    RAISE EXCEPTION 'El período contable % está cerrado', a.periodo USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER asiento_periodo_abierto BEFORE INSERT OR DELETE ON asientos
  FOR EACH ROW EXECUTE FUNCTION asiento_periodo_abierto();
