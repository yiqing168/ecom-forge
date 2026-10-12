import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  and,
  creditLedger,
  desc,
  eq,
  lt,
  or,
  runQuotes,
  users,
  type Database,
} from '@ecom-forge/db';
import { CreditError, lockCreditAccount, submitRunQuote } from '@ecom-forge/credit';
import {
  NOOP_EVENT_WAKE_PUBLISHER,
  normalizeMoney,
  type EventWakePublisher,
} from '@ecom-forge/shared';
import { createQueueIntentInTransaction } from '@ecom-forge/queue';

import { appendOutboxEventInTransaction } from '../../shared/database/outbox.repository.js';
import { validateQuoteDraft, type QuoteProducer, type QuoteRequest } from './quote-producer.js';

function quoteResponse(row: typeof runQuotes.$inferSelect) {
  const legacyItems = Array.isArray(row.promptPreview)
    ? []
    : (row.promptPreview as { items?: unknown }).items;
  const items =
    Array.isArray(row.itemsSnapshot) && row.itemsSnapshot.length > 0
      ? row.itemsSnapshot
      : legacyItems;
  return {
    id: row.id,
    status: row.status,
    estimated_total_credits: normalizeMoney(row.estimatedTotalCredits),
    has_unknown_price: row.hasUnknownPrice,
    expires_at: row.expiresAt.toISOString(),
    items: Array.isArray(items) ? items : [],
    workflow_run_id: row.workflowRunId,
  };
}

export class CreditService {
  constructor(
    private readonly database: Database,
    private readonly cursorSecret: string,
    private readonly producer: QuoteProducer,
    private readonly eventWakePublisher: EventWakePublisher = NOOP_EVENT_WAKE_PUBLISHER,
  ) {}

  async createQuote(userId: string, input: QuoteRequest, idempotencyKey: string) {
    await this.assertChargeAllowed(this.database, userId);
    const draft = validateQuoteDraft(await this.producer.produce(userId, input), {
      userId,
      source: input.source,
      sourceId: input.sourceId ?? null,
    });
    return this.database.transaction(async (transaction) => {
      const existing = await transaction.query.runQuotes.findFirst({
        where: eq(runQuotes.idempotencyKey, idempotencyKey),
      });
      if (existing) {
        if (existing.userId !== userId || existing.inputSignature !== draft.inputSignature) {
          throw new CreditError('Quote idempotency conflict', 'IDEMPOTENCY_CONFLICT');
        }
        return quoteResponse(existing);
      }
      const active = await transaction.query.runQuotes.findFirst({
        where: and(
          eq(runQuotes.userId, userId),
          eq(runQuotes.source, input.source),
          eq(runQuotes.inputSignature, draft.inputSignature),
          eq(runQuotes.status, 'quoted'),
        ),
      });
      if (active && active.expiresAt.getTime() > Date.now()) return quoteResponse(active);
      if (active) {
        await transaction
          .update(runQuotes)
          .set({ status: 'expired' })
          .where(and(eq(runQuotes.id, active.id), eq(runQuotes.status, 'quoted')));
      }
      const [created] = await transaction
        .insert(runQuotes)
        .values({
          userId,
          source: draft.source,
          productId: draft.productId,
          status: 'quoted',
          promptPreview: draft.promptPreview,
          itemsSnapshot: draft.items.map((item) => ({
            task_key: item.taskKey,
            task_type: item.taskType,
            estimated_credits: item.estimatedCredits,
          })),
          estimatedCallCount: draft.estimatedCallCount,
          estimatedTotalCredits: draft.estimatedTotalCredits,
          hasUnknownPrice: draft.hasUnknownPrice,
          idempotencyKey,
          inputSignature: draft.inputSignature,
          confirmationSnapshot: {},
          planSnapshot: draft.planSnapshot,
          skillSnapshot: draft.skillSnapshot,
          pricingSnapshot: draft.pricingSnapshot,
          expiresAt: draft.expiresAt,
        })
        .onConflictDoNothing()
        .returning();
      if (!created) {
        const replay = await transaction.query.runQuotes.findFirst({
          where: eq(runQuotes.idempotencyKey, idempotencyKey),
        });
        if (replay) {
          if (replay.userId !== userId || replay.inputSignature !== draft.inputSignature) {
            throw new CreditError('Quote idempotency conflict', 'IDEMPOTENCY_CONFLICT');
          }
          return quoteResponse(replay);
        }
        const concurrentActive = await transaction.query.runQuotes.findFirst({
          where: and(
            eq(runQuotes.userId, userId),
            eq(runQuotes.source, input.source),
            eq(runQuotes.inputSignature, draft.inputSignature),
            eq(runQuotes.status, 'quoted'),
          ),
        });
        if (concurrentActive) return quoteResponse(concurrentActive);
        throw new CreditError('Quote could not be created', 'RESOURCE_BUSY');
      }
      return quoteResponse(created);
    });
  }

  async submitQuote(
    userId: string,
    quoteId: string,
    confirmationAmount: string,
    costConfirmation: 'required' | 'not_required',
    idempotencyKey: string,
  ) {
    let result;
    try {
      result = await submitRunQuote({
        database: this.database,
        ports: {
          createQueueIntent: createQueueIntentInTransaction,
          appendOutboxEvent: appendOutboxEventInTransaction,
        },
        userId,
        quoteId,
        idempotencyKey,
        evidence: {
          kind: 'user_confirmation@v1',
          confirmation_amount: confirmationAmount,
          cost_confirmation: costConfirmation,
        },
      });
    } catch (error) {
      if (error instanceof CreditError && error.eventWakes.length > 0) {
        await Promise.all(
          error.eventWakes.map((wake) =>
            this.eventWakePublisher.publish(wake).catch(() => undefined),
          ),
        );
      }
      throw error;
    }
    await Promise.all(
      result.wakes.map((wake) => this.eventWakePublisher.publish(wake).catch(() => undefined)),
    );
    return result.response;
  }

  private async assertChargeAllowed(
    database: Pick<Database, 'query'>,
    userId: string,
  ): Promise<void> {
    const user = await database.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { emailVerifiedAt: true, riskStatus: true },
    });
    if (!user?.emailVerifiedAt) {
      throw new CreditError(
        'Verified email is required for charging',
        'AUTH_VERIFICATION_REQUIRED',
      );
    }
    if (user.riskStatus !== 'normal') {
      throw new CreditError('Account is restricted from charging', 'FORBIDDEN');
    }
  }

  async account(userId: string) {
    return this.database.transaction(async (transaction) => {
      const account = await lockCreditAccount(transaction, userId);
      return {
        balance: account.balance,
        frozen: account.frozen,
        available: account.balance,
        currency: 'credits',
        as_of: new Date().toISOString(),
      };
    });
  }

  async ledger(userId: string, cursor: string | undefined, limit: number) {
    const position = cursor ? this.decodeCursor(cursor) : undefined;
    const rows = await this.database
      .select()
      .from(creditLedger)
      .where(
        and(
          eq(creditLedger.userId, userId),
          position
            ? or(
                lt(creditLedger.createdAt, position.createdAt),
                and(
                  eq(creditLedger.createdAt, position.createdAt),
                  lt(creditLedger.id, position.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(creditLedger.createdAt), desc(creditLedger.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        id: row.id,
        type: row.type,
        amount: normalizeMoney(row.amount),
        balance_after: normalizeMoney(row.balanceAfter),
        frozen_after: normalizeMoney(row.frozenAfter),
        reservation_id: row.reservationId,
        workflow_run_id: row.workflowRunId,
        created_at: row.createdAt.toISOString(),
      })),
      next_cursor: rows.length > limit && last ? this.encodeCursor(last.createdAt, last.id) : null,
    };
  }

  private encodeCursor(createdAt: Date, id: string): string {
    const value = JSON.stringify({ created_at: createdAt.toISOString(), id });
    const body = Buffer.from(value).toString('base64url');
    const signature = createHmac('sha256', this.cursorSecret).update(body).digest('base64url');
    return `${body}.${signature}`;
  }

  private decodeCursor(cursor: string): { createdAt: Date; id: string } {
    const [body, signature] = cursor.split('.');
    if (!body || !signature)
      throw new CreditError('Invalid ledger cursor', 'RESERVATION_STATE_INVALID');
    const expected = createHmac('sha256', this.cursorSecret).update(body).digest('base64url');
    const received = Buffer.from(signature, 'utf8');
    const expectedBytes = Buffer.from(expected, 'utf8');
    if (received.length !== expectedBytes.length || !timingSafeEqual(received, expectedBytes)) {
      throw new CreditError('Invalid ledger cursor', 'RESERVATION_STATE_INVALID');
    }
    try {
      const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
        created_at?: string;
        id?: string;
      };
      const createdAt = new Date(parsed.created_at ?? '');
      if (!parsed.id || Number.isNaN(createdAt.getTime())) throw new Error();
      return { createdAt, id: parsed.id };
    } catch {
      throw new CreditError('Invalid ledger cursor', 'RESERVATION_STATE_INVALID');
    }
  }
}
