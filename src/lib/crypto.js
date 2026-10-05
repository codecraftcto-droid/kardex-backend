import crypto from 'node:crypto';

export const tokenAleatorio = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (valor) => crypto.createHash('sha256').update(valor).digest('hex');

/** Comparación en tiempo constante de dos hashes hex. */
export function hashIguales(a, b) {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
