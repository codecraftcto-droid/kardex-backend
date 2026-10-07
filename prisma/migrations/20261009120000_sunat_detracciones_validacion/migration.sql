-- AlterTable
ALTER TABLE "clientes" ADD COLUMN     "agente_retencion" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "comprobantes" ADD COLUMN     "detraccion_codigo" TEXT,
ADD COLUMN     "detraccion_monto" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "detraccion_porcentaje" DECIMAL(5,2),
ADD COLUMN     "retencion_monto" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "config_facturacion" ADD COLUMN     "sunat_client_id" TEXT,
ADD COLUMN     "sunat_client_secret_cifrado" TEXT;

-- AlterTable
ALTER TABLE "documentos_comerciales" ADD COLUMN     "validacion_estado" TEXT,
ADD COLUMN     "validacion_mensaje" TEXT,
ADD COLUMN     "validacion_ruc_condicion" TEXT,
ADD COLUMN     "validacion_ruc_estado" TEXT,
ADD COLUMN     "validado_en" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "empresas" ADD COLUMN     "cuenta_detracciones" TEXT,
ADD COLUMN     "exceptuado_retencion" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "productos" ADD COLUMN     "detraccion_codigo" TEXT;

-- Importes coherentes
ALTER TABLE comprobantes ADD CONSTRAINT comprobante_spot CHECK (
  detraccion_monto >= 0 AND retencion_monto >= 0 AND detraccion_monto + retencion_monto <= total
  AND (detraccion_monto = 0 OR (detraccion_codigo IS NOT NULL AND detraccion_porcentaje > 0))
);
ALTER TABLE productos ADD CONSTRAINT producto_detraccion_codigo CHECK (detraccion_codigo IS NULL OR detraccion_codigo ~ '^\d{3}$');
ALTER TABLE documentos_comerciales ADD CONSTRAINT documento_validacion_estado
  CHECK (validacion_estado IS NULL OR validacion_estado IN ('VALIDO', 'NO_EXISTE', 'ANULADO', 'NO_AUTORIZADO', 'ERROR'));

-- La detracción y la retención también son parte del comprobante emitido
CREATE OR REPLACE FUNCTION comprobante_importes_inmutables() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.tipo, NEW.serie, NEW.numero, NEW.total, NEW.igv, NEW.op_gravada, NEW.op_exonerada, NEW.op_inafecta,
      NEW.cliente_numero_documento, NEW.cliente_nombre, NEW.fecha_emision, NEW.empresa_id,
      NEW.forma_pago, NEW.monto_credito, NEW.descuento_total, NEW.descuento_global, NEW.aplicado_a_saldo,
      NEW.detraccion_codigo, NEW.detraccion_monto, NEW.retencion_monto)
     IS DISTINCT FROM
     (OLD.tipo, OLD.serie, OLD.numero, OLD.total, OLD.igv, OLD.op_gravada, OLD.op_exonerada, OLD.op_inafecta,
      OLD.cliente_numero_documento, OLD.cliente_nombre, OLD.fecha_emision, OLD.empresa_id,
      OLD.forma_pago, OLD.monto_credito, OLD.descuento_total, OLD.descuento_global, OLD.aplicado_a_saldo,
      OLD.detraccion_codigo, OLD.detraccion_monto, OLD.retencion_monto) THEN
    RAISE EXCEPTION 'Un comprobante emitido no se modifica: anúlelo o emita una nota de crédito';
  END IF;
  RETURN NEW;
END $$;
