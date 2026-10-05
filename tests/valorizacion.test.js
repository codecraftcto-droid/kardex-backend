import { describe, it, expect } from 'vitest';
import { D, entrada, salidaPromedio, salidaPEPS, salidaACosto, costoPromedio } from '../src/kardex/valorizacion.js';

const vacio = () => ({ cantidad: D(0), valor: D(0) });
const s = (x) => x.toString();

describe('promedio ponderado', () => {
  it('recalcula el costo promedio en cada entrada y sale a ese costo', () => {
    let saldo = entrada(vacio(), D(100), '18.5').saldo;
    saldo = salidaPromedio(saldo, D(40)).saldo;
    expect(s(saldo.valor)).toBe('1110');
    saldo = entrada(saldo, D(60), '19.7').saldo;
    expect(s(costoPromedio(saldo))).toBe('19.1');
    const r = salidaPromedio(saldo, D(70));
    expect(s(r.costoTotal)).toBe('1337');
    expect(s(r.saldo.valor)).toBe('955');
  });

  it('la última unidad se lleva el valor restante (sin residuos de redondeo)', () => {
    let saldo = entrada(vacio(), D(3), '10').saldo;
    saldo = entrada(saldo, D(3), '10.01').saldo; // promedio 10.005
    saldo = salidaPromedio(saldo, D(5)).saldo;
    const r = salidaPromedio(saldo, D(1));
    expect(s(r.saldo.cantidad)).toBe('0');
    expect(s(r.saldo.valor)).toBe('0');
  });

  it('rechaza salidas mayores al stock', () => {
    const saldo = entrada(vacio(), D(5), '1').saldo;
    expect(() => salidaPromedio(saldo, D(6))).toThrow(/Stock insuficiente/);
  });
});

describe('PEPS', () => {
  it('consume primero las capas más antiguas', () => {
    let saldo = entrada(vacio(), D(200), '27.5').saldo;
    saldo = entrada(saldo, D(100), '29.9').saldo;
    const capas = [
      { id: 1, cantidadRestante: '200', costoUnitario: '27.5' },
      { id: 2, cantidadRestante: '100', costoUnitario: '29.9' },
    ];
    const r = salidaPEPS(saldo, capas, D(220));
    expect(s(r.costoTotal)).toBe('6098'); // 200×27.5 + 20×29.9
    expect(r.consumos.map((c) => [c.id, s(c.restante)])).toEqual([[1, '0'], [2, '80']]);
    expect(s(r.saldo.valor)).toBe('2392');
  });

  it('salida a costo específico (reversión de entrada)', () => {
    const saldo = entrada(vacio(), D(10), '5').saldo;
    const r = salidaACosto(entrada(saldo, D(10), '15').saldo, D(10), '5');
    expect(s(r.saldo.valor)).toBe('150');
    expect(s(costoPromedio(r.saldo))).toBe('15');
  });

  it('impide dejar valor negativo', () => {
    let saldo = entrada(vacio(), D(10), '100').saldo;
    saldo = salidaPromedio(saldo, D(9)).saldo;
    saldo = entrada(saldo, D(10), '1').saldo;
    expect(() => salidaACosto(saldo, D(10), '100')).toThrow(/negativo/);
  });
});
