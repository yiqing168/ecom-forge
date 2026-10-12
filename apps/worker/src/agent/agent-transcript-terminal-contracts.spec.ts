import {
  agentConfirmedFactDependencySchema,
  mergeAuthoredPrompts,
  validateAgentTranscriptProtocol,
  verifyAgentTranscriptPayload,
  type AgentTranscriptItem,
  type AgentTranscriptItemContracts,
} from '@ecom-forge/agent';
import { canonicalSha256 } from '@ecom-forge/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  prepareTranscriptTerminalOutput,
  prepareTranscriptTerminalResult,
  transcriptTerminalContracts,
} from './agent-transcript-terminal-contracts.js';

const uuid = (id: number) => `eeeeeeee-eeee-4eee-8eee-${id.toString(16).padStart(12, '0')}`;
const usage = { input_tokens: 20, output_tokens: 30 };
const plan = {
  schema_version: 1,
  intent: { kind: 'creative_generate', confidence: 1 },
  skill_id: 'creative@1.0.0',
  source: 'chat',
  nodes: ['first', 'second'].map((key) => ({
    candidate_key: key,
    capability: 'image.generate',
    capability_version: 1,
    depends_on: [],
    input_bindings: [],
    params: {},
    expected_output: 'image',
  })),
};
const metadata = (id = 4, sequence = '1') => ({
  id: uuid(id),
  user_id: uuid(1),
  session_id: uuid(2),
  turn_id: uuid(3),
  continuation_no: 1,
  sequence_no: sequence,
  schema_version: 1 as const,
  source_message_id: null,
  source_trace_step_id: uuid(5),
  import_attempt_id: null,
  reply_to_item_id: null,
  call_ordinal: null,
  resource_dependencies_json: [],
  created_at: '2026-09-08T00:00:00.000Z',
});
const contracts: AgentTranscriptItemContracts = {
  userMessage: { schema: z.never() },
  legacyMessage: { schema: z.never() },
  hostContexts: [],
  calls: transcriptTerminalContracts,
  resourceDependencySchema: agentConfirmedFactDependencySchema,
};
function output(outcome: unknown, phase: 'planning' | 'authoring' = 'planning') {
  return prepareTranscriptTerminalOutput(
    { metadata: metadata(), outcome, phase, privatePayloadId: uuid(6) },
    contracts,
  );
}
function result(
  parent: AgentTranscriptItem,
  value: unknown,
  status: 'succeeded' | 'rejected' | 'unknown' | 'not_executed' = 'succeeded',
) {
  return prepareTranscriptTerminalResult(
    { metadata: metadata(7, '2'), parent, status, result: value },
    contracts,
  );
}

describe('terminal transcript capture', () => {
  it('stores native chat text without inventing a terminal tool or result', () => {
    const prepared = output({ type: 'chat_text', text: 'A direct answer.', usage });
    expect(prepared.item.payload_json).toEqual({
      schema_version: 1,
      type: 'assistant_output',
      mode: 'text',
      calls: [],
      text: 'A direct answer.',
    });
    expect(prepared.privatePayloads).toEqual([]);
    expect(
      validateAgentTranscriptProtocol(
        {
          scope: { user_id: uuid(1), session_id: uuid(2) },
          first_sequence_no: '1',
          require_closed: true,
          items: [prepared.item],
        },
        contracts,
      ).protocol_closed,
    ).toBe(true);
    expect(() => result(prepared.item, { type: 'message_published' })).toThrow();
  });

  it.each([
    [
      { type: 'respond', text: 'Original reply', usage },
      'agent_respond@1',
      { text: 'Original reply' },
    ],
    [
      { type: 'request_clarification', question: 'Which?', usage },
      'agent_request_clarification@1',
      { question: 'Which?' },
    ],
    [
      {
        type: 'request_clarification',
        question: 'Which?',
        suggestions: ['Second', 'First'],
        usage,
      },
      'agent_request_clarification@1',
      { question: 'Which?', suggestions: ['Second', 'First'] },
    ],
  ])('retains accepted arguments without adding usage: %j', (outcome, name, args) => {
    const prepared = output(outcome);
    expect(prepared.item.payload_json).toEqual({
      schema_version: 1,
      type: 'assistant_output',
      mode: 'terminal',
      calls: [
        {
          name,
          arguments: { type: 'inline', value: args },
          arguments_digest: canonicalSha256(args),
          provider_call_id: null,
        },
      ],
    });
    expect(prepared.privatePayloads).toEqual([]);
  });

  it.each(['candidate_plan', 'authoring_request'])(
    'retains %s as a private planning call',
    (type) => {
      const prepared = output({ type, plan, usage });
      expect(prepared.item.payload_json).toMatchObject({
        calls: [
          {
            name: 'agent_candidate_plan@1',
            arguments: { type: 'private_payload', kind: 'planning' },
          },
        ],
      });
      expect(prepared.privatePayloads[0]?.content_json).toEqual({ plan });
      expect(prepared.privatePayloads[0]?.content_digest).toBe(canonicalSha256({ plan }));
      expect(JSON.stringify(prepared.item)).not.toContain('creative_generate');
    },
  );

  it('keeps the original authoring order and text beyond the envelope limit', () => {
    const authored = {
      prompts: [
        { candidate_key: 'second', creative_prompt: 'Second original prompt. '.repeat(3200) },
        { candidate_key: 'first', creative_prompt: 'First original prompt.' },
      ].map((prompt) => ({ ...prompt, creative_prompt: prompt.creative_prompt.trim() })),
    };
    const prepared = output(
      {
        type: 'candidate_plan',
        plan: mergeAuthoredPrompts(plan, authored),
        usage,
        authoring_output: {
          name: 'agent_author_prompts@1',
          arguments: authored,
          provider_call_id: 'original_call',
        },
      },
      'authoring',
    );
    const envelope = prepared.item.payload_json;
    expect(envelope.type).toBe('assistant_output');
    if (envelope.type !== 'assistant_output') throw new Error('fixture');
    expect(envelope.calls[0]).toMatchObject({
      name: 'agent_author_prompts@1',
      provider_call_id: 'original_call',
    });
    const record = prepared.privatePayloads[0]!;
    expect(record.byte_size).toBeGreaterThan(65_536);
    expect(Buffer.byteLength(JSON.stringify(envelope))).toBeLessThan(1000);
    const restored = verifyAgentTranscriptPayload(
      {
        scope: { user_id: uuid(1), session_id: uuid(2), turn_id: uuid(3), import_attempt_id: null },
        reference: envelope.calls[0]!.arguments,
        record,
      },
      { kind: 'authoring', contentSchema: transcriptTerminalContracts[4]!.arguments.schema },
    );
    expect(restored).toEqual(authored);
    expect(Object.isFrozen(record.content_json)).toBe(true);
  });

  it.each([
    { type: 'candidate_plan', plan, usage },
    { type: 'authoring_request', plan, usage },
    { type: 'respond', text: 'Missing original authoring', usage },
  ])('never reconstructs missing authoring in authoring phase: %j', (outcome) => {
    expect(() => output(outcome, 'authoring')).toThrow('AGENT_TRANSCRIPT_TERMINAL_INVALID');
  });

  it('refuses to relabel an authoring output as direct planning', () => {
    const authored = {
      prompts: plan.nodes.map((node) => ({
        candidate_key: node.candidate_key,
        creative_prompt: node.candidate_key,
      })),
    };
    expect(() =>
      output({
        type: 'candidate_plan',
        plan: mergeAuthoredPrompts(plan, authored),
        usage,
        authoring_output: {
          name: 'agent_author_prompts@1',
          arguments: authored,
          provider_call_id: null,
        },
      }),
    ).toThrow('AGENT_TRANSCRIPT_TERMINAL_INVALID');
  });

  it.each([
    { type: 'tool_calls', calls: [{ call_id: 'one', name: 'load_skill@1', arguments: {} }], usage },
    {
      type: 'invalid_tool_input',
      error_code: 'AGENT_BRAIN_TOOL_INPUT_INVALID',
      tool: 'agent_respond',
      paths: ['text'],
      usage,
    },
    { type: 'respond', text: 'Reply', raw_provider_response: 'private', usage },
    { type: 'candidate_plan', plan: { ...plan, nodes: [plan.nodes[0], plan.nodes[0]] }, usage },
  ])('does not capture invalid or nonterminal outputs as accepted calls: %j', (outcome) => {
    expect(() => output(outcome)).toThrow('AGENT_TRANSCRIPT_TERMINAL_INVALID');
  });

  it('closes an answer with a real-message receipt, not the answer text again', () => {
    const parent = output({ type: 'respond', text: 'Reply', usage }).item;
    const receipt = {
      type: 'message_published',
      message_id: uuid(8),
      content_digest: canonicalSha256({ text: 'Reply' }),
    };
    const item = result(parent, receipt);
    expect(item.payload_json).toMatchObject({ result: { value: receipt } });
    expect(() =>
      validateAgentTranscriptProtocol(
        {
          scope: { user_id: uuid(1), session_id: uuid(2) },
          items: [parent, item],
          first_sequence_no: '1',
          require_closed: true,
        },
        contracts,
      ),
    ).not.toThrow();
  });

  it('allows only the exact original draft digest in an authoring handoff', () => {
    const parent = output({ type: 'authoring_request', plan, usage }).item;
    expect(
      result(parent, { type: 'authoring_required', plan_digest: canonicalSha256({ plan }) }),
    ).toBeDefined();
    expect(() =>
      result(parent, { type: 'authoring_required', plan_digest: canonicalSha256(plan) }),
    ).toThrow();
    expect(() => result(parent, { type: 'workflow_started', workflow_run_id: uuid(9) })).toThrow();
  });

  it('pairs a compiler scope clarification with the accepted authoring call', () => {
    const authored = {
      prompts: plan.nodes.map((node) => ({
        candidate_key: node.candidate_key,
        creative_prompt: 'An original creative direction.',
      })),
    };
    const parent = output(
      {
        type: 'candidate_plan',
        plan: mergeAuthoredPrompts(plan, authored),
        usage,
        authoring_output: {
          name: 'agent_author_prompts@1',
          arguments: authored,
          provider_call_id: null,
        },
      },
      'authoring',
    ).item;
    const receipt = result(parent, {
      type: 'scope_confirmation_requested',
      confirmation_id: uuid(8),
      payload_digest: 'a'.repeat(64),
      scope_digest: 'b'.repeat(64),
    });
    expect(receipt.payload_json).toMatchObject({ name: 'agent_author_prompts@1' });
    expect(() =>
      validateAgentTranscriptProtocol(
        {
          scope: { user_id: uuid(1), session_id: uuid(2) },
          items: [parent, receipt],
          first_sequence_no: '1',
          require_closed: true,
        },
        contracts,
      ),
    ).not.toThrow();
    expect(() =>
      result(parent, {
        type: 'confirmation_requested',
        confirmation_id: uuid(8),
        payload_digest: 'a'.repeat(64),
      }),
    ).toThrow();
  });

  it('refuses to associate a different published answer with the same call', () => {
    const parent = output({ type: 'respond', text: 'Original reply', usage }).item;
    expect(() =>
      result(parent, {
        type: 'message_published',
        message_id: uuid(8),
        content_digest: canonicalSha256({ text: 'Different reply' }),
      }),
    ).toThrow('AGENT_TRANSCRIPT_TERMINAL_INVALID');
  });

  it('retains the existing NFC-only public text normalization', () => {
    const parent = output({ type: 'respond', text: 'Cafe\u0301', usage }).item;
    expect(() =>
      result(parent, {
        type: 'message_published',
        message_id: uuid(8),
        content_digest: canonicalSha256({ text: 'Caf\u00e9' }),
      }),
    ).not.toThrow();
  });

  it.each([
    ['rejected', { public_error_code: 'AGENT_TOOL_NOT_ALLOWED' }],
    ['unknown', { public_error_code: 'AGENT_MODEL_UNAVAILABLE' }],
    ['not_executed', { reason: 'turn_interrupted' }],
  ] as const)('keeps %s distinct from success', (status, value) => {
    const parent = output({ type: 'respond', text: 'Reply', usage }).item;
    expect(result(parent, value, status).payload_json).toMatchObject({ status });
    expect(() => result(parent, { ...value, prompt: 'private' }, status)).toThrow();
  });

  it.each([
    { continuation_no: 0 },
    { sequence_no: '1' },
    { turn_id: uuid(19) },
    { user_id: uuid(20) },
    { session_id: uuid(21) },
    { source_trace_step_id: uuid(22) },
    { source_message_id: uuid(23) },
  ])('refuses a mismatched result position/source: %j', (overrides) => {
    const parent = output({ type: 'respond', text: 'Reply', usage }).item;
    expect(() =>
      prepareTranscriptTerminalResult(
        {
          metadata: { ...metadata(7, '2'), ...overrides },
          parent,
          status: 'rejected',
          result: { public_error_code: 'AGENT_TOOL_NOT_ALLOWED' },
        },
        contracts,
      ),
    ).toThrow();
  });
});
