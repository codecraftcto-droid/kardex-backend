import { simulado } from './simulado.js';
import { nubefact } from './nubefact.js';

/** Conectores disponibles. Agregar un proveedor = escribir su conector y registrarlo aquí. */
export const PROVEEDORES = { SIMULADO: simulado, NUBEFACT: nubefact };
