import { and, eq, eventOutbox, max, sql, type Database } from '@ecom-forge/db';
import { scopedAdvisoryLockKey } from '@ecom-forge/shared';
import type { RetentionTier } from '@ecom-forge/types';

type OutboxWriteContext = Pick<Database, 'execute' | 'select' | 'insert'>;

export async function appendOutboxEventInTransaction(
  transaction: OutboxWriteContext,
  input: {
    scopeType: string;
    scopeId: string;
    eventType: string;
    payload: Record<string, unknown>;
    retentionTier?: RetentionTier;
  },
): Promise<{ eventSeq: number }> {
  await transaction.execute(
    sql`select pg_advisory_xact_lock(${scopedAdvisoryLockKey(input.scopeType, input.scopeId)})`,
  );
  const [current] = await transaction
    .select({ eventSeq: max(eventOutbox.eventSeq) })
    .from(eventOutbox)
    .where(and(eq(eventOutbox.scopeType, input.scopeType), eq(eventOutbox.scopeId, input.scopeId)));
  const eventSeq = Number(current?.eventSeq ?? 0) + 1;
  const [created] = await transaction
    .insert(eventOutbox)
    .values({
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      eventSeq,
      eventType: input.eventType,
      payload: input.payload,
      retentionTier: input.retentionTier ?? 'normal',
    })
    .returning({ eventSeq: eventOutbox.eventSeq });
  if (!created) throw new Error('Outbox insert returned no row');
  return created;
}
