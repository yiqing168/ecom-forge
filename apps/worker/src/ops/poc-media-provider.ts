import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  createDatabaseClient,
  eq,
  models,
  providerChannels,
  providerCredentialVersions,
} from '@ecom-forge/db';
import { capabilityContractSchema, mediaV2CapabilityContractSchema } from '@ecom-forge/provider';
import { SecretEnvelope } from '@ecom-forge/shared/secret-envelope';

import { loadWorkerConfig } from '../config/worker-config.js';
import { ImagePocRunner, type ImagePocInput } from '../provider/image-poc.runner.js';
import { ModerationPocRunner, type ModerationPocInput } from '../provider/moderation-poc.runner.js';

type PocKind = 'image' | 'edit' | 'moderation';

const exactUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseKind(): PocKind {
  const kind = process.argv[2]?.trim();
  if (kind !== 'image' && kind !== 'edit' && kind !== 'moderation') {
    throw new Error('PoC kind must be image, edit, or moderation');
  }
  return kind;
}

async function run(): Promise<void> {
  const kind = parseKind();
  const config = loadWorkerConfig();
  if (!config.providerRealPocEnabled || !config.providerCredentialEncryptionKeys) {
    throw new Error('Real Provider PoC is not explicitly enabled');
  }
  const modelSnapshotId = requiredEnvironment('PROVIDER_POC_MODEL_SNAPSHOT_ID');
  if (!exactUuid.test(modelSnapshotId)) {
    throw new Error('PROVIDER_POC_MODEL_SNAPSHOT_ID must be an exact UUID');
  }

  const resource = createDatabaseClient({
    databaseUrl: config.databaseUrl,
    maxConnections: 1,
    statementTimeoutMs: config.databaseStatementTimeoutMs,
    transactionTimeoutMs: config.databaseTransactionTimeoutMs,
    applicationName: `ecom-forge-${kind}-provider-poc`,
  });
  try {
    const model = await resource.db.query.models.findFirst({
      where: eq(models.id, modelSnapshotId),
    });
    if (!model?.providerChannelId || !['free_test_only', 'poc_passed'].includes(model.status)) {
      throw new Error('Provider model snapshot is unavailable for PoC');
    }
    const channel = await resource.db.query.providerChannels.findFirst({
      where: eq(providerChannels.id, model.providerChannelId),
    });
    if (!channel?.activeCredentialVersionId || channel.status !== 'active') {
      throw new Error('Provider channel is not active');
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
      throw new Error('Provider credential is not active and validated');
    }
    const apiKey = new SecretEnvelope(config.providerCredentialEncryptionKeys).decrypt({
      keyId: credential.secretKeyId,
      ciphertext: credential.secretCiphertext,
      nonce: credential.secretNonce,
      authTag: credential.secretAuthTag,
    });
    const runId = randomUUID();
    const traceId = randomUUID();
    const common = {
      runId,
      traceId,
      apiKey,
      model,
      channel,
      credentialVersionId: credential.id,
    };

    const result =
      kind === 'moderation'
        ? await runModeration(config, common)
        : await runImage(config, common, kind);
    const report = {
      generated_at: new Date().toISOString(),
      kind,
      model_snapshot_id: model.id,
      provider_channel_id: channel.id,
      credential_version_id: credential.id,
      status: result.status,
      evidence_digest: result.evidenceDigest,
      summary: result.summary,
    };
    const reportRoot = resolve(process.cwd(), '..', '..', 'artifacts', 'poc');
    await mkdir(reportRoot, { recursive: true });
    const reportPath = resolve(reportRoot, `${kind}-${model.id}-${Date.now()}.json`);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    console.info(
      JSON.stringify({
        event: 'provider_media_poc_completed',
        kind,
        model_snapshot_id: model.id,
        status: result.status,
        evidence_digest: result.evidenceDigest,
        report_path: reportPath,
      }),
    );
    if (result.status !== 'passed') process.exitCode = 1;
  } finally {
    await resource.client.end();
  }
}

async function runImage(
  config: ReturnType<typeof loadWorkerConfig>,
  input: Omit<ImagePocInput, 'requestedSpecKeys'>,
  kind: 'image' | 'edit',
) {
  const contract = mediaV2CapabilityContractSchema.parse(input.model.capabilityContractJson);
  if (contract.media_kind !== 'image') throw new Error('PoC model is not an image model');
  const operation = kind === 'image' ? 'image.generate' : 'image.edit';
  const requestedSpecKey = requiredEnvironment('PROVIDER_POC_SPEC_KEY');
  const spec = contract.specs.find(
    (candidate) => candidate.spec_key === requestedSpecKey && candidate.operation === operation,
  );
  if (!spec) throw new Error(`PROVIDER_POC_SPEC_KEY does not declare ${operation}`);
  return new ImagePocRunner(
    config.providerRelayOrigins,
    config.providerImageOutputOrigins,
    config.providerRequestTimeoutMs,
    config.storageMaxImageBytes,
    config.storageMaxImagePixels,
  ).run({ ...input, requestedSpecKeys: [requestedSpecKey] });
}

async function runModeration(
  config: ReturnType<typeof loadWorkerConfig>,
  input: Omit<ModerationPocInput, 'requestedCapabilities'>,
) {
  const contract = capabilityContractSchema.parse(input.model.capabilityContractJson);
  const requested = requiredEnvironment('PROVIDER_POC_MODERATION_CAPABILITIES')
    .split(',')
    .map((value) => value.trim())
    .filter(
      (value): value is 'moderation.text' | 'moderation.image' =>
        value === 'moderation.text' || value === 'moderation.image',
    );
  const capabilities = [...new Set(requested)];
  if (
    capabilities.length === 0 ||
    capabilities.some((capability) => !contract.capabilities.includes(capability))
  ) {
    throw new Error('PROVIDER_POC_MODERATION_CAPABILITIES is invalid for this model');
  }
  return new ModerationPocRunner(config.providerRelayOrigins, config.providerRequestTimeoutMs).run({
    ...input,
    requestedCapabilities: capabilities,
  });
}

await run();
