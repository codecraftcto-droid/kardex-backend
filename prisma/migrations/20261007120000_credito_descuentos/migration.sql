-- CreateEnum
CREATE TYPE "FormaPago" AS ENUM ('CONTADO', 'CREDITO');

-- CreateEnum
CREATE TYPE "EstadoCobranza" AS ENUM ('VIGENTE', 'ANULADA');

-- AlterTable
ALTER TABLE "cajas" ADD COLUMN     "descuento_maximo" DECIMAL(5,2) NOT NULL DEFAULT 5;

-- AlterTable
ALTER TABLE "clientes" ADD COLUMN     "credito_habilitado" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "dias_credito" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "limite_credito" DECIMAL(14,2),
ADD COLUMN     "ruc_asociado" TEXT;

-- AlterTable
ALTER TABLE "comprobantes" ADD COLUMN     "aplicado_a_saldo" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "autorizacion" TEXT,
ADD COLUMN     "autorizado_por_id" UUID,
ADD COLUMN     "descuento_global" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "forma_pago" "FormaPago" NOT NULL DEFAULT 'CONTADO',
ADD COLUMN     "monto_credito" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "saldo_pendiente" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "comprobante_cuotas" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "comprobante_id" UUID NOT NULL,
    "numero" INTEGER NOT NULL,
    "monto" DECIMAL(14,2) NOT NULL,
    "fecha_vencimiento" DATE NOT NULL,

    CONSTRAINT "comprobante_cuotas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cobranzas" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "empresa_id" UUID NOT NULL,
    "cliente_id" UUID NOT NULL,
    "comprobante_id" UUID NOT NULL,
    "sesion_caja_id" UUID,
    "numero" INTEGER NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "medio" "MedioPago" NOT NULL,
    "monto" DECIMAL(14,2) NOT NULL,
    "referencia" TEXT,
    "observacion" TEXT,
    "estado" "EstadoCobranza" NOT NULL DEFAULT 'VIGENTE',
    "usuario_id" UUID NOT NULL,
    "anulado_por_id" UUID,
    "anulado_en" TIMESTAMP(3),
    "motivo_anulacion" TEXT,

    CONSTRAINT "cobranzas_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "comprobante_cuotas_tenant_id_idx" ON "comprobante_cuotas"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "comprobante_cuotas_comprobante_id_numero_key" ON "comprobante_cuotas"("comprobante_id", "numero");

-- CreateIndex
CREATE INDEX "cobranzas_tenant_id_idx" ON "cobranzas"("tenant_id");

-- CreateIndex
CREATE INDEX "cobranzas_cliente_id_idx" ON "cobranzas"("cliente_id");

-- CreateIndex
CREATE INDEX "cobranzas_comprobante_id_idx" ON "cobranzas"("comprobante_id");

-- CreateIndex
CREATE INDEX "cobranzas_sesion_caja_id_idx" ON "cobranzas"("sesion_caja_id");

-- CreateIndex
CREATE UNIQUE INDEX "cobranzas_empresa_id_numero_key" ON "cobranzas"("empresa_id", "numero");

-- CreateIndex
CREATE INDEX "comprobantes_cliente_id_saldo_pendiente_idx" ON "comprobantes"("cliente_id", "saldo_pendiente");

-- AddForeignKey
ALTER TABLE "comprobante_cuotas" ADD CONSTRAINT "comprobante_cuotas_comprobante_id_fkey" FOREIGN KEY ("comprobante_id") REFERENCES "comprobantes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cobranzas" ADD CONSTRAINT "cobranzas_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cobranzas" ADD CONSTRAINT "cobranzas_cliente_id_fkey" FOREIGN KEY ("cliente_id") REFERENCES "clientes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cobranzas" ADD CONSTRAINT "cobranzas_comprobante_id_fkey" FOREIGN KEY ("comprobante_id") REFERENCES "comprobantes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cobranzas" ADD CONSTRAINT "cobranzas_sesion_caja_id_fkey" FOREIGN KEY ("sesion_caja_id") REFERENCES "sesiones_caja"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- Seguridad: RLS por estudio y permisos del rol de aplicación
-- ═══════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['comprobante_cuotas', 'cobranzas'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY aislamiento_tenant ON %I USING (tenant_id = app_tenant_actual()) WITH CHECK (tenant_id = app_tenant_actual())',
      t
    );
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kardex_app') THEN
    -- Las cuotas son parte del comprobante: no cambian
    GRANT SELECT, INSERT ON comprobante_cuotas TO kardex_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON comprobante_cuotas FROM kardex_app;
    -- Una cobranza no se borra: se anula
    GRANT SELECT, INSERT, UPDATE ON cobranzas TO kardex_app;
    REVOKE DELETE, TRUNCATE ON cobranzas FROM kardex_app;
  END IF;
END $$;

-- Importes coherentes
ALTER TABLE clientes ADD CONSTRAINT cliente_credito CHECK ((limite_credito IS NULL OR limite_credito >= 0) AND dias_credito BETWEEN 0 AND 365);
ALTER TABLE cajas ADD CONSTRAINT caja_descuento_maximo CHECK (descuento_maximo BETWEEN 0 AND 100);
ALTER TABLE comprobantes ADD CONSTRAINT comprobante_credito CHECK (
  monto_credito >= 0 AND monto_credito <= total
  AND saldo_pendiente >= 0 AND saldo_pendiente <= monto_credito
  AND aplicado_a_saldo >= 0 AND aplicado_a_saldo <= total
  AND descuento_global >= 0
  AND (forma_pago = 'CREDITO' OR monto_credito = 0)
);
ALTER TABLE comprobante_cuotas ADD CONSTRAINT cuota_monto CHECK (monto > 0 AND numero > 0);
ALTER TABLE cobranzas ADD CONSTRAINT cobranza_monto CHECK (monto > 0 AND numero > 0);

-- La forma de pago y el monto financiado también son parte del comprobante emitido
CREATE OR REPLACE FUNCTION comprobante_importes_inmutables() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.tipo, NEW.serie, NEW.numero, NEW.total, NEW.igv, NEW.op_gravada, NEW.op_exonerada, NEW.op_inafecta,
      NEW.cliente_numero_documento, NEW.cliente_nombre, NEW.fecha_emision, NEW.empresa_id,
      NEW.forma_pago, NEW.monto_credito, NEW.descuento_total, NEW.descuento_global, NEW.aplicado_a_saldo)
     IS DISTINCT FROM
     (OLD.tipo, OLD.serie, OLD.numero, OLD.total, OLD.igv, OLD.op_gravada, OLD.op_exonerada, OLD.op_inafecta,
      OLD.cliente_numero_documento, OLD.cliente_nombre, OLD.fecha_emision, OLD.empresa_id,
      OLD.forma_pago, OLD.monto_credito, OLD.descuento_total, OLD.descuento_global, OLD.aplicado_a_saldo) THEN
    RAISE EXCEPTION 'Un comprobante emitido no se modifica: anúlelo o emita una nota de crédito';
  END IF;
  RETURN NEW;
END $$;

-- Una cobranza registrada no cambia de importe, comprobante ni medio: solo puede anularse
CREATE OR REPLACE FUNCTION cobranza_inmutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.monto, NEW.medio, NEW.comprobante_id, NEW.cliente_id, NEW.empresa_id, NEW.numero, NEW.fecha, NEW.sesion_caja_id)
     IS DISTINCT FROM
     (OLD.monto, OLD.medio, OLD.comprobante_id, OLD.cliente_id, OLD.empresa_id, OLD.numero, OLD.fecha, OLD.sesion_caja_id)
     OR (OLD.estado = 'ANULADA') THEN
    RAISE EXCEPTION 'Una cobranza registrada no se modifica: anúlela y registre otra';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cobranzas_inmutables BEFORE UPDATE ON cobranzas
  FOR EACH ROW EXECUTE FUNCTION cobranza_inmutable();
