import { describe, expect, it } from 'vitest';
import {
  CREATIVE_DIRECTION_OPTIONS,
  CREATIVE_DIRECTION_PROFILE_IDS,
  parseCreativeDirectionSelection,
  createSessionCreativeDirectionSnapshot,
  parseSessionCreativeDirectionSnapshot,
  effectiveCreativeDirection,
} from './creative-direction.js';
import { canonicalSha256 } from './canonical-json.js';

describe('public creative direction selection', () => {
  it('accepts the six complete, distinct choices and round trips persisted JSON', () => {
    expect(CREATIVE_DIRECTION_OPTIONS.map((item) => item.id)).toEqual([
      ...CREATIVE_DIRECTION_PROFILE_IDS,
    ]);
    expect(new Set(CREATIVE_DIRECTION_OPTIONS.map((item) => item.name)).size).toBe(6);
    for (const version of [1, 2]) {
      for (const id of CREATIVE_DIRECTION_PROFILE_IDS) {
        const selection = { mode: 'profile', profile_id: id, version };
        expect(parseCreativeDirectionSelection(JSON.parse(JSON.stringify(selection)))).toEqual(
          selection,
        );
      }
      expect(parseCreativeDirectionSelection({ mode: 'auto', version })).toEqual({
        mode: 'auto',
        version,
      });
    }
    expect(parseCreativeDirectionSelection({ mode: 'auto', version: 1 })).toEqual({
      mode: 'auto',
      version: 1,
    });
    expect(parseCreativeDirectionSelection({ mode: 'native' })).toEqual({ mode: 'native' });
    expect(parseCreativeDirectionSelection({ mode: 'auto', version: 3 })).toEqual({
      mode: 'auto',
      version: 3,
    });
  });
  it('distinguishes method versions in frozen preference hashes', () => {
    const preference = {
      schema_version: 2,
      output_kind: 'image',
      creative_direction: { mode: 'profile', profile_id: 'visual-metaphor', version: 1 },
    };
    expect(canonicalSha256(preference)).not.toBe(
      canonicalSha256({
        ...preference,
        creative_direction: { ...preference.creative_direction, version: 2 },
      }),
    );
  });
  it.each([
    null,
    undefined,
    [],
    'auto',
    {},
    { mode: 'auto' },
    { mode: 'auto', version: 4 },
    { mode: 'auto', version: '2' },
    { mode: 'native', profile_id: 'human-story' },
    { mode: 'profile', profile_id: 'human-story', version: '1' },
    { mode: 'profile', profile_id: 'unknown', version: 1 },
    { mode: 'profile', profile_id: 'human-story', version: 3 },
    { mode: 'profile', profile_id: 'human-story', version: '2' },
    { mode: 'profile', profile_id: 'human-story', version: 2, content: 'override policy' },
    { mode: 'profile', profile_id: 'human-story', version: 1, content: 'override policy' },
  ])('rejects invalid, future, or client-authored selections: %j', (value) => {
    expect(parseCreativeDirectionSelection(value)).toBeNull();
  });
});

describe('session designer snapshot', () => {
  it('defaults legacy requests to native and preserves pending automatic policy', () => {
    expect(createSessionCreativeDirectionSnapshot(undefined)).toEqual({
      schema_version: 1,
      selection: { mode: 'native' },
    });
    const pending = createSessionCreativeDirectionSnapshot({ mode: 'auto', version: 3 });
    expect(parseSessionCreativeDirectionSnapshot(pending)).toEqual(pending);
    expect(effectiveCreativeDirection(pending)).toEqual({ mode: 'auto', version: 3 });
  });
  it('accepts only a complete v3 resolution with method v2 and immutable provenance', () => {
    const resolved = {
      schema_version: 1,
      selection: { mode: 'auto', version: 3 },
      resolved_profile: { mode: 'profile', profile_id: 'spatial-drama', version: 2 },
      resolution_turn_id: '10000000-0000-4000-8000-000000000001',
      resolution_step_id: '10000000-0000-4000-8000-000000000002',
    };
    const snapshot = parseSessionCreativeDirectionSnapshot(resolved);
    expect(snapshot).toEqual(resolved);
    expect(effectiveCreativeDirection(snapshot!)).toEqual(resolved.resolved_profile);
    for (const invalid of [
      { ...resolved, selection: { mode: 'auto', version: 2 } },
      { ...resolved, selection: { mode: 'native' } },
      { ...resolved, resolution_step_id: undefined },
      { ...resolved, resolved_profile: { ...resolved.resolved_profile, version: 3 } },
      { ...resolved, content: 'override' },
    ])
      expect(parseSessionCreativeDirectionSnapshot(invalid)).toBeNull();
  });
});
