import { describe, it, expect } from 'vitest';
import { construirPermisos, puede, tieneAlguno, whereAlcance, empresasConAcceso } from '../src/rbac/resolver.js';

const E1 = 'e1', E2 = 'e2', S1 = 's1', A1 = 'a1', A2 = 'a2';
const alc = {
  estudio: { tipo: 'estudio', id: null, empresaId: null, sedeId: null },
  e1: { tipo: 'empresa', id: E1, empresaId: E1, sedeId: null },
  s1: { tipo: 'sede', id: S1, empresaId: E1, sedeId: S1 },
  a1: { tipo: 'almacen', id: A1, empresaId: E1, sedeId: S1 },
};
const recA1 = { empresaId: E1, sedeId: S1, almacenId: A1 };
const recA2 = { empresaId: E1, sedeId: 's2', almacenId: A2 };
const recE2 = { empresaId: E2 };

describe('resolución de permisos', () => {
  it('alcance estudio cubre todo', () => {
    const p = construirPermisos({ tipoUsuario: 'interno', asignaciones: [{ alcance: alc.estudio, permisos: ['x.ver'] }] });
    expect(puede(p, 'x.ver', recA1)).toBe(true);
    expect(puede(p, 'x.ver', recE2)).toBe(true);
    expect(puede(p, 'x.ver', {})).toBe(true);
  });

  it('alcance empresa hereda hacia abajo pero no cubre otras empresas ni el estudio', () => {
    const p = construirPermisos({ tipoUsuario: 'interno', asignaciones: [{ alcance: alc.e1, permisos: ['x.ver'] }] });
    expect(puede(p, 'x.ver', recA1)).toBe(true);
    expect(puede(p, 'x.ver', recA2)).toBe(true);
    expect(puede(p, 'x.ver', recE2)).toBe(false);
    expect(puede(p, 'x.ver', {})).toBe(false);
  });

  it('alcance almacén solo cubre ese almacén', () => {
    const p = construirPermisos({ tipoUsuario: 'interno', asignaciones: [{ alcance: alc.a1, permisos: ['x.ver'] }] });
    expect(puede(p, 'x.ver', recA1)).toBe(true);
    expect(puede(p, 'x.ver', recA2)).toBe(false);
    expect(puede(p, 'x.ver', { empresaId: E1 })).toBe(false);
  });

  it('unión de varios roles', () => {
    const p = construirPermisos({
      tipoUsuario: 'interno',
      asignaciones: [{ alcance: alc.a1, permisos: ['a'] }, { alcance: alc.e1, permisos: ['b'] }],
    });
    expect(puede(p, 'a', recA1)).toBe(true);
    expect(puede(p, 'b', recA2)).toBe(true);
    expect(puede(p, 'a', recA2)).toBe(false);
  });

  it('deny tiene prioridad sobre allow y sobre roles', () => {
    const p = construirPermisos({
      tipoUsuario: 'interno',
      asignaciones: [{ alcance: alc.e1, permisos: ['x.ver'] }],
      excepciones: [
        { alcance: alc.s1, permiso: 'x.ver', efecto: 'deny' },
        { alcance: alc.a1, permiso: 'x.ver', efecto: 'allow' },
      ],
    });
    expect(puede(p, 'x.ver', recA1)).toBe(false);
    expect(puede(p, 'x.ver', recA2)).toBe(true);
  });

  it('allow puntual otorga un permiso que ningún rol da', () => {
    const p = construirPermisos({ tipoUsuario: 'interno', asignaciones: [], excepciones: [{ alcance: alc.a1, permiso: 'z', efecto: 'allow' }] });
    expect(tieneAlguno(p, 'z')).toBe(true);
    expect(puede(p, 'z', recA1)).toBe(true);
  });

  it('usuario cliente: solo permisos de lectura y solo en su empresa', () => {
    const p = construirPermisos({
      tipoUsuario: 'cliente',
      empresaCliente: E1,
      permisosLectura: new Set(['x.ver']),
      asignaciones: [
        { alcance: alc.e1, permisos: ['x.ver', 'x.crear'] },
        { alcance: alc.estudio, permisos: ['x.ver'] },
        { alcance: { tipo: 'empresa', id: E2, empresaId: E2 }, permisos: ['x.ver'] },
      ],
    });
    expect(puede(p, 'x.ver', recA1)).toBe(true);
    expect(puede(p, 'x.crear', recA1)).toBe(false);
    expect(puede(p, 'x.ver', recE2)).toBe(false);
  });

  it('whereAlcance genera filtros por nivel', () => {
    const p = construirPermisos({
      tipoUsuario: 'interno',
      asignaciones: [{ alcance: alc.e1, permisos: ['v'] }, { alcance: alc.a1, permisos: ['v'] }],
      excepciones: [{ alcance: alc.s1, permiso: 'v', efecto: 'deny' }],
    });
    expect(whereAlcance(p, 'v', 'almacen')).toEqual({
      OR: [{ empresaId: { in: [E1] } }, { id: { in: [A1] } }],
      NOT: { OR: [{ sedeId: { in: [S1] } }] },
    });
    expect(whereAlcance(p, 'v', 'empresa')).toEqual({ OR: [{ id: { in: [E1] } }] });
    expect(whereAlcance(p, 'otro', 'empresa')).toBeNull();
  });

  it('whereAlcance: rol solo en almacén no ve la empresa', () => {
    const p = construirPermisos({ tipoUsuario: 'interno', asignaciones: [{ alcance: alc.a1, permisos: ['v'] }] });
    expect(whereAlcance(p, 'v', 'empresa')).toBeNull();
    expect(empresasConAcceso(p)).toEqual([E1]);
  });
});
