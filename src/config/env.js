import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  APP_URL: z.string().default('http://localhost:5173'),
  DATABASE_URL: z.string(),
  DATABASE_APP_URL: z.string(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  JWT_ACCESS_SECRET: z.string().min(16),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  /** Secreto DISTINTO para la plataforma: un token de estudio nunca sirve en la plataforma */
  JWT_PLATAFORMA_SECRET: z.string().min(32),
  REFRESH_TOKEN_DIAS: z.coerce.number().default(7),
  PASSWORD_MIN_LENGTH: z.coerce.number().default(8),
  LOGIN_MAX_INTENTOS: z.coerce.number().default(5),
  LOGIN_BLOQUEO_MINUTOS: z.coerce.number().default(15),
  /** Intentos de login por IP cada 15 minutos */
  LOGIN_RATE_LIMIT: z.coerce.number().default(10),
  IGV_TASA: z.coerce.number().min(0).max(1).default(0.18),
  /** Carpeta de archivos de exportación (se borran a las 24 h) */
  REPORTES_DIR: z.string().default('./storage/reportes'),
  /** true: el worker de reportes corre dentro de la API; false: proceso aparte (npm run worker) */
  REPORTES_WORKER_EMBEBIDO: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  /** Clave para cifrar los secretos 2FA (64 caracteres hex = 32 bytes) */
  MFA_ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/i, 'MFA_ENCRYPTION_KEY debe tener 64 caracteres hexadecimales'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default('Kardex <no-reply@kardex.local>'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Variables de entorno inválidas:', z.prettifyError(parsed.error));
  process.exit(1);
}

export const env = {
  ...parsed.data,
  isProd: parsed.data.NODE_ENV === 'production',
  corsOrigins: parsed.data.CORS_ORIGINS.split(',').map((s) => s.trim()),
};
