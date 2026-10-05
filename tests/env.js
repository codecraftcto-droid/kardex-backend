// Las pruebas usan una BD y un índice de Redis separados de desarrollo.
try { process.loadEnvFile('.env'); } catch { /* sin .env: se usan los valores por defecto */ }
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://kardex_owner:kardex_owner@localhost:5432/kardex_test';
process.env.DATABASE_APP_URL = process.env.TEST_DATABASE_APP_URL || 'postgresql://kardex_app:kardex_app@localhost:5432/kardex_test';
process.env.REDIS_URL = process.env.TEST_REDIS_URL || 'redis://localhost:6379/15';
// Las pruebas inician muchas sesiones desde la misma IP
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.MFA_ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.REPORTES_DIR = `${process.env.TMPDIR || '/tmp'}/kardex-pruebas-reportes`;
process.env.REPORTES_LIMITE_PDF = '10000';
process.env.JWT_PLATAFORMA_SECRET ||= 'secreto-de-plataforma-para-pruebas-0123456789';
process.env.JWT_ACCESS_SECRET ||= 'secreto-de-pruebas-suficientemente-largo';
