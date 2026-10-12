import {
  agentConfirmedFactDependencySchema,
  mergeAuthoredPrompts,
  type AgentTranscriptItemContracts,
} from '@ecom-forge/agent';
import type { Database } from '@ecom-forge/db';
import { attachmentSnapshotSchema } from '@ecom-forge/compiler';
import { canonicalSha256 } from '@ecom-forge/shared';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  prepareTranscriptModelInputBinding,
  prepareTranscriptModelOutputBinding,
} from './agent-transcript-model-binding.js';
import {
  AgentTranscriptTerminalBinding,
  prepareTranscriptTerminalResultBinding,
} from './agent-transcript-terminal-binding.js';
import {
  prepareTranscriptTerminalOutput,
  prepareTranscriptTerminalResult,
  transcriptTerminalContracts,
} from './agent-transcript-terminal-contracts.js';

const uuid = (id: number) => `dddddddd-dddd-4ddd-8ddd-${id.toString(16).padStart(12, '0')}`;
const contracts: AgentTranscriptItemContracts = {
  userMessage: { schema: z.never() },
  legacyMessage: { schema: z.never() },
  hostContexts: [],
  calls: transcriptTerminalContracts,
  resourceDependencySchema: z.union([agentConfirmedFactDependencySchema, attachmentSnapshotSchema]),
};
const usage = { input_tokens: 1, output_tokens: 2 };
const facts = {
  product_name: 'Product',
  primary_colors: [],
  logos: [],
  visible_text: [],
  materials: [],
  must_preserve: [],
  unknown_fields: [],
};
const dependency = {
  kind: 'product_fact_set',
  object_id: uuid(12),
  object_version: '2',
  content_hash: canonicalSha256(facts),
  owner_user_id: uuid(1),
  product_id: uuid(13),
  source_asset_id: uuid(14),
  source_version: 'c'.repeat(64),
};
const plan = {
  schema_version: 1,
  intent: { kind: 'creative_generate', confidence: 1 },
  skill_id: 'creative@1.0.0',
  source: 'chat',
  nodes: [
    {
      candidate_key: 'first',
      capability: 'image.generate',
      capability_version: 1,
      depends_on: [],
      input_bindings: [],
      params: {},
      expected_output: 'image',
    },
  ],
};
function fixture(
  kind:
    | 'message'
    | 'clarification'
    | 'scope'
    | 'authored-scope'
    | 'product'
    | 'facts'
    | 'quote'
    | 'authoring' = 'message',
  sourceImageId = uuid(14),
) {
  const source = attachmentSnapshotSchema.parse({
    binding_key: 'product',
    kind: 'asset',
    object_id: sourceImageId,
    object_version: 'c'.repeat(64),
    content_hash: 'c'.repeat(64),
    owner_user_id: uuid(1),
    readable: true,
    mutable: false,
    producer_mode: null,
    producer_session_id: null,
    mutation_owner: null,
    source_action: null,
    media_type: 'image',
    lifecycle: 'active',
    visibility: 'private',
    role: 'product',
    position: 0,
    publication_revision: null,
  });
  const metadata = {
    id: uuid(4),
    user_id: uuid(1),
    session_id: uuid(2),
    turn_id: uuid(3),
    continuation_no: 1,
    sequence_no: '1',
    schema_version: 1 as const,
    source_message_id: null,
    source_trace_step_id: uuid(5),
    import_attempt_id: null,
    reply_to_item_id: null,
    call_ordinal: null,
    resource_dependencies_json: kind === 'product' || kind === 'facts' ? [source] : [],
    created_at: '2026-09-08T00:00:00.000Z',
  };
  const isScope = kind === 'scope' || kind === 'authored-scope';
  const authored = {
    prompts: plan.nodes.map((node) => ({
      candidate_key: node.candidate_key,
      creative_prompt: 'A restrained original composition.',
    })),
  };
  const outcome =
    kind === 'authored-scope'
      ? {
          type: 'candidate_plan',
          plan: mergeAuthoredPrompts(plan, authored),
          usage,
          authoring_output: {
            name: 'agent_author_prompts@1',
            arguments: authored,
            provider_call_id: null,
          },
        }
      : kind === 'message'
        ? { type: 'respond', text: 'Reply', usage }
        : kind === 'clarification'
          ? { type: 'request_clarification', question: 'Which?', suggestions: [], usage }
          : kind === 'product' || kind === 'facts'
            ? {
                type: 'request_product_facts',
                source_binding_key: 'product',
                candidate_facts: facts,
                evidence: [],
                usage,
              }
            : { type: kind === 'authoring' ? 'authoring_request' : 'candidate_plan', plan, usage };
  const parent = prepareTranscriptTerminalOutput(
    {
      metadata,
      outcome,
      phase: kind === 'authored-scope' ? 'authoring' : 'planning',
      privatePayloadId: uuid(6),
    },
    contracts,
  ).item;
  const confirmationPayload = isScope
    ? {
        schema_version: 1,
        question: 'Use both upload groups?',
        options: [
          { id: 'option-1', label: 'Latest only' },
          { id: 'option-2', label: 'Both groups' },
        ],
        allow_free_text: false,
        max_response_chars: 2000,
        scope_digest: 'a'.repeat(64),
      }
    : kind === 'clarification'
      ? {
          schema_version: 1,
          question: 'Which?',
          options: [],
          allow_free_text: true,
          max_response_chars: 2000,
        }
      : {
          schema_version: 1,
          mode: 'create_product',
          source_asset_id: uuid(14),
          source_version: 'c'.repeat(64),
          candidate_facts: facts,
          required_fields: ['product_name', 'visible_text'],
        };
  const value =
    kind === 'message'
      ? {
          type: 'message_published',
          message_id: uuid(8),
          content_digest: canonicalSha256({ text: 'Reply' }),
        }
      : isScope
        ? {
            type: 'scope_confirmation_requested',
            confirmation_id: uuid(9),
            payload_digest: canonicalSha256(confirmationPayload),
            scope_digest: 'a'.repeat(64),
          }
        : kind === 'clarification' || kind === 'product'
          ? {
              type: 'confirmation_requested',
              confirmation_id: uuid(9),
              payload_digest: canonicalSha256(confirmationPayload),
            }
          : kind === 'facts'
            ? { type: 'facts_already_confirmed', dependency }
            : kind === 'quote'
              ? { type: 'quote_created', quote_id: uuid(10), plan_digest: 'b'.repeat(64) }
              : { type: 'authoring_required', plan_digest: canonicalSha256({ plan }) };
  const item = prepareTranscriptTerminalResult(
    {
      metadata: { ...metadata, id: uuid(7), sequence_no: '2' },
      parent,
      status: 'succeeded',
      result: value,
    },
    contracts,
  );
  const modelInput = prepareTranscriptModelInputBinding(
    {
      step_id: uuid(5),
      continuation_no: 1,
      resource_dependencies: metadata.resource_dependencies_json,
    },
    contracts.resourceDependencySchema,
  );
  const step = {
    id: uuid(5),
    traceId: uuid(11),
    stepType: 'llm_call',
    actor: 'agent',
    status: 'succeeded',
    errorCode: null,
    inputSummary: { purpose: 'agent_step', continuation_no: 1, transcript_input: modelInput },
    outputSummary: {
      transcript_output: prepareTranscriptModelOutputBinding(parent, modelInput, contracts),
      transcript_result: prepareTranscriptTerminalResultBinding(item, parent, contracts),
    },
  };
  const message = {
    id: uuid(8),
    sessionId: uuid(2),
    turnId: uuid(3),
    role: 'assistant',
    content: 'Reply',
    attachments: [],
    toolCalls: [],
    pendingApproval: {},
  };
  const confirmation = {
    id: uuid(9),
    userId: uuid(1),
    turnId: uuid(3),
    type: kind === 'clarification' || isScope ? 'clarification' : 'product_facts',
    answerSchemaVersion: 1,
    publicPayloadJson: confirmationPayload,
    payloadDigest: canonicalSha256(confirmationPayload),
  };
  const quote = {
    id: uuid(10),
    userId: uuid(1),
    source: 'chat',
    sourceId: uuid(3),
    planDigest: 'b'.repeat(64),
  };
  const fact = {
    id: uuid(12),
    userId: uuid(1),
    productId: uuid(13),
    versionNo: 2,
    sourceAssetId: uuid(14),
    sourceVersion: 'c'.repeat(64),
    factsJson: facts,
    confirmedBy: uuid(1),
    confirmedAt: new Date('2026-09-08T00:00:00.000Z'),
  };
  const query = {
    agentTraces: {
      findFirst: vi
        .fn()
        .mockResolvedValue({ id: uuid(11), turnId: uuid(3), userId: uuid(1), sessionId: uuid(2) }),
    },
    agentTraceSteps: { findFirst: vi.fn().mockResolvedValue(step) },
    chatMessages: { findFirst: vi.fn().mockResolvedValue(message) },
    agentTurnConfirmations: { findFirst: vi.fn().mockResolvedValue(confirmation) },
    runQuotes: { findFirst: vi.fn().mockResolvedValue(quote) },
    productFactSets: { findFirst: vi.fn().mockResolvedValue(fact) },
    assets: {
      findFirst: vi.fn().mockResolvedValue({
        id: sourceImageId,
        userId: uuid(1),
        productId: uuid(13),
        status: 'ready',
        deletedAt: null,
        contentHash: 'c'.repeat(64),
      }),
    },
  };
  const binder = new AgentTranscriptTerminalBinding(
    { query } as unknown as Pick<Database, 'query'>,
    contracts,
  );
  return { binder, query, item, parent, step, message, confirmation, quote, fact };
}

describe('terminal transcript source binding', () => {
  it.each(['message', 'clarification', 'product', 'facts', 'quote', 'authoring'] as const)(
    'accepts a provenance-bound %s receipt with the real owned source',
    async (kind) => {
      const f = fixture(kind);
      expect(await f.binder.verifySource(f)).toBe(true);
    },
  );

  it.each(['transcript_output', 'transcript_result'] as const)(
    'requires the original %s marker',
    async (field) => {
      const f = fixture();
      f.query.agentTraceSteps.findFirst.mockResolvedValue({
        ...f.step,
        outputSummary: { ...f.step.outputSummary, [field]: undefined },
      });
      expect(await f.binder.verifySource(f)).toBe(false);
      expect(f.query.chatMessages.findFirst).not.toHaveBeenCalled();
    },
  );

  it.each([
    { assistant_item_id: uuid(80) },
    { result_item_id: uuid(81) },
    { call_ordinal: 1 },
    { sequence_no: '3' },
    { continuation_no: 2 },
    { payload_digest: '0'.repeat(64) },
    { arguments_digest: '0'.repeat(64) },
    { resource_dependencies_digest: '0'.repeat(64) },
    { raw_prompt: 'private' },
  ])('rejects a changed or extended receipt marker before domain reads: %j', async (change) => {
    const f = fixture();
    f.query.agentTraceSteps.findFirst.mockResolvedValue({
      ...f.step,
      outputSummary: {
        ...f.step.outputSummary,
        transcript_result: { ...f.step.outputSummary.transcript_result, ...change },
      },
    });
    expect(await f.binder.verifySource(f)).toBe(false);
    expect(f.query.chatMessages.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    { status: 'blocked' },
    { status: 'started' },
    { errorCode: 'AGENT_TOOL_NOT_ALLOWED' },
    { traceId: uuid(80) },
    { id: uuid(81) },
    { actor: 'compiler' },
    { inputSummary: { purpose: 'session_compaction' } },
  ])('requires unchanged original model acceptance: %j', async (change) => {
    const f = fixture();
    f.query.agentTraceSteps.findFirst.mockResolvedValue({ ...f.step, ...change });
    expect(await f.binder.verifySource(f)).toBe(false);
    expect(f.query.chatMessages.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    { id: uuid(80) },
    { turnId: uuid(81) },
    { sessionId: uuid(82) },
    { role: 'user' },
    { content: 'Changed text' },
    { attachments: [{ object_id: uuid(90) }] },
    { pendingApproval: { confirmation_id: uuid(90) } },
    { toolCalls: [{ name: 'unexpected' }] },
  ])('rejects a changed message projection: %j', async (change) => {
    const f = fixture();
    f.query.chatMessages.findFirst.mockResolvedValue({ ...f.message, ...change });
    expect(await f.binder.verifySource(f)).toBe(false);
  });

  it.each([
    { userId: uuid(80) },
    { turnId: uuid(81) },
    { type: 'product_facts' },
    { answerSchemaVersion: 2 },
    { payloadDigest: '0'.repeat(64) },
    { publicPayloadJson: {} },
  ])('rejects a changed confirmation: %j', async (change) => {
    const f = fixture('clarification');
    f.query.agentTurnConfirmations.findFirst.mockResolvedValue({ ...f.confirmation, ...change });
    expect(await f.binder.verifySource(f)).toBe(false);
  });

  it.each([
    { userId: uuid(80) },
    { sourceId: uuid(81) },
    { source: 'canvas' },
    { id: uuid(82) },
    { planDigest: '0'.repeat(64) },
  ])('rejects a quote from another owner or plan: %j', async (change) => {
    const f = fixture('quote');
    f.query.runQuotes.findFirst.mockResolvedValue({ ...f.quote, ...change });
    expect(await f.binder.verifySource(f)).toBe(false);
  });

  it.each([
    { userId: uuid(80) },
    { confirmedBy: uuid(81) },
    { confirmedAt: null },
    { productId: uuid(82) },
    { versionNo: 3 },
    { sourceAssetId: uuid(83) },
    { sourceVersion: '0'.repeat(64) },
    { factsJson: { ...facts, product_name: 'Changed' } },
  ])('rejects mismatched confirmed facts: %j', async (change) => {
    const f = fixture('facts');
    f.query.productFactSets.findFirst.mockResolvedValue({ ...f.fact, ...change });
    expect(await f.binder.verifySource(f)).toBe(false);
  });

  it('inherits the returned fact version and refuses an omitted dependency', async () => {
    const f = fixture('facts');
    expect(f.item.resource_dependencies_json).toEqual([
      ...f.parent.resource_dependencies_json,
      dependency,
    ]);
    expect(
      await f.binder.verifySource({ ...f, item: { ...f.item, resource_dependencies_json: [] } }),
    ).toBe(false);
  });

  it('does not leak storage errors or treat missing sources as success', async () => {
    const f = fixture();
    f.query.chatMessages.findFirst.mockResolvedValue(null);
    expect(await f.binder.verifySource(f)).toBe(false);
    f.query.chatMessages.findFirst.mockRejectedValue(new Error('Private driver details'));
    expect(await f.binder.verifySource(f)).toBe(false);
  });

  it('permits another owned image of the same product to reuse confirmed facts', async () => {
    const f = fixture('facts', uuid(99));
    expect(await f.binder.verifySource(f)).toBe(true);
  });

  it('refuses an already-confirmed result if the requested image belongs to another product', async () => {
    const f = fixture('facts');
    f.query.assets.findFirst.mockResolvedValue({
      id: uuid(14),
      userId: uuid(1),
      productId: uuid(99),
      status: 'ready',
      deletedAt: null,
      contentHash: 'c'.repeat(64),
    });
    expect(await f.binder.verifySource(f)).toBe(false);
    expect(f.query.productFactSets.findFirst).not.toHaveBeenCalled();
  });

  it('rejects a same-turn confirmation that does not answer the original question', async () => {
    const f = fixture('clarification');
    const payload = { ...f.confirmation.publicPayloadJson, question: 'Unrelated question' };
    const changed = prepareTranscriptTerminalResult(
      {
        metadata: {
          id: f.item.id,
          user_id: f.item.user_id,
          session_id: f.item.session_id,
          turn_id: f.item.turn_id,
          continuation_no: f.item.continuation_no,
          sequence_no: f.item.sequence_no,
          schema_version: 1,
          source_message_id: null,
          source_trace_step_id: f.item.source_trace_step_id,
          import_attempt_id: null,
          created_at: f.item.created_at,
        },
        parent: f.parent,
        status: 'succeeded',
        result: {
          type: 'confirmation_requested',
          confirmation_id: f.confirmation.id,
          payload_digest: canonicalSha256(payload),
        },
      },
      contracts,
    );
    f.query.agentTurnConfirmations.findFirst.mockResolvedValue({
      ...f.confirmation,
      publicPayloadJson: payload,
      payloadDigest: canonicalSha256(payload),
    });
    f.query.agentTraceSteps.findFirst.mockResolvedValue({
      ...f.step,
      outputSummary: {
        ...f.step.outputSummary,
        transcript_result: prepareTranscriptTerminalResultBinding(changed, f.parent, contracts),
      },
    });
    expect(await f.binder.verifySource({ item: changed, parent: f.parent })).toBe(false);
  });

  it.each(['scope', 'authored-scope'] as const)(
    'binds %s to its owned payload and exact scope digest',
    async (kind) => {
      const f = fixture(kind);
      expect(await f.binder.verifySource(f)).toBe(true);
      f.query.agentTurnConfirmations.findFirst.mockResolvedValue({
        ...f.confirmation,
        publicPayloadJson: {
          ...f.confirmation.publicPayloadJson,
          scope_digest: 'b'.repeat(64),
        },
      });
      expect(await f.binder.verifySource(f)).toBe(false);
    },
  );
});
