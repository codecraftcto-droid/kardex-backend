import { describe, it, expect } from 'vitest';
const r = await import('../src/pos/reglas.js');

describe('reglas del punto de venta', () => {
  it('valida el RUC con su dígito verificador', () => {
    expect(r.rucValido('20100070970')).toBe(true);
    expect(r.rucValido('20100070971')).toBe(false);
    expect(r.rucValido('30100070970')).toBe(false);
    expect(r.errorDocumento('DNI', '4567891')).toMatch(/8 dígitos/);
    expect(r.errorDocumento('DNI', '45678912')).toBeNull();
  });

  it('aplica las reglas SUNAT para identificar al comprador', () => {
    const varios = r.CLIENTES_VARIOS;
    const dni = { tipoDocumento: 'DNI' };
    const ruc = { tipoDocumento: 'RUC' };
    expect(r.errorCliente('FACTURA', dni, 10)).toMatch(/RUC/);
    expect(r.errorCliente('FACTURA', ruc, 10)).toBeNull();
    expect(r.errorCliente('BOLETA', varios, 699.99)).toBeNull();
    expect(r.errorCliente('BOLETA', varios, 700)).toMatch(/identificar/);
    expect(r.errorCliente('BOLETA', dni, 5000)).toBeNull();
    expect(r.errorCliente('NOTA_VENTA', varios, 5000)).toBeNull();
  });

  it('calcula base, IGV y total desde precios con IGV', () => {
    const c = r.calcularLineas([
      { cantidad: '2', precioUnitario: '11.80', descuento: '0', afectacionIgv: '10' },
      { cantidad: '1', precioUnitario: '5', descuento: '1', afectacionIgv: '20' },
    ]);
    expect([c.opGravada, c.opExonerada, c.igv, c.total, c.descuentoTotal].map(String)).toEqual(['20', '4', '3.6', '27.6', '1']);
  });

  it('pagos mixtos con vuelto; los medios no efectivo no pueden exceder', () => {
    const p = r.aplicarPagos('27.60', [{ medio: 'TARJETA', monto: '10' }, { medio: 'EFECTIVO', monto: '20' }]);
    expect(p.vuelto.toString()).toBe('2.4');
    expect(p.pagos.map((x) => [x.medio, x.monto.toString()])).toEqual([['TARJETA', '10'], ['EFECTIVO', '17.6']]);
    expect(r.aplicarPagos('10', [{ medio: 'YAPE', monto: '12' }]).error).toMatch(/superan/);
    expect(r.aplicarPagos('10', [{ medio: 'EFECTIVO', monto: '9' }]).error).toMatch(/faltan S\/ 1.00/);
  });

  it('expresa el monto en letras', () => {
    expect(r.montoEnLetras('1250.5')).toBe('SON: MIL DOSCIENTOS CINCUENTA CON 50/100 SOLES');
    expect(r.montoEnLetras('21')).toBe('SON: VEINTIUNO CON 00/100 SOLES');
    expect(r.montoEnLetras('31001')).toBe('SON: TREINTA Y UN MIL UNO CON 00/100 SOLES');
  });
});
