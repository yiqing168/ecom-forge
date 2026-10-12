import type { CreativeDirectionSelection } from '@ecom-forge/shared/creative-direction';

import type { RealtimeConnectionStatus } from './realtime.client';
import type { AgentPendingConfirmation, PublicAgentAttachment } from '@/lib/agent-api';

export type TurnUserStatus = 'thinking' | 'waiting_for_you' | 'stopped' | 'completed' | 'failed';
export type TurnActivityType =
  'knowledge_loading' | 'context_reading' | 'plan_preparing' | 'safety_checking';

export interface TurnActivity {
  activity_id: string;
  activity_type: TurnActivityType;
  display_summary: string;
  status: 'started' | 'succeeded' | 'failed' | 'blocked' | 'cancelled';
  public_error_code?: string;
  started_at?: string;
  finished_at?: string;
}

export interface TurnSnapshot {
  id: string;
  session_id: string;
  user_status: TurnUserStatus;
  revision: number;
  continuation_no: number;
  agent_trace_id: string;
  skill_selection: {
    primary_skill_id: string;
    primary_name: string;
    preset_selections: Array<{ slot: string; preset_id: string; name: string }>;
  };
  model_selection: {
    catalog_revision: number;
    brain: {
      catalog_entry_id: string;
      version_no: number;
      display_name: string;
    };
    image?: {
      catalog_entry_id: string;
      version_no: number;
      display_name: string;
    };
    video?: {
      catalog_entry_id: string;
      version_no: number;
      display_name: string;
    };
  } | null;
  generation_preferences: {
    schema_version: 2;
    output_kind: 'image';
    aspect_ratio: string;
    resolution_tier: '1k' | '2k' | '4k';
    creative_direction?: CreativeDirectionSelection;
  } | null;
  execution_authorization: {
    kind: 'generate_action';
  } | null;
  loaded_auxiliary_skills: Array<{
    skill_id: string;
    name: string;
    load_mode: 'required' | 'optional';
  }>;
  run_quote_id: string | null;
  workflow_run_id: string | null;
  pending_confirmation: AgentPendingConfirmation | null;
  messages: Array<{
    id: string;
    role: 'user' | 'assistant';
    content: string;
    attachments: PublicAgentAttachment[];
    created_at: string;
    /** Client-only cursor; absent on a complete server snapshot. */
    delta_seq?: number;
    delta_final?: boolean;
  }>;
  response_draft?: { step_id: string; draft_seq: number; text: string } | null;
  last_event_seq: number;
  failure_summary?: string | null;
  created_at: string;
  ended_at: string | null;
  activities: TurnActivity[];
}

export type TurnEventType =
  | 'turn.created'
  | 'turn.status_changed'
  | 'turn.message_delta'
  | 'turn.response_draft_delta'
  | 'turn.response_draft_cleared'
  | 'turn.activity_started'
  | 'turn.activity_finished'
  | 'turn.confirmation_required'
  | 'turn.guardrail_triggered'
  | 'turn.superseded'
  | 'turn.interrupted'
  | 'turn.cancelled'
  | 'turn.completed'
  | 'turn.failed';

export interface TurnRealtimeEvent {
  schema_version: 1;
  scope: string;
  event_seq: number;
  event_type: TurnEventType;
  occurred_at: string;
  payload: Record<string, unknown> & { turn_id: string; agent_trace_id: string };
}

export interface TurnRealtimeCallbacks {
  onStatus(status: RealtimeConnectionStatus): void;
  onSnapshot(snapshot: TurnSnapshot): void;
  onEvent(event: TurnRealtimeEvent): void;
  onAuthenticationRequired(): void;
  onUnavailable(): void;
}
