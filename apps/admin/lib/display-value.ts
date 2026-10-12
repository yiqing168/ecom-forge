export function displayValue(value: unknown, fallback = '-'): string {
  if (typeof value === 'string') return value || fallback;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  return fallback;
}
