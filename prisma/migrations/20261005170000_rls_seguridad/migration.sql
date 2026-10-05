-- ═══════════════════════════════════════════════════════════════════
-- Defensa en profundidad: Row Level Security por tenant_id
-- La aplicación se conecta como kardex_app (NO dueño) → RLS siempre aplica.
-- El dueño (kardex_owner) no se ve afectado: lo usan migraciones, seed y login.
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION app_tenant_actual() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'roles', 'rol_permisos', 'usuarios', 'usuario_roles', 'usuario_permisos_excepcion',
    'sesiones', 'tokens_usuario', 'auditoria', 'empresas', 'sedes', 'almacenes'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY aislamiento_tenant ON %I USING (tenant_id = app_tenant_actual()) WITH CHECK (tenant_id = app_tenant_actual())',
      t
    );
  END LOOP;
END $$;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY aislamiento_tenant ON tenants USING (id = app_tenant_actual());

-- ─── Permisos del rol de aplicación ───
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kardex_app') THEN
    GRANT USAGE ON SCHEMA public TO kardex_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO kardex_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO kardex_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO kardex_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO kardex_app;
    IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
      REVOKE ALL ON _prisma_migrations FROM kardex_app;
    END IF;
    -- Catálogo global: solo lectura (lo siembra el sistema)
    REVOKE INSERT, UPDATE, DELETE ON permisos FROM kardex_app;
    -- Estudios: solo lectura desde la app (alta/baja es del Super Admin)
    REVOKE INSERT, UPDATE, DELETE ON tenants FROM kardex_app;
    -- Auditoría: solo inserción
    REVOKE UPDATE, DELETE, TRUNCATE ON auditoria FROM kardex_app;
  ELSE
    RAISE WARNING 'Rol kardex_app no existe: ejecute database/setup-local.sql y vuelva a aplicar los GRANT';
  END IF;
END $$;

-- ─── Auditoría inmutable (incluso para el dueño) ───
CREATE OR REPLACE FUNCTION auditoria_inmutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'El registro de auditoría es inmutable';
END $$;

CREATE TRIGGER auditoria_sin_cambios
  BEFORE UPDATE OR DELETE ON auditoria
  FOR EACH ROW EXECUTE FUNCTION auditoria_inmutable();

CREATE TRIGGER auditoria_sin_truncate
  BEFORE TRUNCATE ON auditoria
  FOR EACH STATEMENT EXECUTE FUNCTION auditoria_inmutable();
