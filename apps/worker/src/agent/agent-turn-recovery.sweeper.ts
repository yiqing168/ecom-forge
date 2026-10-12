import {
  agentTurns,
  agentTraces,
  agentTraceSteps,
  chatSessions,
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  or,
  queueDispatchIntents,
  sql,
  type Database,
} from '@ecom-forge/db';
import { parseQueuePayload } from '@ecom-forge/queue';

import type { BullMqQueuePublisher } from '../queue/queue-publisher.js';
import { withTranscriptQueryBudget } from './agent-transcript-write-transaction.js';
import { appendOutboxEventWithQuery } from '../database/outbox.repository.js';
import { appendTraceStepWithQuery } from './agent-turn.repository-helpers.js';

const recoverableStatuses = [
  'received_user_input',
  'loading_context',
  'detecting_intent',
  'validating_context',
  'clarifying',
  'planning',
  'plan_ready',
] as const;

export class AgentTurnRecoverySweeper {
  private cursor: string | undefined;
  constructor(
    private readonly database: Database,
    private readonly publisher: Pick<BullMqQueuePublisher, 'recoverAgentJob'>,
  ) {}

  async sweep(now = new Date(), limit = 100): Promise<{ requeued: number; exhausted: number }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new Error('AGENT_RECOVERY_LIMIT_INVALID');
    const rows = await this.database
      .select({ turn: agentTurns, intent: queueDispatchIntents })
      .from(agentTurns)
      .innerJoin(
        queueDispatchIntents,
        and(
          eq(queueDispatchIntents.aggregateType, 'agent_turn'),
          eq(queueDispatchIntents.aggregateId, agentTurns.id),
          eq(queueDispatchIntents.queueName, 'agent'),
          eq(queueDispatchIntents.status, 'dispatched'),
          sql`${queueDispatchIntents.payload}->>'job_type' = 'agent.continue'`,
          sql`(${queueDispatchIntents.payload}->>'continuation_no')::integer = ${agentTurns.continuationNo}`,
        ),
      )
      .where(
        and(
          inArray(agentTurns.status, recoverableStatuses),
          this.cursor ? gt(agentTurns.id, this.cursor) : undefined,
          isNull(agentTurns.runQuoteId),
          isNull(agentTurns.workflowRunId),
          or(
            isNull(agentTurns.processingLeaseExpiresAt),
            lte(agentTurns.processingLeaseExpiresAt, now),
          ),
        ),
      )
      .orderBy(asc(agentTurns.id))
      .limit(limit);
    let requeued = 0;
    let exhausted = 0;
    for (const { turn, intent } of rows) {
      // Advance even on failure so one corrupt record cannot starve later pages.
      this.cursor = turn.id;
      const payload = parseQueuePayload(intent.payload);
      if (
        payload.job_type !== 'agent.continue' ||
        payload.turn_id !== turn.id ||
        payload.session_id !== turn.sessionId ||
        payload.continuation_no !== turn.continuationNo ||
        payload.turn_revision > turn.revision
      ) {
        throw new Error('AGENT_RECOVERY_INTENT_INVALID');
      }
      const result = await this.publisher.recoverAgentJob(intent.jobId, payload);
      if (result === 'requeued') requeued += 1;
      if (result === 'exhausted') {
        exhausted += 1;
        await this.failExhausted(turn, payload.trace_id);
      }
    }
    if (rows.length < limit) this.cursor = undefined;
    return { requeued, exhausted };
  }

  private async failExhausted(
    turn: typeof agentTurns.$inferSelect,
    traceId: string,
  ): Promise<void> {
    await this.database.transaction((transaction) =>
      withTranscriptQueryBudget(transaction, async (query) => {
        const [session] = await query((tx) =>
          tx
            .select({ id: chatSessions.id })
            .from(chatSessions)
            .where(and(eq(chatSessions.id, turn.sessionId), eq(chatSessions.userId, turn.userId)))
            .for('no key update'),
        );
        if (!session) return;
        const [current] = await query((tx) =>
          tx
            .select()
            .from(agentTurns)
            .where(
              and(
                eq(agentTurns.id, turn.id),
                eq(agentTurns.userId, turn.userId),
                eq(agentTurns.sessionId, turn.sessionId),
                eq(agentTurns.revision, turn.revision),
                eq(agentTurns.continuationNo, turn.continuationNo),
                inArray(agentTurns.status, recoverableStatuses),
                isNull(agentTurns.runQuoteId),
                isNull(agentTurns.workflowRunId),
                or(
                  isNull(agentTurns.processingLeaseExpiresAt),
                  sql`${agentTurns.processingLeaseExpiresAt} <= clock_timestamp()`,
                ),
              ),
            )
            .for('update'),
        );
        if (!current) return;
        const trace = await query((tx) =>
          tx.query.agentTraces.findFirst({
            where: and(
              eq(agentTraces.id, traceId),
              eq(agentTraces.turnId, turn.id),
              eq(agentTraces.sessionId, turn.sessionId),
              eq(agentTraces.userId, turn.userId),
            ),
          }),
        );
        if (!trace) throw new Error('AGENT_RECOVERY_INTENT_INVALID');
        // Preserve uncertain model cost exposure; never turn it into not_dispatched.
        await query((tx) =>
          tx
            .update(agentTraceSteps)
            .set({
              status: 'failed',
              errorCode: 'AGENT_CALL_OUTCOME_UNKNOWN',
              outputSummary: { outcome: 'unknown' },
            })
            .where(
              and(
                eq(agentTraceSteps.traceId, traceId),
                eq(agentTraceSteps.stepType, 'llm_call'),
                eq(agentTraceSteps.status, 'started'),
              ),
            ),
        );
        await appendTraceStepWithQuery(query, traceId, {
          stepType: 'guardrail',
          actor: 'system',
          status: 'blocked',
          errorCode: 'AGENT_MODEL_UNAVAILABLE',
          inputSummary: { guardrail_type: 'processing_recovery_exhausted' },
          outputSummary: { action: 'stopped' },
        });
        await query((tx) =>
          tx
            .update(agentTraces)
            .set({ status: 'failed', endedAt: sql`clock_timestamp()` })
            .where(eq(agentTraces.id, traceId)),
        );
        await appendOutboxEventWithQuery(query, {
          scopeType: 'turn',
          scopeId: turn.id,
          eventType: 'turn.status_changed',
          payload: {
            turn_id: turn.id,
            agent_trace_id: traceId,
            previous_user_status: 'thinking',
            user_status: 'failed',
          },
        });
        await appendOutboxEventWithQuery(query, {
          scopeType: 'turn',
          scopeId: turn.id,
          eventType: 'turn.failed',
          payload: {
            turn_id: turn.id,
            agent_trace_id: traceId,
            public_error_code: 'AGENT_MODEL_UNAVAILABLE',
            summary: '本次处理未能恢复，已停止，请重新发送需求',
            user_status: 'failed',
          },
        });
        await query((tx) =>
          tx
            .update(agentTurns)
            .set({
              status: 'failed',
              revision: current.revision + 1,
              processingOwner: null,
              processingLeaseExpiresAt: null,
              endedAt: sql`clock_timestamp()`,
            })
            .where(and(eq(agentTurns.id, turn.id), eq(agentTurns.revision, current.revision))),
        );
      }),
    );
  }
}
