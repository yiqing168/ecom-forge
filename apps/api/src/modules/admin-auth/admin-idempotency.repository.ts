import { adminIdempotencyRecords, and, eq, sql, type Database } from '@ecom-forge/db';
import { canonicalSha256, scopedAdvisoryLockKey } from '@ecom-forge/shared';

import { HmacKeyring } from '../auth/security/hmac-keyring.js';
import { AdminAuthError } from './admin-errors.js';
import type { AdminSessionContext } from './admin-http.js';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export class AdminIdempotencyRepository {
  private readonly keyring: HmacKeyring;

  constructor(
    private readonly database: Database,
    idempotencyHashKeys: string,
  ) {
    this.keyring = new HmacKeyring(idempotencyHashKeys);
  }

  async replay<T extends Record<string, unknown>>(input: {
    context: AdminSessionContext;
    operation: string;
    idempotencyKey: string;
    request: unknown;
  }): Promise<T | undefined> {
    const { keyHash, requestHash } = this.identity(input);
    const replay = await this.database.query.adminIdempotencyRecords.findFirst({
      where: and(
        eq(adminIdempotencyRecords.actorAdminId, input.context.principalId),
        eq(adminIdempotencyRecords.operation, input.operation),
        eq(adminIdempotencyRecords.idempotencyKeyHash, keyHash),
      ),
    });
    if (!replay) return undefined;
    if (replay.requestHash !== requestHash) {
      throw new AdminAuthError('ADMIN_IDEMPOTENCY_CONFLICT', 409);
    }
    if (replay.status !== 'completed' || !replay.responseJson) {
      throw new AdminAuthError('ADMIN_AUTH_UNAVAILABLE', 503);
    }
    return replay.responseJson as T;
  }

  async execute<T extends Record<string, unknown>>(input: {
    context: AdminSessionContext;
    operation: string;
    idempotencyKey: string;
    request: unknown;
    responseStatus: number;
    write: (transaction: Transaction) => Promise<T>;
    persistResponse?: (response: T) => Record<string, unknown>;
  }): Promise<T> {
    const { keyHash, requestHash } = this.identity(input);
    const lockValue = `${input.context.principalId}:${input.operation}:${keyHash}`;
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(${scopedAdvisoryLockKey('admin-write', lockValue)})`,
      );
      const replay = await transaction.query.adminIdempotencyRecords.findFirst({
        where: and(
          eq(adminIdempotencyRecords.actorAdminId, input.context.principalId),
          eq(adminIdempotencyRecords.operation, input.operation),
          eq(adminIdempotencyRecords.idempotencyKeyHash, keyHash),
        ),
      });
      if (replay) {
        if (replay.requestHash !== requestHash) {
          throw new AdminAuthError('ADMIN_IDEMPOTENCY_CONFLICT', 409);
        }
        if (replay.status !== 'completed' || !replay.responseJson) {
          throw new AdminAuthError('ADMIN_AUTH_UNAVAILABLE', 503);
        }
        return replay.responseJson as T;
      }
      const response = await input.write(transaction);
      const persistedResponse = input.persistResponse ? input.persistResponse(response) : response;
      await transaction.insert(adminIdempotencyRecords).values({
        actorAdminId: input.context.principalId,
        idempotencyKeyHash: keyHash,
        operation: input.operation,
        requestHash,
        status: 'completed',
        responseStatus: input.responseStatus,
        responseJson: persistedResponse,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
        completedAt: new Date(),
      });
      return response;
    });
  }

  private identity(input: { operation: string; idempotencyKey: string; request: unknown }): {
    keyHash: string;
    requestHash: string;
  } {
    if (!/^[\x21-\x7e]{16,200}$/.test(input.idempotencyKey)) {
      throw new AdminAuthError('ADMIN_IDEMPOTENCY_KEY_INVALID', 400);
    }
    return {
      keyHash: this.keyring.digest(input.idempotencyKey).digest,
      requestHash: canonicalSha256({ operation: input.operation, request: input.request }),
    };
  }
}
