import { candidatePlanSchema } from '@ecom-forge/compiler';
import { chatSessions, and, eq } from '@ecom-forge/db';
import {
  canonicalSha256,
  effectiveCreativeDirection,
  parseSessionCreativeDirectionSnapshot,
  type CreativeDirectionSelection,
} from '@ecom-forge/shared';
import type { ClaimedAgentTurn } from './agent-turn.types.js';
import type { AgentTranscriptWriteScope } from './agent-transcript-write-transaction.js';

export function turnCreativeDirection(
  claimed: ClaimedAgentTurn,
): CreativeDirectionSelection | undefined {
  const selected = claimed.generationPreferences?.creative_direction;
  const snapshot = claimed.sessionCreativeDirection;
  return selected?.mode === 'auto' &&
    selected.version === 3 &&
    snapshot &&
    canonicalSha256(snapshot.selection) === canonicalSha256(selected)
    ? effectiveCreativeDirection(snapshot)
    : selected;
}

export function creativeDirectionPlanError(claimed: ClaimedAgentTurn, raw: unknown): string | null {
  const direction = turnCreativeDirection(claimed);
  const plan = candidatePlanSchema.safeParse(raw);
  if (!plan.success) return 'Return a valid image plan before selecting a designer.';
  const choice = plan.data.creative_direction_profile_id;
  if (direction?.mode === 'auto' && direction.version === 3) {
    if (!choice)
      return 'Choose creative_direction_profile_id from the six designer IDs for automatic policy v3.';
    const seen = new Set(claimed.materializedImageBindingKeys ?? []);
    const images = new Set(
      [...(claimed.attachments ?? []), ...(claimed.sessionImageCandidates ?? [])]
        .filter((binding) => binding.media_type === 'image')
        .map((binding) => binding.binding_key),
    );
    if (
      plan.data.nodes.some((node) =>
        node.input_bindings.some((key) => images.has(key) && !seen.has(key)),
      )
    )
      return 'Inspect the selected image inputs before choosing the session designer.';
  } else if (choice && (direction?.mode !== 'profile' || direction.profile_id !== choice)) {
    return 'The session designer cannot change. Omit creative_direction_profile_id.';
  }
  return null;
}

/** Called only inside the owned session/turn transaction that accepts a planning receipt. */
export async function resolveSessionCreativeDirection(
  scope: AgentTranscriptWriteScope,
  claimed: ClaimedAgentTurn,
  rawPlan: unknown,
  stepId: string,
) {
  const selection = claimed.generationPreferences?.creative_direction;
  if (selection?.mode !== 'auto' || selection.version !== 3) return undefined;
  const session = await scope.query((tx) =>
    tx.query.chatSessions.findFirst({
      where: and(eq(chatSessions.id, scope.sessionId), eq(chatSessions.userId, scope.userId)),
    }),
  );
  const snapshot = parseSessionCreativeDirectionSnapshot(session?.creativeDirectionSnapshotJson);
  if (
    !snapshot ||
    canonicalSha256(snapshot) !== session?.creativeDirectionSnapshotHash ||
    canonicalSha256(snapshot.selection) !== canonicalSha256(selection)
  )
    return scope.abort();
  const plan = candidatePlanSchema.safeParse(rawPlan);
  if (snapshot.resolved_profile) {
    if (
      plan.success &&
      plan.data.creative_direction_profile_id &&
      plan.data.creative_direction_profile_id !== snapshot.resolved_profile.profile_id
    )
      return scope.abort();
    return snapshot;
  }
  if (
    !plan.success ||
    creativeDirectionPlanError({ ...claimed, sessionCreativeDirection: snapshot }, plan.data)
  )
    return scope.abort();
  const resolved = parseSessionCreativeDirectionSnapshot({
    ...snapshot,
    resolved_profile: {
      mode: 'profile',
      profile_id: plan.data.creative_direction_profile_id,
      version: 2,
    },
    resolution_turn_id: scope.turnId,
    resolution_step_id: stepId,
  });
  if (!resolved) return scope.abort();
  await scope.query((tx) =>
    tx
      .update(chatSessions)
      .set({
        creativeDirectionSnapshotJson: resolved,
        creativeDirectionSnapshotHash: canonicalSha256(resolved),
      })
      .where(and(eq(chatSessions.id, scope.sessionId), eq(chatSessions.userId, scope.userId))),
  );
  return resolved;
}
