import {
  and,
  asc,
  eq,
  gt,
  inArray,
  lte,
  or,
  queueDispatchIntents,
  sql,
  type Database,
} from '@ecom-forge/db';

import { assertStableJobId, compositeJobId } from './job-id.js';
import { parseQueuePayload, type QueuePayload } from './payload.js';
import { queueNameForJobType, type QueueName } from './constants.js';

export interface CreateQueueIntentInput {
  queueName: QueueName;
  jobId: string;
  aggregateType: string;
  aggregateId: string;
  payloadVersion: number;
  payload: unknown;
  nextAttemptAt?: Date;
}

export interface QueueDispatchIntentRecord {
  id: string;
  queueName: QueueName;
  jobId: string;
  aggregateType: string;
  aggregateId: string;
  payloadVersion: number;
  payload: unknown;
  status: 'pending' | 'dispatching' | 'dispatched' | 'cancelled';
  revision: number;
  attemptCount: number;
  nextAttemptAt: Date;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  lastErrorCode: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface ReconciliationCursor {
  id: string;
}

type QueueIntentWriteContext = Pick<Database, 'query' | 'insert'>;
type QueueIntentUpdateContext = Pick<Database, 'update'>;

function toRecord(row: typeof queueDispatchIntents.$inferSelect): QueueDispatchIntentRecord {
  return {
    ...row,
    queueName: row.queueName as QueueName,
  };
}

function assertIntentInput(input: CreateQueueIntentInput): QueuePayload {
  const payload = parseQueuePayload(input.payload);
  assertStableJobId(input.jobId);
  if (input.payloadVersion !== payload.schema_version) {
    throw new Error('Intent payload version must match payload schema_version');
  }
  if (queueNameForJobType(payload.job_type) !== input.queueName) {
    throw new Error('Intent queue name does not match payload job type');
  }
  if (!input.aggregateType.trim()) throw new Error('Intent aggregate type must not be empty');
  return payload;
}

export async function createQueueIntentInTransaction(
  transaction: QueueIntentWriteContext,
  input: CreateQueueIntentInput,
): Promise<QueueDispatchIntentRecord> {
  return createQueueIntentWithQuery((build) => Promise.resolve(build(transaction)), input);
}

export async function createQueueIntentWithQuery(
  query: <T>(build: (transaction: QueueIntentWriteContext) => PromiseLike<T>) => Promise<T>,
  input: CreateQueueIntentInput,
): Promise<QueueDispatchIntentRecord> {
  const payload = assertIntentInput(input);
  const [created] = await query((transaction) =>
    transaction
      .insert(queueDispatchIntents)
      .values({
        queueName: input.queueName,
        jobId: input.jobId,
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        payloadVersion: input.payloadVersion,
        payload,
        nextAttemptAt: input.nextAttemptAt ?? new Date(),
      })
      .onConflictDoNothing({
        target: [queueDispatchIntents.queueName, queueDispatchIntents.jobId],
      })
      .returning(),
  );
  if (created) return toRecord(created);

  const existing = await query((transaction) =>
    transaction.query.queueDispatchIntents.findFirst({
      where: and(
        eq(queueDispatchIntents.queueName, input.queueName),
        eq(queueDispatchIntents.jobId, input.jobId),
      ),
    }),
  );
  if (
    !existing ||
    existing.aggregateType !== input.aggregateType ||
    existing.aggregateId !== input.aggregateId ||
    existing.payloadVersion !== input.payloadVersion ||
    compositeJobId(existing.payload) !== compositeJobId(payload)
  ) {
    throw new Error('Queue intent idempotency conflict');
  }
  return toRecord(existing);
}

export async function recoverQueueIntentInTransaction(
  transaction: QueueIntentUpdateContext,
  input: { id: string; expectedRevision: number; now: Date; errorCode: string },
): Promise<QueueDispatchIntentRecord | undefined> {
  const [updated] = await transaction
    .update(queueDispatchIntents)
    .set({
      status: 'pending',
      revision: sql`${queueDispatchIntents.revision} + 1`,
      nextAttemptAt: input.now,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: input.errorCode,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(queueDispatchIntents.id, input.id),
        eq(queueDispatchIntents.revision, input.expectedRevision),
        or(
          eq(queueDispatchIntents.status, 'pending'),
          and(
            eq(queueDispatchIntents.status, 'dispatching'),
            lte(queueDispatchIntents.leaseExpiresAt, input.now),
          ),
        ),
      ),
    )
    .returning();
  return updated ? toRecord(updated) : undefined;
}

export class QueueIntentRepository {
  constructor(private readonly database: Database) {}

  create(input: CreateQueueIntentInput): Promise<QueueDispatchIntentRecord> {
    return createQueueIntentInTransaction(this.database, input);
  }

  async claimPending(input: {
    owner: string;
    now: Date;
    leaseMs: number;
    limit: number;
  }): Promise<QueueDispatchIntentRecord[]> {
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select()
        .from(queueDispatchIntents)
        .where(
          and(
            eq(queueDispatchIntents.status, 'pending'),
            lte(queueDispatchIntents.nextAttemptAt, input.now),
          ),
        )
        .orderBy(asc(queueDispatchIntents.nextAttemptAt), asc(queueDispatchIntents.createdAt))
        .for('update', { skipLocked: true })
        .limit(input.limit);
      if (rows.length === 0) return [];
      const leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs);
      const claimed = await transaction
        .update(queueDispatchIntents)
        .set({
          status: 'dispatching',
          revision: sql`${queueDispatchIntents.revision} + 1`,
          leaseOwner: input.owner,
          leaseExpiresAt,
          nextAttemptAt: leaseExpiresAt,
          updatedAt: input.now,
        })
        .where(
          and(
            inArray(
              queueDispatchIntents.id,
              rows.map((row) => row.id),
            ),
            eq(queueDispatchIntents.status, 'pending'),
          ),
        )
        .returning();
      return claimed.map(toRecord);
    });
  }

  async renewLease(input: {
    id: string;
    owner: string;
    now: Date;
    leaseMs: number;
  }): Promise<boolean> {
    const leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs);
    const [updated] = await this.database
      .update(queueDispatchIntents)
      .set({
        revision: sql`${queueDispatchIntents.revision} + 1`,
        leaseExpiresAt,
        nextAttemptAt: leaseExpiresAt,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(queueDispatchIntents.id, input.id),
          eq(queueDispatchIntents.status, 'dispatching'),
          eq(queueDispatchIntents.leaseOwner, input.owner),
          gt(queueDispatchIntents.leaseExpiresAt, input.now),
        ),
      )
      .returning({ id: queueDispatchIntents.id });
    return Boolean(updated);
  }

  async markDispatched(input: { id: string; owner: string; now: Date }): Promise<boolean> {
    const [updated] = await this.database
      .update(queueDispatchIntents)
      .set({
        status: 'dispatched',
        revision: sql`${queueDispatchIntents.revision} + 1`,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(queueDispatchIntents.id, input.id),
          eq(queueDispatchIntents.status, 'dispatching'),
          eq(queueDispatchIntents.leaseOwner, input.owner),
          gt(queueDispatchIntents.leaseExpiresAt, input.now),
        ),
      )
      .returning({ id: queueDispatchIntents.id });
    return Boolean(updated);
  }

  async releaseForRetry(input: {
    id: string;
    owner: string;
    now: Date;
    nextAttemptAt: Date;
    errorCode: string;
  }): Promise<boolean> {
    const [updated] = await this.database
      .update(queueDispatchIntents)
      .set({
        status: 'pending',
        revision: sql`${queueDispatchIntents.revision} + 1`,
        attemptCount: sql`${queueDispatchIntents.attemptCount} + 1`,
        nextAttemptAt: input.nextAttemptAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: input.errorCode,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(queueDispatchIntents.id, input.id),
          eq(queueDispatchIntents.status, 'dispatching'),
          eq(queueDispatchIntents.leaseOwner, input.owner),
          gt(queueDispatchIntents.leaseExpiresAt, input.now),
        ),
      )
      .returning({ id: queueDispatchIntents.id });
    return Boolean(updated);
  }

  async cancelPoison(input: {
    id: string;
    owner: string;
    now: Date;
    errorCode: string;
  }): Promise<boolean> {
    const [updated] = await this.database
      .update(queueDispatchIntents)
      .set({
        status: 'cancelled',
        revision: sql`${queueDispatchIntents.revision} + 1`,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: input.errorCode,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(queueDispatchIntents.id, input.id),
          eq(queueDispatchIntents.status, 'dispatching'),
          eq(queueDispatchIntents.leaseOwner, input.owner),
          gt(queueDispatchIntents.leaseExpiresAt, input.now),
        ),
      )
      .returning({ id: queueDispatchIntents.id });
    return Boolean(updated);
  }

  async cancelDispatchedPoison(input: {
    id: string;
    now: Date;
    errorCode: string;
  }): Promise<boolean> {
    const [updated] = await this.database
      .update(queueDispatchIntents)
      .set({
        status: 'cancelled',
        revision: sql`${queueDispatchIntents.revision} + 1`,
        lastErrorCode: input.errorCode,
        updatedAt: input.now,
      })
      .where(
        and(eq(queueDispatchIntents.id, input.id), eq(queueDispatchIntents.status, 'dispatched')),
      )
      .returning({ id: queueDispatchIntents.id });
    return Boolean(updated);
  }

  async recoverExpiredLeases(input: { now: Date; limit: number }): Promise<number> {
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select({ id: queueDispatchIntents.id })
        .from(queueDispatchIntents)
        .where(
          and(
            eq(queueDispatchIntents.status, 'dispatching'),
            lte(queueDispatchIntents.leaseExpiresAt, input.now),
          ),
        )
        .orderBy(asc(queueDispatchIntents.leaseExpiresAt))
        .for('update', { skipLocked: true })
        .limit(input.limit);
      if (rows.length === 0) return 0;
      const recovered = await transaction
        .update(queueDispatchIntents)
        .set({
          status: 'pending',
          revision: sql`${queueDispatchIntents.revision} + 1`,
          nextAttemptAt: input.now,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: 'QUEUE_DISPATCH_LEASE_EXPIRED',
          updatedAt: input.now,
        })
        .where(
          and(
            inArray(
              queueDispatchIntents.id,
              rows.map((row) => row.id),
            ),
            eq(queueDispatchIntents.status, 'dispatching'),
            lte(queueDispatchIntents.leaseExpiresAt, input.now),
          ),
        )
        .returning({ id: queueDispatchIntents.id });
      return recovered.length;
    });
  }

  async listDispatchedPage(input: {
    limit: number;
    cursor?: ReconciliationCursor;
  }): Promise<QueueDispatchIntentRecord[]> {
    const cursorFilter = input.cursor ? gt(queueDispatchIntents.id, input.cursor.id) : undefined;
    const rows = await this.database
      .select()
      .from(queueDispatchIntents)
      .where(and(eq(queueDispatchIntents.status, 'dispatched'), cursorFilter))
      .orderBy(asc(queueDispatchIntents.id))
      .limit(input.limit);
    return rows.map(toRecord);
  }
}
