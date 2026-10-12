import { randomUUID } from 'node:crypto';

import {
  parseAgentBrainStepOutcome,
  agentOutputDiagnosticSchema,
  publicTextPolicyRuleSchema,
  prepareAgentTranscriptItem,
  type AgentBrainStepOutcome,
  type AgentTranscriptItem,
  type AgentTranscriptItemContracts,
} from '@ecom-forge/agent';
import { agentTraces, agentTraceSteps, and, eq, type Database } from '@ecom-forge/db';
import { canonicalJson, canonicalSha256 } from '@ecom-forge/shared';
import { z } from 'zod';

import { appendNativeTranscriptBatch } from './agent-transcript-append.js';
import type { AgentTranscriptWriteScope } from './agent-transcript-write-transaction.js';

export const MAX_MODEL_OUTPUT_REPAIRS = 3;
export const MAX_PUBLIC_TEXT_REPAIRS = 1;

const publicTextRejectedPolicyContextSchema = z.strictObject({
  public_error_code: z.literal('AGENT_PUBLIC_TEXT_REJECTED'),
  rule: publicTextPolicyRuleSchema,
  retryable: z.boolean(),
  repair_attempt: z.int().min(1).max(2),
  max_repair_attempts: z.literal(1),
  remaining_repair_attempts: z.int().min(0).max(1),
  required_action: z.literal('return_safe_public_text_without_secrets_or_private_context'),
});

const invalidToolInputPolicyContextSchema = z.strictObject({
  public_error_code: z.literal('AGENT_BRAIN_TOOL_INPUT_INVALID'),
  tool: z.string().min(1).max(128),
  paths: z.array(z.string().min(1).max(240)).max(8),
  /** Bounded schema categories and safe repair guidance, never rejected model values. */
  detail: z.string().min(1).max(900).optional(),
  output_diagnostic: agentOutputDiagnosticSchema.optional(),
  retryable: z.boolean().optional(),
  repair_attempt: z.int().min(1).max(4).optional(),
  max_repair_attempts: z.literal(3).optional(),
  remaining_repair_attempts: z.int().min(0).max(3).optional(),
  required_action: z.literal('correct_tool_arguments_or_choose_allowed_action').optional(),
});

const invalidTerminalOutputPolicyContextSchema = z.strictObject({
  public_error_code: z.literal('AGENT_BRAIN_TERMINAL_OUTPUT_INVALID'),
  reason: z.enum([
    'free_text_without_tool_call',
    'empty_without_tool_call',
    'mixed_text_and_tool_calls',
  ]),
  paths: z.array(z.string().min(1).max(240)).max(8),
  output_diagnostic: agentOutputDiagnosticSchema.optional(),
  retryable: z.boolean(),
  repair_attempt: z.int().min(1).max(4),
  max_repair_attempts: z.union([z.literal(1), z.literal(3)]),
  remaining_repair_attempts: z.int().min(0).max(3).optional(),
  required_action: z.enum([
    'call_one_supported_tool',
    'return_nonempty_text_or_call_one_supported_tool',
    'choose_text_or_tools_not_both',
  ]),
  forbidden_actions: z
    .tuple([
      z.literal('emit_free_text_without_a_tool_call'),
      z.literal('infer_respond_from_free_text'),
    ])
    .optional(),
});

const illegalToolBatchPolicyContextSchema = z.strictObject({
  public_error_code: z.literal('AGENT_TOOL_NOT_ALLOWED'),
  call_count: z.int().min(1).max(12),
  retryable: z.boolean(),
  repair_attempt: z.int().min(1).max(4),
  max_repair_attempts: z.literal(3),
  remaining_repair_attempts: z.int().min(0).max(3),
  required_action: z.literal('return_one_allowed_tool_class_or_a_single_terminal_action'),
});

export const transcriptRuntimePolicyContextSchema = z.discriminatedUnion('public_error_code', [
  publicTextRejectedPolicyContextSchema,
  invalidToolInputPolicyContextSchema,
  invalidTerminalOutputPolicyContextSchema,
  illegalToolBatchPolicyContextSchema,
]);

type InvalidToolInput = Extract<AgentBrainStepOutcome, { type: 'invalid_tool_input' }>;
type InvalidTerminalOutput = Extract<AgentBrainStepOutcome, { type: 'invalid_terminal_output' }>;
type RuntimePolicyOutcome =
  | InvalidToolInput
  | InvalidTerminalOutput
  | Extract<AgentBrainStepOutcome, { type: 'public_text_rejected' }>
  | {
      type: 'illegal_tool_batch';
      error_code: 'AGENT_TOOL_NOT_ALLOWED';
      call_count: number;
    };

export function prepareTranscriptRuntimePolicyContext(
  input: {
    id: string;
    userId: string;
    sessionId: string;
    turnId: string;
    continuationNo: number;
    sequenceNo: string;
    stepId: string;
    outcome: RuntimePolicyOutcome;
    repairAttempt?: number;
    createdAt: string;
  },
  contracts: AgentTranscriptItemContracts,
) {
  const content =
    input.outcome.type === 'public_text_rejected'
      ? transcriptRuntimePolicyContextSchema.parse({
          public_error_code: input.outcome.error_code,
          rule: input.outcome.rule,
          retryable: (input.repairAttempt ?? 1) <= MAX_PUBLIC_TEXT_REPAIRS,
          repair_attempt: input.repairAttempt ?? 1,
          max_repair_attempts: MAX_PUBLIC_TEXT_REPAIRS,
          remaining_repair_attempts: Math.max(
            0,
            MAX_PUBLIC_TEXT_REPAIRS - (input.repairAttempt ?? 1) + 1,
          ),
          required_action: 'return_safe_public_text_without_secrets_or_private_context',
        })
      : input.outcome.type === 'invalid_tool_input'
        ? transcriptRuntimePolicyContextSchema.parse({
            public_error_code: input.outcome.error_code,
            tool: input.outcome.tool,
            paths: input.outcome.paths,
            ...(input.outcome.detail === undefined ? {} : { detail: input.outcome.detail }),
            ...(input.outcome.output_diagnostic
              ? { output_diagnostic: input.outcome.output_diagnostic }
              : {}),
            ...(input.repairAttempt === undefined
              ? {}
              : {
                  retryable: input.repairAttempt <= MAX_MODEL_OUTPUT_REPAIRS,
                  repair_attempt: input.repairAttempt,
                  max_repair_attempts: MAX_MODEL_OUTPUT_REPAIRS,
                  remaining_repair_attempts: Math.max(
                    0,
                    MAX_MODEL_OUTPUT_REPAIRS - input.repairAttempt + 1,
                  ),
                  required_action: 'correct_tool_arguments_or_choose_allowed_action',
                }),
          })
        : input.outcome.type === 'illegal_tool_batch'
          ? transcriptRuntimePolicyContextSchema.parse({
              public_error_code: input.outcome.error_code,
              call_count: input.outcome.call_count,
              retryable: (input.repairAttempt ?? 1) <= MAX_MODEL_OUTPUT_REPAIRS,
              repair_attempt: input.repairAttempt ?? 1,
              max_repair_attempts: MAX_MODEL_OUTPUT_REPAIRS,
              remaining_repair_attempts: Math.max(
                0,
                MAX_MODEL_OUTPUT_REPAIRS - (input.repairAttempt ?? 1) + 1,
              ),
              required_action: 'return_one_allowed_tool_class_or_a_single_terminal_action',
            })
          : transcriptRuntimePolicyContextSchema.parse({
              public_error_code: input.outcome.error_code,
              reason: input.outcome.reason,
              paths: input.outcome.paths,
              ...(input.outcome.output_diagnostic
                ? { output_diagnostic: input.outcome.output_diagnostic }
                : {}),
              retryable:
                input.repairAttempt === undefined ||
                input.repairAttempt <= MAX_MODEL_OUTPUT_REPAIRS,
              repair_attempt: input.repairAttempt ?? 1,
              max_repair_attempts: input.repairAttempt === undefined ? 1 : MAX_MODEL_OUTPUT_REPAIRS,
              ...(input.repairAttempt === undefined
                ? {
                    forbidden_actions: [
                      'emit_free_text_without_a_tool_call',
                      'infer_respond_from_free_text',
                    ],
                  }
                : {
                    remaining_repair_attempts: Math.max(
                      0,
                      MAX_MODEL_OUTPUT_REPAIRS - input.repairAttempt + 1,
                    ),
                  }),
              required_action:
                input.repairAttempt === undefined ||
                input.outcome.reason === 'free_text_without_tool_call'
                  ? 'call_one_supported_tool'
                  : input.outcome.reason === 'mixed_text_and_tool_calls'
                    ? 'choose_text_or_tools_not_both'
                    : 'return_nonempty_text_or_call_one_supported_tool',
            });
  const sourceSuffix =
    input.outcome.type === 'public_text_rejected'
      ? 'public-text-rejected'
      : input.outcome.type === 'invalid_tool_input'
        ? 'invalid-tool-input'
        : input.outcome.type === 'illegal_tool_batch'
          ? 'tool-batch-shape'
          : 'invalid-terminal-output';
  return prepareAgentTranscriptItem(
    {
      id: input.id,
      user_id: input.userId,
      session_id: input.sessionId,
      turn_id: input.turnId,
      continuation_no: input.continuationNo,
      sequence_no: input.sequenceNo,
      schema_version: 1,
      item_type: 'host_context',
      source_key: `policy:${input.stepId}:${sourceSuffix}`,
      source_message_id: null,
      source_trace_step_id: input.stepId,
      import_attempt_id: null,
      reply_to_item_id: null,
      call_ordinal: null,
      payload_json: {
        schema_version: 1,
        type: 'host_context',
        name: 'runtime_policy@1',
        content: { type: 'inline', value: content },
      },
      resource_dependencies_json: [],
      created_at: input.createdAt,
    },
    contracts,
  ).item;
}

export async function appendTranscriptRuntimePolicyContext(
  scope: AgentTranscriptWriteScope,
  input: {
    stepId: string;
    outcome: RuntimePolicyOutcome;
    repairAttempt: number;
    contracts: AgentTranscriptItemContracts;
  },
): Promise<AgentTranscriptItem> {
  const item = prepareTranscriptRuntimePolicyContext(
    {
      id: randomUUID(),
      userId: scope.userId,
      sessionId: scope.sessionId,
      turnId: scope.turnId,
      continuationNo: scope.continuationNo,
      sequenceNo: scope.nextSequence.toString(),
      stepId: input.stepId,
      outcome: input.outcome,
      repairAttempt: input.repairAttempt,
      createdAt: new Date().toISOString(),
    },
    input.contracts,
  );
  const appended = await appendNativeTranscriptBatch(
    scope,
    { items: [item], privatePayloads: [] },
    input.contracts,
  );
  return appended.items[0]!;
}

/** Trace is source proof only; the semantic repair message is the transcript item above. */
export class AgentTranscriptRuntimePolicyBinding {
  constructor(private readonly database: Pick<Database, 'query'>) {}

  async verifySource(item: AgentTranscriptItem): Promise<boolean> {
    try {
      const payload = item.payload_json;
      if (
        item.item_type !== 'host_context' ||
        payload.type !== 'host_context' ||
        payload.name !== 'runtime_policy@1' ||
        payload.content.type !== 'inline' ||
        !item.turn_id ||
        !item.continuation_no ||
        !item.source_trace_step_id ||
        ![
          `policy:${item.source_trace_step_id}:invalid-tool-input`,
          `policy:${item.source_trace_step_id}:invalid-terminal-output`,
          `policy:${item.source_trace_step_id}:public-text-rejected`,
          `policy:${item.source_trace_step_id}:tool-batch-shape`,
        ].includes(item.source_key) ||
        item.source_message_id !== null ||
        item.import_attempt_id !== null ||
        item.reply_to_item_id !== null ||
        item.call_ordinal !== null ||
        item.resource_dependencies_json.length !== 0
      )
        return false;
      const content = transcriptRuntimePolicyContextSchema.parse(payload.content.value);
      if (canonicalJson(content) !== canonicalJson(payload.content.value)) return false;
      const expectedSourceKey =
        content.public_error_code === 'AGENT_PUBLIC_TEXT_REJECTED'
          ? `policy:${item.source_trace_step_id}:public-text-rejected`
          : content.public_error_code === 'AGENT_BRAIN_TOOL_INPUT_INVALID'
            ? `policy:${item.source_trace_step_id}:invalid-tool-input`
            : content.public_error_code === 'AGENT_TOOL_NOT_ALLOWED'
              ? `policy:${item.source_trace_step_id}:tool-batch-shape`
              : `policy:${item.source_trace_step_id}:invalid-terminal-output`;
      if (item.source_key !== expectedSourceKey) return false;
      const trace = await this.database.query.agentTraces.findFirst({
        where: and(
          eq(agentTraces.turnId, item.turn_id),
          eq(agentTraces.userId, item.user_id),
          eq(agentTraces.sessionId, item.session_id),
        ),
        columns: { id: true },
      });
      if (!trace) return false;
      const step = await this.database.query.agentTraceSteps.findFirst({
        where: and(
          eq(agentTraceSteps.id, item.source_trace_step_id),
          eq(agentTraceSteps.traceId, trace.id),
        ),
        columns: {
          stepType: true,
          actor: true,
          status: true,
          errorCode: true,
          outputSummary: true,
          tokenUsageJson: true,
        },
      });
      if (!step) return false;
      if (content.public_error_code === 'AGENT_TOOL_NOT_ALLOWED') {
        const diagnostic = z
          .object({
            policy: z.literal('tool_batch_shape'),
            outcome: z.literal('tool_batch_rejected'),
            call_count: z.int().min(1).max(12),
            error_key: z.string().regex(/^[a-f0-9]{64}$/),
            progress_hash: z.string().regex(/^[a-f0-9]{64}$/),
            repair_attempt: z.int().min(1).max(4),
          })
          .parse(step.outputSummary);
        if (
          step.stepType !== 'observation' ||
          step.actor !== 'system' ||
          step.status !== 'failed' ||
          step.errorCode !== content.public_error_code ||
          diagnostic.call_count !== content.call_count ||
          diagnostic.repair_attempt !== content.repair_attempt ||
          content.retryable !== content.repair_attempt <= MAX_MODEL_OUTPUT_REPAIRS ||
          content.remaining_repair_attempts !==
            Math.max(0, MAX_MODEL_OUTPUT_REPAIRS - content.repair_attempt + 1)
        )
          return false;
        return true;
      }
      if (
        step.stepType !== 'llm_call' ||
        step.actor !== 'agent' ||
        step.status !== 'failed' ||
        step.errorCode !== content.public_error_code
      )
        return false;
      const summary = z
        .object({
          outcome: z.enum([
            'invalid_tool_input',
            'invalid_terminal_output',
            'public_text_rejected',
          ]),
          transcript_outcome_digest: z.string().regex(/^[a-f0-9]{64}$/),
          diagnostic: z.record(z.string(), z.unknown()),
        })
        .parse(step.outputSummary);
      const persistedAttempt = z
        .object({ repair_attempt: z.int().min(1).max(4).optional() })
        .parse(summary.diagnostic).repair_attempt;
      if (content.max_repair_attempts === MAX_MODEL_OUTPUT_REPAIRS) {
        const attempt = content.repair_attempt;
        if (
          attempt === undefined ||
          persistedAttempt !== attempt ||
          content.retryable !== attempt <= MAX_MODEL_OUTPUT_REPAIRS ||
          content.remaining_repair_attempts !== Math.max(0, MAX_MODEL_OUTPUT_REPAIRS - attempt + 1)
        )
          return false;
      }
      let outcome: AgentBrainStepOutcome;
      if (content.public_error_code === 'AGENT_PUBLIC_TEXT_REJECTED') {
        const diagnostic = z
          .object({
            code: z.literal('AGENT_PUBLIC_TEXT_REJECTED'),
            rule: publicTextPolicyRuleSchema,
          })
          .parse(summary.diagnostic);
        if (
          summary.outcome !== 'public_text_rejected' ||
          diagnostic.rule !== content.rule ||
          persistedAttempt !== content.repair_attempt ||
          content.retryable !== content.repair_attempt <= MAX_PUBLIC_TEXT_REPAIRS ||
          content.remaining_repair_attempts !==
            Math.max(0, MAX_PUBLIC_TEXT_REPAIRS - content.repair_attempt + 1)
        )
          return false;
        outcome = parseAgentBrainStepOutcome({
          type: 'public_text_rejected',
          error_code: content.public_error_code,
          rule: content.rule,
          usage: step.tokenUsageJson,
        });
      } else if (content.public_error_code === 'AGENT_BRAIN_TOOL_INPUT_INVALID') {
        // Tolerant on purpose: the trace diagnostic may carry additional bounded fields
        // (e.g. `detail`); only the identity fields below gate the verification.
        const diagnostic = z
          .object({
            code: z.literal('AGENT_BRAIN_TOOL_INPUT_INVALID'),
            tool: z.string(),
            paths: z.array(z.string()),
          })
          .parse(summary.diagnostic);
        if (
          summary.outcome !== 'invalid_tool_input' ||
          diagnostic.tool !== content.tool ||
          canonicalJson(diagnostic.paths) !== canonicalJson(content.paths)
        )
          return false;
        outcome = parseAgentBrainStepOutcome({
          type: 'invalid_tool_input',
          error_code: content.public_error_code,
          tool: content.tool,
          paths: content.paths,
          ...(content.output_diagnostic ? { output_diagnostic: content.output_diagnostic } : {}),
          usage: step.tokenUsageJson,
        });
      } else {
        const diagnostic = z
          .object({
            code: z.literal('AGENT_BRAIN_TERMINAL_OUTPUT_INVALID'),
            reason: z.enum([
              'free_text_without_tool_call',
              'empty_without_tool_call',
              'mixed_text_and_tool_calls',
            ]),
            paths: z.array(z.string()),
          })
          .parse(summary.diagnostic);
        if (
          summary.outcome !== 'invalid_terminal_output' ||
          diagnostic.reason !== content.reason ||
          canonicalJson(diagnostic.paths) !== canonicalJson(content.paths)
        )
          return false;
        outcome = parseAgentBrainStepOutcome({
          type: 'invalid_terminal_output',
          error_code: content.public_error_code,
          reason: content.reason,
          paths: content.paths,
          ...(content.output_diagnostic ? { output_diagnostic: content.output_diagnostic } : {}),
          usage: step.tokenUsageJson,
        });
      }
      return canonicalSha256(outcome) === summary.transcript_outcome_digest;
    } catch {
      return false;
    }
  }
}
