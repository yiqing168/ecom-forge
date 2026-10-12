import { randomUUID } from 'node:crypto';

import {
  agentBrainModelSnapshotSchema,
  type AgentBrainModelSnapshot,
  type AgentBrainStepInput,
} from '@ecom-forge/agent';
import type { Database } from '@ecom-forge/db';
import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';

import { ApprovedAgentBrainRouter } from './approved-agent-brain.router.js';

describe('ApprovedAgentBrainRouter', () => {
  it('classifies binding-store failure as not dispatched and never calls the Provider', async () => {
    const bindingFailure = new Error('database unavailable');
    const database = {
      query: {
        providerChannels: { findFirst: vi.fn().mockRejectedValue(bindingFailure) },
        providerCredentialVersions: { findFirst: vi.fn().mockRejectedValue(bindingFailure) },
      },
    } as unknown as Database;
    const fetchImpl = vi.fn<typeof fetch>();
    const router = new ApprovedAgentBrainRouter(
      database,
      {} as Redis,
      'agent-brain-router-test',
      `test-v1:${Buffer.alloc(32, 7).toString('base64url')}`,
      ['https://relay.test.invalid'],
      fetchImpl,
    );

    await expect(
      router.runStep(brainInput(), {
        abortSignal: new AbortController().signal,
        deadline: new Date(Date.now() + 10_000),
        idempotencyKey: 'router-test-idempotency-key',
        modelSnapshot: modelSnapshot(),
        requestedMaxOutputTokens: 256,
        traceId: randomUUID(),
      }),
    ).rejects.toMatchObject({
      message: 'AGENT_BRAIN_RUNTIME_BINDING_UNAVAILABLE',
      delivery: 'not_dispatched',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a channel and protocol-family mismatch before decrypting or dispatching', async () => {
    const validSnapshot = modelSnapshot();
    const runtime = validSnapshot.runtime;
    if (!runtime) throw new Error('Expected an approved runtime binding');
    const mismatchedSnapshot = {
      ...validSnapshot,
      protocol_family: 'anthropic',
      api_variant: 'anthropic_messages',
    } as AgentBrainModelSnapshot;
    const database = {
      query: {
        providerChannels: {
          findFirst: vi.fn().mockResolvedValue({
            id: runtime.provider_channel_id,
            provider: 'openai',
            status: 'active',
            revision: runtime.provider_channel_revision,
            adapterKey: runtime.adapter_key,
            endpointProfileKey: runtime.endpoint_profile_key,
            region: runtime.region,
            activeCredentialVersionId: runtime.credential_version_id,
            baseUrl: 'https://relay.test.invalid',
          }),
        },
        providerCredentialVersions: {
          findFirst: vi.fn().mockResolvedValue({
            id: runtime.credential_version_id,
            providerChannelId: runtime.provider_channel_id,
            status: 'active',
            validationEvidenceDigest: 'a'.repeat(64),
          }),
        },
      },
    } as unknown as Database;
    const fetchImpl = vi.fn<typeof fetch>();
    const router = new ApprovedAgentBrainRouter(
      database,
      {} as Redis,
      'agent-brain-router-test',
      `test-v1:${Buffer.alloc(32, 7).toString('base64url')}`,
      ['https://relay.test.invalid'],
      fetchImpl,
    );

    await expect(
      router.runStep(brainInput(), {
        abortSignal: new AbortController().signal,
        deadline: new Date(Date.now() + 10_000),
        idempotencyKey: 'router-test-idempotency-key',
        modelSnapshot: mismatchedSnapshot,
        requestedMaxOutputTokens: 256,
        traceId: randomUUID(),
      }),
    ).rejects.toMatchObject({ delivery: 'not_dispatched' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

function brainInput(): AgentBrainStepInput {
  return {
    execution_format: 'transcript_v1',
    current_message: '生成一张商品图',
    authorized_images: [],
    skill_selection: {
      primary_skill_id: 'creative-free-generation@1.0.1',
      default_output_count: 1,
      primary_name: '自由创作',
      preset_names: [],
      required_capabilities: ['image.generate'],
    },
    loaded_skills: [],
    required_auxiliary_catalog: [],
    optional_auxiliary_catalog: [],
    observations: [],
    enabled_tools: [],
    remaining_budget: { rounds: 1, tool_calls: 0, input_tokens: 32_000, output_tokens: 4_096 },
  };
}

function modelSnapshot() {
  return agentBrainModelSnapshotSchema.parse({
    snapshot_id: randomUUID(),
    adapter: 'approved',
    provider: 'openai',
    protocol_family: 'openai',
    api_variant: 'openai_responses',
    model_id: 'gpt-5-mini',
    version: '2025-08-07',
    status: 'poc_passed',
    status_evidence_digest: 'a'.repeat(64),
    capability_contract: {
      schema_version: 1,
      contract_kind: 'agent_brain',
      capabilities: ['agent.brain'],
      input_modalities: ['text'],
      tool_protocol: 'native_function_calling',
      terminal_protocol: 'terminal_tools',
      supports_usage_tokens: true,
      max_context_tokens: 128_000,
      max_output_tokens: 8_192,
      max_tool_calls_per_response: 4,
    },
    pricing: {
      schema_version: 1,
      contract_kind: 'agent_brain_tokens',
      currency: 'CNY',
      request_base_cost_cny: '0.01',
      input_per_million_tokens_cny: '2.00',
      cached_input_per_million_tokens_cny: '1.00',
      output_per_million_tokens_cny: '8.00',
    },
    quota: {
      schema_version: 1,
      contract_kind: 'agent_brain',
      rpm: 60,
      concurrency: 4,
      hourly_budget_cny: '10.00',
      daily_budget_cny: '100.00',
      max_turn_llm_rounds: 6,
      max_turn_input_tokens: 96_000,
      max_turn_output_tokens: 8_192,
      max_turn_estimated_cost_cny: '0.15',
      terminal_timeout_ms: 45_000,
      circuit_sample_size: 20,
      circuit_failure_rate: '0.50',
      circuit_unknown_rate: '0.20',
      circuit_open_ms: 60_000,
    },
    runtime: {
      provider_channel_id: randomUUID(),
      provider_channel_revision: 1,
      adapter_key: 'vercel-ai-relay-v1',
      endpoint_profile_key: 'relay-v1',
      region: null,
      credential_version_id: randomUUID(),
    },
  });
}
