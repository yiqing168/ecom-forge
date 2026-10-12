import {
  mergeAuthoredPrompts,
  type AgentBrainStepOutcome,
  type AgentTranscriptItem,
} from '@ecom-forge/agent';
import { canonicalSha256 } from '@ecom-forge/shared';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@ecom-forge/db';

import {
  prepareTranscriptModelInputBinding,
  prepareTranscriptModelOutputBinding,
} from './agent-transcript-model-binding.js';
import { nativeTranscriptContracts as contracts } from './agent-transcript-native.js';
import {
  planNativeTranscriptRecovery,
  readNativeTranscriptRecovery,
  restoreNativeTranscriptOutcome,
  restoreNativeTranscriptRuntimeState,
} from './agent-transcript-recovery.js';
import {
  prepareTranscriptTerminalOutput,
  prepareTranscriptTerminalResult,
} from './agent-transcript-terminal-contracts.js';
import {
  prepareTranscriptKnowledgeBatch,
  prepareTranscriptKnowledgeResult,
} from './agent-transcript-tool-contracts.js';
import {
  privatePayloadUses,
  type AuthorizedAgentTranscriptItem,
} from './agent-transcript.repository.js';
import type { ClaimedAgentTurn } from './agent-turn.types.js';

const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const scope = { userId: id(1), sessionId: id(2), turnId: id(3), continuationNo: 1 };
const usage = { input_tokens: 20, cached_input_tokens: 4, output_tokens: 30 };
const metadata = (sequence = 1) => ({
  id: id(100 + sequence),
  user_id: scope.userId,
  session_id: scope.sessionId,
  turn_id: scope.turnId,
  continuation_no: 1,
  sequence_no: String(sequence),
  schema_version: 1 as const,
  source_message_id: null,
  source_trace_step_id: id(200 + sequence),
  import_attempt_id: null,
  reply_to_item_id: null,
  call_ordinal: null,
  resource_dependencies_json: [],
  created_at: '2026-09-10T00:00:00.000Z',
});
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

function authorized(item: AgentTranscriptItem): AuthorizedAgentTranscriptItem {
  return { item, history_generation: '1', private_payloads: [] };
}
function terminal(
  outcome: AgentBrainStepOutcome,
  sequence = 1,
  phase: 'planning' | 'authoring' = 'planning',
): AuthorizedAgentTranscriptItem {
  const captured = prepareTranscriptTerminalOutput(
    { metadata: metadata(sequence), outcome, phase, privatePayloadId: id(300 + sequence) },
    contracts,
  );
  return {
    ...authorized(captured.item),
    private_payloads: privatePayloadUses(captured.item, contracts).map(({ reference }) => ({
      reference,
      value: captured.privatePayloads.find((entry) => entry.id === reference.payload_id)!
        .content_json,
    })),
  };
}
function source(parent: AgentTranscriptItem, outcome: AgentBrainStepOutcome) {
  const binding = prepareTranscriptModelInputBinding(
    {
      step_id: parent.source_trace_step_id,
      continuation_no: 1,
      resource_dependencies: parent.resource_dependencies_json,
    },
    contracts.resourceDependencySchema,
  );
  return {
    id: parent.source_trace_step_id!,
    stepNo: 7,
    stepType: 'llm_call' as const,
    actor: 'agent' as const,
    status: 'succeeded' as const,
    errorCode: null,
    inputSummary: { purpose: 'agent_step', continuation_no: 1, transcript_input: binding },
    outputSummary: {
      transcript_output: prepareTranscriptModelOutputBinding(parent, binding, contracts),
      transcript_outcome_digest: canonicalSha256(outcome),
    },
    tokenUsageJson: usage,
  };
}
function recover(items: AuthorizedAgentTranscriptItem[], outcome: AgentBrainStepOutcome) {
  const recovery = planNativeTranscriptRecovery(items, scope);
  expect(recovery.pending).toBeDefined();
  return restoreNativeTranscriptOutcome(
    recovery.pending!,
    source(recovery.pending!.parent.item, outcome),
    recovery.authoringPlan,
  );
}

describe('native transcript pending execution recovery', () => {
  it('preserves Google signatures across terminal capture and restart recovery', () => {
    const outcome: AgentBrainStepOutcome = {
      type: 'respond',
      text: 'Reply',
      provider_metadata: { google: { thoughtSignature: 'opaque-test-signature' } },
      usage,
    };
    const parent = terminal(outcome);
    expect(parent.item.payload_json).toMatchObject({
      calls: [{ provider_metadata: outcome.provider_metadata }],
    });
    expect(recover([parent], outcome).outcome).toEqual(outcome);
  });
  it('reads settled usage and exact decimal exposure without writing or calling a provider', async () => {
    const outcome: AgentBrainStepOutcome = { type: 'respond', text: 'Reply', usage };
    const parent = terminal(outcome);
    const step = source(parent.item, outcome);
    const database = {
      query: {
        agentTraceSteps: {
          findFirst: vi.fn().mockResolvedValue({
            ...step,
            estimatedCost: '0.07',
            inputSummary: { ...step.inputSummary, reserved_exposure_cost_cny: '0.06' },
          }),
        },
        agentTraces: {
          findFirst: vi.fn().mockResolvedValue({ estimatedCost: '0.10', reservedCost: '0.02' }),
        },
      },
    };
    const restored = await readNativeTranscriptRecovery(database as unknown as Database, [parent], {
      ...scope,
      traceId: id(99),
    } as ClaimedAgentTurn);
    expect(restored.pending).toMatchObject({ outcome, budgetUsed: '0.12', pricingDrift: true });
    expect(database.query.agentTraceSteps.findFirst).toHaveBeenCalledOnce();
    expect(database.query.agentTraces.findFirst).toHaveBeenCalledOnce();
  });

  it.each(['step', 'cost', 'trace'] as const)(
    'fails closed when settled %s evidence is missing',
    async (missing) => {
      const outcome: AgentBrainStepOutcome = { type: 'respond', text: 'Reply', usage };
      const parent = terminal(outcome);
      const step = source(parent.item, outcome);
      const database = {
        query: {
          agentTraceSteps: {
            findFirst: vi.fn().mockResolvedValue(
              missing === 'step'
                ? undefined
                : {
                    ...step,
                    estimatedCost: missing === 'cost' ? null : '0.05',
                    inputSummary: { ...step.inputSummary, reserved_exposure_cost_cny: '0.06' },
                  },
            ),
          },
          agentTraces: {
            findFirst: vi
              .fn()
              .mockResolvedValue(
                missing === 'trace' ? undefined : { estimatedCost: '0.05', reservedCost: '0.00' },
              ),
          },
        },
      };
      await expect(
        readNativeTranscriptRecovery(database as unknown as Database, [parent], {
          ...scope,
          traceId: id(99),
        } as ClaimedAgentTurn),
      ).rejects.toThrow('AGENT_TRANSCRIPT_RECOVERY_INVALID');
    },
  );

  it.each([
    { type: 'respond', text: 'Exact accepted reply', usage },
    { type: 'request_clarification', question: 'Which version?', usage },
    {
      type: 'request_clarification',
      question: 'Which version?',
      suggestions: ['First', 'Second'],
      usage,
    },
    { type: 'candidate_plan', plan, usage },
    { type: 'authoring_request', plan, usage },
  ] as AgentBrainStepOutcome[])(
    'restores the original $type without using trace prose',
    (outcome) => {
      const restored = recover([terminal(outcome)], outcome);
      expect(restored).toEqual({
        step: { stepId: id(201), stepNo: 7 },
        outcome,
        completedOrdinals: [],
      });
    },
  );

  it('does not restore an already closed terminal action', () => {
    const parent = terminal({ type: 'respond', text: 'Reply', usage });
    const receipt = prepareTranscriptTerminalResult(
      {
        metadata: { ...metadata(2), source_trace_step_id: parent.item.source_trace_step_id },
        parent: parent.item,
        status: 'succeeded',
        result: {
          type: 'message_published',
          message_id: id(9),
          content_digest: canonicalSha256({ text: 'Reply' }),
        },
      },
      contracts,
    );
    expect(
      planNativeTranscriptRecovery([parent, authorized(receipt)], scope).pending,
    ).toBeUndefined();
  });

  function authoringHistory() {
    const draft = terminal({ type: 'authoring_request', plan, usage });
    if (draft.item.payload_json.type !== 'assistant_output') throw new Error('fixture');
    const receipt = prepareTranscriptTerminalResult(
      {
        metadata: { ...metadata(2), source_trace_step_id: draft.item.source_trace_step_id },
        parent: draft.item,
        status: 'succeeded',
        result: {
          type: 'authoring_required',
          plan_digest: draft.item.payload_json.calls[0]!.arguments_digest,
        },
      },
      contracts,
    );
    return [draft, authorized(receipt)];
  }

  it('restores a closed authoring handoff without replaying the planning call', () => {
    expect(planNativeTranscriptRecovery(authoringHistory(), scope)).toMatchObject({
      authoringPlan: plan,
      pending: undefined,
    });
  });
  it.each([1, 4, 9])(
    'restores %i-node authoring checkpoints and the last pending batch without regenerating prior nodes',
    (count) => {
      const multi = {
        ...plan,
        nodes: Array.from({ length: count }, (_, index) => ({
          ...plan.nodes[0]!,
          candidate_key: `node-${index}`,
        })),
      };
      const draft = terminal({ type: 'authoring_request', plan: multi, usage });
      if (draft.item.payload_json.type !== 'assistant_output') throw new Error('fixture');
      const receipt = prepareTranscriptTerminalResult(
        {
          metadata: { ...metadata(2), source_trace_step_id: draft.item.source_trace_step_id },
          parent: draft.item,
          status: 'succeeded',
          result: {
            type: 'authoring_required',
            plan_digest: draft.item.payload_json.calls[0]!.arguments_digest,
          },
        },
        contracts,
      );
      const items = [draft, authorized(receipt)];
      for (let index = 0; index < count - 1; index++) {
        const batch = terminal(
          {
            type: 'authoring_batch',
            authoring_output: {
              name: 'agent_author_prompts@1',
              arguments: {
                prompts: [
                  { candidate_key: `node-${index}`, creative_prompt: `Accepted ${index}.` },
                ],
              },
              provider_call_id: `batch-${index}`,
            },
            usage,
          },
          items.length + 1,
          'authoring',
        );
        if (batch.item.payload_json.type !== 'assistant_output') throw new Error('fixture');
        const saved = prepareTranscriptTerminalResult(
          {
            metadata: {
              ...metadata(items.length + 2),
              source_trace_step_id: batch.item.source_trace_step_id,
            },
            parent: batch.item,
            status: 'succeeded',
            result: {
              type: 'authoring_batch_saved',
              arguments_digest: batch.item.payload_json.calls[0]!.arguments_digest,
            },
          },
          contracts,
        );
        items.push(batch, authorized(saved));
      }
      const state = planNativeTranscriptRecovery(items, scope);
      expect(state.authoringCompletedKeys).toHaveLength(count - 1);
      expect(state.pending).toBeUndefined();
      const nodes = state.authoringPlan!.nodes as typeof multi.nodes;
      for (let index = 0; index < count - 1; index++)
        expect(nodes[index]!.params).toMatchObject({ creative_prompt: `Accepted ${index}.` });
      const outcome: AgentBrainStepOutcome = {
        type: 'authoring_batch',
        authoring_output: {
          name: 'agent_author_prompts@1',
          arguments: {
            prompts: [
              { candidate_key: `node-${count - 1}`, creative_prompt: 'Final complete prompt.' },
            ],
          },
          provider_call_id: 'final-batch',
        },
        usage,
      };
      expect(
        recover([...items, terminal(outcome, items.length + 1, 'authoring')], outcome).outcome,
      ).toEqual(outcome);
    },
  );

  it('merges the original authored prompts into the transcript draft for compiler recovery', () => {
    const authored = {
      prompts: [{ candidate_key: 'first', creative_prompt: 'Original complete prompt.' }],
    };
    const outcome: AgentBrainStepOutcome = {
      type: 'candidate_plan',
      plan: mergeAuthoredPrompts(plan, authored),
      authoring_output: {
        name: 'agent_author_prompts@1',
        arguments: authored,
        provider_call_id: 'author-call',
      },
      usage,
    };
    expect(
      recover([...authoringHistory(), terminal(outcome, 3, 'authoring')], outcome).outcome,
    ).toEqual(outcome);
  });

  it('does not borrow an authoring plan from a different continuation', () => {
    expect(
      planNativeTranscriptRecovery(authoringHistory(), { ...scope, continuationNo: 2 })
        .authoringPlan,
    ).toBeUndefined();
  });

  it('rejects authoring recovery without its accepted draft', () => {
    const authored = {
      prompts: [{ candidate_key: 'first', creative_prompt: 'Original complete prompt.' }],
    };
    const outcome: AgentBrainStepOutcome = {
      type: 'candidate_plan',
      plan: mergeAuthoredPrompts(plan, authored),
      authoring_output: {
        name: 'agent_author_prompts@1',
        arguments: authored,
        provider_call_id: null,
      },
      usage,
    };
    expect(() => recover([terminal(outcome, 1, 'authoring')], outcome)).toThrow(
      'AGENT_TRANSCRIPT_RECOVERY_INVALID',
    );
  });

  it.each(['turnId', 'continuationNo'] as const)(
    'rejects pending work belonging to a different %s',
    (key) => {
      const items = [terminal({ type: 'respond', text: 'Reply', usage })];
      expect(() =>
        planNativeTranscriptRecovery(items, { ...scope, [key]: key === 'turnId' ? id(77) : 2 }),
      ).toThrow('AGENT_TRANSCRIPT_RECOVERY_INVALID');
    },
  );

  it.each(['status', 'usage', 'digest', 'binding', 'stepNo'] as const)(
    'rejects %s drift instead of regenerating output',
    (variant) => {
      const outcome: AgentBrainStepOutcome = { type: 'respond', text: 'Reply', usage };
      const parent = terminal(outcome);
      const recovery = planNativeTranscriptRecovery([parent], scope);
      const step = source(parent.item, outcome);
      const changed =
        variant === 'status'
          ? { ...step, status: 'failed' as const }
          : variant === 'usage'
            ? { ...step, tokenUsageJson: { ...usage, input_tokens: 21 } }
            : variant === 'digest'
              ? {
                  ...step,
                  outputSummary: {
                    ...step.outputSummary,
                    transcript_outcome_digest: '0'.repeat(64),
                  },
                }
              : variant === 'binding'
                ? { ...step, id: id(999) }
                : { ...step, stepNo: 0 };
      expect(() => restoreNativeTranscriptOutcome(recovery.pending!, changed)).toThrow(
        'AGENT_TRANSCRIPT_RECOVERY_INVALID',
      );
    },
  );

  it('preserves original ordinals and skips a completed member of a knowledge batch', () => {
    const calls = [0, 1].map((index) => ({
      name: 'load_skill@1',
      call_id: `provider_${index}`,
      arguments: { skill_id: `aux${index}@1.0.0`, view: 'planning' },
    }));
    const outcome: AgentBrainStepOutcome = { type: 'tool_calls', calls, usage };
    const parent = prepareTranscriptKnowledgeBatch(metadata(), calls, contracts);
    const resource = {
      kind: 'skill_resource',
      skill_id: 'aux0@1.0.0',
      definition_hash: 'b'.repeat(64),
      package_record_id: id(71),
      catalog_release_id: id(72),
      catalog_version: 'c'.repeat(64),
      resource_snapshot_id: id(73),
      package_resource_id: id(74),
      resource_path: 'SKILL.md',
      resource_hash: 'd'.repeat(64),
    };
    const receipt = prepareTranscriptKnowledgeResult(
      {
        metadata: metadata(2),
        parent,
        ordinal: 0,
        status: 'succeeded',
        result: {
          skill_id: 'aux0@1.0.0',
          view: 'planning',
          already_loaded: false,
          resources: [resource],
        },
      },
      contracts,
    );
    expect(recover([authorized(parent), authorized(receipt)], outcome)).toMatchObject({
      outcome,
      completedOrdinals: [0],
    });
    expect(
      restoreNativeTranscriptRuntimeState([authorized(parent), authorized(receipt)], scope, [
        id(70),
      ]),
    ).toEqual({
      loadedResourceSnapshotIds: [id(70), resource.resource_snapshot_id],
      materializedImageBindingKeys: [],
      materializedImageDetails: {},
    });
    expect(
      restoreNativeTranscriptRuntimeState(
        [authorized(parent), authorized(receipt)],
        { ...scope, continuationNo: 2 },
        [id(70)],
      ).loadedResourceSnapshotIds,
    ).toEqual([id(70)]);
  });
});
