import { describe, expect, it } from 'vitest';

import {
  addMoney,
  compareMoney,
  divideMoney,
  grossMarginSatisfied,
  moneyEquals,
  multiplyMoney,
  normalizeMoney,
  subtractMoney,
} from './money.js';

describe('money utilities', () => {
  it('normalizes values to two decimal places', () => {
    expect(normalizeMoney('12')).toBe('12.00');
    expect(normalizeMoney('-0.001')).toBe('0.00');
  });

  it('uses ROUND_HALF_UP for positive and negative values', () => {
    expect(normalizeMoney('1.005')).toBe('1.01');
    expect(normalizeMoney('-1.005')).toBe('-1.01');
  });

  it('performs decimal arithmetic without floating-point drift', () => {
    expect(addMoney('0.10', '0.20')).toBe('0.30');
    expect(subtractMoney('1.00', '0.33')).toBe('0.67');
    expect(multiplyMoney('0.15', '3')).toBe('0.45');
    expect(divideMoney('1.00', '3')).toBe('0.33');
  });

  it('compares equivalent decimal representations', () => {
    expect(compareMoney('1.0', '1.00')).toBe(0);
    expect(compareMoney('-1.00', '0.00')).toBe(-1);
    expect(moneyEquals('2.500', '2.50')).toBe(true);
  });

  it('checks gross margin without floating-point arithmetic', () => {
    expect(grossMarginSatisfied('0.20', '0.09', '0.50')).toBe(true);
    expect(grossMarginSatisfied('0.17', '0.09', '0.50')).toBe(false);
    expect(grossMarginSatisfied('1.00', '0.01', '1.00')).toBe(false);
  });

  it.each(['NaN', 'Infinity', '1e3', ' 1.00', '01.00', ''])('rejects invalid input %j', (value) => {
    expect(() => normalizeMoney(value)).toThrow('Money values must be plain decimal strings');
  });

  it('rejects number input at runtime', () => {
    expect(() => normalizeMoney(0.1 as unknown as string)).toThrow(
      'Money values must be plain decimal strings',
    );
  });

  it('rejects division by zero', () => {
    expect(() => divideMoney('1.00', '0')).toThrow('Money values cannot be divided by zero');
  });

  it('enforces the database numeric(18, 2) range after rounding', () => {
    expect(normalizeMoney('9999999999999999.99')).toBe('9999999999999999.99');
    expect(() => normalizeMoney('9999999999999999.999')).toThrow(
      'Money value exceeds numeric(18, 2) range',
    );
  });
});
