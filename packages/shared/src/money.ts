import { Decimal } from 'decimal.js';

const MONEY_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const MONEY_SCALE = 2;
const MoneyDecimal = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
const MAX_MONEY_ABS = new MoneyDecimal('9999999999999999.99');

export type MoneyString = string;

function parseDecimal(value: MoneyString): Decimal {
  if (typeof value !== 'string' || !MONEY_PATTERN.test(value)) {
    throw new TypeError('Money values must be plain decimal strings');
  }

  const decimal = new MoneyDecimal(value);
  if (!decimal.isFinite()) {
    throw new RangeError('Money values must be finite');
  }

  return decimal;
}

function formatDecimal(value: Decimal): MoneyString {
  const rounded = value.toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_HALF_UP);
  if (rounded.abs().greaterThan(MAX_MONEY_ABS)) {
    throw new RangeError('Money value exceeds numeric(18, 2) range');
  }

  return rounded.isZero() ? '0.00' : rounded.toFixed(MONEY_SCALE);
}

export function normalizeMoney(value: MoneyString): MoneyString {
  return formatDecimal(parseDecimal(value));
}

export function addMoney(first: MoneyString, ...rest: MoneyString[]): MoneyString {
  return formatDecimal(
    rest.reduce((total, value) => total.plus(parseDecimal(value)), parseDecimal(first)),
  );
}

export function subtractMoney(minuend: MoneyString, subtrahend: MoneyString): MoneyString {
  return formatDecimal(parseDecimal(minuend).minus(parseDecimal(subtrahend)));
}

export function multiplyMoney(amount: MoneyString, multiplier: MoneyString): MoneyString {
  return formatDecimal(parseDecimal(amount).times(parseDecimal(multiplier)));
}

export function divideMoney(dividend: MoneyString, divisor: MoneyString): MoneyString {
  const parsedDivisor = parseDecimal(divisor);
  if (parsedDivisor.isZero()) {
    throw new RangeError('Money values cannot be divided by zero');
  }

  return formatDecimal(parseDecimal(dividend).dividedBy(parsedDivisor));
}

export function compareMoney(left: MoneyString, right: MoneyString): -1 | 0 | 1 {
  const comparison = parseDecimal(left).comparedTo(parseDecimal(right));
  return comparison < 0 ? -1 : comparison > 0 ? 1 : 0;
}

export function moneyEquals(left: MoneyString, right: MoneyString): boolean {
  return compareMoney(left, right) === 0;
}

export function grossMarginSatisfied(
  revenue: MoneyString,
  totalCost: MoneyString,
  grossMarginTarget: MoneyString,
): boolean {
  const margin = parseDecimal(grossMarginTarget);
  if (margin.isNegative() || margin.greaterThanOrEqualTo(1)) return false;
  return parseDecimal(revenue)
    .times(new MoneyDecimal(1).minus(margin))
    .greaterThanOrEqualTo(parseDecimal(totalCost));
}
