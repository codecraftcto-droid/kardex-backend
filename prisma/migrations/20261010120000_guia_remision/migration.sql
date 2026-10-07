-- CreateEnum
CREATE TYPE "ModalidadTraslado" AS ENUM ('PUBLICO', 'PRIVADO');

-- AlterTable
ALTER TABLE "config_facturacion" ADD COLUMN     "serie_guia" TEXT NOT NULL DEFAULT 'T001';

-- AlterTable
ALTER TABLE "sedes" ADD COLUMN     "codigo_establecimiento" TEXT,
ADD COLUMN     "ubigeo" TEXT;

-- CreateTable
CREATE TABLE "guias_remision" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "empresa_id" UUID NOT NULL,
    "sede_id" UUID NOT NULL,
    "almacen_id" UUID NOT NULL,
    "serie" TEXT NOT NULL,
    "numero" INTEGER NOT NULL,
    "fecha_emision" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fecha_traslado" DATE NOT NULL,
    "motivo" TEXT NOT NULL,
    "motivo_descripcion" TEXT,
    "modalidad" "ModalidadTraslado" NOT NULL,
    "destinatario_tipo_doc" "TipoDocIdentidad" NOT NULL,
    "destinatario_num_doc" TEXT NOT NULL,
    "destinatario_nombre" TEXT NOT NULL,
    "partida_ubigeo" TEXT NOT NULL,
    "partida_direccion" TEXT NOT NULL,
    "partida_establecimiento" TEXT,
    "llegada_ubigeo" TEXT NOT NULL,
    "llegada_direccion" TEXT NOT NULL,
    "llegada_establecimiento" TEXT,
    "peso_bruto" DECIMAL(12,3) NOT NULL,
    "unidad_peso" TEXT NOT NULL DEFAULT 'KGM',
    "bultos" INTEGER,
    "transportista_ruc" TEXT,
    "transportista_nombre" TEXT,
    "transportista_mtc" TEXT,
    "conductor_tipo_doc" "TipoDocIdentidad",
    "conductor_num_doc" TEXT,
    "conductor_nombres" TEXT,
    "conductor_apellidos" TEXT,
    "conductor_licencia" TEXT,
    "vehiculo_placa" TEXT,
    "doc_rel_tipo" TEXT,
    "doc_rel_serie" TEXT,
    "doc_rel_numero" TEXT,
    "transferencia_id" UUID,
    "comprobante_id" UUID,
    "observacion" TEXT,
    "estado" TEXT NOT NULL DEFAULT 'EMITIDA',
    "estado_sunat" "EstadoSunat" NOT NULL DEFAULT 'PENDIENTE',
    "sunat_codigo" TEXT,
    "sunat_descripcion" TEXT,
    "sunat_hash" TEXT,
    "sunat_qr" TEXT,
    "sunat_pdf" TEXT,
    "sunat_xml" TEXT,
    "sunat_cdr" TEXT,
    "sunat_intentos" INTEGER NOT NULL DEFAULT 0,
    "sunat_ultimo_error" TEXT,
    "sunat_enviado_en" TIMESTAMP(3),
    "usuario_id" UUID NOT NULL,
    "creado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guias_remision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guia_remision_detalles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "guia_id" UUID NOT NULL,
    "producto_id" UUID,
    "codigo" TEXT,
    "descripcion" TEXT NOT NULL,
    "unidad_codigo" TEXT NOT NULL,
    "cantidad" DECIMAL(18,4) NOT NULL,

    CONSTRAINT "guia_remision_detalles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "guias_remision_tenant_id_idx" ON "guias_remision"("tenant_id");

-- CreateIndex
CREATE INDEX "guias_remision_empresa_id_fecha_emision_idx" ON "guias_remision"("empresa_id", "fecha_emision");

-- CreateIndex
CREATE INDEX "guias_remision_transferencia_id_idx" ON "guias_remision"("transferencia_id");

-- CreateIndex
CREATE INDEX "guias_remision_comprobante_id_idx" ON "guias_remision"("comprobante_id");

-- CreateIndex
CREATE UNIQUE INDEX "guias_remision_empresa_id_serie_numero_key" ON "guias_remision"("empresa_id", "serie", "numero");

-- CreateIndex
CREATE INDEX "guia_remision_detalles_tenant_id_idx" ON "guia_remision_detalles"("tenant_id");

-- CreateIndex
CREATE INDEX "guia_remision_detalles_guia_id_idx" ON "guia_remision_detalles"("guia_id");

-- AddForeignKey
ALTER TABLE "guias_remision" ADD CONSTRAINT "guias_remision_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guia_remision_detalles" ADD CONSTRAINT "guia_remision_detalles_guia_id_fkey" FOREIGN KEY ("guia_id") REFERENCES "guias_remision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- Seguridad: RLS por estudio y permisos del rol de aplicación
-- ═══════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['guias_remision', 'guia_remision_detalles'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY aislamiento_tenant ON %I USING (tenant_id = app_tenant_actual()) WITH CHECK (tenant_id = app_tenant_actual())', t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kardex_app') THEN
    GRANT SELECT, INSERT, UPDATE ON guias_remision TO kardex_app;
    REVOKE DELETE, TRUNCATE ON guias_remision FROM kardex_app;
    GRANT SELECT, INSERT ON guia_remision_detalles TO kardex_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON guia_remision_detalles FROM kardex_app;
  END IF;
END $$;

-- Datos coherentes
ALTER TABLE guias_remision ADD CONSTRAINT guia_datos CHECK (
  numero > 0 AND peso_bruto > 0
  AND partida_ubigeo ~ '^\d{6}$' AND llegada_ubigeo ~ '^\d{6}$'
  AND estado IN ('EMITIDA', 'ANULADA')
  AND (modalidad <> 'PUBLICO' OR (transportista_ruc ~ '^\d{11}$' AND transportista_nombre IS NOT NULL))
  AND (modalidad <> 'PRIVADO' OR (conductor_num_doc IS NOT NULL AND conductor_licencia IS NOT NULL AND vehiculo_placa IS NOT NULL))
);
ALTER TABLE guia_remision_detalles ADD CONSTRAINT guia_detalle_cantidad CHECK (cantidad > 0);
ALTER TABLE sedes ADD CONSTRAINT sede_ubigeo CHECK (ubigeo IS NULL OR ubigeo ~ '^\d{6}$');

-- Una guía emitida no cambia: solo su estado (anulación) y la respuesta de SUNAT
CREATE OR REPLACE FUNCTION guia_inmutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.serie, NEW.numero, NEW.empresa_id, NEW.fecha_emision, NEW.fecha_traslado, NEW.motivo, NEW.modalidad,
      NEW.destinatario_num_doc, NEW.partida_ubigeo, NEW.partida_direccion, NEW.llegada_ubigeo, NEW.llegada_direccion,
      NEW.peso_bruto, NEW.transportista_ruc, NEW.conductor_num_doc, NEW.vehiculo_placa)
     IS DISTINCT FROM
     (OLD.serie, OLD.numero, OLD.empresa_id, OLD.fecha_emision, OLD.fecha_traslado, OLD.motivo, OLD.modalidad,
      OLD.destinatario_num_doc, OLD.partida_ubigeo, OLD.partida_direccion, OLD.llegada_ubigeo, OLD.llegada_direccion,
      OLD.peso_bruto, OLD.transportista_ruc, OLD.conductor_num_doc, OLD.vehiculo_placa) THEN
    RAISE EXCEPTION 'Una guía de remisión emitida no se modifica: emita una nueva';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guias_inmutables BEFORE UPDATE ON guias_remision FOR EACH ROW EXECUTE FUNCTION guia_inmutable();
