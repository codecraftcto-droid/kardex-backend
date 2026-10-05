-- Preparación de la base de datos LOCAL (ejecutar una sola vez como superusuario):
--   psql -d postgres -f database/setup-local.sql
-- kardex_owner: dueño del esquema (migraciones, seed, flujos de autenticación).
-- kardex_app:   rol de la aplicación SIN privilegios de dueño; RLS se le aplica siempre.
-- En producción use contraseñas fuertes y entréguelas vía variables de entorno.
CREATE ROLE kardex_owner LOGIN CREATEDB PASSWORD 'kardex_owner';  -- CREATEDB: base sombra de prisma migrate dev
CREATE ROLE kardex_app LOGIN PASSWORD 'kardex_app';
CREATE DATABASE kardex OWNER kardex_owner;
