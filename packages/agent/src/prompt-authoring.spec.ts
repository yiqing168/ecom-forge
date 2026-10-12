import { describe, expect, it } from 'vitest';
import {
  authoredPromptsMatchPlan,
  mergeAuthoredPrompts,
  mergeAuthoredPromptBatch,
  authoringCandidateKeys,
} from './prompt-authoring.js';
import { parseAgentBrainStepOutcome } from './brain-contract.js';

const draft = {
  intent: { kind: 'raw_asset_generate' },
  nodes: [
    {
      candidate_key: 'a',
      input_bindings: ['image-a'],
      capability: 'image.edit',
      params: { output_count: 1, aspect_ratio: '3:4' },
    },
    {
      candidate_key: 'b',
      input_bindings: ['image-b'],
      capability: 'image.edit',
      params: { output_count: 1, aspect_ratio: '1:1' },
    },
  ],
};

describe('prompt authoring handoff', () => {
  it('merges checkpoints without modifying bindings, counts or previously accepted prompts', () => {
    const first = mergeAuthoredPromptBatch(
      draft,
      { prompts: [{ candidate_key: 'a', creative_prompt: 'First.' }] },
      ['a'],
    );
    const final = mergeAuthoredPromptBatch(
      first,
      { prompts: [{ candidate_key: 'b', creative_prompt: 'Second.' }] },
      ['b'],
    );
    expect(final).toEqual(
      mergeAuthoredPrompts(draft, {
        prompts: [
          { candidate_key: 'a', creative_prompt: 'First.' },
          { candidate_key: 'b', creative_prompt: 'Second.' },
        ],
      }),
    );
    expect(authoringCandidateKeys(draft)).toEqual(['a', 'b']);
    expect(draft.nodes[0]!.params).not.toHaveProperty('creative_prompt');
  });
  it.each(['missing', 'extra', 'repeat', 'wrong'])('rejects %s batch coverage', (variant) => {
    const prompts =
      variant === 'missing'
        ? []
        : variant === 'extra'
          ? [
              { candidate_key: 'a', creative_prompt: 'A' },
              { candidate_key: 'b', creative_prompt: 'B' },
            ]
          : variant === 'repeat'
            ? [
                { candidate_key: 'a', creative_prompt: 'A' },
                { candidate_key: 'a', creative_prompt: 'B' },
              ]
            : [{ candidate_key: 'b', creative_prompt: 'Wrong node' }];
    expect(() => mergeAuthoredPromptBatch(draft, { prompts }, ['a'])).toThrow();
  });
  const authored = {
    prompts: [
      { candidate_key: 'b', creative_prompt: 'Second source.' },
      { candidate_key: 'a', creative_prompt: 'First source.' },
    ],
  };
  const accepted = {
    type: 'candidate_plan',
    plan: mergeAuthoredPrompts(draft, authored),
    authoring_output: {
      name: 'agent_author_prompts@1',
      arguments: authored,
      provider_call_id: 'original_call',
    },
    usage: { input_tokens: 20, output_tokens: 6 },
  };

  it.each(['omitted', 'duplicate', 'unknown', 'mismatched_text'])(
    'rejects %s prompt evidence even when the merged plan is valid',
    (variant) => {
      const prompts =
        variant === 'omitted'
          ? authored.prompts.slice(1)
          : variant === 'duplicate'
            ? [authored.prompts[0], authored.prompts[0]]
            : authored.prompts.map((prompt, index) =>
                index === 0
                  ? {
                      ...prompt,
                      ...(variant === 'unknown'
                        ? { candidate_key: 'c' }
                        : { creative_prompt: 'Not executed text.' }),
                    }
                  : prompt,
              );
      expect(() =>
        parseAgentBrainStepOutcome({
          ...accepted,
          authoring_output: {
            ...accepted.authoring_output,
            arguments: { prompts },
          },
        }),
      ).toThrow('AGENT_BRAIN_OUTPUT_INVALID');
    },
  );

  it.each([
    { name: 'agent_candidate_plan@1' },
    { provider_call_id: 'https://secret.test.invalid/prompt' },
    { provider_call_id: 'x'.repeat(129) },
    { provider_call_id: '' },
    { extra_prompt: 'private' },
  ])('rejects invalid original call metadata', (changes) => {
    expect(() =>
      parseAgentBrainStepOutcome({
        ...accepted,
        authoring_output: {
          ...accepted.authoring_output,
          ...changes,
        },
      }),
    ).toThrow('AGENT_BRAIN_OUTPUT_INVALID');
  });

  it('keeps direct planning and legacy outcomes compatible without inventing authoring evidence', () => {
    const direct = { type: 'candidate_plan', plan: accepted.plan, usage: accepted.usage };
    expect(parseAgentBrainStepOutcome(direct)).toEqual(direct);
  });

  it('accepts null provider identity and never treats it as an execution identity', () => {
    const value = {
      ...accepted,
      authoring_output: { ...accepted.authoring_output, provider_call_id: null },
    };
    expect(parseAgentBrainStepOutcome(value)).toEqual(value);
  });

  it('retains long multi-line authored prompts without a storage-driven character cut', () => {
    const long = {
      prompts: authored.prompts.map((prompt) => ({
        ...prompt,
        creative_prompt: 'Material, light and composition.\n'.repeat(4000).trim(),
      })),
    };
    const value = {
      ...accepted,
      plan: mergeAuthoredPrompts(draft, long),
      authoring_output: { ...accepted.authoring_output, arguments: long },
    };
    expect(parseAgentBrainStepOutcome(value)).toEqual(value);
  });

  it('rejects malformed plans and missing final prompts rather than accepting self-declared evidence', () => {
    for (const plan of [{}, draft, { nodes: [] }]) {
      expect(authoredPromptsMatchPlan(plan, authored)).toBe(false);
      expect(() => parseAgentBrainStepOutcome({ ...accepted, plan })).toThrow(
        'AGENT_BRAIN_OUTPUT_INVALID',
      );
    }
  });

  it('preserves original authoring order through Brain outcome validation', () => {
    const authored = {
      prompts: [
        { candidate_key: 'b', creative_prompt: 'Second image, first in the model output.' },
        { candidate_key: 'a', creative_prompt: 'First image, last in the model output.' },
      ],
    };
    const outcome = {
      type: 'candidate_plan',
      plan: mergeAuthoredPrompts(draft, authored),
      authoring_output: {
        name: 'agent_author_prompts@1',
        arguments: authored,
        provider_call_id: 'call_original',
      },
      usage: { input_tokens: 20, cached_input_tokens: 8, output_tokens: 6 },
    };
    expect(parseAgentBrainStepOutcome(outcome)).toEqual(outcome);
  });

  it('merges by identity, retaining source order and operational decisions', () => {
    const before = structuredClone(draft);
    expect(
      mergeAuthoredPrompts(draft, {
        prompts: [
          { candidate_key: 'b', creative_prompt: 'Keep product B unchanged.' },
          { candidate_key: 'a', creative_prompt: 'Interpret photo A using its selected Skill.' },
        ],
      }),
    ).toEqual({
      ...draft,
      nodes: draft.nodes.map((node, index) => ({
        ...node,
        params: {
          ...node.params,
          creative_prompt:
            index === 0
              ? 'Interpret photo A using its selected Skill.'
              : 'Keep product B unchanged.',
        },
      })),
    });
    expect(draft).toEqual(before);
  });

  it.each([
    { prompts: [{ candidate_key: 'a', creative_prompt: 'Only one' }] },
    {
      prompts: [
        { candidate_key: 'a', creative_prompt: 'First' },
        { candidate_key: 'a', creative_prompt: 'Duplicate' },
      ],
    },
    {
      prompts: [
        { candidate_key: 'a', creative_prompt: 'First' },
        { candidate_key: 'c', creative_prompt: 'Unknown node' },
      ],
    },
  ])('rejects missing, duplicate or unknown nodes: %j', (authored) => {
    expect(() => mergeAuthoredPrompts(draft, authored)).toThrow();
  });

  it('rejects author attempts to change image bindings', () => {
    expect(() =>
      mergeAuthoredPrompts(draft, {
        prompts: [
          { candidate_key: 'a', creative_prompt: 'Valid', input_bindings: ['other-user-image'] },
        ],
      }),
    ).toThrow();
  });
});
