import { agentBrainModelSnapshotSchema, type AgentBrainStepInput } from '@ecom-forge/agent';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { googleRelayApiBaseUrl } from '../relay-policy.js';
import { googleToolMetadata } from './google-protocol.js';
import { VercelAiAgentBrain } from './vercel-ai-agent-brain.js';

const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const signature = 'opaque-google-test-signature';
const nativeRequestSchema = z
  .object({
    generationConfig: z
      .object({
        maxOutputTokens: z.number().optional(),
        thinkingConfig: z.unknown().optional(),
      })
      .passthrough(),
    reasoning_effort: z.unknown().optional(),
    contents: z.array(
      z
        .object({
          role: z.string(),
          parts: z.array(z.record(z.string(), z.unknown())),
        })
        .passthrough(),
    ),
  })
  .passthrough();
function requestUrl(url: Parameters<typeof fetch>[0]): string {
  return typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
}
function requestBody(init: RequestInit | undefined) {
  if (typeof init?.body !== 'string') throw new Error('Expected a native JSON body');
  return nativeRequestSchema.parse(JSON.parse(init.body));
}
const input: AgentBrainStepInput = {
  execution_format: 'transcript_v1',
  current_message: 'Test request',
  authorized_images: [],
  skill_selection: {
    primary_skill_id: 'creative-free-generation@1.0.1',
    execution_policy: { version: 1, family: 'text_generation', max_sources: 9 },
    primary_name: 'Creation',
    default_output_count: 1,
    preset_names: [],
    required_capabilities: [],
  },
  loaded_skills: [],
  required_auxiliary_catalog: [],
  optional_auxiliary_catalog: [],
  observations: [],
  enabled_tools: [],
  remaining_budget: { rounds: 6, tool_calls: 12, input_tokens: 272000, output_tokens: 8192 },
};
function snapshot() {
  return agentBrainModelSnapshotSchema.parse({
    adapter: 'approved',
    provider: 'google',
    protocol_family: 'google',
    api_variant: 'google_generate_content',
    model_id: 'gemini-test',
    version: '1',
    status: 'poc_passed',
    status_evidence_digest: 'a'.repeat(64),
    runtime: {
      provider_channel_id: id(1),
      provider_channel_revision: 1,
      adapter_key: 'vercel-ai-agent-brain',
      endpoint_profile_key: 'relay',
      region: null,
      credential_version_id: id(2),
    },
    capability_contract: {
      schema_version: 1,
      contract_kind: 'agent_brain',
      capabilities: ['agent.brain'],
      input_modalities: ['text', 'image'],
      tool_protocol: 'native_function_calling',
      terminal_protocol: 'terminal_tools',
      supports_usage_tokens: true,
      max_context_tokens: 272000,
      max_output_tokens: 8192,
      max_tool_calls_per_response: 4,
    },
    pricing: {
      schema_version: 1,
      contract_kind: 'agent_brain_tokens',
      currency: 'CNY',
      request_base_cost_cny: '0.00',
      input_per_million_tokens_cny: '0.00',
      cached_input_per_million_tokens_cny: '0.00',
      output_per_million_tokens_cny: '0.00',
    },
    quota: {
      schema_version: 1,
      contract_kind: 'agent_brain',
      rpm: 60,
      concurrency: 4,
      hourly_budget_cny: '100.00',
      daily_budget_cny: '1000.00',
      max_turn_llm_rounds: 6,
      max_turn_input_tokens: 272000,
      max_turn_output_tokens: 8192,
      max_turn_estimated_cost_cny: '0.15',
      terminal_timeout_ms: 240000,
      circuit_sample_size: 20,
      circuit_failure_rate: '0.50',
      circuit_unknown_rate: '0.25',
      circuit_open_ms: 60000,
    },
  });
}
function context() {
  return {
    modelSnapshot: snapshot(),
    requestedMaxOutputTokens: 512,
    deadline: new Date(Date.now() + 60000),
    abortSignal: new AbortController().signal,
    idempotencyKey: 'google-test-idempotency',
    traceId: id(3),
  };
}
function response(name = 'agent_respond', args: unknown = { text: 'OK' }) {
  return {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [{ functionCall: { name, args }, thoughtSignature: signature }],
        },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: {
      promptTokenCount: 61,
      candidatesTokenCount: 16,
      thoughtsTokenCount: 83,
      totalTokenCount: 160,
    },
  };
}
function brain(fetchImpl: typeof fetch) {
  return new VercelAiAgentBrain(
    'test-google-key',
    'https://relay.test.invalid',
    ['https://relay.test.invalid'],
    fetchImpl,
    'medium',
  );
}

function continuationInput(): AgentBrainStepInput {
  return {
    ...input,
    current_message: 'Improve the first poster and remove the mound from the original photo.',
    prompt_authoring: true,
    skill_selection: {
      ...input.skill_selection,
      execution_policy: { version: 1, family: 'independent_sources', max_sources: 9 },
      required_capabilities: ['image.edit'],
    },
    authorized_images: Array.from({ length: 3 }, (_, index) => index + 1).flatMap((position) => {
      const common = {
        media_type: 'image/png' as const,
        bytes: new Uint8Array([position]),
        width: 32,
        height: 32,
        content_hash: 'a'.repeat(64),
        context_scope: 'session_candidate' as const,
        candidate_position: position,
        source_group: {
          message_id: id(10),
          created_at: '2026-10-09T00:00:00Z',
          is_latest_upload: true,
        },
      };
      return [
        {
          ...common,
          binding_key: `session-output-${position}`,
          role: 'edit_source' as const,
          candidate_kind: 'latest_output' as const,
          lineage_source_binding_keys: [`session-source-${position}`],
        },
        {
          ...common,
          binding_key: `session-source-${position}`,
          role: 'semantic_reference' as const,
          candidate_kind: 'original_source' as const,
          lineage_source_binding_keys: [],
        },
      ];
    }),
  };
}

describe('native Google Agent Brain', () => {
  it.each(['refine_latest', 'restart_original'] as const)(
    'guides the first invalid second-turn plan and accepts one corrected %s call',
    async (mode) => {
      const source = {
        mode,
        output_binding_key: 'session-output-1',
        ...(mode === 'restart_original' ? { original_source_binding_key: 'session-source-1' } : {}),
        reason_summary: 'Apply the requested change to the first poster.',
      };
      const plan = {
        intent: {
          kind: mode === 'refine_latest' ? 'chat_artifact_edit' : 'raw_asset_generate',
          confidence: 0.98,
        },
        source_decision: source,
        scope_decision: {
          mode: 'conversation_reference',
          reason_summary: 'The user refers to the first poster.',
        },
        nodes: [
          {
            input_bindings: [mode === 'refine_latest' ? 'session-output-1' : 'session-source-1'],
            params: {
              semantic_summary:
                'The first source contains a yellow mound to remove while strengthening the visible structure.',
              ...(mode === 'refine_latest'
                ? {
                    changed_items: ['Remove the mound and strengthen the concept.'],
                    preserved_items: ['Keep the photo subject and poster identity.'],
                  }
                : {}),
            },
          },
        ],
      };
      const missingOutput: Record<string, unknown> = { ...source };
      delete missingOutput.output_binding_key;
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify(
              response('agent_candidate_plan', {
                ...plan,
                source_decision: { ...missingOutput, PRIVATE_FIELD: 'PRIVATE_VALUE' },
                scope_decision: { mode: 'PRIVATE_MODE', reason_summary: '' },
                nodes: [{ input_bindings: plan.nodes[0]!.input_bindings, params: {} }],
              }),
            ),
          ),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify(response('agent_candidate_plan', plan))),
        );
      const adapter = brain(fetchImpl);
      const scene = continuationInput();
      const rejected = await adapter.runStep(scene, context());
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(rejected).toMatchObject({
        type: 'invalid_tool_input',
        usage: { input_tokens: 61, output_tokens: 99 },
      });
      if (rejected.type !== 'invalid_tool_input') throw new Error('Expected field diagnostics');
      expect(rejected.paths).toEqual(
        expect.arrayContaining([
          'source_decision.output_binding_key',
          'scope_decision.mode',
          'scope_decision.reason_summary',
          'nodes.0.params.semantic_summary',
        ]),
      );
      for (const text of [
        'refine_latest',
        'restart_original',
        'original_source_binding_key',
        'conversation_reference',
        'semantic_summary',
      ]) {
        expect(rejected.detail).toContain(text);
      }
      expect(rejected.detail!.length).toBeLessThanOrEqual(900);
      expect(rejected.detail).toContain('remove undeclared properties');
      for (const text of ['PRIVATE_FIELD', 'PRIVATE_VALUE', 'PRIVATE_MODE', 'invalid_union']) {
        expect(JSON.stringify(rejected)).not.toContain(text);
      }
      const repaired = await adapter.runStep(
        {
          ...scene,
          transcript_messages: [
            {
              type: 'user_message',
              item_id: id(20),
              current: true,
              content: scene.current_message,
              attachments: [],
            },
            {
              type: 'host_context',
              item_id: id(21),
              name: 'runtime_policy@1',
              content: {
                public_error_code: rejected.error_code,
                tool: rejected.tool,
                paths: rejected.paths,
                detail: rejected.detail,
                repair_attempt: 1,
                remaining_repair_attempts: 3,
                required_action: 'correct_tool_arguments_or_choose_allowed_action',
              },
            },
          ],
        },
        context(),
      );
      expect(repaired).toMatchObject({
        type: 'authoring_request',
        plan: { intent: plan.intent, source_decision: source, nodes: plan.nodes },
      });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const first = requestBody(fetchImpl.mock.calls[0]![1]);
      const second = requestBody(fetchImpl.mock.calls[1]![1]);
      expect(second.tools).toEqual(first.tools);
      const content = JSON.stringify(second.contents);
      expect(content).toContain('correct_tool_arguments_or_choose_allowed_action');
      const policyText = second.contents
        .flatMap((entry) => entry.parts)
        .map((part) => part.text)
        .find(
          (text): text is string =>
            typeof text === 'string' && text.startsWith('<host_context name="runtime_policy@1">'),
        );
      expect(policyText).toContain(JSON.stringify(rejected.detail));
      expect(content).toContain(
        'Allowed candidate intent.kind for this turn: chat_artifact_edit, raw_asset_generate',
      );
      expect(content).toContain('For refinement, bind only the selected latest_output edit_source');
      const candidateTool = (
        first.tools as Array<{
          functionDeclarations: Array<{
            name: string;
            parameters: { properties: Record<string, unknown> };
          }>;
        }>
      )[0]!.functionDeclarations.find((entry) => entry.name === 'agent_candidate_plan')!;
      const sourceSchema = candidateTool.parameters.properties.source_decision;
      expect(sourceSchema).toMatchObject({
        type: 'object',
        required: ['mode', 'output_binding_key', 'reason_summary'],
      });
      expect(sourceSchema).not.toHaveProperty('anyOf');
      expect(sourceSchema).not.toHaveProperty('oneOf');
    },
  );

  it.each([
    { decision: undefined, path: 'source_decision' },
    { decision: null, path: 'source_decision' },
    {
      decision: {
        mode: 'restart_original',
        output_binding_key: 'session-output-1',
        reason_summary: 'Start again.',
      },
      path: 'source_decision.original_source_binding_key',
    },
    {
      decision: {
        mode: 'refine_latest',
        output_binding_key: 'session-output-1',
        original_source_binding_key: 'session-source-1',
        reason_summary: 'Refine.',
      },
      path: 'source_decision.original_source_binding_key',
    },
    {
      decision: {
        mode: 'not-a-mode',
        output_binding_key: 'session-output-1',
        reason_summary: 'Refine.',
      },
      path: 'source_decision.mode',
    },
    {
      decision: {
        mode: 'refine_latest',
        output_binding_key: 'session-source-1',
        reason_summary: 'Refine.',
      },
      path: 'source_decision.output_binding_key',
    },
    {
      decision: {
        mode: 'restart_original',
        output_binding_key: 'session-output-1',
        original_source_binding_key: 'unowned-source',
        reason_summary: 'Start again.',
      },
      path: 'source_decision.original_source_binding_key',
    },
    {
      decision: {
        mode: 'refine_latest',
        output_binding_key: 'session-output-1',
        input_binding_key: 'session-source-1',
        reason_summary: 'Refine.',
      },
      path: 'source_decision',
    },
  ])(
    'rejects invalid source choices at $path without guessing a replacement',
    async ({ decision, path }) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify(
            response('agent_candidate_plan', {
              intent: { kind: 'raw_asset_generate', confidence: 0.9 },
              source_decision: decision,
              scope_decision: {
                mode: 'conversation_reference',
                reason_summary: 'The first poster.',
              },
              nodes: [
                {
                  input_bindings: ['session-source-1'],
                  params: { semantic_summary: 'A visible mound and its surroundings.' },
                },
              ],
            }),
          ),
        ),
      );
      const result = await brain(fetchImpl).runStep(continuationInput(), context());
      expect(result).toMatchObject({ type: 'invalid_tool_input', paths: [path] });
      expect(result).toHaveProperty('detail', expect.stringContaining('refine_latest'));
      expect(result).not.toHaveProperty('plan');
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );

  it('rejects a watercolor generation/edit intent conflict before authoring', async () => {
    const images = Array.from({ length: 3 }, (_, index) => ({
      binding_key: `asset:watercolor-${index + 1}`,
      role: 'semantic_reference' as const,
      media_type: 'image/png' as const,
      bytes: new Uint8Array([index]),
      width: 3,
      height: 4,
      content_hash: String(index).repeat(64),
      context_scope: 'current_attachment' as const,
    }));
    const args = {
      intent: { kind: 'creative_generate', confidence: 0.98 },
      nodes: images.map((image) => ({
        capability: 'image.edit',
        input_bindings: [image.binding_key],
        params: { semantic_summary: 'A source-specific watercolor comparison.' },
      })),
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(response('agent_candidate_plan', args))))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            response('agent_candidate_plan', {
              ...args,
              intent: { ...args.intent, kind: 'raw_asset_generate' },
            }),
          ),
        ),
      );
    const sceneInput: AgentBrainStepInput = {
      ...input,
      prompt_authoring: true,
      authorized_images: images,
      skill_selection: {
        ...input.skill_selection,
        primary_skill_id: 'watercolor-scene-collage@1.0.0',
        execution_policy: { version: 1, family: 'independent_sources', max_sources: 9 },
        required_capabilities: ['image.edit'],
      },
    };
    await expect(brain(fetchImpl).runStep(sceneInput, context())).resolves.toMatchObject({
      type: 'invalid_tool_input',
      paths: ['intent.kind'],
      detail: 'intent.kind: choose one of raw_asset_generate',
      usage: { input_tokens: 61, output_tokens: 99 },
    });
    await expect(brain(fetchImpl).runStep(sceneInput, context())).resolves.toMatchObject({
      type: 'authoring_request',
      plan: { intent: { kind: 'raw_asset_generate' }, nodes: args.nodes },
    });
  });

  it.each([
    ['https://relay.test.invalid', 'https://relay.test.invalid/v1beta'],
    ['https://relay.test.invalid/v1/', 'https://relay.test.invalid/v1beta'],
    ['https://relay.test.invalid/tenant/v1', 'https://relay.test.invalid/tenant/v1beta'],
    ['https://relay.test.invalid/tenant/v1beta', 'https://relay.test.invalid/tenant/v1beta'],
  ])('maps the discovery root %s to the native execution root', (base, expected) => {
    expect(googleRelayApiBaseUrl(base)).toBe(expected);
  });

  it('uses native authentication, keeps signatures, and counts thought tokens once', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(response()), { status: 200 }));
    const result = await brain(fetchImpl).runStep(input, context());
    expect(result).toMatchObject({
      type: 'respond',
      text: 'OK',
      provider_metadata: { google: { thoughtSignature: signature } },
      usage: { input_tokens: 61, output_tokens: 99, reasoning_output_tokens: 83 },
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(requestUrl(url)).toBe(
      'https://relay.test.invalid/v1beta/models/gemini-test:generateContent',
    );
    expect(new Headers(init?.headers).get('x-goog-api-key')).toBe('test-google-key');
    const body = requestBody(init);
    expect(body.generationConfig.maxOutputTokens).toBe(512);
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.generationConfig.thinkingConfig).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('streams native tools without producing contradictory output usage', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('data: ' + JSON.stringify(response()) + '\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    const result = await brain(fetchImpl).runStep(input, {
      ...context(),
      onPublicTextDraft: vi.fn(),
    });
    expect(result).toMatchObject({
      type: 'respond',
      usage: { output_tokens: 99, reasoning_output_tokens: 83 },
    });
    expect(requestUrl(fetchImpl.mock.calls[0]![0])).toContain(':streamGenerateContent');
  });

  it.each([signature, undefined])(
    'replays a call with signature %s without fabricating metadata',
    async (storedSignature) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify(response()), { status: 200 }));
      const callId = 'call_' + id(5).replaceAll('-', '') + '_0';
      await brain(fetchImpl).runStep(
        {
          ...input,
          transcript_messages: [
            {
              type: 'user_message',
              item_id: id(4),
              current: true,
              content: input.current_message,
              attachments: [],
            },
            {
              type: 'assistant_output',
              item_id: id(5),
              calls: [
                {
                  call_id: callId,
                  name: 'inspect_image@1',
                  arguments: { binding_key: 'source', detail: 'overview' },
                  ...(storedSignature
                    ? { provider_metadata: { google: { thoughtSignature: storedSignature } } }
                    : {}),
                },
              ],
            },
            {
              type: 'tool_result',
              item_id: id(6),
              call_id: callId,
              name: 'inspect_image@1',
              status: 'succeeded',
              result: { materialized: true },
            },
          ],
        },
        context(),
      );
      const body = requestBody(fetchImpl.mock.calls[0]![1]);
      const replay = body.contents.find((content) => content.role === 'model');
      expect(replay?.parts[0]).toMatchObject({
        functionCall: {
          name: 'inspect_image',
          args: { binding_key: 'source', detail: 'overview' },
        },
      });
      expect(replay?.parts[0]?.thoughtSignature).toBe(storedSignature);
      expect(JSON.stringify(body)).not.toContain('skip_thought_signature_validator');
    },
  );

  it('summarizes sessions on the same Google protocol', async () => {
    const summary = {
      goals: ['Continue creation'],
      confirmed_preferences: [],
      constraints: [],
      key_decisions: [],
      open_questions: [],
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify(response('agent_session_summary', summary)), { status: 200 }),
      );
    await expect(
      brain(fetchImpl).summarizeSession(
        { messages: [{ role: 'user', content: 'Continue' }] },
        context(),
      ),
    ).resolves.toMatchObject({ summary });
    expect(requestUrl(fetchImpl.mock.calls[0]![0])).toContain('/v1beta/');
  });

  it('retains the authoring call signature for checkpoint recovery', async () => {
    const authored = {
      prompts: [
        { candidate_key: 'source-one', creative_prompt: 'A source-specific visual brief.' },
      ],
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify(response('agent_author_prompts', authored)), { status: 200 }),
      );
    const outcome = await brain(fetchImpl).runStep(
      {
        ...input,
        prompt_authoring: true,
        authoring_plan: { nodes: [{ candidate_key: 'source-one', params: {} }] },
        authoring_candidate_keys: ['source-one'],
      },
      context(),
    );
    expect(outcome).toMatchObject({
      type: 'authoring_batch',
      authoring_output: {
        arguments: authored,
        provider_metadata: { google: { thoughtSignature: signature } },
      },
    });
  });

  it('keeps concurrent channels and credentials isolated', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify(response()), { status: 200 })),
      );
    const first = brain(fetchImpl);
    const second = new VercelAiAgentBrain(
      'second-test-key',
      'https://second.test.invalid/v1',
      ['https://second.test.invalid'],
      fetchImpl,
    );
    await Promise.all([first.runStep(input, context()), second.runStep(input, context())]);
    expect(
      fetchImpl.mock.calls.map(([url, init]) => ({
        url: requestUrl(url),
        key: new Headers(init?.headers).get('x-goog-api-key'),
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          url: 'https://relay.test.invalid/v1beta/models/gemini-test:generateContent',
          key: 'test-google-key',
        },
        {
          url: 'https://second.test.invalid/v1beta/models/gemini-test:generateContent',
          key: 'second-test-key',
        },
      ]),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry an unknown transport result', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('network failed'));
    await expect(brain(fetchImpl).runStep(input, context())).rejects.toMatchObject({
      message: 'AGENT_BRAIN_CALL_OUTCOME_UNKNOWN',
      delivery: 'outcome_unknown',
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each(['http', 'transport'] as const)(
    'does not log private request data or retry a streaming %s failure',
    async (failure) => {
      const privateMarker = 'synthetic-private-request-marker';
      const fetchImpl = vi.fn<typeof fetch>();
      if (failure === 'http') {
        fetchImpl.mockResolvedValue(
          new Response(
            JSON.stringify({
              error: { code: 400, message: privateMarker, status: 'INVALID_ARGUMENT' },
            }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          ),
        );
      } else {
        fetchImpl.mockRejectedValue(new TypeError(privateMarker));
      }
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        await expect(
          brain(fetchImpl).runStep(
            { ...input, current_message: privateMarker },
            { ...context(), onPublicTextDraft: vi.fn().mockResolvedValue(undefined) },
          ),
        ).rejects.toMatchObject({
          message: 'AGENT_BRAIN_CALL_OUTCOME_UNKNOWN',
          delivery: 'outcome_unknown',
          diagnostic: {
            code:
              failure === 'http'
                ? 'AGENT_BRAIN_PROVIDER_HTTP_FAILED'
                : 'AGENT_BRAIN_PROVIDER_OUTCOME_UNKNOWN',
          },
        });
        expect(errorLog).not.toHaveBeenCalled();
        expect(fetchImpl).toHaveBeenCalledOnce();
      } finally {
        errorLog.mockRestore();
      }
    },
  );

  it('extracts only the opaque Google signature, not unrelated provider data', () => {
    expect(
      googleToolMetadata({
        google: { thoughtSignature: signature, reasoning: 'private' },
        unrelated: 'secret',
      }),
    ).toEqual({ google: { thoughtSignature: signature } });
    expect(() =>
      googleToolMetadata({ google: { thoughtSignature: 'skip_thought_signature_validator' } }),
    ).toThrow();
  });
});
