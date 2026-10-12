import type {
  CreativeDirectionSelection,
  SessionCreativeDirectionSnapshot,
} from '@ecom-forge/shared/creative-direction';

type ApiErrorPayload = { error?: { code?: string; message?: string } };

export type AttachmentRole =
  | 'product'
  | 'style_reference'
  | 'composition_reference'
  | 'identity_anchor'
  | 'semantic_reference'
  | 'edit_source'
  | 'other';

export class AgentApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AgentApiError';
  }
}

const apiOrigin = (process.env.NEXT_PUBLIC_API_ORIGIN ?? '').replace(/\/$/, '');

async function request<T>(path: string, init: RequestInit = {}, envelope = true): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const response = await fetch(`${apiOrigin}${path}`, {
    ...init,
    cache: 'no-store',
    credentials: 'include',
    headers,
  });
  const payload = (await response.json().catch(() => null)) as
    ({ data?: T } & ApiErrorPayload) | null;
  if (!response.ok) {
    throw new AgentApiError(
      payload?.error?.code ?? 'AGENT_REQUEST_FAILED',
      response.status,
      payload?.error?.message ?? '创作服务暂时不可用，请稍后重试',
    );
  }
  return (envelope ? payload?.data : payload) as T;
}

function idempotencyKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export type RetryImageResponse = {
  workflow_run_id: string;
  task_id: string;
  status: string;
  replayed: boolean;
};

export function retryFailedImage(workflowRunId: string, taskId: string) {
  return request<RetryImageResponse>(
    `/api/v1/workflow-runs/${encodeURIComponent(workflowRunId)}/retry`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey('image-retry') },
      body: JSON.stringify({ task_id: taskId }),
    },
  );
}

export type SkillPresetOption = {
  preset_id: string;
  name: string;
  description: string;
  preview_asset?: string;
};

export type SkillCatalogItem = {
  attachment_roles?: Array<{ role: AttachmentRole; label: string }>;
  primary_skill_id: string;
  slug: string;
  version: string;
  name: string;
  description: string;
  domain: 'creative' | 'commerce';
  category: string;
  cover_asset?: string;
  required_inputs: string[];
  preset_slots: Array<{
    slot: string;
    label: string;
    required: boolean;
    max_selections: number;
    options: SkillPresetOption[];
  }>;
};

export type SkillCatalog = {
  catalog_version: string;
  response_version: string;
  generation_policy: {
    schema_version: 2;
    policy_version: string;
  };
  items: SkillCatalogItem[];
};

export type ModelCategory = 'brain' | 'image' | 'video';

export type ModelCatalogItem = {
  id: string;
  public_slug: string;
  version_no: number;
  category: ModelCategory;
  display_name: string;
  description: string;
  public_capabilities: Record<string, unknown>;
  user_selectable: boolean;
  is_default: boolean;
  availability: 'available' | 'unavailable';
  pricing_summary: Array<{
    logical_sku_key: string;
    operation: string;
    matcher: Record<string, unknown>;
    unit_kind: string;
    unit_rule: Record<string, unknown>;
    credits_per_unit: string;
    currency: 'credits';
  }>;
};

export type ModelCatalog = {
  catalog_revision: number;
  items: ModelCatalogItem[];
};

export type SessionPreview = {
  id: string;
  title: string;
  revision: number;
  last_message_preview: string;
  last_turn_id: string | null;
  last_turn_status: AgentUserStatus | null;
  updated_at: string;
};

export type AgentUserStatus = 'thinking' | 'waiting_for_you' | 'stopped' | 'completed' | 'failed';

export type ProductFacts = {
  product_name: string;
  primary_colors: string[];
  logos: string[];
  visible_text: string[];
  materials: string[];
  must_preserve: string[];
  unknown_fields: string[];
};

export type ProductFactsConfirmationPayload = {
  schema_version: 1;
  source_asset_id: string;
  source_version: string;
  candidate_facts: ProductFacts;
  required_fields: Array<keyof ProductFacts>;
} & (
  | { mode: 'create_product' }
  | {
      mode: 'link_product';
      product_id: string;
      expected_latest_fact_set_id: string | null;
    }
);

export type AgentPendingConfirmation =
  | {
      id: string;
      type: 'clarification' | 'risk';
      version: number;
      public_payload: Record<string, unknown>;
      expires_at: string;
    }
  | {
      id: string;
      type: 'product_facts';
      version: 1;
      public_payload: ProductFactsConfirmationPayload;
      expires_at: string;
    };

export type PublicAgentAttachment = {
  resource_type: 'asset' | 'artifact';
  resource_id: string;
  role: AttachmentRole;
  position: number;
  creative_note?: string;
};

export type PublicTurn = {
  id: string;
  session_id: string;
  user_status: AgentUserStatus;
  revision: number;
  continuation_no: number;
  agent_trace_id: string | null;
  skill_selection: {
    primary_skill_id: string;
    primary_name: string;
    preset_selections: Array<{ slot: string; preset_id: string; name: string }>;
  } | null;
  model_selection: {
    catalog_revision: number;
    brain: { catalog_entry_id: string; version_no: number; display_name: string };
    image?: { catalog_entry_id: string; version_no: number; display_name: string };
  } | null;
  generation_preferences: Record<string, unknown> | null;
  execution_authorization: {
    kind: 'generate_action';
  } | null;
  run_quote_id: string | null;
  workflow_run_id: string | null;
  pending_confirmation: AgentPendingConfirmation | null;
  last_event_seq: number;
  created_at: string;
  ended_at: string | null;
};

export type SessionDetail = {
  session: {
    id: string;
    title: string;
    revision: number;
    primary_skill_slug: string | null;
    preset_selections: Array<{ slot: string; preset_id: string; name: string }>;
    creative_direction_snapshot?: SessionCreativeDirectionSnapshot;
    created_at: string;
    updated_at: string;
  };
  messages: Array<{
    id: string;
    role: 'user' | 'assistant';
    content: string;
    attachments: PublicAgentAttachment[];
    turn_id: string | null;
    created_at: string;
  }>;
  turns: PublicTurn[];
  active_turn_id: string | null;
  older_cursor: string | null;
};

export type CreateTurnInput = {
  session_id?: string;
  message: string;
  attachments: Array<{
    binding_id: string;
    resource_type: 'asset' | 'artifact' | 'upload';
    resource_id: string;
    resource_version: string;
    role: AttachmentRole;
    position: number;
  }>;
  mention_bindings: Array<{ mention_key: string; binding_id: string }>;
  skill_selection: {
    primary_skill_id: string;
    preset_selections: Array<{ slot: string; preset_id: string }>;
  };
  model_selection: {
    catalog_revision: number;
    brain: { catalog_entry_id: string; version_no: number };
    image: { catalog_entry_id: string; version_no: number };
  };
  generation_preferences: {
    schema_version: 2;
    output_kind: 'image';
    aspect_ratio: string;
    resolution_tier: '1k' | '2k' | '4k';
    creative_direction?: CreativeDirectionSelection;
  };
};

export type CreateTurnResponse = {
  session_id: string;
  turn_id: string;
  user_message_id: string;
  agent_trace_id: string;
  user_status: 'thinking';
  revision: number;
  continuation_no: number;
  event_scope: string;
  last_event_seq: number;
};

export function listSkills(domain?: 'creative' | 'commerce'): Promise<SkillCatalog> {
  return request(`/api/v1/skills${domain ? `?domain=${domain}` : ''}`);
}

export function listModels(category: ModelCategory): Promise<ModelCatalog> {
  return request(`/api/v1/model-catalog?category=${category}`, {}, false);
}

export function listAgentSessions(
  input: {
    query?: string;
    cursor?: string;
    limit?: number;
  } = {},
): Promise<{ items: SessionPreview[]; next_cursor: string | null }> {
  const query = new URLSearchParams();
  if (input.query) query.set('query', input.query);
  if (input.cursor) query.set('cursor', input.cursor);
  if (input.limit) query.set('limit', String(input.limit));
  return request(`/api/v1/agent/sessions${query.size ? `?${query.toString()}` : ''}`);
}

export function getAgentSession(
  sessionId: string,
  input: { cursor?: string; limit?: number } = {},
): Promise<SessionDetail> {
  const query = new URLSearchParams();
  if (input.cursor) query.set('cursor', input.cursor);
  if (input.limit) query.set('limit', String(input.limit));
  return request(
    `/api/v1/agent/sessions/${encodeURIComponent(sessionId)}${query.size ? `?${query.toString()}` : ''}`,
  );
}

export function getAgentTurn(turnId: string): Promise<PublicTurn> {
  return request(`/api/v1/agent/turns/${encodeURIComponent(turnId)}`);
}

export function createAgentTurn(
  input: CreateTurnInput,
  requestIdempotencyKey = idempotencyKey('agent-turn'),
): Promise<CreateTurnResponse> {
  return request('/api/v1/agent/turns', {
    method: 'POST',
    headers: { 'Idempotency-Key': requestIdempotencyKey },
    body: JSON.stringify(input),
  });
}

export function confirmAgentTurn(
  turnId: string,
  input: {
    confirmation_id: string;
    confirmation_type: 'clarification' | 'product_facts' | 'risk';
    confirmation_version: number;
    answers: Record<string, unknown>;
  },
  requestIdempotencyKey = idempotencyKey('agent-confirm'),
): Promise<Record<string, unknown>> {
  return request(`/api/v1/agent/turns/${encodeURIComponent(turnId)}/confirm`, {
    method: 'POST',
    headers: { 'Idempotency-Key': requestIdempotencyKey },
    body: JSON.stringify(input),
  });
}

export function interruptAgentTurn(
  turnId: string,
  requestIdempotencyKey = idempotencyKey('agent-interrupt'),
): Promise<Record<string, unknown>> {
  return request(`/api/v1/agent/turns/${encodeURIComponent(turnId)}/interrupt`, {
    method: 'POST',
    headers: { 'Idempotency-Key': requestIdempotencyKey },
    body: JSON.stringify({ reason: 'user_requested' }),
  });
}

export function renameAgentSession(
  sessionId: string,
  input: { revision: number; title: string },
  requestIdempotencyKey = idempotencyKey('agent-session-rename'),
): Promise<{ id: string; title: string; revision: number; updated_at: string }> {
  return request(`/api/v1/agent/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    headers: { 'Idempotency-Key': requestIdempotencyKey },
    body: JSON.stringify(input),
  });
}

export function archiveAgentSession(
  sessionId: string,
  revision: number,
  requestIdempotencyKey = idempotencyKey('agent-session-archive'),
): Promise<{ id: string; revision: number; archived_at: string }> {
  return request(`/api/v1/agent/sessions/${encodeURIComponent(sessionId)}/archive`, {
    method: 'POST',
    headers: { 'Idempotency-Key': requestIdempotencyKey },
    body: JSON.stringify({ revision }),
  });
}
