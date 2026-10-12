export interface PublicAgentAttachment {
  resource_type: 'asset' | 'artifact';
  resource_id: string;
  role:
    | 'product'
    | 'style_reference'
    | 'composition_reference'
    | 'identity_anchor'
    | 'semantic_reference'
    | 'edit_source'
    | 'other';
  position: number;
  creative_note?: string;
}

const PUBLIC_ROLES = new Set<PublicAgentAttachment['role']>([
  'product',
  'style_reference',
  'composition_reference',
  'identity_anchor',
  'semantic_reference',
  'edit_source',
  'other',
]);

export function publicAgentAttachments(value: unknown): PublicAgentAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const attachment = entry as Record<string, unknown>;
    if (
      (attachment.kind !== 'asset' && attachment.kind !== 'artifact') ||
      typeof attachment.object_id !== 'string' ||
      !PUBLIC_ROLES.has(attachment.role as PublicAgentAttachment['role']) ||
      !Number.isInteger(attachment.position) ||
      (attachment.position as number) < 0 ||
      (attachment.position as number) > 11
    ) {
      return [];
    }
    return [
      {
        resource_type: attachment.kind,
        resource_id: attachment.object_id,
        role: attachment.role as PublicAgentAttachment['role'],
        position: attachment.position as number,
        ...(attachment.kind === 'artifact' &&
        typeof attachment.creative_note === 'string' &&
        attachment.creative_note.trim()
          ? { creative_note: attachment.creative_note.trim().slice(0, 600) }
          : {}),
      },
    ];
  });
}

type PendingAgentConfirmation = {
  id: string;
  type: string;
  answerSchemaVersion: number;
  publicPayloadJson: unknown;
  expiresAt: Date;
};

export function publicPendingConfirmation(input: {
  confirmation: PendingAgentConfirmation | null | undefined;
}) {
  if (input.confirmation) {
    return {
      id: input.confirmation.id,
      type: input.confirmation.type,
      version: input.confirmation.answerSchemaVersion,
      public_payload: input.confirmation.publicPayloadJson,
      expires_at: input.confirmation.expiresAt.toISOString(),
    };
  }
  return null;
}
