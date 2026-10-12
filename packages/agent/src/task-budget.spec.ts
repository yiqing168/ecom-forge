import { describe, expect, it } from 'vitest';
import { agentTaskBudget } from './task-budget.js';

const defaults = { baseRounds: 6, stepOutputTokens: 8192, maxOutputTokens: 44 * 8192 };

describe('task-sized output budget', () => {
  it.each([
    [1, 6, 49152],
    [2, 8, 65536],
    [4, 12, 98304],
    [9, 22, 180224],
  ])(
    'allocates %i independent inputs enough authoring and three repair rounds',
    (count, rounds, tokens) => {
      const budget = agentTaskBudget({ ...defaults, attachmentCount: count, nodeCount: count });
      expect(budget).toEqual({
        units: count,
        rounds,
        toolCalls: 12 + count - 1,
        outputTokens: tokens,
      });
      expect(rounds).toBeGreaterThanOrEqual(count + 1 + count + 3);
    },
  );
  it('allocates by accepted node count when one source requests several variants', () => {
    expect(agentTaskBudget({ ...defaults, attachmentCount: 1, nodeCount: 9 })).toMatchObject({
      units: 9,
      rounds: 14,
    });
  });
  it.each([1, 2, 3, 4])(
    'permits sequential inspection for a model with %i-call batch capacity',
    (inspectionBatchSize) => {
      const budget = agentTaskBudget({ ...defaults, attachmentCount: 9, inspectionBatchSize });
      expect(budget.rounds).toBe(9 + 1 + 9 + 3);
    },
  );
  it.each([0, 5, 1.5, NaN])('rejects illegal inspection batch size %s', (inspectionBatchSize) => {
    expect(() => agentTaskBudget({ ...defaults, attachmentCount: 9, inspectionBatchSize })).toThrow(
      'AGENT_TASK_BUDGET_INVALID',
    );
  });
  it('does not allocate for an unbounded session history', () => {
    expect(agentTaskBudget({ ...defaults, attachmentCount: 0 })).toEqual({
      units: 1,
      rounds: 6,
      toolCalls: 12,
      outputTokens: 49152,
    });
  });
  it('honors smaller model output and an operator ceiling', () => {
    expect(
      agentTaskBudget({ ...defaults, attachmentCount: 9, stepOutputTokens: 2048 }),
    ).toMatchObject({ outputTokens: 45056 });
    expect(
      agentTaskBudget({ ...defaults, attachmentCount: 9, maxOutputTokens: 10000 }),
    ).toMatchObject({ outputTokens: 10000 });
  });
  it.each([-1, 33, 1.5, NaN])('rejects illegal task size %s', (attachmentCount) => {
    expect(() => agentTaskBudget({ ...defaults, attachmentCount })).toThrow(
      'AGENT_TASK_BUDGET_INVALID',
    );
  });
  it('budgets authorized historical images without allocating from unlimited message history', () => {
    expect(agentTaskBudget({ ...defaults, attachmentCount: 0, inspectionCount: 9 })).toMatchObject({
      units: 9,
      rounds: 22,
      toolCalls: 20,
    });
  });
  it.each([-1, 35, 1.5, NaN])('rejects an invalid bounded visual set %s', (inspectionCount) => {
    expect(() => agentTaskBudget({ ...defaults, attachmentCount: 0, inspectionCount })).toThrow(
      'AGENT_TASK_BUDGET_INVALID',
    );
  });
});
