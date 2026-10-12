import { createHmac } from 'node:crypto';

import { and, eq, resourceWriteRequests, sql, type Database } from '@ecom-forge/db';
import { canonicalSha256, scopedAdvisoryLockKey } from '@ecom-forge/shared';

import { resourceError } from './resource.errors.js';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export class ResourceWriteRepository {
  constructor(
    private readonly database: Database,
    private readonly secret: string,
  ) {}

  execute<T extends Record<string, unknown>>(input: {
    userId: string;
    operation: string;
    idempotencyKey: string;
    request: unknown;
    responseStatus: number;
    write: (transaction: Transaction) => Promise<T>;
  }): Promise<T> {
    const keyHash = createHmac('sha256', this.secret).update(input.idempotencyKey).digest('hex');
    const requestHash = canonicalSha256(input.request);
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(${scopedAdvisoryLockKey('resource-write', `${input.userId}:${input.operation}:${keyHash}`)})`,
      );
      const replay = await transaction.query.resourceWriteRequests.findFirst({
        where: and(
          eq(resourceWriteRequests.userId, input.userId),
          eq(resourceWriteRequests.operation, input.operation),
          eq(resourceWriteRequests.idempotencyKeyHash, keyHash),
        ),
      });
      if (replay) {
        if (replay.requestHash !== requestHash) resourceError('IDEMPOTENCY_CONFLICT');
        if (!replay.responseJson) throw new Error('Completed resource write has no response');
        return replay.responseJson as T;
      }
      const response = await input.write(transaction);
      await transaction.insert(resourceWriteRequests).values({
        userId: input.userId,
        operation: input.operation,
        idempotencyKeyHash: keyHash,
        requestHash,
        status: 'completed',
        responseStatus: input.responseStatus,
        responseJson: response,
        completedAt: new Date(),
      });
      return response;
    });
  }
}
