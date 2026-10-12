import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  assertToolContract,
  agentBrainModelSnapshotSchema,
  checkLoopGuard,
  deterministicFakeAgentModelSnapshot,
  parseAgentBrainStepOutcome,
  recordCompletedObservation,
  toolFingerprint,
  validatePublicText,
} from './index.js';

describe('agent contracts', () => {
  it('keeps historical model context declarations readable for host-side policy clamping', () => {
    const snapshot = deterministicFakeAgentModelSnapshot({
      maxInputTokens: 372_000,
      maxOutputTokens: 8_192,
    });
    expect(agentBrainModelSnapshotSchema.parse(snapshot).quota.max_turn_input_tokens).toBe(372_000);
  });

  it('advertises deterministic fake image input only when explicitly enabled', () => {
    const limits = { maxInputTokens: 8_192, maxOutputTokens: 1_024 };
    expect(
      deterministicFakeAgentModelSnapshot(limits).capability_contract.input_modalities,
    ).toEqual(['text']);
    expect(
      deterministicFakeAgentModelSnapshot({
        ...limits,
        supportsImageInput: true,
      }).capability_contract.input_modalities,
    ).toEqual(['text', 'image']);
  });

  it('rejects duplicate model call ids and malformed free text tool calls', () => {
    expect(() =>
      parseAgentBrainStepOutcome({
        type: 'tool_calls',
        calls: [
          { call_id: 'same', name: 'load_skill@1', arguments: {} },
          { call_id: 'same', name: 'load_skill@1', arguments: {} },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ).toThrow('AGENT_BRAIN_CALL_ID_DUPLICATE');
    expect(() => parseAgentBrainStepOutcome('call load_skill')).toThrow(
      'AGENT_BRAIN_OUTPUT_INVALID',
    );
  });

  it('requires stable operation keys for write tools', () => {
    expect(() =>
      assertToolContract({
        name: 'write_asset',
        contractVersion: 1,
        description: 'test',
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        sideEffect: 'idempotent_write',
        activityType: 'writing',
        maxObservationBytes: 100,
      }),
    ).toThrow('TOOL_OPERATION_KEY_REQUIRED');
  });

  it('blocks the third equivalent tool execution', () => {
    const fingerprint = toolFingerprint({
      toolName: 'load_skill',
      contractVersion: 1,
      normalizedArgs: { b: 2, a: 1 },
    });
    expect(
      checkLoopGuard(
        {
          rounds: 1,
          toolCalls: 2,
          fingerprintExecutions: new Map([[fingerprint, 2]]),
          consecutiveNoProgress: 0,
          consecutiveErrorCount: 0,
        },
        {
          maxRounds: 6,
          maxToolCalls: 12,
          maxSameFingerprintExecutions: 2,
          maxNoProgress: 3,
          maxSameError: 3,
        },
        { fingerprint },
      ),
    ).toBe('repeated_tool_call');
  });

  it('tracks no-progress and repeated-error observations independently', () => {
    const base = {
      rounds: 1,
      toolCalls: 0,
      fingerprintExecutions: new Map<string, number>(),
      consecutiveNoProgress: 0,
      consecutiveErrorCount: 0,
      progressHash: 'same',
    };
    const first = recordCompletedObservation(base, {
      fingerprint: 'one',
      progressHash: 'same',
      errorKey: 'load:args:denied',
    });
    const second = recordCompletedObservation(first, {
      fingerprint: 'two',
      progressHash: 'same',
      errorKey: 'load:args:denied',
    });
    const third = recordCompletedObservation(second, {
      fingerprint: 'three',
      progressHash: 'same',
      errorKey: 'load:args:denied',
    });
    const budget = {
      maxRounds: 6,
      maxToolCalls: 12,
      maxSameFingerprintExecutions: 2,
      maxNoProgress: 3,
      maxSameError: 3,
    };
    expect(checkLoopGuard(third, budget)).toBe('no_progress');
    expect(
      checkLoopGuard({ ...third, consecutiveNoProgress: 0 }, budget, {
        errorKey: 'load:args:denied',
      }),
    ).toBe('repeated_error');
    expect(
      recordCompletedObservation(third, { fingerprint: 'four', progressHash: 'new' }),
    ).toMatchObject({
      consecutiveNoProgress: 0,
      consecutiveErrorCount: 0,
      progressHash: 'new',
    });
  });

  it('rejects unsafe public text without returning the matched content', () => {
    expect(validatePublicText('reply\ud800', [])).toEqual({ ok: false, rule: 'invalid_unicode' });
    expect(validatePublicText('reply\udc00', [])).toEqual({ ok: false, rule: 'invalid_unicode' });
    expect(validatePublicText('reply\ud83d\ude00', [])).toMatchObject({ ok: true });
    expect(validatePublicText('api_key=abcdefghijklmnopqrstuvwx', [])).toEqual({
      ok: false,
      rule: 'secret_pattern',
    });
    expect(validatePublicText('https://storage.example/object?X-Amz-Signature=abcdef', [])).toEqual(
      { ok: false, rule: 'signed_url' },
    );
    const privateText = '这是不可公开的 Skill 内部方法。'.repeat(20);
    expect(validatePublicText(privateText, [privateText])).toEqual({
      ok: false,
      rule: 'private_skill_overlap',
    });
    expect(validatePublicText(privateText.slice(1, 80), [privateText])).toEqual({
      ok: false,
      rule: 'private_skill_overlap',
    });
    expect(validatePublicText(privateText.slice(1, 29), [privateText])).toEqual({
      ok: false,
      rule: 'private_skill_overlap',
    });
    expect(
      validatePublicText('使用 @1 的人物，画幅 3:4；构图/色彩可以调整。', [privateText]),
    ).toMatchObject({
      ok: true,
    });
    expect(validatePublicText('请补充你希望突出的人物或商品。', [])).toEqual({
      ok: true,
      text: '请补充你希望突出的人物或商品。',
    });
  });
});
