import type { ModerationOutcome } from '@ecom-forge/provider';
import type { CandidatePlan } from '@ecom-forge/compiler';
import { describe, expect, it } from 'vitest';

import type { ClaimedAgentTurn } from './agent-turn.types.js';
import {
  enforceModerationPolicy,
  selectedImageBindings,
} from './content-safety-preflight.service.js';

describe('enforceModerationPolicy', () => {
  it('preserves an outcome issued under the frozen policy version', () => {
    const outcome: ModerationOutcome = {
      decision: 'pass',
      policy_version: 'content-safety@1',
      confidence: '1',
    };
    expect(enforceModerationPolicy(outcome, 'content-safety@1')).toEqual(outcome);
  });

  it('fails closed when a Provider returns a different policy version', () => {
    expect(
      enforceModerationPolicy(
        {
          decision: 'pass',
          policy_version: 'unexpected-policy@2',
          confidence: '1',
        },
        'content-safety@1',
      ),
    ).toEqual({
      decision: 'unknown',
      policy_version: 'content-safety@1',
      error_code: 'provider_internal_error',
    });
  });
});

describe('selectedImageBindings', () => {
  it('moderates only the Brain-selected image from a session candidate pool', () => {
    const selected = candidateBinding('session-output-2');
    const unselected = candidateBinding('session-output-1');
    const claimed = {
      attachments: [],
      sessionImageCandidates: [unselected, selected],
    } as unknown as ClaimedAgentTurn;
    const candidate = {
      schema_version: 1,
      intent: { kind: 'chat_artifact_edit', confidence: 0.99 },
      skill_id: 'creative-scene-reimagining@1.3.1',
      source: 'chat',
      nodes: [
        {
          candidate_key: 'edit-second',
          capability: 'image.edit',
          capability_version: 1,
          depends_on: [],
          input_bindings: [selected.binding_key],
          params: {},
          expected_output: 'image',
        },
      ],
    } satisfies CandidatePlan;

    expect(selectedImageBindings(claimed, candidate)).toEqual([selected]);
  });
});

function candidateBinding(bindingKey: string) {
  return {
    binding_key: bindingKey,
    kind: 'artifact' as const,
    object_id:
      bindingKey === 'session-output-1'
        ? '11111111-1111-4111-8111-111111111111'
        : '22222222-2222-4222-8222-222222222222',
    object_version: 'a'.repeat(64),
    content_hash: 'a'.repeat(64),
    owner_user_id: '33333333-3333-4333-8333-333333333333',
    readable: true,
    mutable: true,
    producer_mode: 'chat' as const,
    producer_session_id: '44444444-4444-4444-8444-444444444444',
    mutation_owner: 'chat_session' as const,
    source_action: 'edit' as const,
    media_type: 'image' as const,
    lifecycle: 'active' as const,
    visibility: 'private' as const,
    role: 'edit_source' as const,
    position: 0,
    publication_revision: 1,
    candidate_kind: 'latest_output' as const,
    candidate_position: bindingKey === 'session-output-1' ? 1 : 2,
    lineage_source_binding_keys: [],
  };
}
