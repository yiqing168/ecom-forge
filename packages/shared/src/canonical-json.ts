import { createHash } from 'node:crypto';

/**
 * Canonical ordering must be reproducible in **every** environment, and `localeCompare` without an
 * explicit locale is not: it follows the host's default locale/ICU, and real locales reorder
 * ordinary snake_case keys (Czech treats `ch` as a single letter, so `changed_items` sorts after
 * every `h…` key instead of after `c…`). `canonicalSha256` is recomputed independently by the
 * writer (API) and the reader (Worker), so a locale difference between those processes would give
 * the same payload two different digests and every read would fail as a digest mismatch.
 *
 * Compare NFC-normalized code units instead: no locale, no ICU version, no insertion order. The
 * normalization keeps the ambiguity guard below meaningful — two distinct keys that Unicode
 * considers equivalent still compare equal, so they are still rejected rather than silently
 * ordered by insertion.
 */
function compareCanonicalKeys(left: string, right: string): number {
  const normalizedLeft = left.normalize('NFC');
  const normalizedRight = right.normalize('NFC');
  if (normalizedLeft < normalizedRight) return -1;
  if (normalizedLeft > normalizedRight) return 1;
  return 0;
}

/**
 * Detects distinct keys whose canonical order would depend on their insertion order, i.e. keys that
 * Unicode normalization treats as equivalent but that are byte-different. Such payloads are
 * rejected instead of being canonicalized, because their digest would otherwise depend on the order
 * the object happened to be built in.
 */
export function hasAmbiguousCanonicalKeys(keys: readonly string[]): boolean {
  const sorted = [...keys];
  if (sorted.some((key) => typeof key !== 'string')) {
    throw new Error('Canonical JSON object keys must be strings');
  }
  sorted.sort(compareCanonicalKeys);
  return sorted.some((key, index) => {
    const previous = sorted[index - 1];
    return previous !== undefined && key !== previous && compareCanonicalKeys(previous, key) === 0;
  });
}

function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Canonical JSON numbers must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => compareCanonicalKeys(left, right));
    return `{${entries
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalize(nested)}`)
      .join(',')}}`;
  }
  throw new Error('Canonical JSON accepts only JSON-compatible values');
}

export function canonicalJson(value: unknown): string {
  return canonicalize(value);
}

export function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function utf8Sha256(value: string): string {
  return createHash('sha256').update(value.replaceAll('\r\n', '\n'), 'utf8').digest('hex');
}
