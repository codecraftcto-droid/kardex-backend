-- CreateEnum
CREATE TYPE "RolPlataforma" AS ENUM ('ADMIN', 'SOPORTE');

-- CreateEnum
CREATE TYPE "EstadoFactura" AS ENUM ('PENDIENTE', 'PAGADA', 'ANULADA');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "email_contacto" TEXT,
ADD COLUMN     "motivo_suspension" TEXT,
ADD COLUMN     "plan_id" UUID,
ADD COLUMN     "suspendido_en" TIMESTAMP(3),
ADD COLUMN     "telefono_contacto" TEXT;

-- CreateTable
CREATE TABLE "plataforma_admins" (
    "id" UUID NOT NULL,
    "nombres" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "rol" "RolPlataforma" NOT NULL DEFAULT 'SOPORTE',
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "mfa_activo" BOOLEAN NOT NULL DEFAULT false,
    "mfa_secret" TEXT,
    "intentos_fallidos" INTEGER NOT NULL DEFAULT 0,
    "bloqueado_hasta" TIMESTAMP(3),
    "ultimo_acceso" TIMESTAMP(3),
    "creado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plataforma_admins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plataforma_sesiones" (
    "id" UUID NOT NULL,
    "admin_id" UUID NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "ip" TEXT,
    "dispositivo" TEXT,
    "expira_en" TIMESTAMP(3) NOT NULL,
    "revocada" BOOLEAN NOT NULL DEFAULT false,
    "creada_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plataforma_sesiones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plataforma_codigos_recuperacion" (
    "id" UUID NOT NULL,
    "admin_id" UUID NOT NULL,
    "codigo_hash" TEXT NOT NULL,
    "usado_en" TIMESTAMP(3),

    CONSTRAINT "plataforma_codigos_recuperacion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "planes" (
    "id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "descripcion" TEXT,
    "precio_mensual" DECIMAL(10,2) NOT NULL,
    "max_empresas" INTEGER,
    "max_usuarios" INTEGER,
    "max_almacenes" INTEGER,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "creado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "planes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "facturas_plataforma" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "periodo" TEXT NOT NULL,
    "monto" DECIMAL(10,2) NOT NULL,
    "estado" "EstadoFactura" NOT NULL DEFAULT 'PENDIENTE',
    "emitida_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "vence_en" DATE NOT NULL,
    "pagada_en" TIMESTAMP(3),
    "referencia_pago" TEXT,
    "motivo_anulacion" TEXT,

    CONSTRAINT "facturas_plataforma_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plataforma_auditoria" (
    "id" BIGSERIAL NOT NULL,
    "admin_id" UUID,
    "tenant_id" UUID,
    "accion" TEXT NOT NULL,
    "recurso" TEXT NOT NULL,
    "recurso_id" TEXT,
    "antes" JSONB,
    "despues" JSONB,
    "ip" TEXT,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plataforma_auditoria_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plataforma_admins_email_key" ON "plataforma_admins"("email");

-- CreateIndex
CREATE INDEX "plataforma_sesiones_admin_id_idx" ON "plataforma_sesiones"("admin_id");

-- CreateIndex
CREATE INDEX "plataforma_codigos_recuperacion_admin_id_idx" ON "plataforma_codigos_recuperacion"("admin_id");

-- CreateIndex
CREATE UNIQUE INDEX "planes_codigo_key" ON "planes"("codigo");

-- CreateIndex
CREATE INDEX "facturas_plataforma_estado_idx" ON "facturas_plataforma"("estado");

-- CreateIndex
CREATE UNIQUE INDEX "facturas_plataforma_tenant_id_periodo_key" ON "facturas_plataforma"("tenant_id", "periodo");

-- CreateIndex
CREATE INDEX "plataforma_auditoria_fecha_idx" ON "plataforma_auditoria"("fecha");

-- CreateIndex
CREATE INDEX "plataforma_auditoria_tenant_id_idx" ON "plataforma_auditoria"("tenant_id");

-- AddForeignKey
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "planes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plataforma_sesiones" ADD CONSTRAINT "plataforma_sesiones_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "plataforma_admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plataforma_codigos_recuperacion" ADD CONSTRAINT "plataforma_codigos_recuperacion_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "plataforma_admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "facturas_plataforma" ADD CONSTRAINT "facturas_plataforma_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "facturas_plataforma" ADD CONSTRAINT "facturas_plataforma_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "planes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ═══════════════════════════════════════════════════════════════════
-- Las tablas de plataforma son globales: el rol de los estudios NO las ve.
-- (ALTER DEFAULT PRIVILEGES de migraciones anteriores le habría dado acceso)
-- ═══════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kardex_app') THEN
    REVOKE ALL ON plataforma_admins, plataforma_sesiones, plataforma_codigos_recuperacion,
                  facturas_plataforma, plataforma_auditoria FROM kardex_app;
    -- Los estudios pueden leer el catálogo de planes (para mostrar su plan y límites)
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON planes FROM kardex_app;
    GRANT SELECT ON planes TO kardex_app;
  END IF;
END $$;

ALTER TABLE facturas_plataforma ADD CONSTRAINT factura_periodo CHECK (periodo ~ '^\d{4}-(0[1-9]|1[0-2])$');
ALTER TABLE facturas_plataforma ADD CONSTRAINT factura_monto CHECK (monto >= 0);

CREATE OR REPLACE FUNCTION plataforma_auditoria_inmutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'La auditoría de plataforma es inmutable';
END $$;
CREATE TRIGGER plataforma_auditoria_sin_cambios BEFORE UPDATE OR DELETE ON plataforma_auditoria
  FOR EACH ROW EXECUTE FUNCTION plataforma_auditoria_inmutable();
CREATE TRIGGER plataforma_auditoria_sin_truncate BEFORE TRUNCATE ON plataforma_auditoria
  FOR EACH STATEMENT EXECUTE FUNCTION plataforma_auditoria_inmutable();
