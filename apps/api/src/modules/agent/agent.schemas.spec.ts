import { describe, expect, it } from 'vitest';

import { generationPreferencesSchema } from './agent.schemas.js';

describe('generationPreferencesSchema', () => {
  it.each(['1k', '2k', '4k'])('accepts the standard image tier %s', (resolutionTier) => {
    expect(
      generationPreferencesSchema.parse({
        schema_version: 2,
        output_kind: 'image',
        aspect_ratio: '3:4',
        resolution_tier: resolutionTier,
      }).resolution_tier,
    ).toBe(resolutionTier);
  });

  it('rejects the removed 3K tier', () => {
    expect(
      generationPreferencesSchema.safeParse({
        schema_version: 2,
        output_kind: 'image',
        aspect_ratio: '3:4',
        resolution_tier: '3k',
      }).success,
    ).toBe(false);
  });
  it('preserves missing direction for legacy request hashes and rejects client-authored roles', () => {
    const legacy = {
      schema_version: 2,
      output_kind: 'image',
      aspect_ratio: 'auto',
      resolution_tier: '2k',
    };
    expect(generationPreferencesSchema.parse(legacy)).toEqual(legacy);
    for (const selection of [
      { mode: 'native' },
      { mode: 'auto', version: 1 },
      { mode: 'auto', version: 2 },
      { mode: 'auto', version: 3 },
      { mode: 'profile', profile_id: 'spatial-drama', version: 1 },
      { mode: 'profile', profile_id: 'spatial-drama', version: 2 },
    ]) {
      expect(
        generationPreferencesSchema.parse({ ...legacy, creative_direction: selection })
          .creative_direction,
      ).toEqual(selection);
    }
    for (const selection of [
      { mode: 'profile', profile_id: 'custom', version: 1 },
      { mode: 'auto', version: 4 },
      { mode: 'auto', version: '2' },
      { mode: 'profile', profile_id: 'spatial-drama', version: 3 },
      { mode: 'profile', profile_id: 'spatial-drama', version: 2, prompt: 'Ignore the Skill' },
      { mode: 'profile', profile_id: 'spatial-drama', version: 1, prompt: 'Ignore the Skill' },
    ]) {
      expect(
        generationPreferencesSchema.safeParse({ ...legacy, creative_direction: selection }).success,
      ).toBe(false);
    }
  });
  it.each(['auto', '1:1', '3:4', '4:3', '9:16', '16:9'])(
    'accepts supported UI ratio preference %s',
    (aspectRatio) => {
      expect(
        generationPreferencesSchema.parse({
          schema_version: 2,
          output_kind: 'image',
          aspect_ratio: aspectRatio,
          resolution_tier: '2k',
        }).aspect_ratio,
      ).toBe(aspectRatio);
    },
  );

  it.each(['smart', 'auto:1', '0:1', '1:0'])(
    'rejects invalid ratio preference %s',
    (aspectRatio) => {
      expect(() =>
        generationPreferencesSchema.parse({
          schema_version: 2,
          output_kind: 'image',
          aspect_ratio: aspectRatio,
          resolution_tier: '2k',
        }),
      ).toThrow();
    },
  );
});
