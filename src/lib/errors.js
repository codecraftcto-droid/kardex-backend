export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const noAutenticado = (msg = 'No autenticado') => new HttpError(401, msg);
export const prohibido = (msg = 'No tiene permiso para esta acción') => new HttpError(403, msg);
export const noEncontrado = (msg = 'Recurso no encontrado') => new HttpError(404, msg);
export const conflicto = (msg) => new HttpError(409, msg);
export const solicitudInvalida = (msg, details) => new HttpError(400, msg, details);

/** La operación excede lo que el usuario puede hacer solo: necesita que un supervisor la autorice. */
export const autorizacionRequerida = (tipo, msg) => new HttpError(403, msg, { codigo: 'AUTORIZACION_REQUERIDA', tipo });
