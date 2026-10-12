import {
  AgentBrainCallError,
  type AgentBrainCallContext,
  type AgentBrainModelSnapshot,
  type AgentBrainPort,
  type AgentBrainStepInput,
  type AgentSessionCompactionInput,
} from '@ecom-forge/agent';
import { eq, providerChannels, providerCredentialVersions, type Database } from '@ecom-forge/db';
import {
  estimateAgentBrainInputTokens,
  normalizeRelayApiBaseUrl,
  VERCEL_AI_AGENT_ENDPOINT_PROFILE_KEY,
  VERCEL_AI_AGENT_ADAPTER_KEY,
  VercelAiAgentBrain,
  type AgentBrainReasoningEffort,
} from '@ecom-forge/provider';
import { SecretEnvelope } from '@ecom-forge/shared/secret-envelope';
import type { Redis } from 'ioredis';

import { AgentBrainRuntimeGuard } from './agent-brain-runtime.guard.js';

type FetchLike = typeof fetch;

export class ApprovedAgentBrainRouter implements AgentBrainPort {
  private readonly envelope: SecretEnvelope;
  private readonly runtimeGuard: AgentBrainRuntimeGuard;

  constructor(
    private readonly database: Database,
    redis: Redis,
    redisPrefix: string,
    serializedCredentialKeyring: string,
    private readonly allowedRelayOrigins: readonly string[],
    private readonly fetchImpl: FetchLike = fetch,
    private readonly allowConfiguredRelayOrigin = false,
    private readonly reasoningEffort?: AgentBrainReasoningEffort,
  ) {
    this.envelope = new SecretEnvelope(serializedCredentialKeyring);
    this.runtimeGuard = new AgentBrainRuntimeGuard(database, redis, redisPrefix);
  }

  countInputTokens(input: AgentBrainStepInput, snapshot: AgentBrainModelSnapshot): number {
    assertApprovedBinding(snapshot);
    return estimateAgentBrainInputTokens(input);
  }

  async runStep(input: AgentBrainStepInput, context: Parameters<AgentBrainPort['runStep']>[1]) {
    return this.withApprovedBrain(context, (brain) => brain.runStep(input, context));
  }

  async summarizeSession(
    input: AgentSessionCompactionInput,
    context: Parameters<NonNullable<AgentBrainPort['summarizeSession']>>[1],
  ) {
    return this.withApprovedBrain(context, (brain) => brain.summarizeSession(input, context));
  }

  private async withApprovedBrain<T>(
    context: AgentBrainCallContext,
    operation: (brain: VercelAiAgentBrain) => Promise<T>,
  ): Promise<T> {
    const runtime = assertApprovedBinding(context.modelSnapshot);
    let channel: Awaited<ReturnType<typeof this.database.query.providerChannels.findFirst>>;
    let credential: Awaited<
      ReturnType<typeof this.database.query.providerCredentialVersions.findFirst>
    >;
    try {
      [channel, credential] = await Promise.all([
        this.database.query.providerChannels.findFirst({
          where: eq(providerChannels.id, runtime.provider_channel_id),
        }),
        this.database.query.providerCredentialVersions.findFirst({
          where: eq(providerCredentialVersions.id, runtime.credential_version_id),
        }),
      ]);
    } catch {
      throw new AgentBrainCallError('AGENT_BRAIN_RUNTIME_BINDING_UNAVAILABLE', 'not_dispatched');
    }
    if (
      !channel ||
      !credential ||
      channel.status !== 'active' ||
      channel.provider !== context.modelSnapshot.provider ||
      channel.provider !== context.modelSnapshot.protocol_family ||
      channel.revision !== runtime.provider_channel_revision ||
      channel.adapterKey !== runtime.adapter_key ||
      channel.endpointProfileKey !== runtime.endpoint_profile_key ||
      channel.region !== runtime.region ||
      credential.providerChannelId !== channel.id ||
      credential.status !== 'active' ||
      channel.activeCredentialVersionId !== credential.id ||
      !credential.validationEvidenceDigest ||
      !isNormalizedRelayApiBaseUrl(channel.baseUrl)
    ) {
      throw new AgentBrainCallError('AGENT_BRAIN_RUNTIME_BINDING_UNAVAILABLE', 'not_dispatched');
    }

    let apiKey: string;
    try {
      apiKey = this.envelope.decrypt({
        keyId: credential.secretKeyId,
        ciphertext: credential.secretCiphertext,
        nonce: credential.secretNonce,
        authTag: credential.secretAuthTag,
      });
    } catch {
      throw new AgentBrainCallError('AGENT_BRAIN_CREDENTIAL_UNAVAILABLE', 'not_dispatched');
    }
    const permit = await this.runtimeGuard.reserve(context.modelSnapshot, context.deadline);
    try {
      let outcome: T;
      try {
        const brain = new VercelAiAgentBrain(
          apiKey,
          channel.baseUrl,
          this.allowConfiguredRelayOrigin
            ? [...new Set([...this.allowedRelayOrigins, new URL(channel.baseUrl).origin])]
            : this.allowedRelayOrigins,
          this.fetchImpl,
          this.reasoningEffort,
        );
        outcome = await operation(brain);
      } catch (error) {
        if (!(error instanceof AgentBrainCallError) || error.delivery === 'outcome_unknown') {
          await this.runtimeGuard.record(context.modelSnapshot, permit, 'outcome_unknown');
        }
        throw error;
      }
      await this.runtimeGuard.record(context.modelSnapshot, permit, 'succeeded');
      return outcome;
    } finally {
      await this.runtimeGuard.release(permit);
    }
  }
}

function assertApprovedBinding(snapshot: AgentBrainModelSnapshot) {
  if (
    snapshot.adapter !== 'approved' ||
    !snapshot.runtime ||
    snapshot.runtime.adapter_key !== VERCEL_AI_AGENT_ADAPTER_KEY ||
    snapshot.runtime.endpoint_profile_key !== VERCEL_AI_AGENT_ENDPOINT_PROFILE_KEY ||
    !snapshot.protocol_family ||
    !snapshot.api_variant
  ) {
    throw new AgentBrainCallError('AGENT_BRAIN_ADAPTER_NOT_APPROVED', 'not_dispatched');
  }
  return snapshot.runtime;
}

function isNormalizedRelayApiBaseUrl(value: string): boolean {
  try {
    return normalizeRelayApiBaseUrl(value) === value;
  } catch {
    return false;
  }
}
