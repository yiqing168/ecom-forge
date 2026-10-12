import { canonicalJson, canonicalSha256 } from '@ecom-forge/shared';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { authoredPromptsSchema } from './prompt-authoring.js';
import { AGENT_TRANSCRIPT_LIMITS } from './runtime-defaults.js';
import {
  AgentTranscriptPayloadError,
  parseAgentTranscriptPayloadReference,
  prepareAgentTranscriptPayload,
  verifyAgentTranscriptPayload,
  type AgentTranscriptPayloadContract,
  type AgentTranscriptPayloadFailure,
} from './index.js';

const ids = {
  user: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  session: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  turn: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  payload: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  import: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  other: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
};
const scope = {
  user_id: ids.user,
  session_id: ids.session,
  turn_id: ids.turn,
  import_attempt_id: null,
};
const authoringContract = { kind: 'authoring', contentSchema: authoredPromptsSchema } as const;

function input(content: unknown, overrides: Record<string, unknown> = {}) {
  return {
    id: ids.payload,
    schema_version: 1,
    ...scope,
    kind: 'authoring',
    content_json: content,
    ...overrides,
  };
}

function authored(prompt = 'Preserve the observed light and composition.') {
  return { prompts: [{ candidate_key: 'image-1', creative_prompt: prompt }] };
}

function prepare() {
  return prepareAgentTranscriptPayload(input(authored()), authoringContract);
}

function expectFailure(run: () => unknown, reason: AgentTranscriptPayloadFailure) {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AgentTranscriptPayloadError);
  expect(caught).toMatchObject({ message: 'AGENT_TRANSCRIPT_PAYLOAD_INVALID', reason });
  expect(caught).not.toHaveProperty('cause');
  expect(caught).not.toHaveProperty('issues');
  return caught;
}

describe('private transcript payload integrity', () => {
  it('roundtrips the actual authoring schema through the public package surface', () => {
    const content = authored('First line\r\n\u5c71\u6c34 \ud83c\udf04 "light" \\ shadow');
    const result = prepareAgentTranscriptPayload(input(content), authoringContract);
    expect(result.record.content_json).toEqual(content);
    expect(result.record.content_digest).toBe(canonicalSha256(content));
    expect(result.record.byte_size).toBe(Buffer.byteLength(canonicalJson(content), 'utf8'));
    expect(result.reference).toEqual({
      schema_version: 1,
      type: 'private_payload',
      payload_id: ids.payload,
      kind: 'authoring',
      content_digest: result.record.content_digest,
      byte_size: result.record.byte_size,
    });
    const record: unknown = JSON.parse(JSON.stringify(result.record));
    const reference: unknown = JSON.parse(JSON.stringify(result.reference));
    const read = verifyAgentTranscriptPayload({ scope, record, reference }, authoringContract);
    expect(read).toEqual(content);
    expect(read).not.toBe(result.record.content_json);
  });

  it('keeps the canonical policy for key order, numbers, arrays and nulls', () => {
    const contract = {
      kind: 'tool',
      contentSchema: z.strictObject({ z: z.array(z.number().nullable()), a: z.boolean() }),
    } as const;
    const left = prepareAgentTranscriptPayload(
      input({ z: [1, null, -0], a: true }, { kind: 'tool' }),
      contract,
    );
    const right = prepareAgentTranscriptPayload(
      input({ a: true, z: [1, null, 0] }, { kind: 'tool' }),
      contract,
    );
    expect(left.record.content_digest).toBe(right.record.content_digest);
    expect(left.record.byte_size).toBe(right.record.byte_size);
    expect(left.record.content_json).toEqual({ a: true, z: [1, null, 0] });
  });

  it.each(['id', 'user_id', 'session_id', 'turn_id'] as const)(
    'canonicalizes UUID identity %s without changing semantic strings',
    (field) => {
      const raw = input(authored(ids.other.toUpperCase()));
      const expected = raw[field];
      raw[field] = expected.toUpperCase();
      const result = prepareAgentTranscriptPayload(raw, authoringContract);
      expect(result.record[field]).toBe(expected);
      expect(result.reference.payload_id).toBe(ids.payload);
      expect(result.record.content_json).toEqual(authored(ids.other.toUpperCase()));
      expect(verifyAgentTranscriptPayload({ scope, ...result }, authoringContract)).toEqual(
        raw.content_json,
      );
      expect(raw[field]).toBe(expected.toUpperCase());
    },
  );

  it.each(['scope', 'reference', 'record'] as const)(
    'compares UUID identity in %s independently of letter case',
    (part) => {
      const prepared = prepare();
      const parts = { scope, ...prepared };
      const identityKeys = [
        'id',
        'payload_id',
        'user_id',
        'session_id',
        'turn_id',
        'import_attempt_id',
      ];
      const uppercase = Object.fromEntries(
        Object.entries(parts[part]).map(([key, value]) => [
          key,
          identityKeys.includes(key) && typeof value === 'string' ? value.toUpperCase() : value,
        ]),
      );
      expect(
        verifyAgentTranscriptPayload({ ...parts, [part]: uppercase }, authoringContract),
      ).toEqual(authored());
    },
  );

  it('canonicalizes legacy import identity but still rejects a different UUID', () => {
    const contract = {
      kind: 'legacy_message',
      contentSchema: z.strictObject({ content: z.string() }),
    } as const;
    const legacyScope = { ...scope, turn_id: null, import_attempt_id: ids.import };
    const result = prepareAgentTranscriptPayload(
      input(
        { content: 'Original' },
        {
          ...legacyScope,
          kind: 'legacy_message',
          import_attempt_id: ids.import.toUpperCase(),
        },
      ),
      contract,
    );
    expect(result.record.import_attempt_id).toBe(ids.import);
    expect(verifyAgentTranscriptPayload({ scope: legacyScope, ...result }, contract)).toEqual({
      content: 'Original',
    });
    expectFailure(
      () =>
        verifyAgentTranscriptPayload(
          {
            scope: { ...legacyScope, import_attempt_id: ids.other.toUpperCase() },
            ...result,
          },
          contract,
        ),
      'scope_mismatch',
    );
  });

  it('separates and deeply freezes captured data from mutable inputs and read records', () => {
    const content = authored();
    const raw = input(content);
    const result = prepareAgentTranscriptPayload(raw, authoringContract);
    content.prompts[0]!.creative_prompt = 'Changed afterwards';
    raw.user_id = ids.other;
    expect(result.record.content_json).toEqual(authored());
    expect(result.record.user_id).toBe(ids.user);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.record)).toBe(true);
    expect(Object.isFrozen(result.reference)).toBe(true);
    expect(Object.isFrozen(result.record.content_json.prompts[0])).toBe(true);
    expect(() => result.record.content_json.prompts.push(content.prompts[0]!)).toThrow(TypeError);

    const stored = structuredClone(result);
    const read = verifyAgentTranscriptPayload({ scope, ...stored }, authoringContract);
    stored.record.content_json.prompts[0]!.creative_prompt = 'Late mutation';
    expect(read).toEqual(authored());
    expect(Object.isFrozen(read.prompts)).toBe(true);
  });

  it('freezes children even if a lossless parser freezes only the root', () => {
    const contract = {
      kind: 'authoring',
      contentSchema: authoredPromptsSchema.transform((content) => Object.freeze(content)),
    } as const;
    const result = prepareAgentTranscriptPayload(input(authored()), contract);
    expect(Object.isFrozen(result.record.content_json.prompts[0])).toBe(true);
  });

  it('accepts repeated JSON values without confusing them with a cycle', () => {
    const value = { count: 1 };
    const contract = {
      kind: 'tool',
      contentSchema: z.strictObject({
        left: z.strictObject({ count: z.number() }),
        right: z.strictObject({ count: z.number() }),
      }),
    } as const;
    const result = prepareAgentTranscriptPayload(
      input({ left: value, right: value }, { kind: 'tool' }),
      contract,
    );
    expect(result.record.content_digest).toBe(canonicalSha256({ left: value, right: value }));
  });

  it.each(['planning', 'authoring', 'tool'] as const)(
    'requires native ownership for %s',
    (kind) => {
      const contract = { kind, contentSchema: authoredPromptsSchema };
      const result = prepareAgentTranscriptPayload(input(authored(), { kind }), contract);
      expect(verifyAgentTranscriptPayload({ scope, ...result }, contract)).toEqual(authored());
      expectFailure(
        () => prepareAgentTranscriptPayload(input(authored(), { kind, turn_id: null }), contract),
        'metadata_invalid',
      );
      expectFailure(
        () =>
          prepareAgentTranscriptPayload(
            input(authored(), { kind, import_attempt_id: ids.import }),
            contract,
          ),
        'metadata_invalid',
      );
    },
  );

  it.each([null, ids.turn])(
    'keeps real legacy turn provenance %s within its import attempt',
    (turnId) => {
      // Synthetic legacy content checks scope only, not the future provenance importer.
      const contract = {
        kind: 'legacy_message',
        contentSchema: z.strictObject({ content: z.string() }),
      } as const;
      const legacyScope = { ...scope, turn_id: turnId, import_attempt_id: ids.import };
      const result = prepareAgentTranscriptPayload(
        input({ content: 'Original' }, { ...legacyScope, kind: 'legacy_message' }),
        contract,
      );
      expect(verifyAgentTranscriptPayload({ scope: legacyScope, ...result }, contract)).toEqual({
        content: 'Original',
      });
      expectFailure(
        () =>
          prepareAgentTranscriptPayload(
            input(
              { content: 'Original' },
              { ...legacyScope, kind: 'legacy_message', import_attempt_id: null },
            ),
            contract,
          ),
        'metadata_invalid',
      );
    },
  );

  it.each([
    { schema_version: 2 },
    { kind: 'provider_body' },
    { id: 'not-a-uuid' },
    { user_id: ids.user + '-extra' },
    { session_id: null },
    { turn_id: 1 },
    { import_attempt_id: false },
    { extra: 'not admitted' },
    { byte_size: 1 },
  ])('rejects malformed or extra preparation metadata: %j', (override) => {
    expectFailure(
      () => prepareAgentTranscriptPayload(input(authored(), override), authoringContract),
      'metadata_invalid',
    );
  });

  it('requires explicit nullable scope fields rather than inventing defaults', () => {
    const { import_attempt_id: omittedImport, ...missingImport } = input(authored());
    const { turn_id: omittedTurn, ...missingTurn } = input(authored());
    void omittedImport;
    void omittedTurn;
    expectFailure(
      () => prepareAgentTranscriptPayload(missingImport, authoringContract),
      'metadata_invalid',
    );
    expectFailure(
      () => prepareAgentTranscriptPayload(missingTurn, authoringContract),
      'metadata_invalid',
    );
  });

  it.each([
    { schema_version: 2 },
    { type: 'external_url' },
    { kind: 'raw_response' },
    { payload_id: 'not-a-uuid' },
    { content_digest: 'A'.repeat(64) },
    { byte_size: 0 },
    { byte_size: 1.5 },
    { byte_size: '10' },
    { byte_size: AGENT_TRANSCRIPT_LIMITS.privatePayloadBytes + 1 },
    { url: 'https://example.test/private' },
    { user_id: ids.other },
  ])('parses references strictly: %j', (override) => {
    expectFailure(
      () => parseAgentTranscriptPayloadReference({ ...prepare().reference, ...override }),
      'metadata_invalid',
    );
  });

  it('does not let a kind label select a different host schema', () => {
    expectFailure(
      () => prepareAgentTranscriptPayload(input(authored(), { kind: 'tool' }), authoringContract),
      'contract_mismatch',
    );
    expectFailure(
      () =>
        verifyAgentTranscriptPayload(
          { scope, ...prepare() },
          { ...authoringContract, kind: 'tool' },
        ),
      'contract_mismatch',
    );
  });

  it.each(['user_id', 'session_id', 'turn_id', 'import_attempt_id'] as const)(
    'rejects matching content outside expected %s',
    (field) => {
      expectFailure(
        () =>
          verifyAgentTranscriptPayload(
            { scope: { ...scope, [field]: ids.other }, ...prepare() },
            authoringContract,
          ),
        'scope_mismatch',
      );
    },
  );

  it.each(['payload_id', 'kind', 'content_digest', 'byte_size'] as const)(
    'rejects changed reference %s',
    (field) => {
      const result = prepare();
      const replacements = {
        payload_id: ids.other,
        kind: 'tool',
        content_digest: '0'.repeat(64),
        byte_size: result.reference.byte_size + 1,
      };
      expectFailure(
        () =>
          verifyAgentTranscriptPayload(
            { scope, ...result, reference: { ...result.reference, [field]: replacements[field] } },
            authoringContract,
          ),
        'reference_mismatch',
      );
    },
  );

  it('rejects read records and scopes with unexpected fields', () => {
    const result = prepare();
    expectFailure(
      () =>
        verifyAgentTranscriptPayload(
          { scope, ...result, record: { ...result.record, raw_body: 'private' } },
          authoringContract,
        ),
      'metadata_invalid',
    );
    expectFailure(
      () =>
        verifyAgentTranscriptPayload(
          { ...result, scope: { ...scope, authorized: true } },
          authoringContract,
        ),
      'metadata_invalid',
    );
  });

  it('recomputes content hashes even when record and reference claim the same digest', () => {
    const result = prepareAgentTranscriptPayload(input(authored('aaa')), authoringContract);
    const record = { ...result.record, content_json: authored('bbb') };
    expectFailure(
      () => verifyAgentTranscriptPayload({ scope, ...result, record }, authoringContract),
      'digest_mismatch',
    );
    expectFailure(
      () =>
        verifyAgentTranscriptPayload(
          {
            scope,
            record: { ...result.record, content_digest: '0'.repeat(64) },
            reference: { ...result.reference, content_digest: '0'.repeat(64) },
          },
          authoringContract,
        ),
      'digest_mismatch',
    );
  });

  it('recomputes UTF-8 bytes rather than trusting matching declarations or string length', () => {
    const result = prepareAgentTranscriptPayload(input(authored('\u5c71')), authoringContract);
    const wrongSize = canonicalJson(result.record.content_json).length;
    expect(wrongSize).toBeLessThan(result.record.byte_size);
    expectFailure(
      () =>
        verifyAgentTranscriptPayload(
          {
            scope,
            record: { ...result.record, byte_size: wrongSize },
            reference: { ...result.reference, byte_size: wrongSize },
          },
          authoringContract,
        ),
      'byte_size_mismatch',
    );
  });

  it('revalidates the actual domain schema on readback, not only byte/hash metadata', () => {
    const result = prepare();
    const content = { prompts: [] };
    const digest = canonicalSha256(content);
    const bytes = Buffer.byteLength(canonicalJson(content), 'utf8');
    expectFailure(
      () =>
        verifyAgentTranscriptPayload(
          {
            scope,
            record: {
              ...result.record,
              content_json: content,
              content_digest: digest,
              byte_size: bytes,
            },
            reference: { ...result.reference, content_digest: digest, byte_size: bytes },
          },
          authoringContract,
        ),
      'content_invalid',
    );
  });

  it('retains an actual 8 MiB canonical multibyte authoring payload without truncation', () => {
    const available =
      AGENT_TRANSCRIPT_LIMITS.privatePayloadBytes -
      Buffer.byteLength(canonicalJson(authored('')), 'utf8');
    const prompt = '\u5c71'.repeat(Math.floor(available / 3)) + 'x'.repeat(available % 3);
    const content = authored(prompt);
    const result = prepareAgentTranscriptPayload(input(content), authoringContract);
    expect(result.record.byte_size).toBe(8_388_608);
    expect(verifyAgentTranscriptPayload({ scope, ...result }, authoringContract)).toEqual(content);
  });

  it('rejects over-limit capture and readback before domain parsing without truncating', () => {
    const available =
      AGENT_TRANSCRIPT_LIMITS.privatePayloadBytes -
      Buffer.byteLength(canonicalJson(authored('')), 'utf8');
    const content = authored('x'.repeat(available + 1));
    const validate = vi.fn(() => true);
    const contract = {
      kind: 'authoring',
      contentSchema: authoredPromptsSchema.refine(validate),
    } as const;
    expectFailure(
      () => prepareAgentTranscriptPayload(input(content), contract),
      'content_too_large',
    );
    const result = prepare();
    expectFailure(
      () =>
        verifyAgentTranscriptPayload(
          { scope, ...result, record: { ...result.record, content_json: content } },
          contract,
        ),
      'content_too_large',
    );
    expect(validate).not.toHaveBeenCalled();
    expect(content.prompts[0]!.creative_prompt.length).toBe(available + 1);
  });
});

describe('lossless domain validation', () => {
  it.each([
    {
      label: 'strip unknown keys',
      content: { text: 'kept', secret: 'lost' },
      schema: z.object({ text: z.string() }),
    },
    {
      label: 'trim text',
      content: { text: ' keep spaces ' },
      schema: z.strictObject({ text: z.string().trim() }),
    },
    {
      label: 'add a default',
      content: {},
      schema: z.strictObject({ text: z.string().default('invented') }),
    },
    {
      label: 'coerce a number',
      content: { count: '1' },
      schema: z.strictObject({ count: z.coerce.number() }),
    },
    {
      label: 'reorder an array',
      content: { values: [2, 1] },
      schema: z.strictObject({ values: z.array(z.number()).transform((values) => values.sort()) }),
    },
  ])('does not silently $label', ({ content, schema }) => {
    const contract: AgentTranscriptPayloadContract<unknown> = {
      kind: 'tool',
      contentSchema: schema,
    };
    expectFailure(
      () => prepareAgentTranscriptPayload(input(content, { kind: 'tool' }), contract),
      'content_changed',
    );
    const digest = canonicalSha256(content);
    const byteSize = Buffer.byteLength(canonicalJson(content), 'utf8');
    expectFailure(
      () =>
        verifyAgentTranscriptPayload(
          {
            scope,
            record: {
              ...input(content, { kind: 'tool' }),
              content_digest: digest,
              byte_size: byteSize,
            },
            reference: {
              ...prepare().reference,
              kind: 'tool',
              content_digest: digest,
              byte_size: byteSize,
            },
          },
          contract,
        ),
      'content_changed',
    );
  });

  it('does not lose unknown fields under the real strict authoring schema', () => {
    expectFailure(
      () =>
        prepareAgentTranscriptPayload(
          input({ ...authored(), raw_response: 'not a semantic field' }),
          authoringContract,
        ),
      'content_invalid',
    );
  });

  it.each(['throw', 'issue'] as const)('redacts private schema diagnostics from a %s', (mode) => {
    const secret = 'PRIVATE_PROMPT_AND_CREDENTIAL_FIXTURE';
    const schema = z.strictObject({ text: z.string() }).superRefine((_, context) => {
      if (mode === 'throw') throw new Error(secret);
      context.addIssue({ code: 'custom', message: secret });
    });
    const error = expectFailure(
      () =>
        prepareAgentTranscriptPayload(input({ text: secret }, { kind: 'tool' }), {
          kind: 'tool',
          contentSchema: schema,
        }),
      'content_invalid',
    );
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });
});

describe('persistable JSON boundary', () => {
  const contract = { kind: 'tool', contentSchema: z.strictObject({ value: z.json() }) } as const;

  it.each(['forward', 'reversed', 'nested'] as const)(
    'rejects %s ambiguous canonical keys on capture and readback',
    (order) => {
      const keys = order === 'reversed' ? ['e\u0301', '\u00e9'] : ['\u00e9', 'e\u0301'];
      const ambiguous = Object.fromEntries(keys.map((key, index) => [key, index]));
      const content = { value: order === 'nested' ? [{ inner: ambiguous }] : ambiguous };
      const original = JSON.stringify(content);
      expectFailure(
        () => prepareAgentTranscriptPayload(input(content, { kind: 'tool' }), contract),
        'json_invalid',
      );
      const contentDigest = canonicalSha256(content);
      const byteSize = Buffer.byteLength(canonicalJson(content), 'utf8');
      expectFailure(
        () =>
          verifyAgentTranscriptPayload(
            {
              scope,
              record: {
                ...input(content, { kind: 'tool' }),
                content_digest: contentDigest,
                byte_size: byteSize,
              },
              reference: {
                ...prepare().reference,
                kind: 'tool',
                content_digest: contentDigest,
                byte_size: byteSize,
              },
            },
            contract,
          ),
        'json_invalid',
      );
      expect(JSON.stringify(content)).toBe(original);
    },
  );

  it('preserves Unicode text and distinct unambiguous Unicode keys without normalization', () => {
    const content = {
      value: {
        ['\u5c71']: '\u00e9 / e\u0301 / \ud83c\udf04',
        ['\u00e9']: { ['e\u0301']: ' Keep spacing\r\nand line breaks. ' },
      },
    };
    const result = prepareAgentTranscriptPayload(input(content, { kind: 'tool' }), contract);
    const record = {
      ...structuredClone(result.record),
      content_json: { value: Object.fromEntries(Object.entries(content.value).reverse()) },
    };
    expect(result.record.content_json).toEqual(content);
    expect(verifyAgentTranscriptPayload({ scope, ...result, record }, contract)).toEqual(content);
  });

  it.each([
    ['undefined', undefined],
    ['function', () => 'secret'],
    ['symbol', Symbol('secret')],
    ['bigint', 1n],
    ['NaN', NaN],
    ['infinity', Infinity],
    ['negative infinity', -Infinity],
    ['date', new Date('2026-09-07T00:00:00.000Z')],
    ['buffer', Buffer.from('private')],
    ['typed array', new Uint8Array([1, 2])],
    ['map', new Map()],
    ['set', new Set()],
    ['regexp', /private/],
    [
      'class instance',
      new (class Example {
        value = 1;
      })(),
    ],
    ['sparse array', new Array(2)],
    ['NUL', 'text\u0000text'],
    ['high surrogate', '\ud800'],
    ['low surrogate', '\udc00'],
    ['bad surrogate sequence', '\ud800A\udc00'],
  ])('rejects %s instead of normalizing it into different data', (_, value) => {
    expectFailure(
      () => prepareAgentTranscriptPayload(input({ value }, { kind: 'tool' }), contract),
      'json_invalid',
    );
  });

  it.each([null, 'text', 1, false, []])('requires an object payload, not %j', (content) => {
    expectFailure(
      () => prepareAgentTranscriptPayload(input(content, { kind: 'tool' }), contract),
      'json_invalid',
    );
  });

  it('rejects cycles without recursive validation overflow', () => {
    const value: { nested?: unknown } = {};
    value.nested = [value];
    expectFailure(
      () => prepareAgentTranscriptPayload(input({ value }, { kind: 'tool' }), contract),
      'json_invalid',
    );
  });

  it('never evaluates accessors while checking incoming data', () => {
    const read = vi.fn(() => 'private');
    const value = Object.defineProperty({}, 'text', { get: read, enumerable: true });
    expectFailure(
      () => prepareAgentTranscriptPayload(input({ value }, { kind: 'tool' }), contract),
      'json_invalid',
    );
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ['symbol key', Object.assign({}, { [Symbol('secret')]: true })],
    ['hidden key', Object.defineProperty({}, 'hidden', { value: 'private' })],
    ['invalid string key', { ['bad\u0000key']: true }],
    ['array extension', Object.assign([1], { extra: 'private' })],
    ['sparse array with replacement property', Object.assign(new Array(1), { extra: 1 })],
    ['sparse array with non-index numeric key', Object.assign(new Array(1), { 4294967295: 1 })],
    [
      'sparse array with unsafe integer key',
      Object.assign(new Array(1), { '9007199254740993': 1 }),
    ],
    ['array subclass', new (class Items extends Array<number> {})()],
  ])('rejects %s rather than dropping it in canonicalization', (_, value) => {
    expectFailure(
      () => prepareAgentTranscriptPayload(input({ value }, { kind: 'tool' }), contract),
      'json_invalid',
    );
  });

  it('accepts plain null-prototype JSON objects and valid surrogate pairs', () => {
    const value: Record<string, unknown> = Object.assign(Object.create(null) as object, {
      text: '\ud83c\udf04',
      count: null,
    });
    const result = prepareAgentTranscriptPayload(input({ value }, { kind: 'tool' }), contract);
    expect(result.record.content_json).toEqual({ value: { text: '\ud83c\udf04', count: null } });
  });

  it('rejects non-JSON parser output without serializing it', () => {
    const schema = z.strictObject({ value: z.string() }).transform(() => ({ value: new Date() }));
    expectFailure(
      () =>
        prepareAgentTranscriptPayload(input({ value: 'date' }, { kind: 'tool' }), {
          kind: 'tool',
          contentSchema: schema,
        }),
      'json_invalid',
    );
  });

  it('handles wide valid JSON without spreading an unbounded argument list', () => {
    const value = Array.from({ length: 150_000 }, () => null);
    const result = prepareAgentTranscriptPayload(input({ value }, { kind: 'tool' }), contract);
    expect(result.record.content_json.value).toHaveLength(value.length);
  });
});
