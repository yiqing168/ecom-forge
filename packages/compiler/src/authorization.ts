import type { BindingSnapshot, CandidatePlan, CapabilityRequirements } from './types.js';

export type AuthorizationResult =
  | { ok: true }
  | {
      ok: false;
      code: 'reference_unavailable' | 'mutation_forbidden';
      safeAction: 'remove_reference' | 'open_canvas' | 'start_new_generation';
      bindingKey?: string;
      ruleId: string;
    };

export function authorizeBindings(input: {
  intent: CandidatePlan['intent']['kind'];
  actorUserId: string;
  actorSessionId: string;
  bindings: readonly BindingSnapshot[];
  requirements: CapabilityRequirements;
}): AuthorizationResult {
  for (const binding of input.bindings) {
    if (
      binding.owner_user_id !== input.actorUserId ||
      !binding.readable ||
      binding.lifecycle !== 'active' ||
      binding.visibility === 'quarantined' ||
      binding.visibility === 'deleted'
    ) {
      return {
        ok: false,
        code: 'reference_unavailable',
        safeAction: 'remove_reference',
        bindingKey: binding.binding_key,
        ruleId: 'r1_reference_unavailable',
      };
    }
  }

  const mutationRequested =
    input.intent === 'chat_artifact_edit' || input.intent === 'external_artifact_edit';
  if (!mutationRequested) return { ok: true };

  const artifacts = input.bindings.filter((binding) => binding.kind === 'artifact');
  if (input.intent === 'external_artifact_edit') {
    const external = artifacts[0];
    return {
      ok: false,
      code: 'mutation_forbidden',
      safeAction:
        external?.producer_mode === 'canvas' || external?.producer_mode === 'suite'
          ? 'open_canvas'
          : 'start_new_generation',
      ...(external ? { bindingKey: external.binding_key } : {}),
      ruleId: 'r5_external_edit_forbidden',
    };
  }
  if (artifacts.length === 0) {
    return {
      ok: false,
      code: 'mutation_forbidden',
      safeAction: 'start_new_generation',
      ruleId: 'r2_edit_target_required',
    };
  }
  for (const artifact of artifacts) {
    if (
      !artifact.mutable ||
      artifact.producer_mode !== 'chat' ||
      artifact.producer_session_id !== input.actorSessionId ||
      artifact.mutation_owner !== 'chat_session'
    ) {
      return {
        ok: false,
        code: 'mutation_forbidden',
        safeAction:
          artifact.producer_mode === 'canvas' || artifact.producer_mode === 'suite'
            ? 'open_canvas'
            : 'start_new_generation',
        bindingKey: artifact.binding_key,
        ruleId: 'r3_mutation_owner_mismatch',
      };
    }
  }
  return { ok: true };
}
