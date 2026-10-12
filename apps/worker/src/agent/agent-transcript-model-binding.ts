import {
  creativeDirectionSelectionSchema,
  prepareAgentTranscriptDependencies,
  transcriptSequenceSchema,
  verifyAgentTranscriptItem,
  type AgentTranscriptItem,
  type AgentTranscriptItemContracts,
} from '@ecom-forge/agent';
import type { agentTraceSteps } from '@ecom-forge/db';
import { canonicalJson } from '@ecom-forge/shared';
import { z } from 'zod';

const uuidSchema = z.uuid().toLowerCase();
const continuationSchema = z.int().positive().max(2_147_483_647);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const modelInputBindingSchema = z.strictObject({
  schema_version: z.literal(1),
  step_id: uuidSchema,
  continuation_no: continuationSchema,
  resource_dependencies_digest: digestSchema,
});
export const modelOutputBindingSchema = z.strictObject({
  schema_version: z.literal(1),
  step_id: uuidSchema,
  assistant_item_id: uuidSchema,
  sequence_no: transcriptSequenceSchema,
  payload_digest: digestSchema,
});
// Existing diagnostic fields are not semantic inputs; only the nested binding is strict.
// Diagnostic summary fields (round/tokens/exposure/phase) ride along in production writes;
// only the nested binding is semantic input, so the rest stay optional here.
const inputSummarySchema = z.strictObject({
  purpose: z.literal('agent_step'),
  round: z.int().nonnegative().optional(),
  continuation_no: continuationSchema,
  requested_input_tokens: z.int().nonnegative().optional(),
  requested_max_output_tokens: z.int().nonnegative().optional(),
  creative_direction: creativeDirectionSelectionSchema.optional(),
  creative_direction_hash: digestSchema.optional(),
  reserved_exposure_cost_cny: z.string().optional(),
  transcript_phase: z.enum(['planning', 'authoring']).optional(),
  transcript_input: modelInputBindingSchema,
});
const outputSummarySchema = z.strictObject({
  outcome: z.string().optional(),
  transcript_outcome_digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  diagnostic: z.record(z.string(), z.unknown()).optional(),
  // recordModelStepDiagnostic jsonb-merges downstream outcomes here without touching the
  // accepted model binding, so the bag is tolerated (not validated) on re-read.
  downstream: z.record(z.string(), z.unknown()).optional(),
  message_id: z.uuid().optional(),
  confirmation_id: z.uuid().optional(),
  transcript_output: modelOutputBindingSchema,
  // Terminal steps merge their result binding into the same summary (see
  // agent-transcript-results.ts jsonb merge); its presence is verified separately.
  transcript_result: z.unknown().optional(),
  // Knowledge batches merge an array of per-call result bindings the same way.
  transcript_results: z.unknown().optional(),
});
const prepareInputSchema = z.strictObject({
  step_id: uuidSchema,
  continuation_no: continuationSchema,
  resource_dependencies: z.array(z.unknown()),
});

export type TranscriptModelSourceStep = Readonly<
  Pick<
    typeof agentTraceSteps.$inferSelect,
    'id' | 'stepType' | 'actor' | 'status' | 'errorCode' | 'inputSummary' | 'outputSummary'
  >
>;

/** Persist on the reserved step before calling the model, using the host's actual input. */
export function prepareTranscriptModelInputBinding(input: unknown, dependencySchema: z.ZodType) {
  return withBindingErrors(() => {
    const parsed = prepareInputSchema.parse(input);
    const checked = prepareAgentTranscriptDependencies(
      parsed.resource_dependencies,
      dependencySchema,
    );
    return Object.freeze(
      modelInputBindingSchema.parse({
        schema_version: 1,
        step_id: parsed.step_id,
        continuation_no: parsed.continuation_no,
        resource_dependencies_digest: checked.digest,
      }),
    );
  });
}

/** Use the already-persisted input binding; commit this marker with the item and usage. */
export function prepareTranscriptModelOutputBinding(
  raw: AgentTranscriptItem,
  inputBinding: unknown,
  contracts: AgentTranscriptItemContracts,
) {
  return withBindingErrors(() => {
    const item = verifyAgentTranscriptItem(
      { scope: { user_id: raw.user_id, session_id: raw.session_id }, record: raw },
      contracts,
    ).item;
    const input = modelInputBindingSchema.parse(inputBinding);
    if (
      item.payload_json.type !== 'assistant_output' ||
      item.source_trace_step_id !== input.step_id ||
      item.source_key !== `model:${input.step_id}:output` ||
      item.continuation_no !== input.continuation_no ||
      item.source_message_id !== null ||
      item.import_attempt_id !== null ||
      prepareAgentTranscriptDependencies(
        item.resource_dependencies_json,
        contracts.resourceDependencySchema,
      ).digest !== input.resource_dependencies_digest
    )
      fail();
    return Object.freeze(
      modelOutputBindingSchema.parse({
        schema_version: 1,
        step_id: input.step_id,
        assistant_item_id: item.id,
        sequence_no: item.sequence_no,
        payload_digest: item.payload_digest,
      }),
    );
  });
}

/** The repository must first prove that this step belongs to the owned trace and turn. */
export function verifyTranscriptModelOutputSource(
  item: AgentTranscriptItem,
  step: TranscriptModelSourceStep,
  contracts: AgentTranscriptItemContracts,
): boolean {
  try {
    if (
      step.id !== item.source_trace_step_id ||
      step.stepType !== 'llm_call' ||
      step.actor !== 'agent' ||
      step.status !== 'succeeded' ||
      step.errorCode !== null
    )
      return false;
    const input = inputSummarySchema.parse(step.inputSummary);
    const output = outputSummarySchema.parse(step.outputSummary);
    if (
      input.continuation_no !== item.continuation_no ||
      input.transcript_input.step_id !== step.id
    )
      return false;
    const expected = prepareTranscriptModelOutputBinding(item, input.transcript_input, contracts);
    return canonicalJson(output.transcript_output) === canonicalJson(expected);
  } catch {
    return false;
  }
}

function withBindingErrors<T>(operation: () => T): T {
  try {
    return operation();
  } catch {
    fail();
  }
}

function fail(): never {
  throw new Error('AGENT_TRANSCRIPT_MODEL_SOURCE_INVALID');
}
