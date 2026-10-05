# Despliegue en producción con Dokploy

Arquitectura en Dokploy (un proyecto, cuatro servicios):

```
                              ┌────────────────────────────┐
 kardex.codecraft.net.pe ────▶│ frontend (nginx, puerto 80) │
                              └────────────────────────────┘
                              ┌────────────────────────────┐      ┌────────────┐
 api.kardex.codecraft.net.pe ▶│ backend (Node, puerto 3000) │ ───▶ │ PostgreSQL │ (servicio de BD de Dokploy)
                              │  API + Socket.io + worker   │ ───▶ │ Redis      │ (servicio de BD de Dokploy)
                              └────────────────────────────┘      └────────────┘
```

Ambos dominios deben apuntar (registro **A**) a la IP del servidor de Dokploy:

| Dominio | Servicio |
|---|---|
| `kardex.codecraft.net.pe` | frontend |
| `api.kardex.codecraft.net.pe` | backend |

---

## 1. Repositorios

| Repositorio | Contenido | Servicio en Dokploy |
|---|---|---|
| `codecraftcto-droid/kardex-backend` | API, Socket.io, worker, migraciones | `backend` |
| `codecraftcto-droid/kardex-frontend` | SPA Vue (nginx) | `frontend` |

- Ambos deben ser **privados** (GitHub → Settings → General → Danger Zone → Change visibility).
- En Dokploy: **Settings → Git → GitHub** y conecte la cuenta (GitHub App) para acceder a los repos privados.
- Los `.env` reales nunca se suben: cada repo tiene su propio `.gitignore`.

---

## 2. Bases de datos (servicios de Dokploy)

En el proyecto de Dokploy → **Create Service → Database**:

**PostgreSQL** (versión 17)
- Database name: `kardex` · User: `kardex_owner` · Password: una clave larga
- Anote el **Internal Host** (p. ej. `kardex-postgres-xxxx`). No exponga el puerto a Internet.

**Redis** (versión 7)
- Password: una clave larga · anote el **Internal Host**.

> El backend crea automáticamente el segundo usuario de PostgreSQL, `kardex_app` (el que usa la aplicación con
> RLS), con la contraseña que ponga en `DATABASE_APP_URL`. **El nombre debe ser exactamente `kardex_app`.**

---

## 3. Backend

**Create Service → Application** → nombre `backend`.

- **Provider**: GitHub · repositorio `kardex-backend` · rama `main`
- **Build Type**: Dockerfile
- **Docker File**: `Dockerfile` · **Docker Context Path**: `.`
- **Environment** (pestaña *Environment*):

```env
NODE_ENV=production
PORT=3000
APP_URL=https://kardex.codecraft.net.pe
CORS_ORIGINS=https://kardex.codecraft.net.pe

# Conexión dueña (migraciones) y conexión de aplicación (RLS). Host = Internal Host de Dokploy.
DATABASE_URL=postgresql://kardex_owner:CLAVE_POSTGRES@HOST_POSTGRES:5432/kardex
DATABASE_APP_URL=postgresql://kardex_app:OTRA_CLAVE_LARGA@HOST_POSTGRES:5432/kardex
REDIS_URL=redis://default:CLAVE_REDIS@HOST_REDIS:6379

# Secretos NUEVOS (no reutilice los de desarrollo). Genere cada uno con:  openssl rand -hex 32
JWT_ACCESS_SECRET=
JWT_PLATAFORMA_SECRET=
MFA_ENCRYPTION_KEY=

ACCESS_TOKEN_TTL=15m
REFRESH_TOKEN_DIAS=7
PASSWORD_MIN_LENGTH=8
LOGIN_MAX_INTENTOS=5
LOGIN_BLOQUEO_MINUTOS=15
LOGIN_RATE_LIMIT=10
IGV_TASA=0.18

# Correo (obligatorio en producción para invitaciones y recuperación de contraseña)
SMTP_HOST=smtp.su-proveedor.com
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
MAIL_FROM="Kardex <no-reply@codecraft.net.pe>"

REPORTES_DIR=/app/storage/reportes
REPORTES_WORKER_EMBEBIDO=true
```

> Si una contraseña tiene caracteres especiales (`@ : / ? # %`), escríbala codificada en la URL
> (p. ej. `@` → `%40`). Lo más simple: use contraseñas solo con letras y números.

- **Domains**: `api.kardex.codecraft.net.pe` → **Container Port 3000** · HTTPS activado (Let's Encrypt).
- **Advanced → Volumes**: volumen `kardex-reportes` montado en `/app/storage/reportes` (archivos de exportación).
- **Deploy**.

En los *logs* del primer arranque debe ver:

```
✔ Rol de aplicación "kardex_app" creado
All migrations have been successfully applied.
✔ Catálogo de permisos sincronizado (47 nuevos)
Worker de reportes activo (concurrencia 2)
API Kardex escuchando en http://localhost:3000
```

Compruebe: `https://api.kardex.codecraft.net.pe/api/salud` → `{"ok":true}`.

> **`MFA_ENCRYPTION_KEY` no se puede cambiar ni perder**: cifra los secretos 2FA de todos los usuarios.
> Respáldela junto con la base de datos.

---

## 4. Frontend

**Create Service → Application** → nombre `frontend`.

- **Provider**: GitHub · repositorio `kardex-frontend` · rama `main`
- **Build Type**: Dockerfile
- **Docker File**: `Dockerfile` · **Docker Context Path**: `.`
- **Environment**:

```env
API_ORIGIN=https://api.kardex.codecraft.net.pe
```

(La misma imagen sirve para cualquier dominio: la URL de la API se aplica al iniciar el contenedor.)

- **Domains**: `kardex.codecraft.net.pe` → **Container Port 80** · HTTPS activado.
- **Deploy**.

---

## 5. Primer acceso

1. **Usuario de plataforma** (Super Admin). En Dokploy → servicio `backend` → **Docker Terminal**:

   ```bash
   node scripts/crear-admin-plataforma.js su-correo@codecraft.net.pe "Su Nombre" ADMIN
   ```

   Muestra una **contraseña temporal una sola vez**.

2. Entre a `https://kardex.codecraft.net.pe/plataforma`, configure la verificación en dos pasos y guarde los códigos de recuperación.
3. Cree los **planes** y luego el **primer estudio** con su administrador: recibirá un correo de invitación.

En producción **no** se cargan datos ni usuarios demo.

---

## 6. Respaldos (obligatorio)

- Dokploy → **Settings → S3 Destinations**: agregue un bucket (AWS S3, Cloudflare R2, Backblaze…).
- Servicio PostgreSQL → **Backups**: programe un respaldo diario (p. ej. `0 3 * * *`) a ese destino.
- Una vez al mes, **pruebe la restauración** en una base de datos aparte.
- Guarde fuera del servidor: `JWT_*`, `MFA_ENCRYPTION_KEY` y las claves de PostgreSQL/Redis.

Redis no necesita respaldo (contiene caché, colas y sesiones revocadas temporales).

---

## 7. Actualizaciones

- En cada servicio active **Autodeploy**: cada `git push` a `main` vuelve a desplegar.
- Las **migraciones se aplican solas** al arrancar el backend; los permisos nuevos del catálogo se asignan a los roles plantilla.
- Despliegue primero el backend y después el frontend cuando un cambio involucre a ambos.

## 8. Escalar los reportes (opcional)

Si las exportaciones grandes cargan la API, cree otro servicio `worker` con el mismo repositorio (`kardex-backend`)
y Dockerfile, las mismas variables, el mismo volumen de reportes y **Command** `node src/worker.js`.
En el backend cambie `REPORTES_WORKER_EMBEBIDO=false`.

## 9. Problemas frecuentes

| Síntoma | Causa probable |
|---|---|
| El login funciona pero al recargar pide ingresar de nuevo | `CORS_ORIGINS`/`APP_URL` no coinciden exactamente con `https://kardex.codecraft.net.pe`, o falta HTTPS |
| Error CORS en la consola del navegador | `CORS_ORIGINS` distinto al dominio del frontend (sin `/` final) |
| "En línea" no aparece (tiempo real) | `API_ORIGIN` del frontend mal escrito; debe ser `https://api.kardex.codecraft.net.pe` |
| `DATABASE_APP_URL debe usar el usuario "kardex_app"` | Cambie el usuario de esa URL a `kardex_app` |
| `permission denied` en la API | El rol `kardex_app` existía antes con otros permisos: elimínelo y vuelva a desplegar sobre una base nueva |
| No llegan las invitaciones | Falta configurar `SMTP_*` |
| La cámara no abre en el celular | El sitio debe abrirse por `https://` |
