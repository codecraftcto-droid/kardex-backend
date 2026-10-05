-- CreateEnum
CREATE TYPE "TipoUsuario" AS ENUM ('interno', 'cliente');

-- CreateEnum
CREATE TYPE "EstadoUsuario" AS ENUM ('pendiente', 'activo', 'suspendido');

-- CreateEnum
CREATE TYPE "AlcanceTipo" AS ENUM ('estudio', 'empresa', 'sede', 'almacen');

-- CreateEnum
CREATE TYPE "EfectoExcepcion" AS ENUM ('allow', 'deny');

-- CreateEnum
CREATE TYPE "TipoTokenUsuario" AS ENUM ('invitacion', 'recuperacion');

-- CreateEnum
CREATE TYPE "MetodoValorizacion" AS ENUM ('PEPS', 'PROMEDIO');

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "nombre" TEXT NOT NULL,
    "ruc" TEXT,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "creado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permisos" (
    "id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "modulo" TEXT NOT NULL,
    "descripcion" TEXT NOT NULL,
    "sensible" BOOLEAN NOT NULL DEFAULT false,
    "lectura" BOOLEAN NOT NULL DEFAULT false,
    "orden" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "permisos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "nombre" TEXT NOT NULL,
    "descripcion" TEXT,
    "es_sistema" BOOLEAN NOT NULL DEFAULT false,
    "requiere_mfa" BOOLEAN NOT NULL DEFAULT false,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "creado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizado_en" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rol_permisos" (
    "rol_id" UUID NOT NULL,
    "permiso_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,

    CONSTRAINT "rol_permisos_pkey" PRIMARY KEY ("rol_id","permiso_id")
);

-- CreateTable
CREATE TABLE "usuarios" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "empresa_id" UUID,
    "nombres" TEXT NOT NULL,
    "documento" TEXT,
    "cargo" TEXT,
    "telefono" TEXT,
    "email" TEXT NOT NULL,
    "password_hash" TEXT,
    "tipo" "TipoUsuario" NOT NULL DEFAULT 'interno',
    "estado" "EstadoUsuario" NOT NULL DEFAULT 'pendiente',
    "mfa_activo" BOOLEAN NOT NULL DEFAULT false,
    "mfa_secret" TEXT,
    "intentos_fallidos" INTEGER NOT NULL DEFAULT 0,
    "bloqueado_hasta" TIMESTAMP(3),
    "ultimo_acceso" TIMESTAMP(3),
    "creado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizado_en" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usuarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usuario_roles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "rol_id" UUID NOT NULL,
    "alcance_tipo" "AlcanceTipo" NOT NULL,
    "alcance_id" UUID,
    "creado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usuario_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usuario_permisos_excepcion" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "permiso_id" UUID NOT NULL,
    "efecto" "EfectoExcepcion" NOT NULL,
    "alcance_tipo" "AlcanceTipo" NOT NULL,
    "alcance_id" UUID,
    "creado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usuario_permisos_excepcion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sesiones" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "dispositivo" TEXT,
    "ip" TEXT,
    "expira_en" TIMESTAMP(3) NOT NULL,
    "revocada" BOOLEAN NOT NULL DEFAULT false,
    "creada_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ultimo_uso" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sesiones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tokens_usuario" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "tipo" "TipoTokenUsuario" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expira_en" TIMESTAMP(3) NOT NULL,
    "usado_en" TIMESTAMP(3),
    "creado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tokens_usuario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auditoria" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" UUID NOT NULL,
    "usuario_id" UUID,
    "empresa_id" UUID,
    "modulo" TEXT NOT NULL,
    "accion" TEXT NOT NULL,
    "recurso" TEXT NOT NULL,
    "recurso_id" TEXT,
    "antes" JSONB,
    "despues" JSONB,
    "ip" TEXT,
    "dispositivo" TEXT,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auditoria_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "empresas" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "razon_social" TEXT NOT NULL,
    "ruc" TEXT NOT NULL,
    "contacto" TEXT,
    "email" TEXT,
    "telefono" TEXT,
    "direccion" TEXT,
    "metodo_valorizacion" "MetodoValorizacion" NOT NULL DEFAULT 'PROMEDIO',
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "creado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizado_en" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "empresas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sedes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "empresa_id" UUID NOT NULL,
    "nombre" TEXT NOT NULL,
    "direccion" TEXT,
    "responsable_id" UUID,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "creado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizado_en" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sedes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "almacenes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "empresa_id" UUID NOT NULL,
    "sede_id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "descripcion" TEXT,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "creado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizado_en" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "almacenes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "permisos_codigo_key" ON "permisos"("codigo");

-- CreateIndex
CREATE INDEX "roles_tenant_id_idx" ON "roles"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "roles_tenant_id_nombre_key" ON "roles"("tenant_id", "nombre");

-- CreateIndex
CREATE INDEX "rol_permisos_tenant_id_idx" ON "rol_permisos"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "usuarios_email_key" ON "usuarios"("email");

-- CreateIndex
CREATE INDEX "usuarios_tenant_id_idx" ON "usuarios"("tenant_id");

-- CreateIndex
CREATE INDEX "usuario_roles_tenant_id_idx" ON "usuario_roles"("tenant_id");

-- CreateIndex
CREATE INDEX "usuario_roles_alcance_id_idx" ON "usuario_roles"("alcance_id");

-- CreateIndex
CREATE UNIQUE INDEX "usuario_roles_usuario_id_rol_id_alcance_tipo_alcance_id_key" ON "usuario_roles"("usuario_id", "rol_id", "alcance_tipo", "alcance_id");

-- CreateIndex
CREATE INDEX "usuario_permisos_excepcion_tenant_id_idx" ON "usuario_permisos_excepcion"("tenant_id");

-- CreateIndex
CREATE INDEX "usuario_permisos_excepcion_alcance_id_idx" ON "usuario_permisos_excepcion"("alcance_id");

-- CreateIndex
CREATE UNIQUE INDEX "usuario_permisos_excepcion_usuario_id_permiso_id_alcance_ti_key" ON "usuario_permisos_excepcion"("usuario_id", "permiso_id", "alcance_tipo", "alcance_id");

-- CreateIndex
CREATE INDEX "sesiones_usuario_id_idx" ON "sesiones"("usuario_id");

-- CreateIndex
CREATE INDEX "sesiones_tenant_id_idx" ON "sesiones"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "tokens_usuario_token_hash_key" ON "tokens_usuario"("token_hash");

-- CreateIndex
CREATE INDEX "tokens_usuario_tenant_id_idx" ON "tokens_usuario"("tenant_id");

-- CreateIndex
CREATE INDEX "auditoria_tenant_id_fecha_idx" ON "auditoria"("tenant_id", "fecha");

-- CreateIndex
CREATE INDEX "auditoria_tenant_id_usuario_id_idx" ON "auditoria"("tenant_id", "usuario_id");

-- CreateIndex
CREATE INDEX "auditoria_tenant_id_empresa_id_idx" ON "auditoria"("tenant_id", "empresa_id");

-- CreateIndex
CREATE INDEX "empresas_tenant_id_idx" ON "empresas"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "empresas_tenant_id_ruc_key" ON "empresas"("tenant_id", "ruc");

-- CreateIndex
CREATE INDEX "sedes_tenant_id_idx" ON "sedes"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "sedes_empresa_id_nombre_key" ON "sedes"("empresa_id", "nombre");

-- CreateIndex
CREATE INDEX "almacenes_tenant_id_idx" ON "almacenes"("tenant_id");

-- CreateIndex
CREATE INDEX "almacenes_sede_id_idx" ON "almacenes"("sede_id");

-- CreateIndex
CREATE UNIQUE INDEX "almacenes_empresa_id_codigo_key" ON "almacenes"("empresa_id", "codigo");

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rol_permisos" ADD CONSTRAINT "rol_permisos_rol_id_fkey" FOREIGN KEY ("rol_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rol_permisos" ADD CONSTRAINT "rol_permisos_permiso_id_fkey" FOREIGN KEY ("permiso_id") REFERENCES "permisos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usuarios" ADD CONSTRAINT "usuarios_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usuarios" ADD CONSTRAINT "usuarios_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "empresas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usuario_roles" ADD CONSTRAINT "usuario_roles_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usuario_roles" ADD CONSTRAINT "usuario_roles_rol_id_fkey" FOREIGN KEY ("rol_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usuario_permisos_excepcion" ADD CONSTRAINT "usuario_permisos_excepcion_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usuario_permisos_excepcion" ADD CONSTRAINT "usuario_permisos_excepcion_permiso_id_fkey" FOREIGN KEY ("permiso_id") REFERENCES "permisos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sesiones" ADD CONSTRAINT "sesiones_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tokens_usuario" ADD CONSTRAINT "tokens_usuario_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "empresas" ADD CONSTRAINT "empresas_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sedes" ADD CONSTRAINT "sedes_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sedes" ADD CONSTRAINT "sedes_responsable_id_fkey" FOREIGN KEY ("responsable_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "almacenes" ADD CONSTRAINT "almacenes_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "almacenes" ADD CONSTRAINT "almacenes_sede_id_fkey" FOREIGN KEY ("sede_id") REFERENCES "sedes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
