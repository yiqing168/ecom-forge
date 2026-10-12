import { describe, expect, it } from 'vitest';

import { canonicalJson, canonicalSha256, utf8Sha256 } from './canonical-json.js';
import { hasAmbiguousCanonicalKeys } from './index.js';

describe('canonical JSON', () => {
  it('sorts object keys recursively and ignores undefined fields', () => {
    expect(canonicalJson({ z: 1, a: { y: true, x: 'ok' }, omitted: undefined })).toBe(
      '{"a":{"x":"ok","y":true},"z":1}',
    );
  });

  it('produces stable digests for equivalent values', () => {
    expect(canonicalSha256({ b: 2, a: 1 })).toBe(canonicalSha256({ a: 1, b: 2 }));
  });

  it('hashes normalized UTF-8 text independently from canonical JSON', () => {
    expect(utf8Sha256('a\r\nb')).toBe(utf8Sha256('a\nb'));
    expect(utf8Sha256('a')).not.toBe(canonicalSha256('a'));
  });
});

describe('canonical key ambiguity', () => {
  it.each([
    [[], false],
    [[''], false],
    [['same', 'same'], false],
    [['z', 'a', '10', '2'], false],
    [['\u00e9'], false],
    [['e\u0301'], false],
    [['e', '\u00e9', '\u5c71'], false],
    [['\u00e9', 'e\u0301'], true],
    [['e\u0301', '\u00e9'], true],
    [['z', '\u00e9', 'a', 'e\u0301', '\u00e9'], true],
  ] as const)('checks %j without confusing identical keys with ambiguity', (keys, expected) => {
    expect(hasAmbiguousCanonicalKeys(keys)).toBe(expected);
  });

  it('does not mutate caller order or change existing canonical/hash semantics', () => {
    const value = { z: 0, ['\u00e9']: 1, ['e\u0301']: 2, a: 3 };
    const keys = Object.freeze(Object.keys(value));
    const original = canonicalJson(value);
    const digest = canonicalSha256(value);
    // Code-point order over NFC-normalized keys: `a` < `z` < `é`. The two equivalent spellings of
    // `é` compare equal, so a stable sort keeps their insertion order.
    expect(original).toBe('{"a":3,"z":0,"\u00e9":1,"e\u0301":2}');
    expect(hasAmbiguousCanonicalKeys(keys)).toBe(true);
    expect(keys).toEqual(['z', '\u00e9', 'e\u0301', 'a']);
    expect(Object.keys(value)).toEqual(keys);
    expect(canonicalJson(value)).toBe(original);
    expect(canonicalSha256(value)).toBe(digest);
    expect(canonicalSha256({ z: 0, ['e\u0301']: 2, ['\u00e9']: 1, a: 3 })).not.toBe(digest);
  });

  it('orders keys independently of the runtime locale', () => {
    // `changed_items` is the real-world trigger: Czech collation treats `ch` as one letter and
    // sorts it after `h`, so a locale-aware comparator would put it after `i`/`l` instead of after
    // `c`. Canonical output is recomputed by both the writer and the reader process, so a locale
    // difference would produce two digests for one payload and every read would fail.
    const value = { content_hash: 'h', changed_items: [], call_ordinal: 1, in_bindings: 'i' };
    expect(canonicalJson(value)).toBe(
      '{"call_ordinal":1,"changed_items":[],"content_hash":"h","in_bindings":"i"}',
    );
    // The same payload must hash identically no matter which locale the process runs under.
    expect(canonicalSha256(value)).toBe(canonicalSha256({ ...value }));
    expect([...Object.keys(value)].sort()).toEqual([
      'call_ordinal',
      'changed_items',
      'content_hash',
      'in_bindings',
    ]);
  });

  it.each([42, null, undefined, Symbol('private'), { key: 'private' }])(
    'rejects non-string keys instead of coercing %j',
    (key) => {
      expect(() => hasAmbiguousCanonicalKeys([key] as unknown as string[])).toThrow(
        'Canonical JSON object keys must be strings',
      );
    },
  );
});
