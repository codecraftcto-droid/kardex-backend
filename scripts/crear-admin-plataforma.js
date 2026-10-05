// Crea un usuario de la plataforma (Módulo C). Uso:
//   npm run plataforma:admin -- correo@dominio.com "Nombre Apellido" [ADMIN|SOPORTE]
// Genera una contraseña temporal que se muestra UNA vez. En su primer ingreso deberá
// configurar la verificación en dos pasos (obligatoria para la plataforma).
import crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';

const [email, nombres, rol = 'ADMIN'] = process.argv.slice(2);
if (!email || !nombres || !['ADMIN', 'SOPORTE'].includes(rol)) {
  console.error('Uso: npm run plataforma:admin -- correo@dominio.com "Nombre Apellido" [ADMIN|SOPORTE]');
  process.exit(1);
}

const prisma = new PrismaClient();
const password = crypto.randomBytes(12).toString('base64url') + '9a';
try {
  await prisma.plataformaAdmin.create({
    data: { email: email.toLowerCase(), nombres, rol, passwordHash: await argon2.hash(password, { type: argon2.argon2id }) },
  });
  console.log(`✔ Usuario de plataforma creado: ${email} (${rol})`);
  console.log(`  Contraseña temporal: ${password}`);
  console.log('  Guárdela ahora: no se volverá a mostrar.');
} catch (e) {
  console.error(e.code === 'P2002' ? 'Ya existe un usuario de plataforma con ese correo' : e.message);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
