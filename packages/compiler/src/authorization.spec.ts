import { describe, expect, it } from 'vitest';

import { authorizeBindings } from './authorization.js';
import type { BindingSnapshot, CapabilityRequirements } from './types.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const DIGEST = 'a'.repeat(64);

const editRequirements: CapabilityRequirements = {
  outputType: 'image',
  outputCount: 1,
  referenceImageCount: 1,
  operation: 'edit',
  mandatoryConfirmation: false,
};

function binding(overrides: Partial<BindingSnapshot> = {}): BindingSnapshot {
  return {
    binding_key: 'source-1',
    kind: 'asset',
    object_id: '44444444-4444-4444-8444-444444444444',
    object_version: DIGEST,
    content_hash: DIGEST,
    owner_user_id: USER_ID,
    readable: true,
    mutable: false,
    producer_mode: null,
    producer_session_id: null,
    mutation_owner: null,
    source_action: null,
    media_type: 'image',
    lifecycle: 'active',
    visibility: 'private',
    ...overrides,
  };
}

function authorize(
  intent: Parameters<typeof authorizeBindings>[0]['intent'],
  item: BindingSnapshot,
) {
  return authorizeBindings({
    intent,
    actorUserId: USER_ID,
    actorSessionId: SESSION_ID,
    bindings: [item],
    requirements: editRequirements,
  });
}

describe('binding authorization', () => {
  it.each(['commerce_generate', 'raw_asset_generate'] as const)(
    'allows %s to use image.edit with a readable source asset without treating it as mutation',
    (intent) => {
      expect(authorize(intent, binding())).toEqual({ ok: true });
    },
  );

  it('still applies R1 before allowing source-guided generation', () => {
    expect(authorize('commerce_generate', binding({ owner_user_id: OTHER_USER_ID }))).toMatchObject(
      {
        ok: false,
        code: 'reference_unavailable',
        ruleId: 'r1_reference_unavailable',
      },
    );
  });

  it('requires an artifact mutation target for chat artifact edits', () => {
    expect(authorize('chat_artifact_edit', binding())).toMatchObject({
      ok: false,
      code: 'mutation_forbidden',
      ruleId: 'r2_edit_target_required',
    });
  });

  it('allows only a mutable artifact owned by the current chat session', () => {
    expect(
      authorize(
        'chat_artifact_edit',
        binding({
          kind: 'artifact',
          mutable: true,
          producer_mode: 'chat',
          producer_session_id: SESSION_ID,
          mutation_owner: 'chat_session',
        }),
      ),
    ).toEqual({ ok: true });
  });
});
