import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { agentBrainModelSnapshotSchema } from '@ecom-forge/agent';
import {
  createDatabaseClient,
  eq,
  models,
  providerChannels,
  providerCredentialVersions,
} from '@ecom-forge/db';
import { SecretEnvelope } from '@ecom-forge/shared/secret-envelope';

import { AgentBrainPocService } from '../agent/agent-brain-poc.service.js';
import { loadWorkerConfig } from '../config/worker-config.js';

async function run(): Promise<void> {
  const config = loadWorkerConfig();
  if (!config.providerRealPocEnabled || config.agentBrainAdapter !== 'approved') {
    throw new Error('Agent Brain PoC is not explicitly enabled');
  }
  const snapshotId = process.env.AGENT_BRAIN_POC_MODEL_SNAPSHOT_ID?.trim();
  if (!snapshotId || !/^[0-9a-f-]{36}$/.test(snapshotId)) {
    throw new Error('AGENT_BRAIN_POC_MODEL_SNAPSHOT_ID must be an exact UUID');
  }
  const maxCalls = Number(process.env.AGENT_BRAIN_POC_MAX_CALLS?.trim() || '5');
  if (maxCalls !== 5) {
    throw new Error('AGENT_BRAIN_POC_MAX_CALLS must be exactly 5');
  }
  if (!config.providerCredentialEncryptionKeys) {
    throw new Error('Provider credential keyring is unavailable');
  }

  const resource = createDatabaseClient({
    databaseUrl: config.databaseUrl,
    maxConnections: 1,
    statementTimeoutMs: config.databaseStatementTimeoutMs,
    transactionTimeoutMs: config.databaseTransactionTimeoutMs,
    applicationName: 'ecom-forge-agent-brain-poc',
  });
  try {
    const model = await resource.db.query.models.findFirst({ where: eq(models.id, snapshotId) });
    if (!model?.providerChannelId || !['free_test_only', 'poc_passed'].includes(model.status)) {
      throw new Error('Agent Brain model snapshot is unavailable for PoC');
    }
    const channel = await resource.db.query.providerChannels.findFirst({
      where: eq(providerChannels.id, model.providerChannelId),
    });
    if (!channel?.activeCredentialVersionId || channel.status !== 'active') {
      throw new Error('Agent Brain Provider channel is not active');
    }
    const credential = await resource.db.query.providerCredentialVersions.findFirst({
      where: eq(providerCredentialVersions.id, channel.activeCredentialVersionId),
    });
    if (
      !credential ||
      credential.status !== 'active' ||
      credential.providerChannelId !== channel.id ||
      !credential.validationEvidenceDigest
    ) {
      throw new Error('Agent Brain credential is not active and validated');
    }
    const snapshot = agentBrainModelSnapshotSchema.parse({
      snapshot_id: model.id,
      adapter: 'approved',
      provider: model.provider,
      protocol_family: model.protocolFamily,
      api_variant: model.apiVariant,
      model_id: model.modelId,
      version: model.version,
      status: model.status,
      status_evidence_digest: model.statusEvidenceDigest ?? '0'.repeat(64),
      capability_contract: model.capabilityContractJson,
      pricing: model.pricingJson,
      quota: model.quotaJson,
      runtime: {
        provider_channel_id: channel.id,
        provider_channel_revision: channel.revision,
        adapter_key: channel.adapterKey,
        endpoint_profile_key: channel.endpointProfileKey,
        region: channel.region,
        credential_version_id: credential.id,
      },
    });
    const apiKey = new SecretEnvelope(config.providerCredentialEncryptionKeys).decrypt({
      keyId: credential.secretKeyId,
      ciphertext: credential.secretCiphertext,
      nonce: credential.secretNonce,
      authTag: credential.secretAuthTag,
    });
    const report = await new AgentBrainPocService(config.providerRelayOrigins).run({
      apiKey,
      baseUrl: channel.baseUrl,
      snapshot,
      maxCalls,
      timeoutMs: Math.min(config.agentRequestTimeoutMs, snapshot.quota.terminal_timeout_ms),
      traceId: randomUUID(),
    });
    const reportRoot = resolve(process.cwd(), '..', '..', 'artifacts', 'poc');
    await mkdir(reportRoot, { recursive: true });
    const reportPath = resolve(
      reportRoot,
      `agent-brain-${snapshot.snapshot_id}-${Date.now()}.json`,
    );
    await writeFile(
      reportPath,
      `${JSON.stringify({ generated_at: new Date().toISOString(), ...report }, null, 2)}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    console.info(
      JSON.stringify({
        event: 'agent_brain_poc_completed',
        status: report.status,
        model_snapshot_id: snapshot.snapshot_id,
        call_count: report.call_count,
        total_actual_cost_cny: report.total_actual_cost_cny,
        evidence_digest: report.evidence_digest,
        report_path: reportPath,
      }),
    );
    if (report.status !== 'passed') process.exitCode = 1;
  } finally {
    await resource.client.end();
  }
}

await run();
