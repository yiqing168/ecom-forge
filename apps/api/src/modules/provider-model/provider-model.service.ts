import { isDeepStrictEqual } from 'node:util';

import { and, eq, models, type Database } from '@ecom-forge/db';
import {
  capabilityContractSchema,
  pricingSnapshotSchema,
  quotaSnapshotSchema,
} from '@ecom-forge/provider';
import { z } from 'zod';

const registrationSchema = z.strictObject({
  provider: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  model_id: z.string().min(1).max(128),
  version: z.string().min(1).max(128),
  capability_contract: capabilityContractSchema,
  pricing: pricingSnapshotSchema,
  quota: quotaSnapshotSchema,
});

const approvalSchema = z.strictObject({
  model_id: z.uuid(),
  expected_status: z.enum(['free_test_only', 'poc_passed']),
  target_status: z.enum(['poc_passed', 'poc_failed', 'disabled']),
  evidence_digest: z.string().regex(/^[a-f0-9]{64}$/),
  operator_id: z.string().min(1).max(128),
  reason: z.string().trim().min(8).max(1_000),
});

export type ProviderModelRegistration = z.output<typeof registrationSchema>;
export type ProviderModelApproval = z.output<typeof approvalSchema>;

export function parseProviderModelRegistration(input: unknown): ProviderModelRegistration {
  return registrationSchema.parse(input);
}

export function parseProviderModelApproval(input: unknown): ProviderModelApproval {
  return approvalSchema.parse(input);
}

export class ProviderModelConflictError extends Error {
  constructor(readonly code: 'MODEL_SNAPSHOT_CONFLICT' | 'MODEL_STATUS_CONFLICT') {
    super(code);
    this.name = 'ProviderModelConflictError';
  }
}

function sameSnapshot(
  row: typeof models.$inferSelect,
  input: z.output<typeof registrationSchema>,
): boolean {
  return (
    isDeepStrictEqual(row.capabilityContractJson, input.capability_contract) &&
    isDeepStrictEqual(row.pricingJson, input.pricing) &&
    isDeepStrictEqual(row.quotaJson, input.quota)
  );
}

export class ProviderModelService {
  constructor(
    private readonly database: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async register(rawInput: unknown): Promise<{
    model: typeof models.$inferSelect;
    reused: boolean;
  }> {
    const input = parseProviderModelRegistration(rawInput);
    const [created] = await this.database
      .insert(models)
      .values({
        provider: input.provider,
        modelId: input.model_id,
        version: input.version,
        capabilityContractJson: input.capability_contract,
        pricingJson: input.pricing,
        quotaJson: input.quota,
        status: 'free_test_only',
      })
      .onConflictDoNothing({ target: [models.provider, models.modelId, models.version] })
      .returning();
    if (created) return { model: created, reused: false };
    const existing = await this.database.query.models.findFirst({
      where: and(
        eq(models.provider, input.provider),
        eq(models.modelId, input.model_id),
        eq(models.version, input.version),
      ),
    });
    if (!existing || !sameSnapshot(existing, input)) {
      throw new ProviderModelConflictError('MODEL_SNAPSHOT_CONFLICT');
    }
    return { model: existing, reused: true };
  }

  async approve(rawInput: unknown): Promise<{
    model: typeof models.$inferSelect;
    audit: { evidenceDigest: string; operatorId: string; reason: string };
  }> {
    const input = parseProviderModelApproval(rawInput);
    const allowed =
      (input.expected_status === 'free_test_only' &&
        ['poc_passed', 'poc_failed', 'disabled'].includes(input.target_status)) ||
      (input.expected_status === 'poc_passed' && input.target_status === 'disabled');
    if (!allowed) throw new ProviderModelConflictError('MODEL_STATUS_CONFLICT');
    const [updated] = await this.database
      .update(models)
      .set({
        status: input.target_status,
        statusEvidenceDigest: input.evidence_digest,
        statusOperatorId: input.operator_id,
        statusReason: input.reason,
        statusChangedAt: this.now(),
      })
      .where(and(eq(models.id, input.model_id), eq(models.status, input.expected_status)))
      .returning();
    if (!updated) throw new ProviderModelConflictError('MODEL_STATUS_CONFLICT');
    return {
      model: updated,
      audit: {
        evidenceDigest: input.evidence_digest,
        operatorId: input.operator_id,
        reason: input.reason,
      },
    };
  }
}
