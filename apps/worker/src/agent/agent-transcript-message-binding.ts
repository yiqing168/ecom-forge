import type { AgentTranscriptItem, AgentTranscriptValueContract } from '@ecom-forge/agent';
import { attachmentSnapshotSchema, type AttachmentSnapshot } from '@ecom-forge/compiler';
import { and, artifacts, assets, eq, inArray, users, type Database } from '@ecom-forge/db';
import { canonicalJson } from '@ecom-forge/shared';
import { z } from 'zod';

import type { AgentTranscriptRepositoryOptions } from './agent-transcript.repository.js';
import type { AgentReadQuery } from './agent-turn.types.js';

export const transcriptUserMessageSchema = z
  .strictObject({
    text: z.string(),
    attachments: z.array(attachmentSnapshotSchema).max(9),
  })
  .superRefine(({ attachments }, context) => {
    if (
      new Set(attachments.map((attachment) => attachment.binding_key)).size !==
        attachments.length ||
      new Set(attachments.map((attachment) => attachment.position)).size !== attachments.length
    ) {
      context.addIssue({ code: 'custom', message: 'Duplicate attachment identity or position' });
    }
  });

export const transcriptUserMessageContract: AgentTranscriptValueContract = {
  schema: transcriptUserMessageSchema,
};

type SourceInput = Parameters<
  NonNullable<AgentTranscriptRepositoryOptions['verifyMessageSource']>
>[0];

/** Only native user messages. Confirmation facts and Skill knowledge are separate host events. */
export function verifyTranscriptUserMessageSource({ item, source }: SourceInput): boolean {
  try {
    if (
      item.item_type !== 'user_message' ||
      item.payload_json.type !== 'user_message' ||
      item.import_attempt_id !== null ||
      !item.turn_id ||
      source.role !== 'user' ||
      source.id !== item.source_message_id ||
      source.sessionId !== item.session_id ||
      source.turnId !== item.turn_id ||
      canonicalJson(source.toolCalls) !== '[]' ||
      canonicalJson(source.pendingApproval) !== '{}'
    )
      return false;
    const content = transcriptUserMessageSchema.safeParse(item.payload_json.content.value);
    const original = transcriptUserMessageSchema.safeParse({
      text: source.content,
      attachments: source.attachments,
    });
    return (
      content.success &&
      original.success &&
      canonicalJson(content.data) === canonicalJson(item.payload_json.content.value) &&
      canonicalJson(original.data) ===
        canonicalJson({ text: source.content, attachments: source.attachments }) &&
      canonicalJson(content.data) === canonicalJson(original.data)
    );
  } catch {
    return false;
  }
}

/** DB authorization for a verified user item, never tool execution or image-byte validation. */
export class AgentTranscriptUserMessageAuthorizer {
  constructor(
    private readonly database: Pick<Database, 'query'>,
    private readonly read: AgentReadQuery = async (build) => build(),
  ) {}

  async authorize(item: AgentTranscriptItem): Promise<boolean> {
    try {
      if (
        item.item_type !== 'user_message' ||
        item.payload_json.type !== 'user_message' ||
        item.import_attempt_id !== null ||
        !item.turn_id ||
        !item.source_message_id
      )
        return false;
      const content = transcriptUserMessageSchema.safeParse(item.payload_json.content.value);
      if (!content.success) return false;
      const bindings = content.data.attachments;
      const expected = new Set(bindings.map(canonicalJson));
      if (
        canonicalJson(content.data) !== canonicalJson(item.payload_json.content.value) ||
        item.resource_dependencies_json.length !== bindings.length ||
        new Set(item.resource_dependencies_json.map(canonicalJson)).size !== bindings.length ||
        item.resource_dependencies_json.some(
          (dependency) => !expected.has(canonicalJson(dependency)),
        ) ||
        bindings.some((binding) => binding.owner_user_id !== item.user_id)
      )
        return false;
      return await this.authorizeBindings(item.user_id, bindings);
    } catch {
      return false;
    }
  }

  /** Revalidate captured model/tool dependencies without inventing a user-message source. */
  async authorizeBindings(userId: string, raw: readonly unknown[]): Promise<boolean> {
    try {
      const bindings = raw.map((binding) => attachmentSnapshotSchema.parse(binding));
      if (
        canonicalJson(bindings) !== canonicalJson(raw) ||
        bindings.some(
          (binding) =>
            binding.owner_user_id !== userId ||
            !binding.readable ||
            binding.lifecycle !== 'active' ||
            binding.visibility === 'deleted' ||
            binding.visibility === 'quarantined' ||
            binding.object_version !== binding.content_hash,
        )
      )
        return false;
      const user = await this.read(() =>
        this.database.query.users.findFirst({
          where: eq(users.id, userId),
          columns: { id: true, riskStatus: true },
        }),
      );
      if (!user || user.id !== userId || user.riskStatus !== 'normal') return false;

      const assetBindings = bindings.filter((binding) => binding.kind === 'asset');
      if (assetBindings.length > 0) {
        const rows = await this.read(() =>
          this.database.query.assets.findMany({
            where: and(
              eq(assets.userId, userId),
              inArray(
                assets.id,
                assetBindings.map((binding) => binding.object_id),
              ),
            ),
            columns: {
              id: true,
              userId: true,
              status: true,
              deletedAt: true,
              contentHash: true,
              mimeType: true,
            },
          }),
        );
        const byId = new Map(rows.map((row) => [row.id, row]));
        if (
          assetBindings.some((binding) => {
            const row = byId.get(binding.object_id);
            return (
              !row ||
              row.userId !== userId ||
              row.status !== 'ready' ||
              row.deletedAt !== null ||
              row.contentHash !== binding.content_hash ||
              !['image/jpeg', 'image/png', 'image/webp'].includes(row.mimeType ?? '') ||
              binding.media_type !== 'image' ||
              binding.publication_revision != null
            );
          })
        )
          return false;
      }

      const artifactBindings = bindings.filter((binding) => binding.kind === 'artifact');
      if (artifactBindings.length > 0) {
        const rows = await this.read(() =>
          this.database.query.artifacts.findMany({
            where: and(
              eq(artifacts.userId, userId),
              inArray(
                artifacts.id,
                artifactBindings.map((binding) => binding.object_id),
              ),
            ),
            columns: {
              id: true,
              userId: true,
              type: true,
              visibility: true,
              contentHash: true,
              publishedContentHash: true,
              publicationRevision: true,
            },
          }),
        );
        const byId = new Map(rows.map((row) => [row.id, row]));
        if (
          artifactBindings.some((binding) => {
            const row = byId.get(binding.object_id);
            return (
              !row ||
              row.userId !== userId ||
              row.type !== binding.media_type ||
              row.visibility === 'deleted' ||
              row.visibility === 'quarantined' ||
              !matchesArtifactVersion(binding, row)
            );
          })
        )
          return false;
      }
      return true;
    } catch {
      return false;
    }
  }
}

function matchesArtifactVersion(
  binding: AttachmentSnapshot,
  row: Pick<
    typeof artifacts.$inferSelect,
    'contentHash' | 'publishedContentHash' | 'publicationRevision'
  >,
): boolean {
  if (binding.publication_revision != null) {
    return (
      row.publishedContentHash === binding.content_hash &&
      row.publicationRevision === binding.publication_revision
    );
  }
  return row.contentHash === binding.content_hash;
}
