import { and, eq, isNull, lte, or, providerCircuitStates, type Database } from '@ecom-forge/db';
import { z } from 'zod';

const recoverySchema = z.strictObject({
  scope_key: z.string().min(1).max(256),
  expected_revision: z.int().nonnegative(),
  operator_id: z.string().min(1).max(128),
  reason: z.string().trim().min(8).max(1_000),
});

export type ProviderCircuitRecovery = z.output<typeof recoverySchema>;

export function parseProviderCircuitRecovery(input: unknown): ProviderCircuitRecovery {
  return recoverySchema.parse(input);
}

export class ProviderCircuitConflictError extends Error {
  constructor() {
    super('PROVIDER_CIRCUIT_REVISION_CONFLICT');
    this.name = 'ProviderCircuitConflictError';
  }
}

export class ProviderCircuitControlService {
  constructor(
    private readonly database: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async recover(rawInput: unknown) {
    const input = parseProviderCircuitRecovery(rawInput);
    const now = this.now();
    const [updated] = await this.database
      .update(providerCircuitStates)
      .set({
        status: 'closed',
        reasonCode: null,
        sampleCount: 0,
        failureCount: 0,
        unknownCount: 0,
        openedAt: null,
        probeAfter: null,
        probeOwner: null,
        windowStartedAt: now,
        revision: input.expected_revision + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(providerCircuitStates.scopeKey, input.scope_key),
          or(
            eq(providerCircuitStates.status, 'open'),
            and(
              eq(providerCircuitStates.status, 'half_open'),
              or(
                isNull(providerCircuitStates.probeAfter),
                lte(providerCircuitStates.probeAfter, now),
              ),
            ),
          ),
          eq(providerCircuitStates.revision, input.expected_revision),
        ),
      )
      .returning();
    if (!updated) throw new ProviderCircuitConflictError();
    return {
      circuit: updated,
      audit: { operatorId: input.operator_id, reason: input.reason },
    };
  }
}
