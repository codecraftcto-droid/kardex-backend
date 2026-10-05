import argon2 from 'argon2';
import { z } from 'zod';
import { env } from '../config/env.js';

const OPCIONES = { type: argon2.argon2id };
// Hash ficticio para igualar tiempos cuando el usuario no existe (evita enumeración)
const HASH_FICTICIO = await argon2.hash('contraseña-ficticia', OPCIONES);

export const hashPassword = (plano) => argon2.hash(plano, OPCIONES);
export const verificarPassword = (hash, plano) => argon2.verify(hash || HASH_FICTICIO, plano).catch(() => false);

/** Política mínima configurable de contraseñas. */
export const esquemaPassword = z
  .string()
  .min(env.PASSWORD_MIN_LENGTH, `Debe tener al menos ${env.PASSWORD_MIN_LENGTH} caracteres`)
  .max(128)
  .regex(/[a-zA-Z]/, 'Debe contener al menos una letra')
  .regex(/[0-9]/, 'Debe contener al menos un número');
