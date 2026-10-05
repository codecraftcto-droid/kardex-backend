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
