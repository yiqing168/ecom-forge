import { agentTraces, agentTurns, and, eq, runQuotes, type Database } from '@ecom-forge/db';
import { CreditError, submitRunQuote } from '@ecom-forge/credit';
import { createQueueIntentInTransaction, type QueuePayload } from '@ecom-forge/queue';
import type { EventWake, EventWakePublisher } from '@ecom-forge/shared';

import { appendOutboxEventInTransaction } from '../database/outbox.repository.js';

type SubmitPayload = Extract<QueuePayload, { job_type: 'agent.quote.submit' }>;
type ExpirePayload = Extract<QueuePayload, { job_type: 'agent.quote.expire' }>;

export class AgentQuoteService {
  constructor(
    private readonly database: Database,
    private readonly eventWakePublisher: EventWakePublisher,
  ) {}

  async submit(payload: SubmitPayload): Promise<void> {
    const turn = await this.database.query.agentTurns.findFirst({
      where: eq(agentTurns.id, payload.turn_id),
      columns: { userId: true },
    });
    if (!turn) return;
    try {
      const result = await submitRunQuote({
        database: this.database,
        ports: {
          createQueueIntent: createQueueIntentInTransaction,
          appendOutboxEvent: appendOutboxEventInTransaction,
        },
        userId: turn.userId,
        quoteId: payload.quote_id,
        idempotencyKey: `agent-auto:${payload.turn_id}:${payload.continuation_no}:${payload.plan_digest}:${payload.authorization_digest}`,
        evidence: {
          kind: 'generate_action@v2',
          turn_id: payload.turn_id,
          continuation_no: payload.continuation_no,
          plan_digest: payload.plan_digest,
          authorization_digest: payload.authorization_digest,
        },
      });
      await this.publish(result.wakes);
    } catch (error) {
      if (error instanceof CreditError && error.eventWakes.length > 0) {
        await this.publish([...error.eventWakes]);
      }
      if (error instanceof CreditError && error.code === 'RUN_QUOTE_EXPIRED') return;
      if (
        error instanceof CreditError &&
        (error.code === 'COST_ACK_REQUIRED' || error.code === 'RESERVATION_STATE_INVALID') &&
        (await this.isCancelledSubmission(payload))
      ) {
        return;
      }
      if (
        error instanceof CreditError &&
        ['AUTH_VERIFICATION_REQUIRED', 'FORBIDDEN'].includes(error.code)
      ) {
        const wake = await this.blockRestrictedSubmission(payload);
        if (wake) await this.publish([wake]);
        return;
      }
      if (error instanceof CreditError && error.code === 'INSUFFICIENT_CREDITS') {
        const wake = await this.blockAutomaticSubmission(
          payload,
          error.code,
          '本次生成所需积分超过当前可用余额，未开始生成；请减少生成数量或联系管理员补充积分后重试',
        );
        if (wake) await this.publish([wake]);
        return;
      }
      throw error;
    }
  }

  async expire(payload: ExpirePayload, now = new Date()): Promise<void> {
    const wake = await this.database.transaction(async (transaction) => {
      const [turn] = await transaction
        .select()
        .from(agentTurns)
        .where(eq(agentTurns.id, payload.turn_id))
        .for('update');
      if (!turn) return null;
      const [quote] = await transaction
        .select()
        .from(runQuotes)
        .where(eq(runQuotes.id, payload.quote_id))
        .for('update');
      if (!quote) return null;
      if (
        turn.runQuoteId !== quote.id ||
        turn.continuationNo !== payload.continuation_no ||
        quote.planDigest !== payload.plan_digest
      ) {
        throw new Error('AGENT_QUOTE_EXPIRY_OWNERSHIP_INVALID');
      }
      if (quote.status !== 'quoted') return null;
      if (quote.expiresAt.getTime() > now.getTime()) {
        throw new Error('AGENT_QUOTE_EXPIRY_NOT_DUE');
      }
      const trace = await transaction.query.agentTraces.findFirst({
        where: eq(agentTraces.turnId, turn.id),
        columns: { id: true },
      });
      if (!trace) throw new Error('AGENT_TRACE_MISSING');
      await transaction
        .update(runQuotes)
        .set({ status: 'expired' })
        .where(and(eq(runQuotes.id, quote.id), eq(runQuotes.status, 'quoted')));
      await transaction
        .update(agentTurns)
        .set({ status: 'cancelled', revision: turn.revision + 1, endedAt: now })
        .where(and(eq(agentTurns.id, turn.id), eq(agentTurns.revision, turn.revision)));
      await transaction
        .update(agentTraces)
        .set({ status: 'cancelled', endedAt: now })
        .where(eq(agentTraces.id, trace.id));
      await appendOutboxEventInTransaction(transaction, {
        scopeType: 'turn',
        scopeId: turn.id,
        eventType: 'turn.status_changed',
        payload: {
          turn_id: turn.id,
          agent_trace_id: trace.id,
          previous_user_status:
            turn.status === 'waiting_user_confirmation' ? 'waiting_for_you' : 'thinking',
          user_status: 'stopped',
        },
      });
      const event = await appendOutboxEventInTransaction(transaction, {
        scopeType: 'turn',
        scopeId: turn.id,
        eventType: 'turn.cancelled',
        payload: {
          turn_id: turn.id,
          agent_trace_id: trace.id,
          reason: 'confirmation_expired',
          user_status: 'stopped',
        },
      });
      return turnWake(turn.id, event.eventSeq);
    });
    if (wake) await this.publish([wake]);
  }

  private async blockAutomaticSubmission(
    payload: SubmitPayload,
    errorCode: 'INSUFFICIENT_CREDITS',
    summary: '本次生成所需积分超过当前可用余额，未开始生成；请减少生成数量或联系管理员补充积分后重试',
  ): Promise<EventWake | null> {
    return this.database.transaction(async (transaction) => {
      const [turn] = await transaction
        .select()
        .from(agentTurns)
        .where(eq(agentTurns.id, payload.turn_id))
        .for('update');
      if (!turn) return null;
      const [quote] = await transaction
        .select()
        .from(runQuotes)
        .where(eq(runQuotes.id, payload.quote_id))
        .for('update');
      if (!quote || quote.status === 'cancelled' || turn.status === 'blocked') return null;
      if (
        turn.runQuoteId !== quote.id ||
        turn.status !== 'run_quote_created' ||
        turn.continuationNo !== payload.continuation_no ||
        quote.planDigest !== payload.plan_digest ||
        quote.authorizationDigest !== payload.authorization_digest
      ) {
        throw new Error('AGENT_QUOTE_SUBMISSION_OWNERSHIP_INVALID');
      }
      const trace = await transaction.query.agentTraces.findFirst({
        where: eq(agentTraces.turnId, turn.id),
        columns: { id: true },
      });
      if (!trace) throw new Error('AGENT_TRACE_MISSING');
      const [cancelledQuote] = await transaction
        .update(runQuotes)
        .set({ status: 'cancelled' })
        .where(and(eq(runQuotes.id, quote.id), eq(runQuotes.status, 'quoted')))
        .returning({ id: runQuotes.id });
      if (!cancelledQuote) return null;
      const now = new Date();
      const [updated] = await transaction
        .update(agentTurns)
        .set({ status: 'blocked', revision: turn.revision + 1, endedAt: now })
        .where(and(eq(agentTurns.id, turn.id), eq(agentTurns.revision, turn.revision)))
        .returning({ id: agentTurns.id });
      if (!updated) throw new Error('AGENT_QUOTE_SUBMISSION_CAS_FAILED');
      await transaction
        .update(agentTraces)
        .set({ status: 'blocked', loopGuardrailHit: 'charge_blocked', endedAt: now })
        .where(eq(agentTraces.id, trace.id));
      await appendOutboxEventInTransaction(transaction, {
        scopeType: 'turn',
        scopeId: turn.id,
        eventType: 'turn.status_changed',
        payload: {
          turn_id: turn.id,
          agent_trace_id: trace.id,
          previous_user_status: 'thinking',
          user_status: 'failed',
        },
      });
      const event = await appendOutboxEventInTransaction(transaction, {
        scopeType: 'turn',
        scopeId: turn.id,
        eventType: 'turn.failed',
        payload: {
          turn_id: turn.id,
          agent_trace_id: trace.id,
          public_error_code: errorCode,
          summary,
          user_status: 'failed',
        },
      });
      return turnWake(turn.id, event.eventSeq);
    });
  }

  private async blockRestrictedSubmission(payload: SubmitPayload): Promise<EventWake | null> {
    return this.database.transaction(async (transaction) => {
      const [turn] = await transaction
        .select()
        .from(agentTurns)
        .where(eq(agentTurns.id, payload.turn_id))
        .for('update');
      if (!turn) return null;
      const [quote] = await transaction
        .select()
        .from(runQuotes)
        .where(eq(runQuotes.id, payload.quote_id))
        .for('update');
      if (!quote || quote.status === 'cancelled' || turn.status === 'blocked') return null;
      if (
        quote.status !== 'quoted' ||
        turn.runQuoteId !== quote.id ||
        turn.status !== 'run_quote_created' ||
        turn.continuationNo !== payload.continuation_no ||
        quote.planDigest !== payload.plan_digest ||
        quote.authorizationDigest !== payload.authorization_digest
      ) {
        throw new Error('AGENT_QUOTE_POLICY_OWNERSHIP_INVALID');
      }
      const trace = await transaction.query.agentTraces.findFirst({
        where: eq(agentTraces.turnId, turn.id),
        columns: { id: true },
      });
      if (!trace) throw new Error('AGENT_TRACE_MISSING');
      const [cancelledQuote] = await transaction
        .update(runQuotes)
        .set({ status: 'cancelled' })
        .where(and(eq(runQuotes.id, quote.id), eq(runQuotes.status, 'quoted')))
        .returning({ id: runQuotes.id });
      if (!cancelledQuote) throw new Error('AGENT_QUOTE_POLICY_CANCEL_CAS_FAILED');
      const now = new Date();
      const [blockedTurn] = await transaction
        .update(agentTurns)
        .set({ status: 'blocked', revision: turn.revision + 1, endedAt: now })
        .where(and(eq(agentTurns.id, turn.id), eq(agentTurns.revision, turn.revision)))
        .returning({ id: agentTurns.id });
      if (!blockedTurn) throw new Error('AGENT_QUOTE_POLICY_TURN_CAS_FAILED');
      await transaction
        .update(agentTraces)
        .set({ status: 'blocked', loopGuardrailHit: 'account_restricted', endedAt: now })
        .where(eq(agentTraces.id, trace.id));
      await appendOutboxEventInTransaction(transaction, {
        scopeType: 'turn',
        scopeId: turn.id,
        eventType: 'turn.status_changed',
        payload: {
          turn_id: turn.id,
          agent_trace_id: trace.id,
          previous_user_status: 'thinking',
          user_status: 'failed',
        },
      });
      const event = await appendOutboxEventInTransaction(transaction, {
        scopeType: 'turn',
        scopeId: turn.id,
        eventType: 'turn.failed',
        payload: {
          turn_id: turn.id,
          agent_trace_id: trace.id,
          public_error_code: 'AGENT_TOOL_NOT_ALLOWED',
          summary: '当前状态不允许使用该能力',
          user_status: 'failed',
        },
      });
      return turnWake(turn.id, event.eventSeq);
    });
  }

  private async isCancelledSubmission(payload: SubmitPayload): Promise<boolean> {
    const [turn, quote] = await Promise.all([
      this.database.query.agentTurns.findFirst({
        where: eq(agentTurns.id, payload.turn_id),
        columns: {
          status: true,
          runQuoteId: true,
          continuationNo: true,
        },
      }),
      this.database.query.runQuotes.findFirst({
        where: eq(runQuotes.id, payload.quote_id),
        columns: {
          status: true,
          planDigest: true,
          authorizationDigest: true,
        },
      }),
    ]);
    return Boolean(
      turn?.status === 'blocked' &&
      turn.runQuoteId === payload.quote_id &&
      turn.continuationNo === payload.continuation_no &&
      quote?.status === 'cancelled' &&
      quote.planDigest === payload.plan_digest &&
      quote.authorizationDigest === payload.authorization_digest,
    );
  }

  private async publish(wakes: EventWake[]): Promise<void> {
    await Promise.all(
      wakes.map((wake) => this.eventWakePublisher.publish(wake).catch(() => undefined)),
    );
  }
}

function turnWake(turnId: string, eventSeq: number): EventWake {
  return { schema_version: 1, scope_type: 'turn', scope_id: turnId, event_seq: eventSeq };
}
