import { describe, expect, it } from 'vitest';

import {
  buildApprovedImagePrompt,
  IMAGE_PROVIDER_WRAPPER,
  type ApprovedImagePromptInput,
} from './approved-image-prompt.js';
import { resolveCreativeExecutionProfile } from './creative-profiles.js';

describe('photo-line extension approved image prompt', () => {
  it.each([
    'A real source element crosses the divider continuously into delicate ink lines. Render no added figures and no text.',
    'A small figure walks along the path extending from the photo without a gap. Write only "A quiet pause.".',
  ])('preserves the final figure and text decisions: %s', (creativePrompt) => {
    const result = buildApprovedImagePrompt(input(creativePrompt));

    expect(result.startsWith(IMAGE_PROVIDER_WRAPPER)).toBe(true);
    expect(result).toContain(creativePrompt);
    expect(result).toContain('Image 1: semantic_reference.');
    expect(result).not.toContain('figures that physically interact');
    expect(result).not.toContain('one short handwritten English caption');
  });

  it('does not override the final artistic ratio choice', () => {
    expect(
      buildApprovedImagePrompt({ ...input('Make a square composition.'), aspect_ratio: '1:1' }),
    ).toContain('Make a square composition.');
  });

  it('still requires the final creative instruction', () => {
    expect(() =>
      buildApprovedImagePrompt({
        ...input('Create the source-specific poster.'),
        creative_prompt: undefined,
        creative_constraints_snapshot: {
          ...(input('Create the source-specific poster.').creative_constraints_snapshot as Record<
            string,
            unknown
          >),
          creative_prompt: undefined,
        },
      }),
    ).toThrow('CREATIVE_PROMPT_REQUIRED');
  });

  it('still requires the source photograph to be a provider input', () => {
    const request = input('Create the source-specific poster.');
    expect(() =>
      buildApprovedImagePrompt({
        ...request,
        input_bindings: request.input_bindings.map((binding) => ({
          ...binding,
          provider_input: false,
        })),
      }),
    ).toThrow('SEMANTIC_REFERENCE_ARTWORK_CLOSURE_INCOMPLETE');
  });

  it('still rejects creative instruction drift from the frozen snapshot', () => {
    expect(() =>
      buildApprovedImagePrompt({
        ...input('Create the source-specific poster.'),
        creative_prompt: 'Replace the frozen creative decision.',
      }),
    ).toThrow('CREATIVE_PROMPT_DRIFT');
  });
});

function input(creativePrompt: string): ApprovedImagePromptInput {
  const profile = resolveCreativeExecutionProfile({
    primarySkillId: 'second-world-photo-remix@1.0.4',
    intent: 'raw_asset_generate',
    executionPolicy: { version: 1, family: 'independent_sources', max_sources: 9 },
  });
  if (!profile) throw new Error('Missing second-world profile');

  return {
    goal_summary: 'Create a photo-line extension poster.',
    aspect_ratio: '3:4',
    creative_prompt: creativePrompt,
    input_bindings: [
      {
        object_id: '55555555-5555-4555-8555-555555555555',
        object_version: 'a'.repeat(64),
        role: 'semantic_reference',
        provider_input: true,
        publication_revision: null,
      },
    ],
    creative_execution_profile: profile,
    creative_constraints_snapshot: {
      schema_version: 1,
      profile_id: profile.profile_id,
      preserve_original_pixels: profile.constraints.preserve_original_pixels,
      creative_prompt: creativePrompt,
      allowed_changes: profile.constraints.allowed_changes,
      forbidden_changes: profile.constraints.forbidden_changes,
    },
  };
}
