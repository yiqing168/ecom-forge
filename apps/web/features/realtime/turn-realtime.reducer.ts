import type {
  TurnActivity,
  TurnRealtimeEvent,
  TurnSnapshot,
  TurnUserStatus,
} from './turn-realtime.types';

export function applyTurnEvent(snapshot: TurnSnapshot, event: TurnRealtimeEvent): TurnSnapshot {
  if (event.event_seq <= snapshot.last_event_seq) return snapshot;
  if (event.event_seq !== snapshot.last_event_seq + 1) {
    throw new Error('Turn event sequence gap requires snapshot recovery');
  }
  let next: TurnSnapshot = { ...snapshot, last_event_seq: event.event_seq };
  const payload = event.payload;
  switch (event.event_type) {
    case 'turn.created':
    case 'turn.status_changed':
    case 'turn.guardrail_triggered':
    case 'turn.superseded':
    case 'turn.cancelled':
    case 'turn.completed':
    case 'turn.failed':
      if (typeof payload.user_status === 'string') {
        next = { ...next, user_status: payload.user_status as TurnUserStatus };
      }
      if (
        event.event_type === 'turn.status_changed' &&
        typeof payload.workflow_run_id === 'string'
      ) {
        next = { ...next, workflow_run_id: payload.workflow_run_id };
      }
      if (next.user_status !== 'waiting_for_you') {
        next = { ...next, pending_confirmation: null };
      }
      if (next.user_status !== 'thinking') next = { ...next, response_draft: null };
      if (event.event_type === 'turn.failed' && typeof payload.summary === 'string') {
        next = { ...next, failure_summary: payload.summary };
      }
      break;
    case 'turn.message_delta':
      next = { ...applyMessageDelta(next, event), response_draft: null };
      break;
    case 'turn.response_draft_delta': {
      if (next.user_status !== 'thinking') break;
      const stepId = String(payload.step_id);
      const draftSeq = Number(payload.draft_seq);
      const previous = next.response_draft;
      if (previous && previous.step_id === stepId && draftSeq !== previous.draft_seq + 1) {
        throw new Error('Turn draft sequence gap requires snapshot recovery');
      }
      if ((!previous || previous.step_id !== stepId) && draftSeq !== 1) {
        throw new Error('Turn draft must start at sequence one');
      }
      const text = (previous?.step_id === stepId ? previous.text : '') + String(payload.text_delta);
      if (Array.from(text).length > 8000) throw new Error('Turn draft exceeds the text limit');
      next = {
        ...next,
        response_draft: {
          step_id: stepId,
          draft_seq: draftSeq,
          text,
        },
      };
      break;
    }
    case 'turn.response_draft_cleared':
      if (next.response_draft?.step_id === payload.step_id) {
        next = { ...next, response_draft: null };
      }
      break;
    case 'turn.activity_started':
    case 'turn.activity_finished':
      next = applyActivity(next, payload as unknown as TurnActivity, event.occurred_at);
      break;
    case 'turn.confirmation_required':
      next = applyConfirmation(next, payload);
      break;
    case 'turn.interrupted':
      next = { ...next, response_draft: null };
      break;
  }
  return next;
}

function applyConfirmation(snapshot: TurnSnapshot, payload: Record<string, unknown>): TurnSnapshot {
  const shared = {
    version: Number(payload.confirmation_version),
    public_payload: payload.public_payload as Record<string, unknown>,
    expires_at: String(payload.expires_at),
  };
  const pendingConfirmation: NonNullable<TurnSnapshot['pending_confirmation']> =
    payload.confirmation_type === 'product_facts'
      ? {
          ...shared,
          id: String(payload.confirmation_id),
          type: 'product_facts',
          version: 1,
          public_payload: shared.public_payload as Extract<
            NonNullable<TurnSnapshot['pending_confirmation']>,
            { type: 'product_facts' }
          >['public_payload'],
        }
      : {
          ...shared,
          id: String(payload.confirmation_id),
          type: payload.confirmation_type as 'clarification' | 'risk',
        };
  return {
    ...snapshot,
    user_status: 'waiting_for_you',
    response_draft: null,
    pending_confirmation: pendingConfirmation,
  };
}

function applyMessageDelta(snapshot: TurnSnapshot, event: TurnRealtimeEvent): TurnSnapshot {
  const payload = event.payload;
  const messageId = String(payload.message_id);
  const deltaSeq = Number(payload.delta_seq);
  const index = snapshot.messages.findIndex((message) => message.id === messageId);
  if (index < 0) {
    if (deltaSeq !== 1) throw new Error('Turn message must start at sequence one');
    return {
      ...snapshot,
      messages: [
        ...snapshot.messages,
        {
          id: messageId,
          role: 'assistant',
          content: String(payload.text_delta),
          attachments: [],
          created_at: event.occurred_at,
          delta_seq: deltaSeq,
          delta_final: payload.is_final === true,
        },
      ],
    };
  }
  const existing = snapshot.messages[index];
  if (!existing || existing.role !== 'assistant') {
    throw new Error('Turn message delta target is invalid');
  }
  if (
    existing.delta_seq === undefined ||
    existing.delta_final ||
    deltaSeq !== existing.delta_seq + 1
  ) {
    throw new Error('Turn message sequence gap requires snapshot recovery');
  }
  const messages = [...snapshot.messages];
  messages[index] = {
    ...existing,
    content: existing.content + String(payload.text_delta),
    delta_seq: deltaSeq,
    delta_final: payload.is_final === true,
  };
  return { ...snapshot, messages };
}

function applyActivity(
  snapshot: TurnSnapshot,
  activity: TurnActivity,
  occurredAt: string,
): TurnSnapshot {
  const index = snapshot.activities.findIndex((item) => item.activity_id === activity.activity_id);
  const timed: TurnActivity =
    activity.status === 'started'
      ? { ...activity, started_at: occurredAt }
      : {
          ...activity,
          started_at: snapshot.activities[index]?.started_at ?? occurredAt,
          finished_at: occurredAt,
        };
  if (index < 0) return { ...snapshot, activities: [...snapshot.activities, timed] };
  const activities = [...snapshot.activities];
  activities[index] = { ...activities[index]!, ...timed };
  return { ...snapshot, activities };
}
