import { randomUUID } from 'node:crypto';

import { agentBrainModelSnapshotSchema } from '@ecom-forge/agent';
import { describe, expect, it, vi } from 'vitest';

import { AgentBrainPocService } from './agent-brain-poc.service.js';

function snapshot() {
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

function providerResponse(name: string, args: Record<string, unknown>) {
  return new Response(
    JSON.stringify({
      id: randomUUID(),
      status: 'completed',
      output: [
        {
          type: 'function_call',
          id: randomUUID(),
          call_id: randomUUID(),
          name,
          arguments: JSON.stringify(args),
        },
      ],
      usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 40 } },
    }),
    { status: 200 },
  );
}

function successfulResponses(finalReferencePath = 'references/visual-decision-method.md') {
  return [
    providerResponse('agent_respond', { text: '已理解。' }),
    providerResponse('agent_request_clarification', {
      question: '希望突出商品还是使用场景？',
      suggestions: ['突出商品', '突出场景'],
    }),
    providerResponse('agent_candidate_plan', {
      schema_version: 1,
      intent: { kind: 'creative_generate', confidence: 0.95 },
      skill_id: 'creative-free-generation@1.0.1',
      source: 'chat',
      nodes: [
        {
          candidate_key: 'generate-1',
          capability: 'image.generate',
          capability_version: 1,
          depends_on: [],
          input_bindings: [],
          params: {
            goal_summary: 'Create a product image',
            creative_prompt: 'Create a clean product image with a clear focal subject.',
            output_count: 1,
            output_count_source: 'skill_default',
          },
          expected_output: 'image',
        },
      ],
    }),
    providerResponse('load_skill', {
      skill_id: 'commerce-shared-visual@1.0.0',
      view: 'planning',
      reference_paths: [],
    }),
    providerResponse('load_skill', {
      skill_id: 'creative-free-generation@1.0.1',
      view: 'references',
      reference_paths: [finalReferencePath],
    }),
  ];
}

describe('Agent Brain PoC service', () => {
  it('requires all five fixed cases and emits only redacted usage/cost evidence', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    for (const response of successfulResponses()) fetchImpl.mockResolvedValueOnce(response);
    const report = await new AgentBrainPocService(['https://relay.test.invalid'], fetchImpl).run({
      apiKey: 'sk-test-key-123456',
      baseUrl: 'https://relay.test.invalid',
      snapshot: snapshot(),
      maxCalls: 5,
      timeoutMs: 10_000,
      traceId: randomUUID(),
    });
    expect(report).toMatchObject({
      status: 'passed',
      call_count: 5,
      total_actual_cost_cny: '0.05',
      cases: [
        { name: 'respond', status: 'passed', outcomeType: 'respond' },
        { name: 'clarification', status: 'passed', outcomeType: 'request_clarification' },
        { name: 'candidate_plan', status: 'passed', outcomeType: 'candidate_plan' },
        { name: 'tool_call', status: 'passed', outcomeType: 'tool_calls' },
        { name: 'reference_call', status: 'passed', outcomeType: 'tool_calls' },
      ],
    });
    expect(JSON.stringify(report)).not.toContain('已理解');
    expect(JSON.stringify(report)).not.toContain('sk-test-key');
    expect(report.evidence_digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('fails a wrong reference call but still accounts for the dispatched model cost', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    for (const response of successfulResponses('references/quality-check.md')) {
      fetchImpl.mockResolvedValueOnce(response);
    }
    const report = await new AgentBrainPocService(['https://relay.test.invalid'], fetchImpl).run({
      apiKey: 'sk-test-key-123456',
      baseUrl: 'https://relay.test.invalid',
      snapshot: snapshot(),
      maxCalls: 5,
      timeoutMs: 10_000,
      traceId: randomUUID(),
    });
    expect(report).toMatchObject({
      status: 'failed',
      call_count: 5,
      total_actual_cost_cny: '0.05',
      cases: [
        {},
        {},
        {},
        {},
        {
          name: 'reference_call',
          status: 'failed',
          actualCostCny: '0.01',
          usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20 },
        },
      ],
    });
  });

  it('stops after an outcome-unknown call and never spends the remaining allowance', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('connection reset'));
    const report = await new AgentBrainPocService(['https://relay.test.invalid'], fetchImpl).run({
      apiKey: 'sk-test-key-123456',
      baseUrl: 'https://relay.test.invalid',
      snapshot: snapshot(),
      maxCalls: 5,
      timeoutMs: 10_000,
      traceId: randomUUID(),
    });
    expect(report).toMatchObject({
      status: 'outcome_unknown',
      call_count: 1,
      total_actual_cost_cny: '0.00',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects an unbounded or incomplete call allowance before dispatch', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      new AgentBrainPocService(['https://relay.test.invalid'], fetchImpl).run({
        apiKey: 'sk-test-key-123456',
        baseUrl: 'https://relay.test.invalid',
        snapshot: snapshot(),
        maxCalls: 4,
        timeoutMs: 10_000,
        traceId: randomUUID(),
      }),
    ).rejects.toThrow(/CALL_LIMIT_INVALID/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
