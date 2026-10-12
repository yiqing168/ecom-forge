import type { AgentBrainStepOutcome } from '@ecom-forge/agent';
import { describe, expect, it, vi } from 'vitest';
import { validateAuthoringBatchOutcome } from './agent-authoring-outcome.js';

const usage = { input_tokens: 100, output_tokens: 50 };
const draft = {
  nodes: [
    { candidate_key: 'a', params: { creative_prompt: 'Accepted scene.', output_count: 1 } },
    { candidate_key: 'b', params: { output_count: 1 } },
  ],
};
function batch(
  prompts: Array<{ candidate_key: string; creative_prompt: string }>,
): AgentBrainStepOutcome {
  return {
    type: 'authoring_batch',
    authoring_output: {
      name: 'agent_author_prompts@1',
      arguments: { prompts },
      provider_call_id: 'call_b',
    },
    usage,
  };
}

describe('authoring validation before settlement', () => {
  it.each(
    [
      [],
      [{ candidate_key: 'unknown', creative_prompt: 'New scene.' }],
      [{ candidate_key: 'a', creative_prompt: 'New scene.' }],
      [
        { candidate_key: 'b', creative_prompt: 'New scene.' },
        { candidate_key: 'a', creative_prompt: 'Another scene.' },
      ],
      [
        { candidate_key: 'b', creative_prompt: 'New scene.' },
        { candidate_key: 'b', creative_prompt: 'New scene.' },
      ],
    ].map((prompts) => ({ prompts })),
  )('returns repairable feedback for invalid coverage: %j', async ({ prompts }) => {
    const check = vi.fn();
    const before = structuredClone(draft);
    const result = await validateAuthoringBatchOutcome({
      outcome: batch(prompts),
      draft,
      completedKeys: ['a'],
      rejectsRepeatedPrompt: check,
    });
    expect(result).toMatchObject({
      type: 'invalid_tool_input',
      tool: 'agent_author_prompts',
      usage,
    });
    expect(check).not.toHaveBeenCalled();
    expect(draft).toEqual(before);
  });
  it('repairs an exact duplicate only when the compiler rejects it', async () => {
    const check = vi.fn().mockResolvedValue(true);
    const result = await validateAuthoringBatchOutcome({
      outcome: batch([{ candidate_key: 'b', creative_prompt: 'Accepted scene.' }]),
      draft,
      completedKeys: ['a'],
      rejectsRepeatedPrompt: check,
    });
    expect(result).toMatchObject({ type: 'invalid_tool_input', usage });
    expect(result).not.toHaveProperty('authoring_output');
    expect(check).toHaveBeenCalledOnce();
    expect(draft.nodes[1]!.params).not.toHaveProperty('creative_prompt');
  });
  it('does not impose scene uniqueness on profiles that allow equal prompts', async () => {
    const outcome = batch([{ candidate_key: 'b', creative_prompt: 'Accepted scene.' }]);
    expect(
      await validateAuthoringBatchOutcome({
        outcome,
        draft,
        completedKeys: ['a'],
        rejectsRepeatedPrompt: () => false,
      }),
    ).toBe(outcome);
  });
  it('does not reject similar but distinct prompts or revalidate normal drafts', async () => {
    const outcome = batch([
      { candidate_key: 'b', creative_prompt: 'Accepted scene with a different source bend.' },
    ]);
    const check = vi.fn();
    expect(
      await validateAuthoringBatchOutcome({
        outcome,
        draft,
        completedKeys: ['a'],
        rejectsRepeatedPrompt: check,
      }),
    ).toBe(outcome);
    expect(check).not.toHaveBeenCalled();
  });
  it('does not turn missing host state into a model-output repair', async () => {
    await expect(
      validateAuthoringBatchOutcome({
        outcome: batch([{ candidate_key: 'b', creative_prompt: 'New scene.' }]),
        draft: undefined,
        completedKeys: [],
        rejectsRepeatedPrompt: vi.fn(),
      }),
    ).rejects.toThrow('AGENT_AUTHORING_DRAFT_MISSING');
  });
});
