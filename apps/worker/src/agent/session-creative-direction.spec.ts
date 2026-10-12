import { describe, expect, it } from 'vitest';
import { canonicalSha256, createSessionCreativeDirectionSnapshot } from '@ecom-forge/shared';
import { creativeDirectionPlanError, turnCreativeDirection } from './session-creative-direction.js';
import type { ClaimedAgentTurn } from './agent-turn.types.js';

const plan = {
  schema_version: 1,
  intent: { kind: 'creative_generate', confidence: 1 },
  skill_id: 'creative-free-generation@1.0.1',
  source: 'chat',
  nodes: [
    {
      candidate_key: 'one',
      capability: 'image.generate',
      capability_version: 1,
      depends_on: [],
      input_bindings: [],
      params: {},
      expected_output: 'image',
    },
  ],
};
const selection = { mode: 'auto' as const, version: 3 as const };
function claimed() {
  return {
    generationPreferences: { creative_direction: selection },
    sessionCreativeDirection: createSessionCreativeDirectionSnapshot(selection),
    materializedImageBindingKeys: [],
    attachments: [{ binding_key: 'asset:selected', media_type: 'image' }],
  } as unknown as ClaimedAgentTurn;
}

describe('automatic session designer policy', () => {
  it('requires a valid method and inspection of only the selected images', () => {
    expect(creativeDirectionPlanError(claimed(), plan)).toContain('Choose');
    const chosen = { ...plan, creative_direction_profile_id: 'human-story' };
    expect(creativeDirectionPlanError(claimed(), chosen)).toBeNull();
    const bound = { ...chosen, nodes: [{ ...plan.nodes[0], input_bindings: ['asset:selected'] }] };
    expect(creativeDirectionPlanError(claimed(), bound)).toContain('Inspect');
    expect(
      creativeDirectionPlanError(
        { ...claimed(), materializedImageBindingKeys: ['asset:selected'] },
        bound,
      ),
    ).toBeNull();
    expect(
      creativeDirectionPlanError(claimed(), {
        ...chosen,
        nodes: [{ ...plan.nodes[0], input_bindings: ['fact:text'] }],
      }),
    ).toBeNull();
    expect(
      creativeDirectionPlanError(claimed(), { ...chosen, creative_direction_profile_id: 'custom' }),
    ).not.toBeNull();
  });
  it('reuses the resolved method without rewriting the original selection or hash', () => {
    const turn = claimed();
    const before = canonicalSha256(turn.generationPreferences);
    turn.sessionCreativeDirection = {
      ...turn.sessionCreativeDirection!,
      resolved_profile: { mode: 'profile', profile_id: 'human-story', version: 2 },
      resolution_turn_id: '10000000-0000-4000-8000-000000000001',
      resolution_step_id: '10000000-0000-4000-8000-000000000002',
    };
    expect(turnCreativeDirection(turn)).toEqual({
      mode: 'profile',
      profile_id: 'human-story',
      version: 2,
    });
    expect(creativeDirectionPlanError(turn, plan)).toBeNull();
    expect(
      creativeDirectionPlanError(turn, { ...plan, creative_direction_profile_id: 'spatial-drama' }),
    ).toContain('cannot change');
    expect(canonicalSha256(turn.generationPreferences)).toBe(before);
  });
  it('leaves native, manual and old auto turn definitions unchanged', () => {
    for (const selection of [
      { mode: 'native' as const },
      { mode: 'auto' as const, version: 1 as const },
      { mode: 'profile' as const, profile_id: 'spatial-drama' as const, version: 1 as const },
    ]) {
      const turn = {
        ...claimed(),
        generationPreferences: {
          ...claimed().generationPreferences!,
          creative_direction: selection,
        },
      };
      expect(turnCreativeDirection(turn)).toEqual(selection);
      expect(creativeDirectionPlanError(turn, plan)).toBeNull();
    }
  });
});
