import {
  AGENT_PUBLIC_ERROR_CODES,
  AGENT_PUBLIC_SUMMARIES,
  AGENT_GUARDRAIL_TYPES,
} from '@ecom-forge/shared';
import { TASK_STATUSES, WORKFLOW_RUN_STATUSES } from '@ecom-forge/types';
import { z } from 'zod';

const moneySchema = z.string().regex(/^(?:0|[1-9]\d*)\.\d{2}$/);
const workflowCreatedSchema = z
  .object({ workflow_run_id: z.uuid(), status: z.literal('queued') })
  .strict();
const workflowStatusSchema = z
  .object({ from: z.enum(WORKFLOW_RUN_STATUSES), to: z.enum(WORKFLOW_RUN_STATUSES) })
  .strict();
const taskStatusSchema = z
  .object({ task_id: z.uuid(), from: z.enum(TASK_STATUSES), to: z.enum(TASK_STATUSES) })
  .strict();
const artifactCreatedSchema = z
  .object({
    artifact_id: z.uuid(),
    task_id: z.uuid(),
    visibility: z.enum(['private', 'shared', 'public']),
  })
  .strict();
const contentReviewResolvedSchema = z
  .object({
    content_review_case_id: z.uuid(),
    decision: z.enum(['release', 'reject', 'expired']),
    artifact_id: z.uuid(),
  })
  .strict();
const creditEventSchema = z
  .object({
    amount: moneySchema,
    reservation_id: z.uuid(),
    task_id: z.uuid(),
    task_attempt_id: z.uuid(),
    ledger_id: z.uuid(),
    action: z.enum(['consumed', 'released']),
    final_release_ledger_id: z.uuid().optional(),
    final_release_amount: moneySchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.final_release_ledger_id === undefined) !==
      (value.final_release_amount === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Final release fields must be provided together',
      });
    }
  });

const turnUserStatusSchema = z.enum([
  'thinking',
  'waiting_for_you',
  'stopped',
  'completed',
  'failed',
]);
const turnEventBaseSchema = z.object({ turn_id: z.uuid(), agent_trace_id: z.uuid() });
const publicErrorCodeSchema = z.enum(AGENT_PUBLIC_ERROR_CODES);
const publicSummarySchema = z.enum(AGENT_PUBLIC_SUMMARIES);
const activityTypeSchema = z.enum([
  'knowledge_loading',
  'context_reading',
  'plan_preparing',
  'safety_checking',
]);
const activitySummarySchema = z.enum([
  '正在加载专业知识',
  '正在理解你的需求',
  '正在分析参考图片',
  '正在继续思考',
  // Historical turns must remain replayable.
  '正在读取已授权的上下文',
  '正在准备方案',
  '正在检查安全与权限',
]);
const activitySummariesByType = {
  knowledge_loading: ['正在加载专业知识'],
  context_reading: [
    '正在理解你的需求',
    '正在分析参考图片',
    '正在继续思考',
    '正在读取已授权的上下文',
  ],
  plan_preparing: ['正在准备方案'],
  safety_checking: ['正在检查安全与权限'],
} as const satisfies Record<z.infer<typeof activityTypeSchema>, readonly string[]>;

function validateActivitySummary(
  value: {
    activity_type: z.infer<typeof activityTypeSchema>;
    display_summary: z.infer<typeof activitySummarySchema>;
  },
  context: z.core.$RefinementCtx,
): void {
  const allowed: readonly string[] = activitySummariesByType[value.activity_type];
  if (!allowed.includes(value.display_summary)) {
    context.addIssue({ code: 'custom', message: 'Activity summary does not match activity type' });
  }
}
const clarificationPayloadSchema = z
  .object({
    schema_version: z.literal(1),
    question: z.string().min(1).max(500),
    options: z
      .array(z.object({ id: z.string().min(1).max(80), label: z.string().min(1).max(80) }).strict())
      .max(6),
    allow_free_text: z.boolean(),
    max_response_chars: z.number().int().min(1).max(2000),
    scope_digest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.scope_digest &&
      (value.allow_free_text ||
        value.options.length !== 2 ||
        value.options[0]?.id !== 'option-1' ||
        value.options[1]?.id !== 'option-2')
    ) {
      context.addIssue({ code: 'custom', message: 'Scope confirmation options are invalid' });
    }
    if (new Set(value.options.map((option) => option.id)).size !== value.options.length) {
      context.addIssue({
        code: 'custom',
        message: 'Confirmation option identifiers must be unique',
      });
    }
  });
const turnCreatedSchema = turnEventBaseSchema
  .extend({ user_status: z.literal('thinking') })
  .strict();
const turnStatusSchema = turnEventBaseSchema
  .extend({
    previous_user_status: turnUserStatusSchema,
    user_status: turnUserStatusSchema,
    workflow_run_id: z.uuid().optional(),
  })
  .strict();
const turnMessageDeltaSchema = turnEventBaseSchema
  .extend({
    message_id: z.uuid(),
    delta_seq: z.number().int().positive().max(64),
    text_delta: z
      .string()
      .min(1)
      .refine((value) => Array.from(value).length <= 1000),
    is_final: z.boolean(),
  })
  .strict();
const turnResponseDraftDeltaSchema = turnEventBaseSchema
  .extend({
    step_id: z.uuid(),
    draft_seq: z.number().int().positive().max(64),
    text_delta: z.string().min(1).max(1000),
  })
  .strict();
const turnResponseDraftClearedSchema = turnEventBaseSchema.extend({ step_id: z.uuid() }).strict();
const turnActivityStartedSchema = turnEventBaseSchema
  .extend({
    activity_id: z.uuid(),
    activity_type: activityTypeSchema,
    display_summary: activitySummarySchema,
    status: z.literal('started'),
  })
  .strict()
  .superRefine(validateActivitySummary);
const turnActivityFinishedSchema = turnEventBaseSchema
  .extend({
    activity_id: z.uuid(),
    activity_type: activityTypeSchema,
    display_summary: activitySummarySchema,
    status: z.enum(['succeeded', 'failed', 'blocked', 'cancelled']),
    public_error_code: publicErrorCodeSchema.optional(),
  })
  .strict()
  .superRefine(validateActivitySummary);
const clarificationConfirmationSchema = turnEventBaseSchema
  .extend({
    confirmation_id: z.uuid(),
    confirmation_type: z.literal('clarification'),
    confirmation_version: z.number().int().positive(),
    public_payload: clarificationPayloadSchema,
    expires_at: z.iso.datetime(),
    user_status: z.literal('waiting_for_you'),
  })
  .strict();
const turnConfirmationSchema = clarificationConfirmationSchema;
const turnGuardrailSchema = turnEventBaseSchema
  .extend({
    guardrail_type: z.enum(AGENT_GUARDRAIL_TYPES),
    action: z.literal('stopped'),
    summary: publicSummarySchema,
    user_status: z.literal('failed'),
  })
  .strict();
const turnSupersededSchema = turnEventBaseSchema
  .extend({
    new_turn_id: z.uuid(),
    reason: z.literal('new_user_message'),
    user_status: z.literal('stopped'),
  })
  .strict();
const turnInterruptedSchema = turnEventBaseSchema
  .extend({ reason: z.literal('user_requested') })
  .strict();
const turnCancelledSchema = turnEventBaseSchema
  .extend({
    reason: z.enum(['user_requested', 'confirmation_expired', 'policy_cancelled']),
    user_status: z.literal('stopped'),
  })
  .strict();
const turnCompletedSchema = turnEventBaseSchema
  .extend({ message_id: z.uuid(), user_status: z.literal('completed') })
  .strict();
const turnFailedSchema = turnEventBaseSchema
  .extend({
    public_error_code: publicErrorCodeSchema,
    summary: publicSummarySchema,
    user_status: z.literal('failed'),
  })
  .strict();

const payloadSchemas = {
  'workflow.created': workflowCreatedSchema,
  'workflow.status_changed': workflowStatusSchema,
  'task.status_changed': taskStatusSchema,
  'artifact.created': artifactCreatedSchema,
  'content_review.resolved': contentReviewResolvedSchema,
  'credit.settled': creditEventSchema,
  'credit.released': creditEventSchema,
  'turn.created': turnCreatedSchema,
  'turn.status_changed': turnStatusSchema,
  'turn.message_delta': turnMessageDeltaSchema,
  'turn.response_draft_delta': turnResponseDraftDeltaSchema,
  'turn.response_draft_cleared': turnResponseDraftClearedSchema,
  'turn.activity_started': turnActivityStartedSchema,
  'turn.activity_finished': turnActivityFinishedSchema,
  'turn.confirmation_required': turnConfirmationSchema,
  'turn.guardrail_triggered': turnGuardrailSchema,
  'turn.superseded': turnSupersededSchema,
  'turn.interrupted': turnInterruptedSchema,
  'turn.cancelled': turnCancelledSchema,
  'turn.completed': turnCompletedSchema,
  'turn.failed': turnFailedSchema,
} as const;

export type SupportedEventType = keyof typeof payloadSchemas;

export interface OutboxEventProjection {
  eventSeq: number;
  eventType: string;
  payload: unknown;
  createdAt: Date | null;
}

export interface PublicEventEnvelope {
  schema_version: 1;
  scope: string;
  event_seq: number;
  event_type: SupportedEventType;
  occurred_at: string;
  payload: Record<string, unknown>;
}

export class EventContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventContractError';
  }
}

export function projectPublicEvent(
  scope: string,
  event: OutboxEventProjection,
): PublicEventEnvelope {
  if (!Number.isInteger(event.eventSeq) || event.eventSeq < 1 || !event.createdAt) {
    throw new EventContractError('Outbox event metadata is invalid');
  }
  if (!(event.eventType in payloadSchemas)) {
    throw new EventContractError('Outbox event type is not part of the public contract');
  }
  const eventType = event.eventType as SupportedEventType;
  const isTurnScope = scope.startsWith('turn:');
  const isTurnEvent = eventType.startsWith('turn.');
  if (isTurnScope !== isTurnEvent) {
    throw new EventContractError('Outbox event type does not match its public scope');
  }
  const parsed = payloadSchemas[eventType].safeParse(event.payload);
  if (!parsed.success) {
    throw new EventContractError('Outbox event payload does not match the public contract');
  }
  if (eventType === 'credit.settled' || eventType === 'credit.released') {
    const action = (parsed.data as Record<string, unknown>).action;
    if (
      (eventType === 'credit.settled' && action !== 'consumed') ||
      (eventType === 'credit.released' && action !== 'released')
    ) {
      throw new EventContractError('Credit event type and action do not match');
    }
  }
  return {
    schema_version: 1,
    scope,
    event_seq: event.eventSeq,
    event_type: eventType,
    occurred_at: event.createdAt.toISOString(),
    payload: parsed.data,
  };
}

export function encodeBusinessEvent(event: PublicEventEnvelope): string {
  assertFrameToken(String(event.event_seq));
  assertFrameToken(event.event_type);
  return `id: ${event.event_seq}\nevent: ${event.event_type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function encodeControlEvent(
  eventType: 'heartbeat' | 'recovery_required',
  payload: Record<string, unknown>,
): string {
  assertFrameToken(eventType);
  return `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function assertFrameToken(value: string): void {
  if (!value || /[\r\n]/.test(value)) {
    throw new EventContractError('SSE frame token is invalid');
  }
}
