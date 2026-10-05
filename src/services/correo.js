import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

const transporte = env.SMTP_HOST
  ? nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    })
  : null;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function enviar({ para, asunto, html, enlace }) {
  if (!transporte) {
    // Desarrollo local sin SMTP: el enlace se muestra en consola
    logger.warn({ para, asunto, enlace }, 'SMTP no configurado — correo no enviado');
    return;
  }
  await transporte.sendMail({ from: env.MAIL_FROM, to: para, subject: asunto, html });
}

export function enviarInvitacion({ email, nombres, token }) {
  const enlace = `${env.APP_URL}/activar?token=${encodeURIComponent(token)}`;
  return enviar({
    para: email,
    asunto: 'Invitación al sistema Kardex',
    enlace,
    html: `<p>Hola ${esc(nombres)},</p><p>Ha sido invitado al sistema Kardex. Active su cuenta y cree su contraseña aquí:</p><p><a href="${enlace}">${enlace}</a></p><p>El enlace vence en 72 horas.</p>`,
  });
}

export function enviarRecuperacion({ email, nombres, token }) {
  const enlace = `${env.APP_URL}/restablecer?token=${encodeURIComponent(token)}`;
  return enviar({
    para: email,
    asunto: 'Recuperación de contraseña — Kardex',
    enlace,
    html: `<p>Hola ${esc(nombres)},</p><p>Para crear una nueva contraseña ingrese aquí:</p><p><a href="${enlace}">${enlace}</a></p><p>El enlace vence en 1 hora y solo puede usarse una vez. Si no lo solicitó, ignore este correo.</p>`,
  });
}
