import { randomUUID } from 'node:crypto';

import {
  and,
  eq,
  providerChannels,
  providerCredentialValidationRuns,
  providerCredentialVersions,
  sql,
  type Database,
} from '@ecom-forge/db';
import type { QueuePayload } from '@ecom-forge/queue';
import { canonicalSha256 } from '@ecom-forge/shared';
import { SecretEnvelope } from '@ecom-forge/shared/secret-envelope';
import {
  probeVercelAiRelayCredential,
  VERCEL_AI_AGENT_ADAPTER_KEY,
  VERCEL_AI_AGENT_ENDPOINT_PROFILE_KEY,
  VERCEL_AI_AGENT_PROBE_CONTRACT_VERSION,
} from '@ecom-forge/provider';

import type { WorkerConfig } from '../config/worker-config.js';

type ValidationPayload = Extract<QueuePayload, { job_type: 'provider-credential.validate' }>;

const terminalStatuses = new Set(['passed', 'failed', 'outcome_unknown', 'cancelled']);

export class ProviderCredentialValidationService {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly database: Database,
    private readonly config: WorkerConfig,
    private readonly leaseMs: number,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.fetchImpl = fetchImpl;
  }

  async execute(payload: ValidationPayload): Promise<boolean> {
    const owner = randomUUID();
    const now = new Date();
    const claim = await this.claim(payload, owner, now);
    if (!claim) return false;
    let result: Awaited<ReturnType<ProviderCredentialValidationService['validate']>>;
    try {
      result = await this.validate(payload);
    } catch (error) {
      result = {
        status: 'outcome_unknown',
        evidenceDigest: canonicalSha256({
          job: payload.job_type,
          run_id: payload.credential_validation_run_id,
          outcome: 'unknown',
          error: error instanceof Error ? error.name : 'UNKNOWN_ERROR',
        }),
        summary: { code: 'PROVIDER_VALIDATION_OUTCOME_UNKNOWN' },
      };
    }
    return this.complete(payload, claim, result, new Date());
  }

  private async claim(
    payload: ValidationPayload,
    owner: string,
    now: Date,
  ): Promise<{ revision: number; owner: string } | null> {
    return this.database.transaction(async (transaction) => {
      const [run] = await transaction
        .select({
          id: providerCredentialValidationRuns.id,
          revision: providerCredentialValidationRuns.revision,
          status: providerCredentialValidationRuns.status,
          processingLeaseExpiresAt: providerCredentialValidationRuns.processingLeaseExpiresAt,
        })
        .from(providerCredentialValidationRuns)
        .where(
          and(
            eq(providerCredentialValidationRuns.id, payload.credential_validation_run_id),
            eq(providerCredentialValidationRuns.providerChannelId, payload.provider_channel_id),
            eq(providerCredentialValidationRuns.credentialVersionId, payload.credential_version_id),
            eq(
              providerCredentialValidationRuns.probeContractVersion,
              payload.probe_contract_version,
            ),
            eq(providerCredentialValidationRuns.attemptNo, payload.attempt_no),
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
        .update(providerCredentialValidationRuns)
        .set({
          status: 'running',
          revision,
          processingOwner: owner,
          processingLeaseExpiresAt: new Date(now.getTime() + this.leaseMs),
          startedAt: run.status === 'queued' ? now : undefined,
        })
        .where(
          and(
            eq(providerCredentialValidationRuns.id, run.id),
            eq(providerCredentialValidationRuns.revision, run.revision),
          ),
        )
        .returning({ id: providerCredentialValidationRuns.id });
      return updated ? { revision, owner } : null;
    });
  }

  private async validate(payload: ValidationPayload): Promise<{
    status: 'passed' | 'failed' | 'outcome_unknown';
    evidenceDigest: string;
    summary: Record<string, string>;
  }> {
    const channel = await this.database.query.providerChannels.findFirst({
      where: eq(providerChannels.id, payload.provider_channel_id),
    });
    const credential = await this.database.query.providerCredentialVersions.findFirst({
      where: eq(providerCredentialVersions.id, payload.credential_version_id),
    });
    if (
      !channel ||
      !credential ||
      credential.providerChannelId !== channel.id ||
      credential.status === 'revoked'
    ) {
      return {
        status: 'failed',
        evidenceDigest: canonicalSha256({ payload, result: 'snapshot_invalid' }),
        summary: { code: 'PROVIDER_VALIDATION_SNAPSHOT_INVALID' },
      };
    }
    if (
      this.config.providerProcessorMode === 'fake_validation' &&
      channel.adapterKey === 'fake-provider-v1'
    ) {
      return {
        status: 'passed',
        evidenceDigest: canonicalSha256({
          provider: channel.provider,
          adapter_key: channel.adapterKey,
          endpoint_profile_key: channel.endpointProfileKey,
          credential_version_id: credential.id,
          probe_contract_version: payload.probe_contract_version,
          result: 'fake_probe_passed',
        }),
        summary: { code: 'PROVIDER_FAKE_PROBE_PASSED' },
      };
    }
    if (
      !this.config.providerRealPocEnabled ||
      !['openai', 'anthropic', 'google'].includes(channel.provider) ||
      channel.adapterKey !== VERCEL_AI_AGENT_ADAPTER_KEY ||
      channel.endpointProfileKey !== VERCEL_AI_AGENT_ENDPOINT_PROFILE_KEY ||
      payload.probe_contract_version !== VERCEL_AI_AGENT_PROBE_CONTRACT_VERSION ||
      !this.config.providerCredentialEncryptionKeys
    ) {
      return {
        status: 'failed',
        evidenceDigest: canonicalSha256({ payload, result: 'processor_disabled' }),
        summary: { code: 'PROVIDER_VALIDATION_PROCESSOR_DISABLED' },
      };
    }
    let secret: string;
    try {
      secret = new SecretEnvelope(this.config.providerCredentialEncryptionKeys).decrypt({
        keyId: credential.secretKeyId,
        ciphertext: credential.secretCiphertext,
        nonce: credential.secretNonce,
        authTag: credential.secretAuthTag,
      });
    } catch {
      return {
        status: 'failed',
        evidenceDigest: canonicalSha256({ payload, result: 'credential_unavailable' }),
        summary: { code: 'PROVIDER_CREDENTIAL_UNAVAILABLE' },
      };
    }
    const probe = await probeVercelAiRelayCredential({
      apiKey: secret,
      baseUrl: channel.baseUrl,
      allowedRelayOrigins: this.config.providerRelayOrigins,
      protocolFamily:
        channel.provider === 'google'
          ? 'google'
          : channel.provider === 'anthropic'
            ? 'anthropic'
            : 'openai',
      abortSignal: AbortSignal.timeout(this.config.providerRequestTimeoutMs),
      fetchImpl: this.fetchImpl,
    });
    return {
      status: probe.status,
      evidenceDigest: canonicalSha256({
        provider: channel.provider,
        adapter_key: channel.adapterKey,
        endpoint_profile_key: channel.endpointProfileKey,
        provider_channel_id: channel.id,
        provider_channel_revision: channel.revision,
        base_url: channel.baseUrl,
        credential_version_id: credential.id,
        probe_contract_version: payload.probe_contract_version,
        result: probe.code,
      }),
      summary: { code: probe.code },
    };
  }

  private async complete(
    payload: ValidationPayload,
    claim: { revision: number; owner: string },
    result: {
      status: 'passed' | 'failed' | 'outcome_unknown';
      evidenceDigest: string;
      summary: Record<string, string>;
    },
    now: Date,
  ): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const [run] = await transaction
        .update(providerCredentialValidationRuns)
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
            eq(providerCredentialValidationRuns.id, payload.credential_validation_run_id),
            eq(providerCredentialValidationRuns.status, 'running'),
            eq(providerCredentialValidationRuns.processingOwner, claim.owner),
            eq(providerCredentialValidationRuns.revision, claim.revision),
          ),
        )
        .returning({ id: providerCredentialValidationRuns.id });
      if (!run) return false;
      const credential = await transaction.query.providerCredentialVersions.findFirst({
        where: eq(providerCredentialVersions.id, payload.credential_version_id),
      });
      if (!credential) return true;
      if (credential.status === 'active') {
        if (result.status === 'passed') {
          await transaction
            .update(providerCredentialVersions)
            .set({
              validationEvidenceDigest: result.evidenceDigest,
              verifiedAt: now,
              revision: credential.revision + 1,
            })
            .where(
              and(
                eq(providerCredentialVersions.id, credential.id),
                eq(providerCredentialVersions.status, 'active'),
                eq(providerCredentialVersions.revision, credential.revision),
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
        .update(providerCredentialVersions)
        .set({
          status: credentialStatus,
          validationEvidenceDigest: result.evidenceDigest,
          revision: sql`${providerCredentialVersions.revision} + 1`,
          ...(result.status === 'passed' ? { verifiedAt: now } : {}),
        })
        .where(
          and(
            eq(providerCredentialVersions.id, payload.credential_version_id),
            eq(providerCredentialVersions.status, 'pending_validation'),
          ),
        );
      return true;
    });
  }
}
