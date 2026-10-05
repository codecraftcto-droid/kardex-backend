import { z } from 'zod';

export const email = () => z.string().trim().toLowerCase().pipe(z.email('Correo inválido'));
export const textoOpcional = (max) => z.string().trim().max(max).nullish().transform((v) => v || null);
export const filtroListado = z.object({
  q: z.string().trim().max(100).optional(),
  activo: z.enum(['true', 'false']).optional(),
  empresaId: z.uuid().optional(),
  sedeId: z.uuid().optional(),
  pagina: z.string().optional(),
  porPagina: z.string().optional(),
});
