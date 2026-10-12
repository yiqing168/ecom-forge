import { randomUUID } from 'node:crypto';

import {
  and,
  asc,
  eq,
  inArray,
  lte,
  storageChannels,
  storageCredentialVersions,
  storageValidationRuns,
  sql,
  type Database,
} from '@ecom-forge/db';
import type { QueuePayload } from '@ecom-forge/queue';
import { canonicalSha256 } from '@ecom-forge/shared';
import { LocalPrivateStorage, S10_PRIVATE_ASSET_SMOKE_CONTRACT_VERSION } from '@ecom-forge/storage';

import type { WorkerConfig } from '../config/worker-config.js';

type ValidationPayload = Extract<QueuePayload, { job_type: 'storage-credential.validate' }>;
type ValidationResult = {
  status: 'passed' | 'failed' | 'outcome_unknown';
  evidenceDigest: string;
  summary: Record<string, string>;
};

const terminalStatuses = new Set(['passed', 'failed', 'outcome_unknown', 'cancelled']);
const sweepableStatuses = ['passed', 'failed', 'outcome_unknown', 'cancelled'] as const;
const DEFAULT_SWEEP_BATCH_SIZE = 50;
const MAX_SWEEP_BATCH_SIZE = 100;
const SWEEP_GRACE_MS = 60_000;
const PROBE_CLEANUP_COMPLETE = 'completed';

function probeObjectKey(rootPrefix: string, runId: string): string {
  return `${rootPrefix ? `${rootPrefix}/` : ''}s14-validation/${runId}/probe.bin`;
}

function isMissingObject(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

export class StorageCredentialValidationService {
  constructor(
    private readonly database: Database,
    private readonly config: WorkerConfig,
    private readonly leaseMs: number,
  ) {}

  async execute(payload: ValidationPayload): Promise<boolean> {
    const owner = randomUUID();
    const now = new Date();
    const claim = await this.claim(payload, owner, now);
    if (!claim) return false;

    let result: ValidationResult;
    try {
      if (claim.recovered) await this.deleteProbe(payload);
      result = await this.validate(payload);
    } catch (error) {
      result = {
        status: 'outcome_unknown',
        evidenceDigest: canonicalSha256({
          job: payload.job_type,
          run_id: payload.storage_validation_run_id,
          outcome: 'unknown',
          error: error instanceof Error ? error.name : 'UNKNOWN_ERROR',
        }),
        summary: { code: 'STORAGE_VALIDATION_OUTCOME_UNKNOWN' },
      };
    }
    return this.complete(payload, claim, result, new Date());
  }

  private async claim(
    payload: ValidationPayload,
    owner: string,
    now: Date,
  ): Promise<{ revision: number; owner: string; recovered: boolean } | null> {
    return this.database.transaction(async (transaction) => {
      const [run] = await transaction
        .select({
          id: storageValidationRuns.id,
          revision: storageValidationRuns.revision,
          status: storageValidationRuns.status,
          processingLeaseExpiresAt: storageValidationRuns.processingLeaseExpiresAt,
        })
        .from(storageValidationRuns)
        .where(
          and(
            eq(storageValidationRuns.id, payload.storage_validation_run_id),
            eq(storageValidationRuns.storageChannelId, payload.storage_channel_id),
            eq(storageValidationRuns.credentialVersionId, payload.credential_version_id),
            eq(storageValidationRuns.probeContractVersion, payload.probe_contract_version),
            eq(storageValidationRuns.attemptNo, payload.attempt_no),
          ),
        )
        .for('update');
      if (!run || terminalStatuses.has(run.status)) return null;
      if (
        run.status === 'running' &&
        run.processingLeaseExpiresAt &&
        run.processingLeaseExpiresAt.getTime() > now.getTime()
      ) {
        return null;
      }
      const revision = run.revision + 1;
      const [updated] = await transaction
        .update(storageValidationRuns)
        .set({
          status: 'running',
          revision,
          processingOwner: owner,
          processingLeaseExpiresAt: new Date(now.getTime() + this.leaseMs),
          startedAt: run.status === 'queued' ? now : undefined,
        })
        .where(
          and(
            eq(storageValidationRuns.id, run.id),
            eq(storageValidationRuns.revision, run.revision),
          ),
        )
        .returning({ id: storageValidationRuns.id });
      return updated ? { revision, owner, recovered: run.status === 'running' } : null;
    });
  }

  private async validate(payload: ValidationPayload): Promise<ValidationResult> {
    const channel = await this.database.query.storageChannels.findFirst({
      where: eq(storageChannels.id, payload.storage_channel_id),
    });
    const credential = await this.database.query.storageCredentialVersions.findFirst({
      where: eq(storageCredentialVersions.id, payload.credential_version_id),
    });
    if (
      !channel ||
      !credential ||
      credential.storageChannelId !== channel.id ||
      credential.status === 'revoked'
    ) {
      return {
        status: 'failed',
        evidenceDigest: canonicalSha256({ payload, result: 'snapshot_invalid' }),
        summary: { code: 'STORAGE_VALIDATION_SNAPSHOT_INVALID' },
      };
    }
    if (
      !this.config.storageEnabled ||
      channel.adapterKey !== 'local-private-v1' ||
      channel.endpointProfileKey !== 'local' ||
      channel.region !== 'local'
    ) {
      return {
        status: 'failed',
        evidenceDigest: canonicalSha256({ payload, result: 'adapter_not_enabled' }),
        summary: { code: 'STORAGE_VALIDATION_ADAPTER_NOT_ENABLED' },
      };
    }

    const storage = new LocalPrivateStorage(this.config.localUploadRoot);
    await storage.initialize();
    const key = probeObjectKey(channel.rootPrefix, payload.storage_validation_run_id);
    const contents = Buffer.from('ecom-forge-storage-probe-v1', 'utf8');
    try {
      await storage.writeExclusive(key, contents);
      const size = await storage.size(key);
      const read = await storage.read(key);
      if (size !== contents.length || !read.equals(contents)) {
        return {
          status: 'failed',
          evidenceDigest: canonicalSha256({ payload, result: 'probe_mismatch' }),
          summary: { code: 'STORAGE_VALIDATION_PROBE_MISMATCH' },
        };
      }
      const range = read.subarray(0, 8);
      if (!range.equals(contents.subarray(0, 8))) {
        return {
          status: 'failed',
          evidenceDigest: canonicalSha256({ payload, result: 'range_read_mismatch' }),
          summary: { code: 'STORAGE_VALIDATION_RANGE_READ_FAILED' },
        };
      }
      return {
        status: 'passed',
        evidenceDigest: canonicalSha256({
          adapter_key: channel.adapterKey,
          endpoint_profile_key: channel.endpointProfileKey,
          probe_contract_version: payload.probe_contract_version,
          smoke_contract_version: S10_PRIVATE_ASSET_SMOKE_CONTRACT_VERSION,
          capabilities: ['put', 'head', 'range_read', 'delete'],
          result: 'probe_passed',
        }),
        summary: {
          code: 'STORAGE_LOCAL_PROBE_PASSED',
          smoke_contract_version: S10_PRIVATE_ASSET_SMOKE_CONTRACT_VERSION,
        },
      };
    } finally {
      await storage.delete(key).catch((error: unknown) => {
        if (!isMissingObject(error)) throw error;
      });
    }
  }

  async sweepResidualProbes(now = new Date(), limit = DEFAULT_SWEEP_BATCH_SIZE): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SWEEP_BATCH_SIZE) {
      throw new Error('STORAGE_PROBE_SWEEP_LIMIT_INVALID');
    }
    if (!this.config.storageEnabled) return 0;
    const candidates = await this.database
      .select({
        runId: storageValidationRuns.id,
        rootPrefix: storageChannels.rootPrefix,
      })
      .from(storageValidationRuns)
      .innerJoin(storageChannels, eq(storageChannels.id, storageValidationRuns.storageChannelId))
      .where(
        and(
          inArray(storageValidationRuns.status, sweepableStatuses),
          sql`${storageValidationRuns.completedAt} is not null`,
          lte(storageValidationRuns.completedAt, new Date(now.getTime() - SWEEP_GRACE_MS)),
          eq(storageChannels.adapterKey, 'local-private-v1'),
          sql`coalesce(${storageValidationRuns.resultSummaryJson}->>'probe_cleanup_status', '') <> ${PROBE_CLEANUP_COMPLETE}`,
        ),
      )
      .orderBy(asc(storageValidationRuns.completedAt), asc(storageValidationRuns.id))
      .limit(MAX_SWEEP_BATCH_SIZE);
    const storage = new LocalPrivateStorage(this.config.localUploadRoot);
    await storage.initialize();
    let deleted = 0;
    for (const candidate of candidates) {
      if (deleted >= limit) break;
      try {
        await storage.delete(probeObjectKey(candidate.rootPrefix, candidate.runId));
        deleted += 1;
      } catch (error) {
        if (!isMissingObject(error)) throw error;
      }
      await this.database
        .update(storageValidationRuns)
        .set({
          resultSummaryJson: sql`coalesce(${storageValidationRuns.resultSummaryJson}, '{}'::jsonb) || jsonb_build_object('probe_cleanup_status', cast(${PROBE_CLEANUP_COMPLETE} as text), 'probe_cleanup_at', cast(${now.toISOString()} as text))`,
        })
        .where(
          and(
            eq(storageValidationRuns.id, candidate.runId),
            inArray(storageValidationRuns.status, sweepableStatuses),
          ),
        );
    }
    return deleted;
  }

  private async deleteProbe(payload: ValidationPayload): Promise<void> {
    const channel = await this.database.query.storageChannels.findFirst({
      where: and(
        eq(storageChannels.id, payload.storage_channel_id),
        eq(storageChannels.adapterKey, 'local-private-v1'),
      ),
    });
    if (!channel) return;
    const storage = new LocalPrivateStorage(this.config.localUploadRoot);
    await storage.initialize();
    await storage
      .delete(probeObjectKey(channel.rootPrefix, payload.storage_validation_run_id))
      .catch((error: unknown) => {
        if (!isMissingObject(error)) throw error;
      });
  }

  private async complete(
    payload: ValidationPayload,
    claim: { revision: number; owner: string; recovered: boolean },
    result: ValidationResult,
    now: Date,
  ): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const [run] = await transaction
        .update(storageValidationRuns)
        .set({
          status: result.status,
          revision: claim.revision + 1,
          processingOwner: null,
          processingLeaseExpiresAt: null,
          evidenceDigest: result.evidenceDigest,
          resultSummaryJson: result.summary,
          completedAt: now,
        })
        .where(
          and(
            eq(storageValidationRuns.id, payload.storage_validation_run_id),
            eq(storageValidationRuns.status, 'running'),
            eq(storageValidationRuns.processingOwner, claim.owner),
            eq(storageValidationRuns.revision, claim.revision),
          ),
        )
        .returning({ id: storageValidationRuns.id });
      if (!run) return false;
      const credential = await transaction.query.storageCredentialVersions.findFirst({
        where: eq(storageCredentialVersions.id, payload.credential_version_id),
      });
      if (!credential) return true;
      if (credential.status === 'active') {
        if (result.status === 'passed') {
          await transaction
            .update(storageCredentialVersions)
            .set({
              validationEvidenceDigest: result.evidenceDigest,
              verifiedAt: now,
              revision: credential.revision + 1,
            })
            .where(
              and(
                eq(storageCredentialVersions.id, credential.id),
                eq(storageCredentialVersions.status, 'active'),
                eq(storageCredentialVersions.revision, credential.revision),
              ),
            );
        }
        return true;
      }
      const credentialStatus =
        result.status === 'passed'
          ? 'valid'
          : result.status === 'outcome_unknown'
            ? 'validation_unknown'
            : 'invalid';
      await transaction
        .update(storageCredentialVersions)
        .set({
          status: credentialStatus,
          validationEvidenceDigest: result.evidenceDigest,
          revision: sql`${storageCredentialVersions.revision} + 1`,
          ...(result.status === 'passed' ? { verifiedAt: now } : {}),
        })
        .where(
          and(
            eq(storageCredentialVersions.id, payload.credential_version_id),
            eq(storageCredentialVersions.status, 'pending_validation'),
          ),
        );
      return true;
    });
  }
}
