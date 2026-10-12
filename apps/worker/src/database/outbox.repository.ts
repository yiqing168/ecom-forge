import { and, asc, eq, eventOutbox, gt, max, sql, type Database } from '@ecom-forge/db';
import { scopedAdvisoryLockKey } from '@ecom-forge/shared';
import type { RetentionTier } from '@ecom-forge/types';

type OutboxWriteContext = Pick<Database, 'execute' | 'select' | 'insert'>;
type OutboxQuery = <T>(build: (transaction: OutboxWriteContext) => PromiseLike<T>) => Promise<T>;

export interface AppendOutboxEventInput {
  scopeType: string;
  scopeId: string;
  eventType: string;
  payload: Record<string, unknown>;
  retentionTier?: RetentionTier;
}

export interface OutboxEventRecord {
  id: string;
  scopeType: string;
  scopeId: string;
  eventSeq: number;
  eventType: string;
  payload: unknown;
  retentionTier: RetentionTier;
  createdAt: Date | null;
}

export async function appendOutboxEventInTransaction(
  transaction: OutboxWriteContext,
  input: AppendOutboxEventInput,
): Promise<OutboxEventRecord> {
  return appendOutboxEventWithQuery((build) => Promise.resolve(build(transaction)), input);
}

export async function appendOutboxEventWithQuery(
  query: OutboxQuery,
  input: AppendOutboxEventInput,
): Promise<OutboxEventRecord> {
  const lockKey = scopedAdvisoryLockKey(input.scopeType, input.scopeId);
  await query((transaction) => transaction.execute(sql`select pg_advisory_xact_lock(${lockKey})`));
  const [current] = await query((transaction) =>
    transaction
      .select({ eventSeq: max(eventOutbox.eventSeq) })
      .from(eventOutbox)
      .where(
        and(eq(eventOutbox.scopeType, input.scopeType), eq(eventOutbox.scopeId, input.scopeId)),
      ),
  );
  const eventSeq = Number(current?.eventSeq ?? 0) + 1;
  const [created] = await query((transaction) =>
    transaction
      .insert(eventOutbox)
      .values({
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        eventSeq,
        eventType: input.eventType,
        payload: input.payload,
        retentionTier: input.retentionTier ?? 'normal',
      })
      .returning(),
  );
  if (!created) throw new Error('Outbox insert returned no row');
  return created;
}

export class OutboxRepository {
  constructor(private readonly database: Database) {}

  append(input: AppendOutboxEventInput): Promise<OutboxEventRecord> {
    return this.database.transaction((transaction) =>
      appendOutboxEventInTransaction(transaction, input),
    );
  }

  async listAfter(input: {
    scopeType: string;
    scopeId: string;
    lastEventSeq: number;
    limit: number;
  }): Promise<OutboxEventRecord[]> {
    const rows = await this.database
      .select()
      .from(eventOutbox)
      .where(
        and(
          eq(eventOutbox.scopeType, input.scopeType),
          eq(eventOutbox.scopeId, input.scopeId),
          gt(eventOutbox.eventSeq, input.lastEventSeq),
        ),
      )
      .orderBy(asc(eventOutbox.eventSeq))
      .limit(input.limit);
    return rows;
  }
}
