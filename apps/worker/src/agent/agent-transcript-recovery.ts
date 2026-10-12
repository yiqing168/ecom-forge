import {
  mergeAuthoredPrompts,
  mergeAuthoredPromptBatch,
  authoringCandidateKeys,
  authoredPromptsSchema,
  parseAgentBrainStepOutcome,
  validateAgentTranscriptProtocol,
  type AgentBrainStepOutcome,
} from '@ecom-forge/agent';
import { agentTraceSteps, agentTraces, and, eq, type Database } from '@ecom-forge/db';
import { addMoney, compareMoney, canonicalSha256 } from '@ecom-forge/shared';
import { z } from 'zod';

import { transcriptValue } from './agent-transcript-brain-view.js';
import {
  verifyTranscriptModelOutputSource,
  type TranscriptModelSourceStep,
} from './agent-transcript-model-binding.js';
import { nativeTranscriptContracts } from './agent-transcript-native.js';
import {
  transcriptInspectedImageSchema,
  transcriptLoadedSkillSchema,
} from './agent-transcript-tool-contracts.js';
import type { AuthorizedAgentTranscriptItem } from './agent-transcript.repository.js';
import type { ClaimedAgentTurn } from './agent-turn.types.js';

export interface NativeTranscriptPendingExecution {
  step: { stepId: string; stepNo: number };
  outcome: AgentBrainStepOutcome;
  completedOrdinals: readonly number[];
  budgetUsed: string;
  pricingDrift: boolean;
}

type RecoveryStep = TranscriptModelSourceStep & { stepNo: number; tokenUsageJson: unknown };
type Scope = Pick<ClaimedAgentTurn, 'turnId' | 'sessionId' | 'userId' | 'continuationNo'>;

/** Runtime state that may affect model input must be reconstructed from authorized transcript. */
export function restoreNativeTranscriptRuntimeState(
  items: readonly AuthorizedAgentTranscriptItem[],
  scope: Scope,
  initialResourceSnapshotIds: readonly string[],
) {
  const loadedResourceSnapshotIds = new Set(initialResourceSnapshotIds);
  const materializedImageBindingKeys = new Set<string>();
  const materializedImageDetails: Record<string, 'overview' | 'detail'> = {};
  for (const authorized of items) {
    const item = authorized.item;
    if (item.turn_id !== scope.turnId || item.continuation_no !== scope.continuationNo) continue;
    const payload = item.payload_json;
    if (
      payload.type === 'tool_result' &&
      payload.name === 'load_skill@1' &&
      payload.status === 'succeeded'
    ) {
      const result = transcriptLoadedSkillSchema.parse(transcriptValue(payload.result, authorized));
      for (const resource of result.resources) {
        loadedResourceSnapshotIds.add(resource.resource_snapshot_id);
      }
    }
    if (
      payload.type === 'tool_result' &&
      payload.name === 'inspect_image@1' &&
      payload.status === 'succeeded'
    ) {
      const result = transcriptInspectedImageSchema.parse(
        transcriptValue(payload.result, authorized),
      );
      materializedImageBindingKeys.add(result.binding.binding_key);
      materializedImageDetails[result.binding.binding_key] = result.detail;
    }
  }
  return {
    loadedResourceSnapshotIds: [...loadedResourceSnapshotIds],
    materializedImageBindingKeys: [...materializedImageBindingKeys],
    materializedImageDetails,
  };
}

/** Pure planning over an already authorized window; no tool execution or domain state writes. */
export function planNativeTranscriptRecovery(
  items: readonly AuthorizedAgentTranscriptItem[],
  scope: Scope,
) {
  const protocol = validateAgentTranscriptProtocol(
    {
      scope: { user_id: scope.userId, session_id: scope.sessionId },
      first_sequence_no: items[0]?.item.sequence_no ?? '1',
      require_closed: false,
      items: items.map((item) => item.item),
    },
    nativeTranscriptContracts,
  );
  let authoringPlan: Record<string, unknown> | undefined;
  const authoringCompletedKeys: string[] = [];
  for (const authorized of items) {
    const item = authorized.item;
    if (item.turn_id !== scope.turnId || item.continuation_no !== scope.continuationNo) continue;
    const payload = item.payload_json;
    if (
      payload.type !== 'tool_result' ||
      !['agent_candidate_plan@1', 'agent_author_prompts@1'].includes(payload.name)
    )
      continue;
    const result = z
      .record(z.string(), z.unknown())
      .parse(transcriptValue(payload.result, authorized));
    if (payload.name === 'agent_author_prompts@1') {
      if (payload.status !== 'succeeded' || result.type !== 'authoring_batch_saved') continue;
      const parent = items.find((entry) => entry.item.id === item.reply_to_item_id);
      if (
        !authoringPlan ||
        !parent ||
        parent.item.payload_json.type !== 'assistant_output' ||
        parent.item.payload_json.mode !== 'terminal'
      )
        invalid();
      const call = parent.item.payload_json.calls[0]!;
      if (
        call.name !== 'agent_author_prompts@1' ||
        result.arguments_digest !== call.arguments_digest
      )
        invalid();
      const args = authoredPromptsSchema.parse(transcriptValue(call.arguments, parent));
      const expected = authoringCandidateKeys(authoringPlan)
        .filter((key) => !authoringCompletedKeys.includes(key))
        .slice(0, 1);
      authoringPlan = mergeAuthoredPromptBatch(authoringPlan, args, expected);
      authoringCompletedKeys.push(...expected);
      continue;
    }
    if (payload.status !== 'succeeded' || result.type !== 'authoring_required') {
      authoringPlan = undefined;
      continue;
    }
    const parent = items.find((entry) => entry.item.id === item.reply_to_item_id);
    if (
      !parent ||
      parent.item.payload_json.type !== 'assistant_output' ||
      parent.item.payload_json.mode === 'text'
    )
      invalid();
    const call = parent.item.payload_json.calls[0];
    if (
      !call ||
      call.name !== 'agent_candidate_plan@1' ||
      result.plan_digest !== call.arguments_digest
    )
      invalid();
    const args = z.record(z.string(), z.unknown()).parse(transcriptValue(call.arguments, parent));
    authoringPlan = z.record(z.string(), z.unknown()).parse(args.plan);
    authoringCompletedKeys.length = 0;
  }
  const pendingCall = protocol.pending_calls[0];
  if (!pendingCall) return { authoringPlan, authoringCompletedKeys, pending: undefined };
  const parent = items.find((entry) => entry.item.id === pendingCall.assistant_item_id);
  if (
    !parent ||
    parent.item.turn_id !== scope.turnId ||
    parent.item.continuation_no !== scope.continuationNo ||
    parent.item.payload_json.type !== 'assistant_output' ||
    parent.item.payload_json.mode === 'text'
  )
    invalid();
  const results = items.filter((entry) => entry.item.reply_to_item_id === parent.item.id);
  // The production writer atomically closes a failed call and its unexecuted siblings.
  if (
    results.some(
      (entry) =>
        entry.item.payload_json.type !== 'tool_result' ||
        entry.item.payload_json.status !== 'succeeded',
    )
  )
    invalid();
  return {
    authoringPlan,
    authoringCompletedKeys,
    pending: { parent, completedOrdinals: results.map((entry) => entry.item.call_ordinal!) },
  };
}

/** Reconstruct semantics from transcript, using trace only to verify its settled source and usage. */
export function restoreNativeTranscriptOutcome(
  pending: NonNullable<ReturnType<typeof planNativeTranscriptRecovery>['pending']>,
  step: RecoveryStep,
  authoringPlan?: Record<string, unknown>,
): Omit<NativeTranscriptPendingExecution, 'budgetUsed' | 'pricingDrift'> {
  const parent = pending.parent;
  if (!verifyTranscriptModelOutputSource(parent.item, step, nativeTranscriptContracts)) invalid();
  if (!Number.isSafeInteger(step.stepNo) || step.stepNo < 1) invalid();
  const payload = parent.item.payload_json;
  if (payload.type !== 'assistant_output' || payload.mode === 'text') invalid();
  const candidates: unknown[] = [];
  if (payload.mode === 'tools') {
    if (payload.calls.some((call) => !call.provider_call_id)) invalid();
    candidates.push({
      type: 'tool_calls',
      ...(payload.commentary ? { commentary: payload.commentary } : {}),
      calls: payload.calls.map((call) => ({
        call_id: call.provider_call_id,
        name: call.name,
        arguments: transcriptValue(call.arguments, parent),
        ...(call.provider_metadata ? { provider_metadata: call.provider_metadata } : {}),
      })),
      usage: step.tokenUsageJson,
    });
  } else {
    const call = payload.calls[0]!;
    const replayMetadata = call.provider_metadata
      ? { provider_metadata: call.provider_metadata }
      : {};
    const args = z.record(z.string(), z.unknown()).parse(transcriptValue(call.arguments, parent));
    switch (call.name) {
      case 'agent_respond@1':
        candidates.push({
          type: 'respond',
          ...args,
          ...replayMetadata,
          usage: step.tokenUsageJson,
        });
        break;
      case 'agent_request_clarification@1':
        candidates.push({
          type: 'request_clarification',
          ...args,
          ...replayMetadata,
          usage: step.tokenUsageJson,
        });
        break;
      case 'agent_request_product_facts@1':
        candidates.push({
          type: 'request_product_facts',
          ...args,
          ...replayMetadata,
          usage: step.tokenUsageJson,
        });
        break;
      case 'agent_candidate_plan@1':
        candidates.push(
          {
            type: 'candidate_plan',
            plan: args.plan,
            ...replayMetadata,
            usage: step.tokenUsageJson,
          },
          {
            type: 'authoring_request',
            plan: args.plan,
            ...replayMetadata,
            usage: step.tokenUsageJson,
          },
        );
        break;
      case 'agent_author_prompts@1':
        if (!authoringPlan) invalid();
        candidates.push({
          type: 'authoring_batch',
          authoring_output: {
            name: call.name,
            arguments: args,
            provider_call_id: call.provider_call_id,
            ...replayMetadata,
          },
          usage: step.tokenUsageJson,
        });
        // Earlier accepted single-call transcripts require full coverage; a partial v2 call
        // must not fail recovery just because it cannot match that historical outcome.
        try {
          candidates.push({
            type: 'candidate_plan',
            plan: mergeAuthoredPrompts(authoringPlan, args),
            authoring_output: {
              name: call.name,
              arguments: args,
              provider_call_id: call.provider_call_id,
              ...replayMetadata,
            },
            usage: step.tokenUsageJson,
          });
        } catch {
          // The batch candidate above is still verified by its exact persisted digest.
        }
        break;
      default:
        invalid();
    }
  }
  const diagnostic = z
    .object({ transcript_outcome_digest: z.string().regex(/^[a-f0-9]{64}$/) })
    .parse(step.outputSummary);
  const matches = candidates.filter(
    (candidate) => canonicalSha256(candidate) === diagnostic.transcript_outcome_digest,
  );
  if (matches.length !== 1) invalid();
  return {
    step: { stepId: step.id, stepNo: step.stepNo },
    outcome: parseAgentBrainStepOutcome(matches[0]),
    completedOrdinals: pending.completedOrdinals,
  };
}

export async function readNativeTranscriptRecovery(
  database: Pick<Database, 'query'>,
  items: readonly AuthorizedAgentTranscriptItem[],
  claimed: ClaimedAgentTurn,
) {
  const plan = planNativeTranscriptRecovery(items, claimed);
  if (!plan.pending)
    return {
      authoringPlan: plan.authoringPlan,
      authoringCompletedKeys: plan.authoringCompletedKeys,
      pending: undefined,
    };
  const step = await database.query.agentTraceSteps.findFirst({
    where: and(
      eq(agentTraceSteps.id, plan.pending.parent.item.source_trace_step_id!),
      eq(agentTraceSteps.traceId, claimed.traceId),
    ),
  });
  if (!step || step.estimatedCost === null) invalid();
  const trace = await database.query.agentTraces.findFirst({
    where: and(
      eq(agentTraces.id, claimed.traceId),
      eq(agentTraces.turnId, claimed.turnId),
      eq(agentTraces.sessionId, claimed.sessionId),
      eq(agentTraces.userId, claimed.userId),
    ),
  });
  if (!trace) invalid();
  // Real input summaries also carry the model input binding (purpose/continuation_no/transcript_input);
  // only the reserved exposure is read here, so the sibling keys are stripped rather than rejected.
  const reserved = z.object({ reserved_exposure_cost_cny: z.string() }).parse(step.inputSummary);
  return {
    authoringPlan: plan.authoringPlan,
    authoringCompletedKeys: plan.authoringCompletedKeys,
    pending: {
      ...restoreNativeTranscriptOutcome(plan.pending, step, plan.authoringPlan),
      budgetUsed: addMoney(trace.estimatedCost, trace.reservedCost),
      pricingDrift: compareMoney(step.estimatedCost, reserved.reserved_exposure_cost_cny) > 0,
    },
  };
}

function invalid(): never {
  throw new Error('AGENT_TRANSCRIPT_RECOVERY_INVALID');
}
