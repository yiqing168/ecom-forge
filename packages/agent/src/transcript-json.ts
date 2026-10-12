import { canonicalJson, canonicalSha256, hasAmbiguousCanonicalKeys } from '@ecom-forge/shared';
import type { z } from 'zod';

export type TranscriptJsonFailure =
  'json_invalid' | 'content_invalid' | 'content_changed' | 'content_too_large';

export class TranscriptJsonError extends Error {
  constructor(
    readonly reason: TranscriptJsonFailure,
    /** Bounded path + cause of the failure (e.g. `nodes.0.params: undefined`). */
    readonly detail?: string,
  ) {
    super('AGENT_TRANSCRIPT_JSON_INVALID');
    this.name = 'TranscriptJsonError';
  }
}

export function verifyTranscriptJsonContent<T>(
  input: unknown,
  schema: z.ZodType<T>,
  maxBytes: number,
) {
  assertTranscriptJsonObject(input);
  const before = serialize(input);
  const byteSize = Buffer.byteLength(before, 'utf8');
  if (byteSize > maxBytes) fail('content_too_large');

  // Both validators use the same immutable snapshot and lossless domain-schema check.
  const snapshot: unknown = freezeTranscriptJson(JSON.parse(before) as unknown);
  let parsed: T;
  try {
    const result = schema.safeParse(snapshot);
    if (!result.success) fail('content_invalid');
    parsed = result.data;
  } catch {
    fail('content_invalid');
  }
  assertTranscriptJsonObject(parsed);
  if (serialize(parsed) !== before) fail('content_changed');
  return { value: freezeTranscriptJson(parsed), byteSize, digest: canonicalSha256(parsed) };
}

export function assertTranscriptJsonObject(input: unknown): void {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      fail('json_invalid', '(root): not a plain object');
    const ancestors = new Set<object>();
    const stack: Array<{ value: unknown; path: string; exit?: boolean }> = [
      { value: input, path: '(root)' },
    ];
    while (stack.length > 0) {
      const entry = stack.pop()!;
      const value = entry.value;
      const where = entry.path;
      if (typeof value === 'string') {
        assertJsonString(value, where);
        continue;
      }
      if (value === null || typeof value === 'boolean') continue;
      if (typeof value === 'number' && Number.isFinite(value)) continue;
      if (typeof value !== 'object') {
        // `undefined` and non-finite numbers are the usual culprits here.
        fail('json_invalid', `${where}: ${typeof value} is not JSON-serializable`);
      }
      if (entry.exit) {
        ancestors.delete(value);
        continue;
      }
      if (ancestors.has(value)) fail('json_invalid', `${where}: circular reference`);
      ancestors.add(value);
      stack.push({ value, path: where, exit: true });
      const isArray = Array.isArray(value);
      const prototype: unknown = Object.getPrototypeOf(value);
      if (
        isArray
          ? prototype !== Array.prototype
          : prototype !== Object.prototype && prototype !== null
      ) {
        const ctor = (value as { constructor?: { name?: string } }).constructor?.name;
        fail('json_invalid', `${where}: non-plain object (${ctor ?? 'unknown'})`);
      }
      const keys = Reflect.ownKeys(value);
      if (!keys.every((key): key is string => typeof key === 'string'))
        fail('json_invalid', `${where}: non-string key`);
      if (isArray && keys.length !== value.length + 1)
        fail('json_invalid', `${where}: sparse array`);
      if (!isArray && hasAmbiguousCanonicalKeys(keys))
        fail('json_invalid', `${where}: ambiguous canonical keys`);
      for (const key of keys) {
        assertJsonString(key, where);
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (!('value' in descriptor)) fail('json_invalid', `${where}.${key}: accessor property`);
        if (isArray && key === 'length') continue;
        if (!descriptor.enumerable) fail('json_invalid', `${where}.${key}: non-enumerable`);
        if (isArray && (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) {
          fail('json_invalid', `${where}.${key}: invalid array index`);
        }
        stack.push({ value: descriptor.value, path: `${where}.${key}` });
      }
    }
  } catch (error) {
    // Never re-wrap our own diagnostic: that erased the only path information a production
    // failure could be located from.
    if (error instanceof TranscriptJsonError) throw error;
    fail('json_invalid', 'unexpected validation failure');
  }
}

export function freezeTranscriptJson<T>(input: T): T {
  const stack: unknown[] = [input];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const value = stack.pop();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    for (const child of Object.values(value)) stack.push(child);
    Object.freeze(value);
  }
  return input;
}

function serialize(input: unknown): string {
  try {
    return canonicalJson(input);
  } catch {
    fail('json_invalid');
  }
}

function assertJsonString(value: string, where: string): void {
  if (
    value.includes('\u0000') ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)
  ) {
    fail('json_invalid', `${where}: invalid string (NUL or lone surrogate)`);
  }
}

function fail(reason: TranscriptJsonFailure, detail?: string): never {
  throw new TranscriptJsonError(reason, detail);
}
