import {
  authoredPromptsSchema,
  prepareAgentTranscriptItem,
  prepareAgentTranscriptPayload,
  type AgentTranscriptItem,
  type AgentTranscriptItemContracts,
} from '@ecom-forge/agent';
import { canonicalSha256 } from '@ecom-forge/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  prepareTranscriptModelInputBinding,
  prepareTranscriptModelOutputBinding,
  verifyTranscriptModelOutputSource,
  type TranscriptModelSourceStep,
} from './agent-transcript-model-binding.js';

const uuid = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${n.toString(16).padStart(12, '0')}`;
const dependencySchema = z.strictObject({ binding_id: z.uuid(), version: z.string() });
const textContract = { schema: z.strictObject({ text: z.string() }) };
const results = {
  succeeded: textContract,
  rejected: { schema: z.never() },
  not_executed: { schema: z.never() },
  unknown: { schema: z.never() },
};
const contracts: AgentTranscriptItemContracts = {
  userMessage: textContract,
  legacyMessage: textContract,
  hostContexts: [],
  resourceDependencySchema: dependencySchema,
  calls: [
    { name: 'inspect_image@1', mode: 'tools', arguments: textContract, results },
    {
      name: 'agent_authoring@1',
      mode: 'terminal',
      arguments: { schema: authoredPromptsSchema, privatePayloadKind: 'authoring' },
      results,
    },
  ],
};

function fixture(mode: 'tools' | 'terminal' = 'tools') {
  const dependencies = [
    { binding_id: uuid(11), version: 'original' },
    { binding_id: uuid(12), version: 'knowledge' },
  ];
  const input = prepareTranscriptModelInputBinding(
    { step_id: uuid(5), continuation_no: 2, resource_dependencies: dependencies },
    dependencySchema,
  );
  const scope = { user_id: uuid(1), session_id: uuid(2), turn_id: uuid(3) };
  const content = { text: 'inspect' };
  const authored = prepareAgentTranscriptPayload(
    {
      ...scope,
      id: uuid(6),
      import_attempt_id: null,
      schema_version: 1,
      kind: 'authoring',
      content_json: {
        prompts: [
          {
            candidate_key: 'main',
            creative_prompt: 'Private creative text. '.repeat(4_000).trim(),
          },
        ],
      },
    },
    { kind: 'authoring', contentSchema: authoredPromptsSchema },
  );
  const item = prepareAgentTranscriptItem(
    {
      ...scope,
      id: uuid(4),
      continuation_no: 2,
      sequence_no: '9007199254740993',
      schema_version: 1,
      item_type: 'assistant_output',
      source_key: `model:${uuid(5)}:output`,
      source_message_id: null,
      source_trace_step_id: uuid(5),
      import_attempt_id: null,
      reply_to_item_id: null,
      call_ordinal: null,
      payload_json: {
        schema_version: 1,
        type: 'assistant_output',
        mode,
        calls: [
          mode === 'tools'
            ? {
                name: 'inspect_image@1',
                arguments: { type: 'inline', value: content },
                arguments_digest: canonicalSha256(content),
                provider_call_id: 'original-call',
              }
            : {
                name: 'agent_authoring@1',
                arguments: authored.reference,
                arguments_digest: authored.reference.content_digest,
                provider_call_id: null,
              },
        ],
      },
      resource_dependencies_json: dependencies,
      created_at: '2026-09-08T00:00:00.000Z',
    },
    contracts,
  ).item;
  const output = prepareTranscriptModelOutputBinding(item, input, contracts);
  const step = {
    id: uuid(5),
    stepType: 'llm_call',
    actor: 'agent',
    status: 'succeeded',
    errorCode: null,
    inputSummary: {
      purpose: 'agent_step',
      continuation_no: 2,
      requested_input_tokens: 123,
      transcript_input: input,
    },
    outputSummary: {
      outcome: mode === 'tools' ? 'tool_calls' : 'candidate_plan',
      transcript_output: output,
    },
  } satisfies TranscriptModelSourceStep;
  return { item, input, output, step, dependencies };
}

describe('model transcript provenance', () => {
  it.each(['tools', 'terminal'] as const)(
    'binds an accepted %s output without private text',
    (mode) => {
      const { item, step, input, output } = fixture(mode);
      expect(verifyTranscriptModelOutputSource(item, step, contracts)).toBe(true);
      expect(output.sequence_no).toBe('9007199254740993');
      expect(Object.isFrozen(input)).toBe(true);
      expect(Object.isFrozen(output)).toBe(true);
      const diagnostic = JSON.stringify(step);
      expect(diagnostic).not.toContain('Private creative text');
      expect(diagnostic).not.toContain('creative_prompt');
      expect(diagnostic).not.toContain('binding_id');
    },
  );

  it.each([
    ['step identity', { id: uuid(99) }],
    ['step type', { stepType: 'tool_call' }],
    ['actor', { actor: 'tool' }],
    ['started status', { status: 'started' }],
    ['failed status', { status: 'failed' }],
    ['error code', { errorCode: 'AGENT_CALL_OUTCOME_UNKNOWN' }],
    ['missing input', { inputSummary: {} }],
    ['missing output', { outputSummary: {} }],
  ] as const)('rejects invalid %s', (_name, changes) => {
    const { item, step } = fixture();
    expect(verifyTranscriptModelOutputSource(item, { ...step, ...changes }, contracts)).toBe(false);
  });

  it.each([
    { purpose: 'session_compaction' },
    { continuation_no: 1 },
    { continuation_no: 3 },
    { continuation_no: '2' },
    { transcript_input: null },
  ])('rejects mismatched original step input %j', (changes) => {
    const { item, step } = fixture();
    expect(
      verifyTranscriptModelOutputSource(
        item,
        {
          ...step,
          inputSummary: { ...step.inputSummary, ...changes },
        },
        contracts,
      ),
    ).toBe(false);
  });

  it.each([
    { step_id: uuid(99) },
    { continuation_no: 1 },
    { resource_dependencies_digest: canonicalSha256([]) },
    { schema_version: 2 },
    { extra: 'private' },
  ])('rejects mismatched frozen input marker %j', (changes) => {
    const { item, input, step } = fixture();
    expect(
      verifyTranscriptModelOutputSource(
        item,
        {
          ...step,
          inputSummary: { ...step.inputSummary, transcript_input: { ...input, ...changes } },
        },
        contracts,
      ),
    ).toBe(false);
  });

  it.each([
    { step_id: uuid(99) },
    { assistant_item_id: uuid(99) },
    { sequence_no: '9007199254740992' },
    { sequence_no: 2 },
    { payload_digest: '0'.repeat(64) },
    { schema_version: 2 },
    { extra: 'private' },
  ])('rejects mismatched accepted output marker %j', (changes) => {
    const { item, output, step } = fixture();
    expect(
      verifyTranscriptModelOutputSource(
        item,
        {
          ...step,
          outputSummary: { transcript_output: { ...output, ...changes } },
        },
        contracts,
      ),
    ).toBe(false);
  });

  it.each([
    { source_key: 'model:invented:output' },
    { source_trace_step_id: null },
    { source_message_id: uuid(99) },
    { continuation_no: 1 },
    { id: uuid(99) },
    { sequence_no: '9007199254740994' },
  ])('rejects item provenance drift %j', (changes) => {
    const { item, step } = fixture();
    expect(verifyTranscriptModelOutputSource({ ...item, ...changes }, step, contracts)).toBe(false);
  });

  it.each(['omitted', 'extra', 'reordered', 'changed'])(
    'rejects %s inherited dependencies even with an unchanged valid envelope',
    (mode) => {
      const { item, step, dependencies } = fixture();
      const changed =
        mode === 'omitted'
          ? []
          : mode === 'extra'
            ? [...dependencies, { binding_id: uuid(13), version: 'new' }]
            : mode === 'reordered'
              ? [...dependencies].reverse()
              : dependencies.map((entry) => ({ ...entry, version: 'changed' }));
      expect(
        verifyTranscriptModelOutputSource(
          { ...item, resource_dependencies_json: changed },
          step,
          contracts,
        ),
      ).toBe(false);
    },
  );

  it('rejects a recomputed envelope and arguments hash against the originally accepted output', () => {
    const { item, step } = fixture();
    const { payload_digest: originalDigest, ...metadata } = item;
    expect(originalDigest).toBe(canonicalSha256(item.payload_json));
    const value = { text: 'different request' };
    const modified = prepareAgentTranscriptItem(
      {
        ...metadata,
        payload_json: {
          schema_version: 1,
          type: 'assistant_output',
          mode: 'tools',
          calls: [
            {
              name: 'inspect_image@1',
              arguments: { type: 'inline', value },
              arguments_digest: canonicalSha256(value),
              provider_call_id: 'original-call',
            },
          ],
        },
      },
      contracts,
    ).item;
    expect(verifyTranscriptModelOutputSource(modified, step, contracts)).toBe(false);
  });

  it('detaches the input evidence from later mutation of the host dependency array', () => {
    const { input, dependencies } = fixture();
    dependencies[0]!.version = 'after model call';
    expect(input.resource_dependencies_digest).not.toBe(canonicalSha256(dependencies));
  });

  it('binds an explicitly empty input without treating that as live authorization', () => {
    const input = prepareTranscriptModelInputBinding(
      {
        step_id: uuid(5),
        continuation_no: 1,
        resource_dependencies: [],
      },
      dependencySchema,
    );
    expect(input.resource_dependencies_digest).toBe(canonicalSha256([]));
  });

  it.each([
    { dependencies: [{ binding_id: uuid(11), version: 'v1', extra: true }] },
    {
      dependencies: [
        { binding_id: uuid(11), version: 'v1' },
        { binding_id: uuid(11), version: 'v1' },
      ],
    },
    { dependencies: [{ binding_id: uuid(11), version: undefined }] },
  ])('rejects invalid dependency snapshots', ({ dependencies }) => {
    expect(() =>
      prepareTranscriptModelInputBinding(
        {
          step_id: uuid(5),
          continuation_no: 1,
          resource_dependencies: dependencies,
        },
        dependencySchema,
      ),
    ).toThrow('AGENT_TRANSCRIPT_MODEL_SOURCE_INVALID');
  });

  it('never silently normalizes dependencies when producing their digest', () => {
    const normalizing = z.strictObject({ binding_id: z.uuid(), version: z.string().trim() });
    expect(() =>
      prepareTranscriptModelInputBinding(
        {
          step_id: uuid(5),
          continuation_no: 1,
          resource_dependencies: [{ binding_id: uuid(11), version: ' original ' }],
        },
        normalizing,
      ),
    ).toThrow('AGENT_TRANSCRIPT_MODEL_SOURCE_INVALID');
  });

  it('reduces unknown schemas and exceptions to fixed errors without private causes', () => {
    const invalidSchema = z.unknown().transform(() => {
      throw new Error('secret prompt');
    });
    let caught: unknown;
    try {
      prepareTranscriptModelInputBinding(
        {
          step_id: uuid(5),
          continuation_no: 1,
          resource_dependencies: [{ secret: 'prompt' }],
        },
        invalidSchema,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).toBe('Error: AGENT_TRANSCRIPT_MODEL_SOURCE_INVALID');
    expect(caught).not.toHaveProperty('cause');
  });

  it('refuses a non-assistant item even with a successful source step', () => {
    const { item, step } = fixture();
    const invalid = { ...item, item_type: 'user_message' } as AgentTranscriptItem;
    expect(verifyTranscriptModelOutputSource(invalid, step, contracts)).toBe(false);
  });
});
