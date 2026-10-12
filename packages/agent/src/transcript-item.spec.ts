import { canonicalJson, canonicalSha256 } from '@ecom-forge/shared';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  agentTranscriptWireCallId,
  AgentTranscriptItemError,
  type AgentTranscriptItemContracts,
  type AgentTranscriptItemFailure,
  type AgentTranscriptResultStatus,
  authoredPromptsSchema,
  prepareAgentTranscriptItem,
  prepareAgentTranscriptPayload,
  validateAgentTranscriptProtocol,
  verifyAgentTranscriptItem,
  verifyAgentTranscriptPayload,
} from './index.js';
import { AGENT_TRANSCRIPT_LIMITS } from './runtime-defaults.js';

const uuid = (id: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${id.toString(16).padStart(12, '0')}`;
const scope = { user_id: uuid(100), session_id: uuid(101) };
const turnId = uuid(102);
const textSchema = z.strictObject({ text: z.string() });
const valueContract = { schema: textSchema, privatePayloadKind: 'tool' } as const;
const statusContracts = {
  succeeded: valueContract,
  rejected: { schema: z.strictObject({ code: z.literal('REJECTED') }) },
  not_executed: { schema: z.strictObject({ code: z.literal('CANCELLED') }) },
  unknown: { schema: z.strictObject({ code: z.literal('UNKNOWN') }) },
};
const contracts: AgentTranscriptItemContracts = {
  userMessage: { schema: textSchema },
  legacyMessage: { schema: textSchema, privatePayloadKind: 'legacy_message' },
  calls: [
    { name: 'inspect_image@1', mode: 'tools', arguments: valueContract, results: statusContracts },
    { name: 'load_skill@1', mode: 'tools', arguments: valueContract, results: statusContracts },
    {
      name: 'agent_respond@1',
      mode: 'terminal',
      arguments: valueContract,
      results: statusContracts,
    },
    {
      name: 'agent_authoring@1',
      mode: 'terminal',
      arguments: {
        schema: authoredPromptsSchema,
        privatePayloadKind: 'authoring',
      },
      results: statusContracts,
    },
  ],
  hostContexts: [{ name: 'phase_changed@1', content: valueContract }],
  resourceDependencySchema: z.strictObject({
    binding_id: z.uuid(),
    resource_version: z.string(),
    content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
};
const inline = (value: unknown) => ({ type: 'inline', value });
const dependency = {
  binding_id: uuid(200),
  resource_version: '1',
  content_hash: canonicalSha256('resource'),
};

function call(name = 'inspect_image@1', text = 'inspect the authorized image') {
  const args = { text };
  return {
    name,
    arguments: inline(args),
    arguments_digest: canonicalSha256(args),
    provider_call_id: 'provider_call_1',
  };
}

function input(
  type = 'user_message',
  sequence = 1,
  payload: unknown = { content: inline({ text: 'hello' }) },
  overrides: Record<string, unknown> = {},
) {
  return {
    id: uuid(sequence),
    ...scope,
    turn_id: turnId,
    continuation_no: 1,
    sequence_no: String(sequence),
    schema_version: 1,
    item_type: type,
    source_key: `test:${sequence}`,
    source_message_id:
      type === 'user_message' || type === 'legacy_message' ? uuid(sequence + 1000) : null,
    source_trace_step_id: null,
    import_attempt_id: type === 'legacy_message' ? uuid(103) : null,
    reply_to_item_id: null,
    call_ordinal: null,
    payload_json: { schema_version: 1, type, ...(payload as Record<string, unknown>) },
    resource_dependencies_json: [],
    created_at: '2026-09-08T00:00:00.000Z',
    ...overrides,
  };
}

function assistant(sequence = 1, count = 1, mode = 'tools') {
  return input('assistant_output', sequence, {
    mode,
    calls: Array.from({ length: count }, () =>
      call(mode === 'tools' ? 'inspect_image@1' : 'agent_respond@1'),
    ),
  });
}

function result(
  sequence = 2,
  ordinal = 0,
  status: AgentTranscriptResultStatus = 'succeeded',
  parent = 1,
) {
  const content =
    status === 'succeeded'
      ? { text: 'observed' }
      : {
          code: status === 'rejected' ? 'REJECTED' : status === 'unknown' ? 'UNKNOWN' : 'CANCELLED',
        };
  return input(
    'tool_result',
    sequence,
    {
      name: 'inspect_image@1',
      arguments_digest: call().arguments_digest,
      status,
      result: inline(content),
    },
    {
      reply_to_item_id: uuid(parent),
      call_ordinal: ordinal,
    },
  );
}

function saved(raw: unknown) {
  return prepareAgentTranscriptItem(raw, contracts).item;
}
function window(items: unknown[], closed = true, first = '1') {
  return { scope, items, require_closed: closed, first_sequence_no: first };
}
function protocol(items: unknown[], closed = true) {
  return validateAgentTranscriptProtocol(window(items.map(saved), closed), contracts);
}
function expectFailure(run: () => unknown, reason: AgentTranscriptItemFailure) {
  let error: unknown;
  try {
    run();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(AgentTranscriptItemError);
  expect(error).toMatchObject({ message: 'AGENT_TRANSCRIPT_ITEM_INVALID', reason });
  expect(error).not.toHaveProperty('cause');
  expect(error).not.toHaveProperty('issues');
  return error;
}

describe('transcript v1 item integrity', () => {
  it('roundtrips a strict user item through the public package API', () => {
    const raw = input();
    const prepared = prepareAgentTranscriptItem(raw, contracts);
    expect(prepared.item.payload_json).toEqual(raw.payload_json);
    expect(prepared.item.payload_digest).toBe(canonicalSha256(raw.payload_json));
    expect(prepared.unresolved_payload_references).toEqual([]);
    expect(
      verifyAgentTranscriptItem(
        { scope, record: JSON.parse(JSON.stringify(prepared.item)) },
        contracts,
      ),
    ).toEqual(prepared);
  });

  it('detaches and freezes the envelope and resource dependencies without freezing input', () => {
    const value = { text: 'before' };
    const dependencies = [{ ...dependency }];
    const raw = input(
      'user_message',
      1,
      { content: inline(value) },
      { resource_dependencies_json: dependencies },
    );
    const prepared = prepareAgentTranscriptItem(raw, contracts);
    value.text = 'after';
    dependencies[0]!.resource_version = '2';
    expect(prepared.item.payload_json).toMatchObject({ content: { value: { text: 'before' } } });
    expect(prepared.item.resource_dependencies_json).toEqual([dependency]);
    expect(Object.isFrozen(value)).toBe(false);
    expect(Object.isFrozen(prepared.item.payload_json)).toBe(true);
    expect(Object.isFrozen(prepared.item.resource_dependencies_json[0])).toBe(true);
    expect(Object.isFrozen(prepared)).toBe(true);
  });

  it.each(['id', 'user_id', 'session_id', 'turn_id', 'source_message_id'])(
    'canonicalizes metadata UUID %s without rewriting semantic text',
    (field) => {
      const raw = input('user_message', 1, { content: inline({ text: turnId.toUpperCase() }) });
      const original = raw[field as keyof typeof raw] as string;
      const upper = { ...raw, [field]: original.toUpperCase() };
      const prepared = prepareAgentTranscriptItem(upper, contracts);
      expect(prepared.item).toHaveProperty(field, original);
      expect(prepared.item.payload_json).toEqual(raw.payload_json);
      expect(
        verifyAgentTranscriptItem(
          {
            scope: {
              user_id: scope.user_id.toUpperCase(),
              session_id: scope.session_id.toUpperCase(),
            },
            record: prepared.item,
          },
          contracts,
        ),
      ).toEqual(prepared);
    },
  );

  it.each(['9007199254740993', '9223372036854775807'])(
    'preserves bigint sequence %s without number rounding',
    (sequence_no) => {
      expect(saved({ ...input(), sequence_no }).sequence_no).toBe(sequence_no);
    },
  );
  it.each([
    0,
    1,
    1.5,
    '0',
    '-1',
    '01',
    '+1',
    '1e3',
    '9223372036854775808',
    '123456789012345678901',
  ])('rejects invalid sequence %s', (sequence_no) => {
    expectFailure(() => saved({ ...input(), sequence_no }), 'metadata_invalid');
  });
  it('rejects a bigint JS value at the JSON protocol boundary', () => {
    expectFailure(() => saved({ ...input(), sequence_no: 1n }), 'json_invalid');
  });

  it('rejects malformed sequence syntax before arbitrary precision conversion', () => {
    const convert = vi.spyOn(globalThis, 'BigInt');
    try {
      expectFailure(() => saved({ ...input(), sequence_no: '1'.repeat(1000) }), 'metadata_invalid');
      expect(convert).not.toHaveBeenCalled();
    } finally {
      convert.mockRestore();
    }
  });

  it.each([
    { schema_version: 2 },
    { extra: 'private' },
    { continuation_no: 0 },
    { continuation_no: 2_147_483_648 },
    { source_key: 'raw text with spaces' },
    { source_key: '' },
    { created_at: '2026-09-08T08:00:00+08:00' },
    { id: 'invalid' },
    { item_type: 'system' },
  ])('rejects invalid metadata %j', (patch) => {
    expectFailure(() => saved({ ...input(), ...patch }), 'metadata_invalid');
  });

  it.each([
    { source_message_id: null },
    { turn_id: null },
    { continuation_no: null },
    { import_attempt_id: uuid(5) },
  ])('requires source and native turn identity %j', (patch) => {
    expectFailure(() => saved({ ...input(), ...patch }), 'source_invalid');
  });
  it.each([{ reply_to_item_id: uuid(8) }, { call_ordinal: 0 }])(
    'rejects a non-result protocol pointer %j',
    (patch) => {
      expectFailure(() => saved({ ...input(), ...patch }), 'pair_invalid');
    },
  );
  it.each([{ reply_to_item_id: null }, { call_ordinal: null }])(
    'requires both result pointers %j',
    (patch) => {
      expectFailure(() => saved({ ...result(), ...patch }), 'pair_invalid');
    },
  );

  it('rejects an envelope that disagrees with the item type', () => {
    expectFailure(
      () => saved({ ...input(), payload_json: assistant().payload_json }),
      'item_type_mismatch',
    );
  });
  it('rejects a forged envelope digest and cross-owner reads', () => {
    const record = saved(input());
    expectFailure(
      () =>
        verifyAgentTranscriptItem(
          { scope, record: { ...record, payload_digest: '0'.repeat(64) } },
          contracts,
        ),
      'digest_mismatch',
    );
    for (const field of ['user_id', 'session_id']) {
      expectFailure(
        () =>
          verifyAgentTranscriptItem({ scope: { ...scope, [field]: uuid(900) }, record }, contracts),
        'scope_mismatch',
      );
    }
  });
  it('checks unknown nested fields rather than stripping them', () => {
    expectFailure(
      () => saved(input('user_message', 1, { content: inline({ text: 'valid', secret: 'no' }) })),
      'content_invalid',
    );
    expectFailure(
      () => saved(input('user_message', 1, { content: inline({ text: 'valid' }), secret: 'no' })),
      'metadata_invalid',
    );
  });
  it.each([
    z.object({ text: z.string() }),
    z.strictObject({ text: z.string().trim(), extra: z.string() }),
  ])('rejects lossy host schemas', (schema) => {
    const raw = input('user_message', 1, { content: inline({ text: ' text ', extra: 'retain' }) });
    expectFailure(
      () => prepareAgentTranscriptItem(raw, { ...contracts, userMessage: { schema } }),
      'content_changed',
    );
  });
  it('sanitizes a custom domain parser exception', () => {
    const schema = textSchema.transform(() => {
      throw new Error('PRIVATE_TEXT');
    });
    const error = expectFailure(
      () => prepareAgentTranscriptItem(input(), { ...contracts, userMessage: { schema } }),
      'content_invalid',
    );
    expect(JSON.stringify(error)).not.toContain('PRIVATE_TEXT');
  });

  it('accepts exactly 64 KiB in canonical multibyte bytes and rejects one extra byte', () => {
    const empty = input().payload_json;
    const available =
      AGENT_TRANSCRIPT_LIMITS.envelopeBytes - Buffer.byteLength(canonicalJson(empty), 'utf8') + 5;
    const text = '\u5c71'.repeat(Math.floor(available / 3)) + 'x'.repeat(available % 3);
    const raw = input('user_message', 1, { content: inline({ text }) });
    expect(Buffer.byteLength(canonicalJson(raw.payload_json), 'utf8')).toBe(65_536);
    expect(saved(raw).payload_json).toEqual(raw.payload_json);
    expectFailure(
      () => saved(input('user_message', 1, { content: inline({ text: `${text}x` }) })),
      'content_too_large',
    );
  });

  it('preserves large actual authoring data as an explicitly unresolved reference', () => {
    const content = {
      prompts: [{ candidate_key: 'image-1', creative_prompt: '\u5c71'.repeat(100_000) }],
    };
    const payload = prepareAgentTranscriptPayload(
      {
        id: uuid(400),
        ...scope,
        turn_id: turnId,
        import_attempt_id: null,
        schema_version: 1,
        kind: 'authoring',
        content_json: content,
      },
      { kind: 'authoring', contentSchema: authoredPromptsSchema },
    );
    const raw = input('assistant_output', 1, {
      mode: 'terminal',
      calls: [
        {
          name: 'agent_authoring@1',
          arguments: { ...payload.reference, payload_id: uuid(400).toUpperCase() },
          arguments_digest: payload.record.content_digest,
          provider_call_id: null,
        },
      ],
    });
    const prepared = prepareAgentTranscriptItem(raw, contracts);
    expect(prepared.unresolved_payload_references).toEqual([payload.reference]);
    expect(JSON.stringify(prepared.item)).not.toContain(content.prompts[0]!.creative_prompt);
    expect(
      verifyAgentTranscriptPayload(
        {
          scope: { ...scope, turn_id: turnId, import_attempt_id: null },
          reference: prepared.unresolved_payload_references[0],
          record: payload.record,
        },
        { kind: 'authoring', contentSchema: authoredPromptsSchema },
      ),
    ).toEqual(content);
    expect(
      validateAgentTranscriptProtocol(window([prepared.item], false), contracts)
        .unresolved_payload_references,
    ).toHaveLength(1);
  });

  it('rejects a reference of the wrong domain kind', () => {
    const reference = prepareAgentTranscriptPayload(
      {
        id: uuid(400),
        ...scope,
        turn_id: turnId,
        import_attempt_id: null,
        schema_version: 1,
        kind: 'authoring',
        content_json: { text: 'x' },
      },
      { kind: 'authoring', contentSchema: textSchema },
    ).reference;
    expectFailure(
      () =>
        saved(
          input('assistant_output', 1, {
            mode: 'tools',
            calls: [
              { ...call(), arguments: reference, arguments_digest: reference.content_digest },
            ],
          }),
        ),
      'contract_mismatch',
    );
  });

  it('deduplicates identical references but rejects conflicting claims for one payload ID', () => {
    const reference = prepareAgentTranscriptPayload(
      {
        id: uuid(400),
        ...scope,
        turn_id: turnId,
        import_attempt_id: null,
        schema_version: 1,
        kind: 'tool',
        content_json: { text: 'x' },
      },
      { kind: 'tool', contentSchema: textSchema },
    ).reference;
    const referencedCall = {
      ...call(),
      arguments: reference,
      arguments_digest: reference.content_digest,
    };
    const raw = input('assistant_output', 1, {
      mode: 'tools',
      calls: [referencedCall, referencedCall],
    });
    expect(prepareAgentTranscriptItem(raw, contracts).unresolved_payload_references).toEqual([
      reference,
    ]);
    const forged = { ...reference, byte_size: reference.byte_size + 1 };
    expectFailure(
      () =>
        saved(
          input('assistant_output', 1, {
            mode: 'tools',
            calls: [referencedCall, { ...referencedCall, arguments: forged }],
          }),
        ),
      'reference_mismatch',
    );
    expectFailure(
      () =>
        saved(
          input('assistant_output', 1, {
            mode: 'tools',
            calls: [{ ...referencedCall, arguments: { ...reference, url: 'untrusted' } }],
          }),
        ),
      'metadata_invalid',
    );
  });

  it('isolates legacy private references even when a host mistakenly permits their kind', () => {
    const content = { text: 'historical' };
    const reference = prepareAgentTranscriptPayload(
      {
        id: uuid(400),
        ...scope,
        turn_id: null,
        import_attempt_id: uuid(103),
        schema_version: 1,
        kind: 'legacy_message',
        content_json: content,
      },
      { kind: 'legacy_message', contentSchema: textSchema },
    ).reference;
    const legacy = input(
      'legacy_message',
      1,
      { role: 'assistant', content: reference, source_content_digest: reference.content_digest },
      { turn_id: null, continuation_no: null },
    );
    expect(prepareAgentTranscriptItem(legacy, contracts).unresolved_payload_references).toEqual([
      reference,
    ]);
    const mistaken = {
      ...contracts,
      hostContexts: [{ name: 'phase_changed@1', content: contracts.legacyMessage }],
    };
    expectFailure(
      () =>
        prepareAgentTranscriptItem(
          input('host_context', 1, { name: 'phase_changed@1', content: reference }),
          mistaken,
        ),
      'contract_mismatch',
    );
  });

  it('requires an unmodified legacy source digest and a status-specific result shape', () => {
    expectFailure(
      () =>
        saved(
          input('legacy_message', 1, {
            role: 'user',
            content: inline({ text: 'old' }),
            source_content_digest: '0'.repeat(64),
          }),
        ),
      'digest_mismatch',
    );
    const rejected = result(2, 0, 'rejected');
    expectFailure(
      () =>
        saved({
          ...rejected,
          payload_json: { ...rejected.payload_json, result: inline({ text: 'pretend success' }) },
        }),
      'content_invalid',
    );
    expectFailure(
      () => saved({ ...result(), payload_json: { ...result().payload_json, status: 'accepted' } }),
      'metadata_invalid',
    );
  });

  it('validates host events against their versioned domain contract', () => {
    expect(
      saved(
        input('host_context', 1, {
          name: 'phase_changed@1',
          content: inline({ text: 'authoring' }),
        }),
      ).item_type,
    ).toBe('host_context');
    expectFailure(
      () => saved(input('host_context', 1, { name: 'unknown@1', content: inline({ text: 'x' }) })),
      'contract_mismatch',
    );
  });
  it.each(['user', 'assistant', 'tool'])(
    'imports actual legacy %s without inventing protocol calls',
    (role) => {
      const content = { text: 'historical summary only' };
      const raw = input(
        'legacy_message',
        1,
        { role, content: inline(content), source_content_digest: canonicalSha256(content) },
        { turn_id: null, continuation_no: null },
      );
      const checked = protocol([raw]);
      expect(checked.protocol_closed).toBe(true);
      expect(checked.pending_calls).toEqual([]);
      expectFailure(() => saved({ ...raw, import_attempt_id: null }), 'source_invalid');
      expectFailure(() => saved({ ...raw, continuation_no: 1 }), 'source_invalid');
    },
  );

  it('rejects duplicate or lossy dependency entries', () => {
    expectFailure(
      () => saved({ ...input(), resource_dependencies_json: [dependency, { ...dependency }] }),
      'dependency_duplicate',
    );
    expectFailure(
      () =>
        saved({ ...input(), resource_dependencies_json: [{ ...dependency, url: 'not allowed' }] }),
      'content_invalid',
    );
  });

  it('recognizes tombstones on read but refuses ordinary append or executable replay', () => {
    const original = saved(input());
    const tombstone = {
      schema_version: 1,
      type: 'redacted',
      reason: 'privacy_erased',
      original_payload_digest: original.payload_digest,
      redacted_at: '2026-09-08T01:00:00Z',
    };
    const record = {
      ...original,
      payload_json: tombstone,
      payload_digest: canonicalSha256(tombstone),
    };
    expect(verifyAgentTranscriptItem({ scope, record }, contracts).item.payload_json).toEqual(
      tombstone,
    );
    expectFailure(() => saved({ ...input(), payload_json: tombstone }), 'redacted_unavailable');
    expectFailure(
      () => validateAgentTranscriptProtocol(window([record]), contracts),
      'redacted_unavailable',
    );
  });

  it.each([undefined, new Date(), new Uint8Array([1]), Number.NaN, '\u0000', '\ud800'])(
    'rejects non-persistable semantic JSON %s',
    (value) => {
      expectFailure(
        () => saved(input('user_message', 1, { content: inline({ text: value }) })),
        'json_invalid',
      );
    },
  );
  it('rejects sparse arrays and getters before parsing or invoking them', () => {
    const getter = vi.fn(() => 'private');
    const value = Object.defineProperty({}, 'text', { get: getter, enumerable: true });
    expectFailure(
      () => saved(input('user_message', 1, { content: inline(value) })),
      'json_invalid',
    );
    expect(getter).not.toHaveBeenCalled();
    expectFailure(
      () => saved({ ...input(), resource_dependencies_json: new Array(1) }),
      'json_invalid',
    );
  });
});

describe('transcript call/result protocol', () => {
  function permutations(values: number[]): number[][] {
    if (values.length === 0) return [[]];
    return values.flatMap((value, index) =>
      permutations(values.filter((_, i) => i !== index)).map((tail) => [value, ...tail]),
    );
  }

  it.each(permutations([0, 1, 2, 3]).map((order) => ({ order })))(
    'checks failure ordering across the complete four-result permutation %j',
    ({ order }) => {
      const statuses: AgentTranscriptResultStatus[] = [
        'succeeded',
        'rejected',
        'not_executed',
        'not_executed',
      ];
      expect(
        protocol([
          assistant(1, 4),
          ...order.map((ordinal, index) => result(index + 2, ordinal, statuses[ordinal])),
        ]).protocol_closed,
      ).toBe(true);
      statuses[3] = 'succeeded';
      expectFailure(
        () =>
          protocol([
            assistant(1, 4),
            ...order.map((ordinal, index) => result(index + 2, ordinal, statuses[ordinal])),
          ]),
        'result_after_failure',
      );
    },
  );

  it.each([1, 2, 3, 4])(
    'closes an ordered %s-call batch without relying on provider call IDs',
    (count) => {
      const checked = protocol([
        assistant(1, count),
        ...Array.from({ length: count }, (_, i) => result(i + 2, i)),
      ]);
      expect(checked.protocol_closed).toBe(true);
      expect(checked.pending_calls).toEqual([]);
    },
  );
  it('allows reversed result completion order', () => {
    expect(
      protocol([assistant(1, 3), result(2, 2), result(3, 0), result(4, 1)]).protocol_closed,
    ).toBe(true);
  });
  it('preserves user and host events while pending and permits recovery in a later continuation', () => {
    const checked = protocol([
      assistant(),
      input('user_message', 2),
      input('host_context', 3, {
        name: 'phase_changed@1',
        content: inline({ text: 'recovering' }),
      }),
      { ...result(4), continuation_no: 2 },
    ]);
    expect(checked.through_sequence_no).toBe('4');
    expect(checked.protocol_closed).toBe(true);
  });
  it.each(['tools', 'terminal'])(
    'rejects a %s result from an earlier continuation than its original call',
    (mode) => {
      const parent = { ...assistant(1, 1, mode), continuation_no: 2 };
      const response = {
        ...result(),
        payload_json: {
          ...result().payload_json,
          name: mode === 'terminal' ? 'agent_respond@1' : 'inspect_image@1',
        },
      };
      expectFailure(() => protocol([parent, response]), 'pair_invalid');
      expect(protocol([parent, { ...response, continuation_no: 2 }]).protocol_closed).toBe(true);
      expect(protocol([parent, { ...response, continuation_no: 3 }]).protocol_closed).toBe(true);
    },
  );
  it('reports pending identities without executing or marking them safe to retry', () => {
    const checked = protocol([assistant(1, 2), result(2)], false);
    expect(checked.protocol_closed).toBe(false);
    expect(checked.pending_calls).toEqual([
      {
        assistant_item_id: uuid(1),
        turn_id: turnId,
        call_ordinal: 1,
        name: 'inspect_image@1',
        arguments_digest: call().arguments_digest,
        wire_call_id: `call_${uuid(1).replaceAll('-', '')}_1`,
      },
    ]);
    expect(Object.isFrozen(checked.pending_calls[0])).toBe(true);
    expectFailure(() => protocol([assistant(1, 2), result(2)]), 'protocol_unclosed');
  });
  it('requires terminal results to close too', () => {
    expectFailure(() => protocol([assistant(1, 1, 'terminal')]), 'protocol_unclosed');
    const terminalResult = {
      ...result(),
      payload_json: { ...result().payload_json, name: 'agent_respond@1' },
    };
    expect(protocol([assistant(1, 1, 'terminal'), terminalResult]).protocol_closed).toBe(true);
  });
  it.each(['rejected', 'unknown', 'not_executed'] as const)(
    'closes %s with later members explicitly not executed',
    (status) => {
      expect(
        protocol([
          assistant(1, 3),
          result(2, 0),
          result(3, 1, status),
          result(4, 2, 'not_executed'),
        ]).protocol_closed,
      ).toBe(true);
    },
  );
  it.each(['rejected', 'unknown', 'not_executed'] as const)(
    'rejects success after %s in either completion order',
    (status) => {
      expectFailure(
        () => protocol([assistant(1, 2), result(2, 0, status), result(3, 1)]),
        'result_after_failure',
      );
      expectFailure(
        () => protocol([assistant(1, 2), result(2, 1), result(3, 0, status)]),
        'result_after_failure',
      );
    },
  );
  it.each([0, 5])('rejects a %s-call assistant batch', (count) => {
    expectFailure(() => saved(assistant(1, count)), 'metadata_invalid');
  });
  it('rejects mixed terminal/tool modes and unregistered names', () => {
    expectFailure(() => saved(assistant(1, 2, 'terminal')), 'contract_mismatch');
    expectFailure(
      () =>
        saved(
          input('assistant_output', 1, { mode: 'tools', calls: [call(), call('agent_respond@1')] }),
        ),
      'contract_mismatch',
    );
    expectFailure(
      () => saved(input('assistant_output', 1, { mode: 'tools', calls: [call('unknown@1')] })),
      'contract_mismatch',
    );
    expectFailure(
      () =>
        prepareAgentTranscriptItem(assistant(), {
          ...contracts,
          calls: [...contracts.calls, contracts.calls[0]!],
        }),
      'contract_mismatch',
    );
  });
  it.each(['unsafe space', 'call/id', 'x'.repeat(129)])(
    'rejects unsafe provider call ID %s',
    (provider_call_id) => {
      expectFailure(
        () =>
          saved(
            input('assistant_output', 1, {
              mode: 'tools',
              calls: [{ ...call(), provider_call_id }],
            }),
          ),
        'metadata_invalid',
      );
    },
  );
  it('rejects a tampered call-arguments digest', () => {
    expectFailure(
      () =>
        saved(
          input('assistant_output', 1, {
            mode: 'tools',
            calls: [{ ...call(), arguments_digest: '0'.repeat(64) }],
          }),
        ),
      'arguments_digest_mismatch',
    );
  });
  it('rejects an orphan, duplicate, future parent or out-of-range result', () => {
    expectFailure(() => protocol([result(1)]), 'pair_invalid');
    expectFailure(() => protocol([assistant(), result(), result(3)]), 'pair_invalid');
    expectFailure(() => protocol([assistant(), result(2, 0, 'succeeded', 3)]), 'pair_invalid');
    expectFailure(() => protocol([assistant(), result(2, 1)]), 'pair_invalid');
  });
  it('does not mistake legacy tool summaries for a parent call', () => {
    const legacy = input('legacy_message', 1, {
      role: 'tool',
      content: inline({ text: 'old' }),
      source_content_digest: canonicalSha256({ text: 'old' }),
    });
    expectFailure(() => protocol([legacy, result()]), 'pair_invalid');
  });
  it.each(['user_id', 'session_id'])(
    'rejects a cross-%s item even with matching payload digest',
    (field) => {
      expectFailure(
        () => protocol([assistant(), { ...result(), [field]: uuid(900) }]),
        'scope_mismatch',
      );
    },
  );
  it('rejects cross-turn or wrong tool/hash results', () => {
    expectFailure(
      () => protocol([assistant(), { ...result(), turn_id: uuid(999) }]),
      'pair_invalid',
    );
    for (const patch of [{ name: 'load_skill@1' }, { arguments_digest: '0'.repeat(64) }]) {
      expectFailure(
        () =>
          protocol([
            assistant(),
            { ...result(), payload_json: { ...result().payload_json, ...patch } },
          ]),
        'pair_invalid',
      );
    }
  });
  it('blocks another model output before closing all prior calls', () => {
    expectFailure(() => protocol([assistant(), assistant(2)], false), 'protocol_unclosed');
    expect(
      protocol([assistant(), result(), assistant(3), result(4, 0, 'succeeded', 3)]).protocol_closed,
    ).toBe(true);
  });
  it('enforces inherited dependencies even on rejected results', () => {
    const parent = { ...assistant(), resource_dependencies_json: [dependency] };
    expectFailure(() => protocol([parent, result(2, 0, 'rejected')]), 'dependency_missing');
    expect(
      protocol([
        parent,
        {
          ...result(),
          resource_dependencies_json: [dependency, { ...dependency, binding_id: uuid(201) }],
        },
      ]).protocol_closed,
    ).toBe(true);
  });
  it('rejects sequence gaps, reordering and duplicate source or item identity', () => {
    expectFailure(() => protocol([assistant(), result(3)]), 'sequence_invalid');
    expectFailure(
      () =>
        validateAgentTranscriptProtocol(window([saved(result()), saved(assistant())]), contracts),
      'sequence_invalid',
    );
    for (const patch of [{ source_key: 'test:1' }, { id: uuid(1) }]) {
      expectFailure(() => protocol([assistant(), { ...result(), ...patch }]), 'duplicate_item');
    }
  });
  it('handles a caller-verified closed starting boundary without converting bigint to number', () => {
    const sequence = '9007199254740993';
    const item = saved({ ...input(), sequence_no: sequence });
    expect(
      validateAgentTranscriptProtocol(window([item], true, sequence), contracts)
        .through_sequence_no,
    ).toBe(sequence);
    expect(validateAgentTranscriptProtocol(window([], true, sequence), contracts)).toMatchObject({
      through_sequence_no: null,
      protocol_closed: true,
    });
  });
  it('derives stable protocol wire IDs independently of provider metadata', () => {
    expect(
      agentTranscriptWireCallId({ assistant_item_id: uuid(1).toUpperCase(), call_ordinal: 3 }),
    ).toBe(`call_${uuid(1).replaceAll('-', '')}_3`);
    expect(agentTranscriptWireCallId({ assistant_item_id: uuid(2), call_ordinal: 3 })).not.toBe(
      agentTranscriptWireCallId({ assistant_item_id: uuid(1), call_ordinal: 3 }),
    );
    expectFailure(
      () => agentTranscriptWireCallId({ assistant_item_id: uuid(1), call_ordinal: 4 }),
      'metadata_invalid',
    );
  });
});
