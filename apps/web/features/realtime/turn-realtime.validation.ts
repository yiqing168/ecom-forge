import {
  AGENT_PUBLIC_ERROR_CODES,
  AGENT_PUBLIC_SUMMARIES,
  AGENT_GUARDRAIL_TYPES,
} from '@ecom-forge/shared/agent-public-contract';
import { parseCreativeDirectionSelection } from '@ecom-forge/shared/creative-direction';

import type {
  TurnActivityType,
  TurnActivity,
  TurnEventType,
  TurnRealtimeEvent,
  TurnSnapshot,
  TurnUserStatus,
} from './turn-realtime.types';
import { parseRecord, RealtimeRecoveryError } from './workflow-realtime.validation';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USER_STATUSES = new Set<TurnUserStatus>([
  'thinking',
  'waiting_for_you',
  'stopped',
  'completed',
  'failed',
]);
const ACTIVITY_TYPES = new Set<TurnActivityType>([
  'knowledge_loading',
  'context_reading',
  'plan_preparing',
  'safety_checking',
]);
const ACTIVITY_SUMMARIES = new Set([
  '正在加载专业知识',
  '正在理解你的需求',
  '正在分析参考图片',
  '正在继续思考',
  '正在读取已授权的上下文',
  '正在准备方案',
  '正在检查安全与权限',
]);
const ACTIVITY_SUMMARIES_BY_TYPE: Record<TurnActivityType, ReadonlySet<string>> = {
  knowledge_loading: new Set(['正在加载专业知识']),
  context_reading: new Set([
    '正在理解你的需求',
    '正在分析参考图片',
    '正在继续思考',
    '正在读取已授权的上下文',
  ]),
  plan_preparing: new Set(['正在准备方案']),
  safety_checking: new Set(['正在检查安全与权限']),
};
const PUBLIC_SUMMARIES: ReadonlySet<string> = new Set(AGENT_PUBLIC_SUMMARIES);
const PUBLIC_ERROR_CODES: ReadonlySet<string> = new Set(AGENT_PUBLIC_ERROR_CODES);
const GUARDRAIL_TYPES: ReadonlySet<string> = new Set(AGENT_GUARDRAIL_TYPES);
const EVENT_TYPES = new Set<TurnEventType>([
  'turn.created',
  'turn.status_changed',
  'turn.message_delta',
  'turn.response_draft_delta',
  'turn.response_draft_cleared',
  'turn.activity_started',
  'turn.activity_finished',
  'turn.confirmation_required',
  'turn.guardrail_triggered',
  'turn.superseded',
  'turn.interrupted',
  'turn.cancelled',
  'turn.completed',
  'turn.failed',
]);

export function parseTurnEvent(serialized: string, expectedScope: string): TurnRealtimeEvent {
  const value = parseRecord(serialized);
  if (
    value.schema_version !== 1 ||
    value.scope !== expectedScope ||
    !positiveInteger(value.event_seq) ||
    typeof value.event_type !== 'string' ||
    !EVENT_TYPES.has(value.event_type as TurnEventType) ||
    !isoDate(value.occurred_at) ||
    !record(value.payload)
  ) {
    throw new RealtimeRecoveryError();
  }
  const turnId = expectedScope.startsWith('turn:') ? expectedScope.slice(5) : '';
  const payload = value.payload;
  if (payload.turn_id !== turnId || !uuid(payload.turn_id) || !uuid(payload.agent_trace_id)) {
    throw new RealtimeRecoveryError();
  }
  validatePayload(value.event_type as TurnEventType, payload);
  return value as unknown as TurnRealtimeEvent;
}

export function parseTurnSnapshot(value: unknown, expectedTurnId: string): TurnSnapshot {
  const envelope = record(value) && value.ok === true && record(value.data) ? value.data : value;
  if (!record(envelope)) throw new Error('Turn snapshot is invalid');
  const requiredKeys = [
    'id',
    'session_id',
    'user_status',
    'revision',
    'continuation_no',
    'agent_trace_id',
    'skill_selection',
    'model_selection',
    'generation_preferences',
    'execution_authorization',
    'loaded_auxiliary_skills',
    'run_quote_id',
    'workflow_run_id',
    'pending_confirmation',
    'messages',
    'activities',
    'last_event_seq',
    'created_at',
    'ended_at',
  ];
  const snapshotKeys = [
    ...requiredKeys,
    ...(envelope.failure_summary !== undefined ? ['failure_summary'] : []),
    ...(envelope.response_draft !== undefined ? ['response_draft'] : []),
  ];
  if (
    !exactKeys(envelope, snapshotKeys) ||
    envelope.id !== expectedTurnId ||
    !uuid(envelope.id) ||
    !uuid(envelope.session_id) ||
    !USER_STATUSES.has(envelope.user_status as TurnUserStatus) ||
    !positiveInteger(envelope.revision) ||
    !positiveInteger(envelope.continuation_no) ||
    !uuid(envelope.agent_trace_id) ||
    !record(envelope.skill_selection) ||
    !(envelope.model_selection === null || record(envelope.model_selection)) ||
    !(envelope.generation_preferences === null || record(envelope.generation_preferences)) ||
    !(envelope.execution_authorization === null || record(envelope.execution_authorization)) ||
    !Array.isArray(envelope.loaded_auxiliary_skills) ||
    !(envelope.run_quote_id === null || uuid(envelope.run_quote_id)) ||
    !(envelope.workflow_run_id === null || uuid(envelope.workflow_run_id)) ||
    !Array.isArray(envelope.messages) ||
    !Array.isArray(envelope.activities) ||
    !(
      envelope.response_draft === undefined ||
      envelope.response_draft === null ||
      (record(envelope.response_draft) &&
        exactKeys(envelope.response_draft, ['step_id', 'draft_seq', 'text']) &&
        uuid(envelope.response_draft.step_id) &&
        positiveInteger(envelope.response_draft.draft_seq) &&
        envelope.response_draft.draft_seq <= 64 &&
        typeof envelope.response_draft.text === 'string' &&
        envelope.response_draft.text.length > 0 &&
        Array.from(envelope.response_draft.text).length <= 8000 &&
        envelope.user_status === 'thinking')
    ) ||
    !nonNegativeInteger(envelope.last_event_seq) ||
    !(
      envelope.failure_summary === undefined ||
      envelope.failure_summary === null ||
      isPublicFailureSummary(envelope.failure_summary)
    ) ||
    !isoDate(envelope.created_at) ||
    !(envelope.ended_at === null || isoDate(envelope.ended_at))
  ) {
    throw new Error('Turn snapshot is invalid');
  }
  validateSkillSelection(envelope.skill_selection);
  if (envelope.model_selection !== null) validateModelSelection(envelope.model_selection);
  if (envelope.generation_preferences !== null)
    validateGenerationPreferences(envelope.generation_preferences);
  if (envelope.execution_authorization !== null)
    validateExecutionAuthorization(envelope.execution_authorization);
  envelope.loaded_auxiliary_skills.forEach(validateLoadedSkill);
  envelope.messages.forEach(validateMessage);
  envelope.activities.forEach(validateSnapshotActivity);
  if (envelope.pending_confirmation !== null)
    validatePendingConfirmation(envelope.pending_confirmation);
  return envelope as unknown as TurnSnapshot;
}

function isPublicFailureSummary(value: unknown): value is string {
  return typeof value === 'string' && PUBLIC_SUMMARIES.has(value);
}

function validateSnapshotActivity(value: unknown): asserts value is TurnActivity {
  if (!record(value)) throw new Error('Turn snapshot activity is invalid');
  const hasError = value.public_error_code !== undefined;
  if (
    !exactKeys(value, [
      'activity_id',
      'activity_type',
      'display_summary',
      'status',
      ...(hasError ? ['public_error_code'] : []),
    ]) ||
    !uuid(value.activity_id) ||
    !ACTIVITY_TYPES.has(value.activity_type as TurnActivityType) ||
    !ACTIVITY_SUMMARIES.has(String(value.display_summary)) ||
    !activitySummaryMatchesType(value.activity_type, value.display_summary) ||
    !new Set(['started', 'succeeded', 'failed', 'blocked', 'cancelled']).has(
      String(value.status),
    ) ||
    (hasError && !PUBLIC_ERROR_CODES.has(String(value.public_error_code)))
  ) {
    throw new Error('Turn snapshot activity is invalid');
  }
}

function validatePayload(eventType: TurnEventType, payload: Record<string, unknown>): void {
  const base = ['turn_id', 'agent_trace_id'];
  switch (eventType) {
    case 'turn.created':
      requirePayload(payload, [...base, 'user_status'], payload.user_status === 'thinking');
      return;
    case 'turn.status_changed':
      requirePayload(
        payload,
        [...base, 'previous_user_status', 'user_status'],
        USER_STATUSES.has(payload.previous_user_status as TurnUserStatus) &&
          USER_STATUSES.has(payload.user_status as TurnUserStatus),
      );
      return;
    case 'turn.message_delta':
      requirePayload(
        payload,
        [...base, 'message_id', 'delta_seq', 'text_delta', 'is_final'],
        uuid(payload.message_id) &&
          positiveInteger(payload.delta_seq) &&
          payload.delta_seq <= 64 &&
          typeof payload.text_delta === 'string' &&
          payload.text_delta.length > 0 &&
          Array.from(payload.text_delta).length <= 1000 &&
          typeof payload.is_final === 'boolean',
      );
      return;
    case 'turn.response_draft_delta':
      requirePayload(
        payload,
        [...base, 'step_id', 'draft_seq', 'text_delta'],
        uuid(payload.step_id) &&
          positiveInteger(payload.draft_seq) &&
          payload.draft_seq <= 64 &&
          typeof payload.text_delta === 'string' &&
          payload.text_delta.length > 0 &&
          Array.from(payload.text_delta).length <= 1000,
      );
      return;
    case 'turn.response_draft_cleared':
      requirePayload(payload, [...base, 'step_id'], uuid(payload.step_id));
      return;
    case 'turn.activity_started':
      validateActivity(payload, 'started');
      return;
    case 'turn.activity_finished':
      validateFinishedActivity(payload);
      return;
    case 'turn.confirmation_required':
      validateConfirmationEvent(payload);
      return;
    case 'turn.guardrail_triggered':
      requirePayload(
        payload,
        [...base, 'guardrail_type', 'action', 'summary', 'user_status'],
        GUARDRAIL_TYPES.has(String(payload.guardrail_type)) &&
          payload.action === 'stopped' &&
          PUBLIC_SUMMARIES.has(String(payload.summary)) &&
          payload.user_status === 'failed',
      );
      return;
    case 'turn.superseded':
      requirePayload(
        payload,
        [...base, 'new_turn_id', 'reason', 'user_status'],
        uuid(payload.new_turn_id) &&
          payload.reason === 'new_user_message' &&
          payload.user_status === 'stopped',
      );
      return;
    case 'turn.interrupted':
      requirePayload(payload, [...base, 'reason'], payload.reason === 'user_requested');
      return;
    case 'turn.cancelled':
      requirePayload(
        payload,
        [...base, 'reason', 'user_status'],
        new Set(['user_requested', 'confirmation_expired', 'policy_cancelled']).has(
          String(payload.reason),
        ) && payload.user_status === 'stopped',
      );
      return;
    case 'turn.completed':
      requirePayload(
        payload,
        [...base, 'message_id', 'user_status'],
        uuid(payload.message_id) && payload.user_status === 'completed',
      );
      return;
    case 'turn.failed':
      requirePayload(
        payload,
        [...base, 'public_error_code', 'summary', 'user_status'],
        PUBLIC_ERROR_CODES.has(String(payload.public_error_code)) &&
          PUBLIC_SUMMARIES.has(String(payload.summary)) &&
          payload.user_status === 'failed',
      );
  }
}

function validateActivity(payload: Record<string, unknown>, status: 'started'): void {
  requirePayload(
    payload,
    ['turn_id', 'agent_trace_id', 'activity_id', 'activity_type', 'display_summary', 'status'],
    uuid(payload.activity_id) &&
      ACTIVITY_TYPES.has(payload.activity_type as TurnActivityType) &&
      ACTIVITY_SUMMARIES.has(String(payload.display_summary)) &&
      activitySummaryMatchesType(payload.activity_type, payload.display_summary) &&
      payload.status === status,
  );
}

function validateFinishedActivity(payload: Record<string, unknown>): void {
  const hasError = payload.public_error_code !== undefined;
  requirePayload(
    payload,
    [
      'turn_id',
      'agent_trace_id',
      'activity_id',
      'activity_type',
      'display_summary',
      'status',
      ...(hasError ? ['public_error_code'] : []),
    ],
    uuid(payload.activity_id) &&
      ACTIVITY_TYPES.has(payload.activity_type as TurnActivityType) &&
      ACTIVITY_SUMMARIES.has(String(payload.display_summary)) &&
      activitySummaryMatchesType(payload.activity_type, payload.display_summary) &&
      new Set(['succeeded', 'failed', 'blocked', 'cancelled']).has(String(payload.status)) &&
      (!hasError || PUBLIC_ERROR_CODES.has(String(payload.public_error_code))),
  );
}

function activitySummaryMatchesType(activityType: unknown, summary: unknown): boolean {
  return (
    ACTIVITY_TYPES.has(activityType as TurnActivityType) &&
    ACTIVITY_SUMMARIES_BY_TYPE[activityType as TurnActivityType].has(String(summary))
  );
}

function validateConfirmationEvent(payload: Record<string, unknown>): void {
  const validPublicPayload =
    payload.confirmation_type === 'clarification'
      ? validClarification(payload.public_payload)
      : payload.confirmation_type === 'product_facts'
        ? validProductFactsConfirmation(payload.public_payload)
        : record(payload.public_payload);
  requirePayload(
    payload,
    [
      'turn_id',
      'agent_trace_id',
      'confirmation_id',
      'confirmation_type',
      'confirmation_version',
      'public_payload',
      'expires_at',
      'user_status',
    ],
    uuid(payload.confirmation_id) &&
      new Set(['clarification', 'product_facts', 'risk']).has(String(payload.confirmation_type)) &&
      positiveInteger(payload.confirmation_version) &&
      (payload.confirmation_type !== 'product_facts' || payload.confirmation_version === 1) &&
      isoDate(payload.expires_at) &&
      payload.user_status === 'waiting_for_you' &&
      validPublicPayload,
  );
}

function validClarification(value: unknown): boolean {
  const baseKeys = [
    'schema_version',
    'question',
    'options',
    'allow_free_text',
    'max_response_chars',
  ];
  if (
    !record(value) ||
    !(exactKeys(value, baseKeys) || exactKeys(value, [...baseKeys, 'scope_digest'])) ||
    value.schema_version !== 1 ||
    typeof value.question !== 'string' ||
    value.question.length < 1 ||
    value.question.length > 500 ||
    !Array.isArray(value.options) ||
    value.options.length > 6 ||
    typeof value.allow_free_text !== 'boolean' ||
    !positiveInteger(value.max_response_chars) ||
    value.max_response_chars > 2000
  ) {
    return false;
  }
  if (
    value.scope_digest !== undefined &&
    (typeof value.scope_digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.scope_digest) ||
      value.allow_free_text ||
      value.options.length !== 2 ||
      !record(value.options[0]) ||
      value.options[0].id !== 'option-1' ||
      !record(value.options[1]) ||
      value.options[1].id !== 'option-2')
  ) {
    return false;
  }
  const ids = new Set<string>();
  for (const option of value.options) {
    if (
      !record(option) ||
      !exactKeys(option, ['id', 'label']) ||
      typeof option.id !== 'string' ||
      option.id.length < 1 ||
      option.id.length > 80 ||
      typeof option.label !== 'string' ||
      option.label.length < 1 ||
      option.label.length > 80 ||
      ids.has(option.id)
    ) {
      return false;
    }
    ids.add(option.id);
  }
  return true;
}

function validateSkillSelection(value: Record<string, unknown>): void {
  if (
    !exactKeys(value, ['primary_skill_id', 'primary_name', 'preset_selections']) ||
    typeof value.primary_skill_id !== 'string' ||
    typeof value.primary_name !== 'string' ||
    !Array.isArray(value.preset_selections)
  ) {
    throw new Error('Turn skill selection is invalid');
  }
}

function validateLoadedSkill(value: unknown): void {
  if (
    !record(value) ||
    !exactKeys(value, ['skill_id', 'name', 'load_mode']) ||
    typeof value.skill_id !== 'string' ||
    typeof value.name !== 'string' ||
    !new Set(['required', 'optional']).has(String(value.load_mode))
  ) {
    throw new Error('Turn loaded Skill is invalid');
  }
}

function validateModelSelection(value: Record<string, unknown>): void {
  const optionalKeys = ['image', 'video'].filter((key) => value[key] !== undefined);
  if (
    !exactKeys(value, ['catalog_revision', 'brain', ...optionalKeys]) ||
    !positiveInteger(value.catalog_revision) ||
    !validPublicModel(value.brain) ||
    (value.image !== undefined && !validPublicModel(value.image)) ||
    (value.video !== undefined && !validPublicModel(value.video))
  ) {
    throw new Error('Turn model selection is invalid');
  }
}

function validPublicModel(value: unknown): boolean {
  return (
    record(value) &&
    exactKeys(value, ['catalog_entry_id', 'version_no', 'display_name']) &&
    uuid(value.catalog_entry_id) &&
    positiveInteger(value.version_no) &&
    typeof value.display_name === 'string' &&
    value.display_name.length > 0 &&
    value.display_name.length <= 200
  );
}

function validateGenerationPreferences(value: Record<string, unknown>): void {
  const hasCreativeDirection = Object.hasOwn(value, 'creative_direction');
  if (
    !exactKeys(value, [
      'schema_version',
      'output_kind',
      'aspect_ratio',
      'resolution_tier',
      ...(hasCreativeDirection ? ['creative_direction'] : []),
    ]) ||
    value.schema_version !== 2 ||
    value.output_kind !== 'image' ||
    typeof value.aspect_ratio !== 'string' ||
    (value.aspect_ratio !== 'auto' && !/^[1-9]\d{0,2}:[1-9]\d{0,2}$/.test(value.aspect_ratio)) ||
    !new Set(['1k', '2k', '4k']).has(String(value.resolution_tier)) ||
    (hasCreativeDirection && parseCreativeDirectionSelection(value.creative_direction) === null)
  ) {
    throw new Error('Turn generation preferences are invalid');
  }
}

function validateExecutionAuthorization(value: Record<string, unknown>): void {
  if (!exactKeys(value, ['kind']) || value.kind !== 'generate_action') {
    throw new Error('Turn execution authorization is invalid');
  }
}

function validateMessage(value: unknown): void {
  if (
    !record(value) ||
    !exactKeys(value, ['id', 'role', 'content', 'attachments', 'created_at']) ||
    !uuid(value.id) ||
    !new Set(['user', 'assistant']).has(String(value.role)) ||
    typeof value.content !== 'string' ||
    !Array.isArray(value.attachments) ||
    value.attachments.length > 12 ||
    !isoDate(value.created_at)
  ) {
    throw new Error('Turn message is invalid');
  }
  value.attachments.forEach(validatePublicAttachment);
}

function validatePublicAttachment(value: unknown): void {
  const hasNote = record(value) && value.creative_note !== undefined;
  if (
    !record(value) ||
    !exactKeys(value, [
      'resource_type',
      'resource_id',
      'role',
      'position',
      ...(hasNote ? ['creative_note'] : []),
    ]) ||
    !new Set(['asset', 'artifact']).has(String(value.resource_type)) ||
    !uuid(value.resource_id) ||
    !new Set([
      'product',
      'style_reference',
      'composition_reference',
      'identity_anchor',
      'semantic_reference',
      'edit_source',
      'other',
    ]).has(String(value.role)) ||
    !nonNegativeInteger(value.position) ||
    value.position > 11 ||
    (hasNote &&
      (typeof value.creative_note !== 'string' ||
        value.creative_note.length === 0 ||
        value.creative_note.length > 600))
  ) {
    throw new Error('Turn message attachment is invalid');
  }
}

function validatePendingConfirmation(value: unknown): void {
  if (
    !record(value) ||
    !exactKeys(value, ['id', 'type', 'version', 'public_payload', 'expires_at']) ||
    !uuid(value.id) ||
    !new Set(['clarification', 'product_facts', 'risk']).has(String(value.type)) ||
    !positiveInteger(value.version) ||
    !record(value.public_payload) ||
    (value.type === 'product_facts' && !validProductFactsConfirmation(value.public_payload)) ||
    !isoDate(value.expires_at)
  ) {
    throw new Error('Turn confirmation is invalid');
  }
}

const PRODUCT_FACT_FIELDS = new Set([
  'product_name',
  'primary_colors',
  'logos',
  'visible_text',
  'materials',
  'must_preserve',
  'unknown_fields',
]);

function validProductFactsConfirmation(value: unknown): boolean {
  if (!record(value) || value.schema_version !== 1) return false;
  const mode = value.mode;
  const expectedKeys = [
    'schema_version',
    'mode',
    'source_asset_id',
    'source_version',
    'candidate_facts',
    'required_fields',
    ...(mode === 'link_product' ? ['product_id', 'expected_latest_fact_set_id'] : []),
  ];
  if (
    (mode !== 'create_product' && mode !== 'link_product') ||
    !exactKeys(value, expectedKeys) ||
    !uuid(value.source_asset_id) ||
    typeof value.source_version !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.source_version) ||
    !validProductFacts(value.candidate_facts) ||
    !Array.isArray(value.required_fields) ||
    value.required_fields.length === 0 ||
    !value.required_fields.every((field) => PRODUCT_FACT_FIELDS.has(String(field)))
  ) {
    return false;
  }
  return (
    mode === 'create_product' ||
    (uuid(value.product_id) &&
      (value.expected_latest_fact_set_id === null || uuid(value.expected_latest_fact_set_id)))
  );
}

function validProductFacts(value: unknown): boolean {
  if (
    !record(value) ||
    !exactKeys(value, [...PRODUCT_FACT_FIELDS]) ||
    typeof value.product_name !== 'string' ||
    value.product_name.trim().length === 0
  ) {
    return false;
  }
  return [...PRODUCT_FACT_FIELDS]
    .filter((field) => field !== 'product_name')
    .every(
      (field) =>
        Array.isArray(value[field]) &&
        value[field].every((item: unknown) => typeof item === 'string' && item.trim().length > 0),
    );
}

function requirePayload(payload: Record<string, unknown>, keys: string[], valid: boolean): void {
  if (!valid || !exactKeys(payload, keys)) throw new RealtimeRecoveryError();
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function isoDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
