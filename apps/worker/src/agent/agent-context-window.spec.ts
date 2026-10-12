import { deterministicFakeAgentModelSnapshot } from '@ecom-forge/agent';
import { describe, expect, it } from 'vitest';

import { WORKER_RUNTIME_DEFAULTS } from '../config/runtime-defaults.js';
import { AgentProcessorWorker } from '../processors/agent-processor.js';
import type { ClaimedAgentTurn } from './agent-turn.types.js';

function processor() {
  const worker = Object.create(AgentProcessorWorker.prototype) as AgentProcessorWorker;
  Object.assign(worker, { config: { ...WORKER_RUNTIME_DEFAULTS } });
  return worker;
}

describe('Agent context cost policy', () => {
  it('tells the model the same enlarged tool allowance that the multi-image loop enforces', () => {
    const snapshot = deterministicFakeAgentModelSnapshot({
      maxInputTokens: 272000,
      maxOutputTokens: 8192,
    });
    const claimed = {
      attachments: Array.from({ length: 9 }, () => ({})),
      modelSnapshot: snapshot,
      transcriptCaptureVersion: 1,
      transcriptGeneration: '1',
      effectiveSkillDefaultOutputCount: 1,
      requiredGenerationCapabilities: [],
      selection: {
        primary_skill_id: 'fixture@1.0.0',
        primary_name: 'Fixture',
        preset_selections: [],
        optional_auxiliary: [],
        required_auxiliary: [],
      },
      message: 'Create nine posters',
    } as unknown as ClaimedAgentTurn;
    const worker = processor();
    Object.assign(worker, { brainGenerationPreferences: () => undefined });
    const input = worker['brainInput'](
      claimed,
      [],
      [],
      undefined,
      {
        rounds: 3,
        toolCalls: 5,
        fingerprintExecutions: new Map(),
        consecutiveNoProgress: 0,
        consecutiveErrorCount: 0,
      },
      0,
      100,
    );
    expect(input.remaining_budget).toMatchObject({
      rounds: 19,
      tool_calls: 15,
      input_tokens: 272000,
      output_tokens: 180124,
      step_output_tokens: 8192,
    });
  });

  it('does not apply the obsolete six-round guard while preparing a multi-image session', async () => {
    const snapshot = deterministicFakeAgentModelSnapshot({
      maxInputTokens: 272000,
      maxOutputTokens: 8192,
    });
    const claimed = {
      attachments: Array.from({ length: 9 }, () => ({})),
      modelSnapshot: snapshot,
      transcriptCaptureVersion: 1,
      loopState: { rounds: 7 },
    } as ClaimedAgentTurn;
    const worker = processor();
    Object.assign(worker, {
      brain: { countInputTokens: () => Promise.resolve(220000) },
      brainInput: () => ({}),
    });
    await expect(worker['prepareSessionMemory'](claimed, 1, [], [], undefined)).resolves.toEqual({
      revision: 1,
    });
    claimed.loopState.rounds = 22;
    await expect(worker['prepareSessionMemory'](claimed, 1, [], [], undefined)).rejects.toThrow(
      'AGENT_BUDGET_EXCEEDED',
    );
  });
  it.each([1, 4, 9])(
    'publishes effective task-sized output for %i inputs without changing context or cost',
    (count) => {
      const snapshot = deterministicFakeAgentModelSnapshot({
        maxInputTokens: 272000,
        maxOutputTokens: 8192,
      });
      const claimed = {
        attachments: Array.from({ length: count }, () => ({})),
        modelSnapshot: snapshot,
      } as ClaimedAgentTurn;
      const budget = processor()['publicBudgets'](snapshot, claimed);
      expect(budget.max_output_tokens).toBe(budget.max_llm_rounds * 8192);
      expect(budget.context_window_tokens).toBe(272000);
      expect(processor()['turnCostBudget'](snapshot)).toBe('0.15');
      expect(snapshot.quota.max_turn_output_tokens).toBe(8192);
    },
  );
  it('clamps a historical larger model window to 272K without changing its snapshot', () => {
    const snapshot = deterministicFakeAgentModelSnapshot({
      maxInputTokens: 372_000,
      maxOutputTokens: 8_192,
    });
    const worker = processor();

    expect(worker['contextWindowTokens'](snapshot)).toBe(272_000);
    expect(worker['publicBudgets'](snapshot)).toMatchObject({
      context_window_tokens: 272_000,
      auto_compact_token_limit: 217_600,
      max_input_tokens: 272_000,
    });
    expect(snapshot.capability_contract.max_context_tokens).toBe(372_000);
    expect(snapshot.quota.max_turn_input_tokens).toBe(372_000);
  });
  it('uses the registered one-call batch limit when allocating a nine-image turn', () => {
    const snapshot = deterministicFakeAgentModelSnapshot({
      maxInputTokens: 272000,
      maxOutputTokens: 8192,
    });
    snapshot.capability_contract.max_tool_calls_per_response = 1;
    const claimed = {
      attachments: Array.from({ length: 9 }, () => ({})),
      modelSnapshot: snapshot,
    } as ClaimedAgentTurn;
    expect(processor()['publicBudgets'](snapshot, claimed)).toMatchObject({
      max_llm_rounds: 22,
      max_output_tokens: 22 * 8192,
    });
  });

  it('budgets nine historical image candidates with no new attachments', () => {
    const snapshot = deterministicFakeAgentModelSnapshot({
      maxInputTokens: 272000,
      maxOutputTokens: 8192,
    });
    const claimed = {
      attachments: [],
      sessionImageCandidates: Array.from({ length: 9 }, (_, index) => ({
        binding_key: `source:${index}`,
      })),
      modelSnapshot: snapshot,
    } as unknown as ClaimedAgentTurn;
    expect(processor()['publicBudgets'](snapshot, claimed)).toMatchObject({
      max_llm_rounds: 22,
      max_tool_calls: 20,
      context_window_tokens: 272000,
    });
  });

  it('respects a model window below the platform ceiling', () => {
    const snapshot = deterministicFakeAgentModelSnapshot({
      maxInputTokens: 128_000,
      maxOutputTokens: 8_192,
    });
    const worker = processor();

    expect(worker['contextWindowTokens'](snapshot)).toBe(128_000);
    expect(worker['publicBudgets'](snapshot).auto_compact_token_limit).toBe(102_400);
  });

  it('respects a lower frozen quota even when the model supports a larger window', () => {
    const snapshot = deterministicFakeAgentModelSnapshot({
      maxInputTokens: 272_000,
      maxOutputTokens: 8_192,
    });
    snapshot.quota.max_turn_input_tokens = 96_000;

    expect(processor()['contextWindowTokens'](snapshot)).toBe(96_000);
  });
});
