import { solicitudInvalida } from '../lib/errors.js';

/** Valida y normaliza req.body / req.query con un esquema Zod. */
export const validar = (schema, origen = 'body') => (req, _res, next) => {
  const r = schema.safeParse(req[origen] ?? {});
  if (!r.success) {
    throw solicitudInvalida(
      'Datos inválidos',
      r.error.issues.map((i) => ({ campo: i.path.join('.'), mensaje: i.message })),
    );
  }
  if (origen === 'query') req.validQuery = r.data;
  else req[origen] = r.data;
  next();
};
