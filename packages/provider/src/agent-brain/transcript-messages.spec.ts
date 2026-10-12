import type { AgentBrainStepInput, AgentBrainTranscriptMessage } from '@ecom-forge/agent';
import { describe, expect, it } from 'vitest';

import { nativeTranscriptMessages } from './transcript-messages.js';

const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const callId = (n: number) => `call_${id(2).replaceAll('-', '')}_${n}`;
const current = { role: 'user' as const, content: 'Current request' };
const user: AgentBrainTranscriptMessage = {
  type: 'user_message',
  item_id: id(1),
  current: true,
  content: current.content,
  attachments: [],
};
const assistant: AgentBrainTranscriptMessage = {
  type: 'assistant_output',
  item_id: id(2),
  calls: [{ call_id: callId(0), name: 'inspect_image@1', arguments: { image_ref: 'source' } }],
};
const result: AgentBrainTranscriptMessage = {
  type: 'tool_result',
  item_id: id(3),
  call_id: callId(0),
  name: 'inspect_image@1',
  status: 'succeeded',
  result: { inspected: true },
};
const host: AgentBrainTranscriptMessage = {
  type: 'host_context',
  item_id: id(4),
  name: 'phase_changed@1',
  content: { phase: 'authoring' },
};
function project(messages: AgentBrainTranscriptMessage[]) {
  return nativeTranscriptMessages(
    { current_message: current.content, transcript_messages: messages } as AgentBrainStepInput,
    current,
  );
}

describe('native transcript wire projection', () => {
  it('replays opaque Google signatures outside tool arguments', () => {
    const provider_metadata = { google: { thoughtSignature: 'opaque-test-signature' } };
    expect(
      project([
        user,
        { ...assistant, calls: [{ ...assistant.calls[0]!, provider_metadata }] },
        result,
      ])[1],
    ).toMatchObject({
      content: [{ providerOptions: provider_metadata, input: { image_ref: 'source' } }],
    });
  });
  it('keeps public commentary beside the original knowledge calls on replay', () => {
    const messages = project([
      user,
      { ...assistant, commentary: 'I will inspect the selected source.' },
      result,
    ]);
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: [
        { type: 'text', text: 'I will inspect the selected source.' },
        { type: 'tool-call', toolCallId: callId(0), toolName: 'inspect_image' },
      ],
    });
  });
  it('preserves a prior native chat reply as an assistant message', () => {
    const messages = project([
      { type: 'assistant_text', item_id: id(8), text: 'Let us compare the two directions.' },
      user,
    ]);
    expect(messages).toEqual([
      { role: 'assistant', content: 'Let us compare the two directions.' },
      current,
    ]);
  });

  it('preserves the current user position, exact text, and native tool identity', () => {
    const messages = project([user, assistant, result, host]);
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'user']);
    expect(messages[0]).toEqual(current);
    expect(messages[1]).toMatchObject({
      content: [{ type: 'tool-call', toolCallId: callId(0), toolName: 'inspect_image' }],
    });
    expect(messages[2]).toMatchObject({
      content: [
        {
          type: 'tool-result',
          toolCallId: callId(0),
          toolName: 'inspect_image',
          output: { type: 'json', value: { inspected: true } },
        },
      ],
    });
    expect(messages[3]).toMatchObject({
      content: '<host_context name="phase_changed@1">{"phase":"authoring"}</host_context>',
    });
  });

  it('keeps results adjacent and in call order while preserving deferred event order', () => {
    const secondCall = { ...assistant.calls[0]!, call_id: callId(1) };
    const secondResult = { ...result, item_id: id(5), call_id: callId(1) };
    const laterUser: AgentBrainTranscriptMessage = {
      ...user,
      item_id: id(6),
      current: false,
      content: 'Later message',
    };
    const messages = project([
      user,
      { ...assistant, calls: [...assistant.calls, secondCall] },
      host,
      secondResult,
      laterUser,
      result,
    ]);
    expect(messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'user',
      'user',
    ]);
    expect(messages[2]).toMatchObject({ content: [{ toolCallId: callId(0) }] });
    expect(messages[3]).toMatchObject({ content: [{ toolCallId: callId(1) }] });
    expect(messages[5]).toEqual({ role: 'user', content: 'Later message' });
  });

  it.each(['rejected', 'unknown', 'not_executed'] as const)(
    'does not encode %s as success',
    (status) => {
      expect(project([user, assistant, { ...result, status }])[2]).toMatchObject({
        content: [{ output: { type: 'error-text' } }],
      });
    },
  );

  it('maps the persisted candidate envelope back to the native tool arguments', () => {
    const plan = { skill_id: 'creative-free-generation@1.0.1', nodes: [] };
    expect(
      project([
        user,
        {
          ...assistant,
          calls: [{ ...assistant.calls[0]!, name: 'agent_candidate_plan@1', arguments: { plan } }],
        },
        { ...result, name: 'agent_candidate_plan@1' },
      ])[1],
    ).toMatchObject({ content: [{ toolName: 'agent_candidate_plan', input: plan }] });
  });

  it.each([
    ['missing current', [assistant, result]],
    ['duplicate current', [user, { ...user, item_id: id(9) }]],
    ['different current content', [{ ...user, content: 'Changed' }]],
    ['unclosed batch', [user, assistant]],
    [
      'assistant text before tool batch closure',
      [
        user,
        assistant,
        { type: 'assistant_text', item_id: id(8), text: 'Premature reply' },
        result,
      ],
    ],
    ['orphan result', [user, result]],
    ['duplicate result', [user, assistant, result, { ...result, item_id: id(9) }]],
    ['wrong result name', [user, assistant, { ...result, name: 'load_skill@1' }]],
    [
      'unknown contract',
      [
        user,
        { ...assistant, calls: [{ ...assistant.calls[0]!, name: 'inspect_image@2' }] },
        result,
      ],
    ],
    ['second batch before closure', [user, assistant, { ...assistant, item_id: id(9) }]],
  ] as const)('rejects %s before dispatch', (_name, messages) => {
    expect(() => project([...messages] as AgentBrainTranscriptMessage[])).toThrow(
      'AGENT_BRAIN_TRANSCRIPT_INVALID',
    );
  });
});
