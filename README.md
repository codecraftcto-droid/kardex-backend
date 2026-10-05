# Kardex — Sistema de inventario para estudios contables

Arquitectura **cliente-servidor** con dos proyectos independientes:

```
kardex/
├── backend/    API REST + Socket.io  (Node.js, Express 5, Prisma, PostgreSQL con RLS, Redis)
└── frontend/   SPA                   (Vue 3, Pinia, Vue Router, TailwindCSS 4, Socket.io-client)
```

Cada uno tiene su propio `package.json`, `.env` y ciclo de despliegue. El frontend solo
habla con el backend por HTTP (`VITE_API_URL`) y WebSocket (`VITE_SOCKET_URL`).

```
 Navegador (Vue 3)  ──HTTPS/JSON──▶  backend :3000  ──▶  PostgreSQL (RLS por tenant_id)
        ▲                              │  ▲
        └──────── Socket.io ───────────┘  └──▶  Redis (caché de permisos, rate limit, adapter de sockets)
```

## Requisitos (desarrollo local, sin Docker)

- Node.js **20.19+**
- PostgreSQL **14+** corriendo en `localhost:5432`
- Redis **6+** corriendo en `localhost:6379`

> **Producción:** ver [DESPLIEGUE.md](DESPLIEGUE.md) (Dokploy: backend, frontend, PostgreSQL y Redis).
> El frontend vive en su propio repositorio: [`kardex-frontend`](https://github.com/codecraftcto-droid/kardex-frontend).

## Puesta en marcha

### 1. Base de datos (una sola vez)

```bash
cd backend
psql -d postgres -f database/setup-local.sql   # crea roles kardex_owner / kardex_app y la BD kardex
```

### 2. Backend

```bash
cd backend
cp .env.example .env        # y genere un JWT_ACCESS_SECRET propio
npm install
npx prisma migrate deploy   # esquema + políticas RLS + auditoría inmutable
npm run db:seed             # catálogo de permisos + estudio demo
npm run dev                 # http://localhost:3000
```

### 3. Frontend

```bash
cd frontend
cp .env.example .env
npm install
npm run dev                 # http://localhost:5173
```

### Datos y usuarios demo

El seed (idempotente: se puede volver a ejecutar) crea dos empresas con productos y movimientos reales:

| Empresa | Valorización | Sedes / almacenes |
|---|---|---|
| Comercial Andina S.A.C. | Promedio ponderado | Sede Central (ALM01, ALM02) |
| Distribuidora del Sur E.I.R.L. | PEPS | Sede Arequipa (ALM01) · Sede Cusco (ALM02) |

| Usuario | Contraseña | Qué permite ver |
|---|---|---|
| `admin@kardex.local` | `Admin123!` | Todo el estudio |
| `contador@kardex.local` | `Demo123!` | Rol Contador en **ambas empresas**: sirve para probar el cambio de empresa |
| `almacenero@kardex.local` | `Demo123!` | Solo el almacén de Arequipa: despacha y recibe transferencias; sin costos ni administración |
| `cliente@kardex.local` | `Demo123!` | **Portal cliente** de Comercial Andina: solo lectura de su empresa (stock, kardex, reportes) |

**Plataforma SaaS (Módulo C)** — http://localhost:5173/plataforma (login separado, 2FA obligatorio):

| Usuario | Contraseña | Rol |
|---|---|---|
| `superadmin@kardex.local` | `Super123!` | ADMIN: estudios, planes, facturación, suspensiones |
| `soporte@kardex.local` | `Soporte123!` | SOPORTE: consulta y acciones de soporte |

En el primer ingreso cada uno escanea su QR de 2FA. En producción, cree los usuarios con
`npm run plataforma:admin -- correo@dominio.com "Nombre" ADMIN` (muestra una contraseña temporal una sola vez).

Transferencias demo (Distribuidora del Sur, Arequipa → Cusco): una recibida con faltante, una en tránsito y una solicitada.

Sin SMTP configurado, los enlaces de invitación y recuperación se imprimen en la consola del backend.

### Probar desde el celular o la tablet (misma red Wi-Fi)

La cámara (lector de código de barras) y la instalación como app exigen **HTTPS**. Para eso:

```bash
cd frontend
npm run dev:movil      # HTTPS en la red local; la API y los sockets pasan por el proxy de Vite
```

Abra en el celular la dirección `Network` que muestra la consola (p. ej. `https://192.168.1.20:5173`),
acepte el aviso del certificado de desarrollo y listo. El backend sigue en `npm run dev` normal.
Desde ahí puede **instalar la app** (menú del navegador → "Agregar a pantalla de inicio" o, en Android,
"Instalar aplicación" en el menú de usuario).

### Pruebas automáticas

```bash
cd backend
psql -d postgres -c "CREATE DATABASE kardex_test OWNER kardex_owner"   # una sola vez
npm test     # resolución de permisos, alcances, anti-escalamiento, aislamiento entre tenants, sesiones
```

## Seguridad: decisiones clave

| Tema | Implementación |
|---|---|
| Aislamiento multiestudio | `tenant_id` en todas las tablas + **RLS** de PostgreSQL. La app se conecta como `kardex_app` (sin privilegios de dueño) y fija `app.tenant_id` por transacción (`withTenant`). |
| RBAC dinámico | Catálogo de permisos sembrado (`backend/src/rbac/catalogo.js`); roles, asignaciones con alcance (estudio/empresa/sede/almacén) y excepciones allow/deny se gestionan desde la UI. Ningún nombre de rol está en el código. |
| Permiso efectivo | Unión de roles cuyo alcance cubre el recurso + excepciones; `deny` gana. Lógica pura en `rbac/resolver.js`, cacheada en Redis e invalidada al cambiar roles/asignaciones. |
| Respuestas | 401 sin sesión · 403 sin el permiso · 404 si el recurso está fuera de su alcance (no se revela que existe). |
| Anti-escalamiento | No se otorgan permisos que uno no tiene, no se editan los propios permisos ni roles propios, y siempre queda al menos un administrador. |
| Sesiones | Access JWT de 15 min en memoria + refresh token rotativo en cookie httpOnly/SameSite=strict; detección de reutilización; revocación inmediata (Redis + desconexión de sockets). |
| Login | argon2id, bloqueo temporal tras intentos fallidos, rate limit en Redis, respuestas que no revelan si el correo existe. |
| Auditoría | Tabla de solo inserción con trigger que bloquea UPDATE/DELETE/TRUNCATE; guarda antes/después, IP y dispositivo. |
| Kardex | Movimientos y líneas inmutables (trigger + sin permisos UPDATE/DELETE). Bloqueo de fila por almacén-producto para concurrencia; el stock nunca queda negativo (CHECK). Los costos solo se envían a quien tiene `kardex.costos.ver`. |
| Transferencias | Cada paso exige su permiso sobre el almacén correcto (aprobar/despachar en origen, recibir en destino). Las transiciones se "reclaman" con UPDATE condicionado al estado: dos aprobaciones simultáneas → una gana, la otra recibe 409. |
| Reportes | Generados en el backend: respetan alcance y costos. Exportar exige `reporte.exportar` y queda auditado. Sincrónicos con tope de 20 000 filas (cola BullMQ pendiente para volúmenes mayores). |
| 2FA | TOTP (RFC 6238) con secreto cifrado AES-256-GCM (`MFA_ENCRYPTION_KEY`). Si el usuario tiene 2FA o su rol lo exige, el login no entrega sesión hasta validar el segundo factor. Un mismo código no se acepta dos veces; 5 intentos fallidos invalidan el desafío. |
| Compras/ventas | Confirmar genera la entrada/salida de kardex en la misma transacción; el movimiento solo se revierte anulando el documento. Comprobantes duplicados rechazados por la BD. |
| Plataforma | Tablas globales a las que el rol de los estudios **no tiene acceso** (`REVOKE`). JWT con secreto y audiencia propios (`JWT_PLATAFORMA_SECRET`), cookie y sesiones separadas: un token de estudio no sirve en la plataforma ni viceversa. No existe suplantación de usuarios. |
| Reportes grandes | La vista previa se corta en 500 filas. Las exportaciones van a una **cola BullMQ**: el worker lee por lotes (cursor) y escribe Excel/PDF en streaming, sin cargar todo en memoria; revalida permisos al procesar, notifica el avance por Socket.io y solo quien la pidió descarga el archivo (24 h). PDF limitado a 30 000 filas; Excel sin límite. Worker embebido o aparte con `npm run worker` (`REPORTES_WORKER_EMBEBIDO=false`). |
| PWA | Solo se cachea la aplicación (HTML/JS/CSS). Los datos de la API nunca se guardan en caché del dispositivo. |
| Tiempo real | Socket.io autenticado con JWT; salas por tenant/empresa/almacén según el alcance; al cambiar permisos se recalculan las salas. |

## Estado por fases

- [x] **Fase 1** — Estudio, empresas, RBAC dinámico completo, usuarios e invitaciones, sesiones, auditoría, sedes, almacenes y layout responsivo.
- [x] **Fase 2** — Productos, Kardex (entradas, salidas, anulación por movimiento inverso), valorización PEPS / Promedio ponderado, stock mínimo/máximo con alertas en tiempo real.
- [x] **Fase 3** — Transferencias (solicitud → aprobación → despacho → recepción, con faltantes), reportes con exportación a Excel/PDF (stock por almacén/sede/consolidado, movimientos, valorización a fecha de corte, transferencias, kardex por producto) y portal cliente.
- [x] **Reportes grandes** — Exportación en segundo plano con cola (BullMQ), lotes y streaming, avance en tiempo real, descarga automática y "Mis exportaciones".
- [x] **Módulo C** — Plataforma SaaS: autenticación separada con 2FA obligatorio (roles ADMIN/SOPORTE), alta y suspensión de estudios (corte inmediato de sesiones), planes con límites aplicados en el backend, facturación mensual idempotente con registro de pagos, monitoreo de servicios y uso, soporte sin suplantación y auditoría de plataforma inmutable.
- [x] **Fase 4** — Compras y ventas integradas al kardex (borrador → confirmado → anulado, IGV, PEN/USD con tipo de cambio, margen por venta), lector de código de barras con la cámara, 2FA TOTP (obligatorio por rol, códigos de recuperación, restablecimiento por administrador), PWA instalable y verificación responsiva de todas las pantallas en 360/768/1280 px.

Al agregar permisos nuevos al catálogo (`npm run db:seed`), se asignan automáticamente a los roles plantilla que los incluyen; los roles editados por cada estudio no se modifican.
