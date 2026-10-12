import { agentTraceSteps, and, eq, type Database } from '@ecom-forge/db';

import { appendOutboxEventWithQuery } from '../database/outbox.repository.js';
import { withNativeTurnWrite } from './agent-transcript-results.js';
import { AgentTranscriptWriteError } from './agent-transcript-write-transaction.js';
import type { ClaimedAgentTurn } from './agent-turn.types.js';

export class AgentTurnDraftRepository {
  constructor(private readonly database: Database) {}

  async append(input: {
    claimed: ClaimedAgentTurn;
    revision: number;
    stepId: string;
    draftSeq: number;
    textDelta: string;
  }): Promise<{ eventSeq: number } | null> {
    return withNativeTurnWrite(this.database, input, async (scope, turn) => {
      if (turn.status !== 'detecting_intent') return null;
      const [step] = await scope.query((transaction) =>
        transaction
          .select({ id: agentTraceSteps.id })
          .from(agentTraceSteps)
          .where(
            and(
              eq(agentTraceSteps.id, input.stepId),
              eq(agentTraceSteps.traceId, input.claimed.traceId),
              eq(agentTraceSteps.stepType, 'llm_call'),
              eq(agentTraceSteps.status, 'started'),
            ),
          )
          .limit(1),
      );
      if (!step) return null;
      const event = await appendOutboxEventWithQuery(scope.query, {
        scopeType: 'turn',
        scopeId: turn.id,
        eventType: 'turn.response_draft_delta',
        payload: {
          turn_id: turn.id,
          agent_trace_id: input.claimed.traceId,
          step_id: step.id,
          draft_seq: input.draftSeq,
          text_delta: input.textDelta,
        },
      });
      return { eventSeq: event.eventSeq };
    }).catch(rejectStaleDraft);
  }

  async clear(input: {
    claimed: ClaimedAgentTurn;
    revision: number;
    stepId: string;
  }): Promise<{ eventSeq: number } | null> {
    return withNativeTurnWrite(this.database, input, async (scope, turn) => {
      const event = await appendOutboxEventWithQuery(scope.query, {
        scopeType: 'turn',
        scopeId: turn.id,
        eventType: 'turn.response_draft_cleared',
        payload: {
          turn_id: turn.id,
          agent_trace_id: input.claimed.traceId,
          step_id: input.stepId,
        },
      });
      return { eventSeq: event.eventSeq };
    }).catch(rejectStaleDraft);
  }
}

function rejectStaleDraft(error: unknown): null {
  if (
    error instanceof AgentTranscriptWriteError &&
    ['turn_stale', 'lease_expired', 'history_changed', 'scope_closed'].includes(error.reason)
  ) {
    return null;
  }
  throw error;
}
