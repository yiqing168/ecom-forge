import { skillExecutionRules } from '@ecom-forge/shared';
import {
  and,
  agentTurns,
  artifactInputBindings,
  artifacts,
  asc,
  assets,
  chatMessages,
  desc,
  eq,
  inArray,
  sql,
  tasks,
  workflowRuns,
  type Database,
} from '@ecom-forge/db';
import { attachmentSnapshotSchema, type AttachmentSnapshot } from '@ecom-forge/compiler';
import { z } from 'zod';

import type { ClaimedAgentTurn } from './agent-turn.types.js';
import { compareWorkflowArtifactOrder } from './workflow-artifact-order.js';

export const MAX_SESSION_OUTPUT_CANDIDATES = 16;
export const MAX_SESSION_SOURCE_CANDIDATES = 9;

export const sessionImageCandidateSchema = attachmentSnapshotSchema
  .safeExtend({
    candidate_kind: z.enum(['latest_output', 'original_source']),
    candidate_position: z.int().min(1).max(MAX_SESSION_OUTPUT_CANDIDATES),
    lineage_source_binding_keys: z.array(z.string().min(1).max(128)).max(9),
  })
  .superRefine((candidate, context) => {
    if (
      candidate.candidate_kind === 'original_source' &&
      candidate.candidate_position > MAX_SESSION_SOURCE_CANDIDATES
    ) {
      context.addIssue({
        code: 'custom',
        path: ['candidate_position'],
        message: 'Original source candidate position exceeds nine',
      });
    }
  });

export type SessionImageCandidate = z.infer<typeof sessionImageCandidateSchema>;

export const sessionImageCandidatesSchema = z
  .array(sessionImageCandidateSchema)
  .max(MAX_SESSION_OUTPUT_CANDIDATES + MAX_SESSION_SOURCE_CANDIDATES)
  .superRefine((candidates, context) => {
    for (const [kind, limit] of [
      ['latest_output', MAX_SESSION_OUTPUT_CANDIDATES],
      ['original_source', MAX_SESSION_SOURCE_CANDIDATES],
    ] as const) {
      if (candidates.filter((candidate) => candidate.candidate_kind === kind).length > limit) {
        context.addIssue({
          code: 'custom',
          message: `Session ${kind} candidate limit exceeded`,
        });
      }
    }
  });

type SourceRole = Extract<
  AttachmentSnapshot['role'],
  'product' | 'identity_anchor' | 'semantic_reference'
>;
type CandidateTurn = Pick<
  ClaimedAgentTurn,
  'turnId' | 'userId' | 'sessionId' | 'attachments' | 'isFirstSessionTurn' | 'selection'
>;
type HistoricalGroup = { messageId: string; createdAt: Date; sources: SessionImageCandidate[] };

export class AgentSessionImageCandidateService {
  constructor(private readonly database: Database) {}

  async resolve(claimed: CandidateTurn): Promise<SessionImageCandidate[]> {
    if (claimed.attachments.length > 0 || claimed.isFirstSessionTurn) return [];
    const sourceRole = claimed.selection.execution_policy
      ? skillExecutionRules(claimed.selection.execution_policy).source_role
      : null;
    const outputScope = and(
      eq(artifacts.userId, claimed.userId),
      eq(workflowRuns.userId, claimed.userId),
      eq(artifacts.producerMode, 'chat'),
      eq(artifacts.producerSessionId, claimed.sessionId),
      eq(artifacts.mutationOwner, 'chat_session'),
      inArray(artifacts.visibility, ['private', 'shared', 'public']),
      sql`${artifacts.publishedStorageKey} is not null`,
      sql`${artifacts.publishedContentHash} is not null`,
      sql`${workflowRuns.createdAt} < (select created_at from agent_turns where id = ${claimed.turnId} and user_id = ${claimed.userId})`,
    );
    const [latestWorkflow] = await this.database
      .select({
        workflowRunId: workflowRuns.id,
        workflowCreatedAt: workflowRuns.createdAt,
      })
      .from(artifacts)
      .innerJoin(tasks, eq(tasks.id, artifacts.taskId))
      .innerJoin(workflowRuns, eq(workflowRuns.id, tasks.workflowRunId))
      .where(outputScope)
      .orderBy(desc(workflowRuns.createdAt), desc(workflowRuns.id))
      .limit(1);
    const outputRows = latestWorkflow
      ? await this.database
          .select({
            id: artifacts.id,
            taskId: artifacts.taskId,
            workflowRunId: tasks.workflowRunId,
            workflowCreatedAt: workflowRuns.createdAt,
            taskCreatedAt: tasks.createdAt,
            userId: artifacts.userId,
            contentHash: artifacts.publishedContentHash,
            publicationRevision: artifacts.publicationRevision,
            producerMode: artifacts.producerMode,
            producerSessionId: artifacts.producerSessionId,
            mutationOwner: artifacts.mutationOwner,
            sourceAction: artifacts.sourceAction,
            visibility: artifacts.visibility,
            metaJson: artifacts.metaJson,
            createdAt: artifacts.createdAt,
          })
          .from(artifacts)
          .innerJoin(tasks, eq(tasks.id, artifacts.taskId))
          .innerJoin(workflowRuns, eq(workflowRuns.id, tasks.workflowRunId))
          .where(and(outputScope, eq(workflowRuns.id, latestWorkflow.workflowRunId)))
          .orderBy(
            asc(workflowRuns.createdAt),
            asc(workflowRuns.id),
            asc(tasks.createdAt),
            asc(tasks.id),
            asc(artifacts.createdAt),
            asc(artifacts.id),
          )
      : [];
    const historicalGroups = sourceRole
      ? await this.resolveHistoricalOriginals(claimed, sourceRole)
      : null;
    const historical = historicalGroups?.latest ?? null;
    const historicalSources = historicalGroups
      ? mergeHistoricalSources(
          [],
          historicalGroups.groups.flatMap((group) => group.sources),
        )
      : [];
    if (
      !latestWorkflow ||
      (historical && historical.createdAt > latestWorkflow.workflowCreatedAt)
    ) {
      return historical?.sources.length ? historicalSources : [];
    }
    const latestWorkflowRunId = latestWorkflow.workflowRunId;
    const latestOutputs = outputRows
      .filter((row) => row.workflowRunId === latestWorkflowRunId)
      .sort(compareWorkflowArtifactOrder);
    if (latestOutputs.length > MAX_SESSION_OUTPUT_CANDIDATES) {
      throw new Error('SESSION_IMAGE_CANDIDATE_LIMIT_EXCEEDED');
    }

    const sourceIdsByOutputId = new Map<string, string[]>();
    const orderedSourceIds: string[] = [];
    const sourceVersions = new Map<string, string>();
    if (sourceRole) {
      for (const output of latestOutputs) {
        const lineage = await this.resolveOriginalSources(output.id, sourceRole, claimed.userId);
        const sourceIds = lineage.map((source) => source.id);
        for (const source of lineage) {
          const existing = sourceVersions.get(source.id);
          sourceVersions.set(
            source.id,
            existing === undefined || existing === source.version ? source.version : '',
          );
        }
        sourceIdsByOutputId.set(output.id, sourceIds);
        for (const sourceId of sourceIds) {
          if (!orderedSourceIds.includes(sourceId)) {
            orderedSourceIds.push(sourceId);
          }
        }
      }
    }
    if (historical?.sources.some((source) => orderedSourceIds.includes(source.object_id))) {
      const groupIds = historical.sources.map((source) => source.object_id);
      const combined = [...groupIds, ...orderedSourceIds.filter((id) => !groupIds.includes(id))];
      if (combined.length > MAX_SESSION_SOURCE_CANDIDATES) {
        throw new Error('SESSION_IMAGE_CANDIDATE_LIMIT_EXCEEDED');
      }
      orderedSourceIds.splice(0, orderedSourceIds.length, ...combined);
      for (const source of historical.sources) {
        const existing = sourceVersions.get(source.object_id);
        sourceVersions.set(
          source.object_id,
          existing === undefined || existing === source.object_version ? source.object_version : '',
        );
      }
    }
    if (historical?.sources.length && historicalSources.length) {
      const firstIds = historicalSources.map((source) => source.object_id);
      const combined = [...firstIds, ...orderedSourceIds.filter((id) => !firstIds.includes(id))];
      if (combined.length > MAX_SESSION_SOURCE_CANDIDATES) {
        throw new Error('SESSION_IMAGE_CANDIDATE_LIMIT_EXCEEDED');
      }
      orderedSourceIds.splice(0, orderedSourceIds.length, ...combined);
      for (const source of historicalSources) {
        const existing = sourceVersions.get(source.object_id);
        sourceVersions.set(
          source.object_id,
          existing === undefined || existing === source.object_version ? source.object_version : '',
        );
      }
    }

    if (orderedSourceIds.length > MAX_SESSION_SOURCE_CANDIDATES) {
      throw new Error('SESSION_IMAGE_CANDIDATE_LIMIT_EXCEEDED');
    }
    const sourceRows =
      orderedSourceIds.length > 0
        ? await this.database
            .select()
            .from(assets)
            .where(and(eq(assets.userId, claimed.userId), inArray(assets.id, orderedSourceIds)))
        : [];
    const sourceById = new Map(sourceRows.map((row) => [row.id, row]));
    const sourceBindingKeyById = new Map<string, string>();
    orderedSourceIds.forEach((sourceId, index) => {
      const row = sourceById.get(sourceId);
      if (
        row &&
        row.userId === claimed.userId &&
        row.status === 'ready' &&
        !row.deletedAt &&
        row.mimeType?.startsWith('image/') &&
        row.contentHash &&
        row.contentHash === sourceVersions.get(sourceId)
      ) {
        sourceBindingKeyById.set(sourceId, `session-source-${index + 1}`);
      }
    });

    const outputs: SessionImageCandidate[] = latestOutputs.map((row, index) => {
      if (!row.contentHash) throw new Error('SESSION_IMAGE_CANDIDATE_VERSION_MISSING');
      return sessionImageCandidateSchema.parse({
        binding_key: `session-output-${index + 1}`,
        kind: 'artifact',
        object_id: row.id,
        object_version: row.contentHash,
        content_hash: row.contentHash,
        owner_user_id: row.userId,
        readable: true,
        mutable: true,
        producer_mode: row.producerMode,
        producer_session_id: row.producerSessionId,
        mutation_owner: row.mutationOwner,
        source_action: row.sourceAction,
        media_type: 'image',
        lifecycle: 'active',
        visibility: row.visibility,
        role: 'edit_source',
        position: index,
        publication_revision: row.publicationRevision,
        candidate_kind: 'latest_output',
        candidate_position: index + 1,
        lineage_source_binding_keys: (sourceIdsByOutputId.get(row.id) ?? []).flatMap((sourceId) => {
          const key = sourceBindingKeyById.get(sourceId);
          return key ? [key] : [];
        }),
      });
    });

    const sources: SessionImageCandidate[] = orderedSourceIds.flatMap((sourceId, index) => {
      const row = sourceById.get(sourceId);
      if (!row || !sourceBindingKeyById.has(sourceId) || !sourceRole) return [];
      return [
        sessionImageCandidateSchema.parse({
          binding_key: sourceBindingKeyById.get(sourceId),
          kind: 'asset',
          object_id: row.id,
          object_version: row.contentHash,
          content_hash: row.contentHash,
          owner_user_id: row.userId,
          readable: true,
          mutable: false,
          producer_mode: null,
          producer_session_id: null,
          mutation_owner: null,
          source_action: null,
          media_type: 'image',
          lifecycle: 'active',
          visibility: 'private',
          role: sourceRole,
          position: index,
          publication_revision: null,
          candidate_kind: 'original_source',
          candidate_position: index + 1,
          lineage_source_binding_keys: [],
          source_group: historicalSources.find((source) => source.object_id === sourceId)
            ?.source_group,
        }),
      ];
    });
    return [...outputs, ...sources];
  }

  private async resolveHistoricalOriginals(
    claimed: CandidateTurn,
    sourceRole: SourceRole,
  ): Promise<{
    latest: HistoricalGroup | null;
    earliest: HistoricalGroup | null;
    groups: HistoricalGroup[];
  }> {
    const queryGroup = (oldest: boolean) =>
      this.database
        .select({
          messageId: chatMessages.id,
          attachments: chatMessages.attachments,
          createdAt: agentTurns.createdAt,
        })
        .from(chatMessages)
        .innerJoin(agentTurns, eq(agentTurns.id, chatMessages.turnId))
        .where(
          and(
            eq(chatMessages.sessionId, claimed.sessionId),
            eq(agentTurns.userId, claimed.userId),
            eq(chatMessages.role, 'user'),
            sql`${chatMessages.turnId} <> ${claimed.turnId}`,
            sql`${agentTurns.createdAt} < (select created_at from agent_turns where id = ${claimed.turnId} and user_id = ${claimed.userId})`,
            sql`${chatMessages.attachments} @> ${JSON.stringify([{ role: sourceRole }])}::jsonb`,
          ),
        )
        .orderBy(
          oldest ? asc(chatMessages.createdAt) : desc(chatMessages.createdAt),
          oldest ? asc(chatMessages.id) : desc(chatMessages.id),
        )
        .limit(oldest ? 1 : MAX_SESSION_SOURCE_CANDIDATES);
    const [recentMessages, [earliestMessage]] = await Promise.all([
      queryGroup(false),
      queryGroup(true),
    ]);
    const latestMessage = recentMessages[0];
    const parseAttachments = (message: typeof latestMessage) => {
      if (!message) return [];
      const parsed = attachmentSnapshotSchema.array().safeParse(message.attachments);
      if (!parsed.success) return [];
      const attachments = parsed.data
        .filter((item) => item.kind === 'asset' && item.role === sourceRole)
        .sort((left, right) => left.position - right.position)
        .filter(
          (item, index, items) =>
            items.findIndex((other) => other.object_id === item.object_id) === index,
        );
      if (attachments.length > MAX_SESSION_SOURCE_CANDIDATES) {
        throw new Error('SESSION_IMAGE_CANDIDATE_LIMIT_EXCEEDED');
      }
      return attachments;
    };
    const messages = [
      ...new Map(
        [earliestMessage, ...recentMessages]
          .filter((message) => message !== undefined)
          .map((message) => [message.messageId, message]),
      ).values(),
    ].sort(
      (left, right) =>
        left.createdAt.getTime() - right.createdAt.getTime() ||
        left.messageId.localeCompare(right.messageId),
    );
    const attachmentsByMessage = new Map(
      messages.map((message) => [message.messageId, parseAttachments(message)]),
    );
    const sourceIds = [
      ...new Set([...attachmentsByMessage.values()].flat().map((item) => item.object_id)),
    ];
    const sourceRows = sourceIds.length
      ? await this.database
          .select()
          .from(assets)
          .where(and(eq(assets.userId, claimed.userId), inArray(assets.id, sourceIds)))
      : [];
    const sourceById = new Map(sourceRows.map((row) => [row.id, row]));
    const restore = (
      message: typeof latestMessage,
      attachments: ReturnType<typeof parseAttachments>,
    ): HistoricalGroup | null => {
      if (!message) return null;
      const validSources = attachments.map((attachment, index) => {
        const row = sourceById.get(attachment.object_id);
        if (
          !row ||
          attachment.owner_user_id !== claimed.userId ||
          !attachment.readable ||
          attachment.lifecycle !== 'active' ||
          row.userId !== claimed.userId ||
          row.status !== 'ready' ||
          row.deletedAt ||
          !row.mimeType?.startsWith('image/') ||
          row.contentHash !== attachment.content_hash ||
          row.contentHash !== attachment.object_version
        ) {
          return null;
        }
        return sessionImageCandidateSchema.parse({
          ...attachment,
          binding_key: `session-source-${index + 1}`,
          candidate_kind: 'original_source',
          candidate_position: index + 1,
          lineage_source_binding_keys: [],
          ...(message.messageId
            ? {
                source_group: {
                  message_id: message.messageId,
                  created_at: message.createdAt.toISOString(),
                  is_latest_upload: message.messageId === latestMessage?.messageId,
                },
              }
            : {}),
        });
      });
      return {
        messageId: message.messageId,
        createdAt: message.createdAt,
        sources: validSources.filter((source) => source !== null),
      };
    };
    const groups = messages.flatMap((message) => {
      const group = restore(message, attachmentsByMessage.get(message.messageId) ?? []);
      return group ? [group] : [];
    });
    return {
      latest: groups.find((group) => group.messageId === latestMessage?.messageId) ?? null,
      earliest: groups.find((group) => group.messageId === earliestMessage?.messageId) ?? null,
      groups,
    };
  }

  private async resolveOriginalSources(
    artifactId: string,
    sourceRole: SourceRole,
    userId: string,
  ): Promise<Array<{ id: string; version: string }>> {
    const visitedArtifactIds = new Set<string>();
    const sources = new Map<string, string>();
    let frontier = [artifactId];
    while (frontier.length > 0) {
      const current = frontier.filter((id) => !visitedArtifactIds.has(id));
      if (current.length === 0) break;
      current.forEach((id) => visitedArtifactIds.add(id));
      const [bindings, artifactRows] = await Promise.all([
        this.database
          .select({
            artifactId: artifactInputBindings.artifactId,
            sourceType: artifactInputBindings.sourceType,
            sourceAssetId: artifactInputBindings.sourceAssetId,
            sourceArtifactId: artifactInputBindings.sourceArtifactId,
            sourceVersion: artifactInputBindings.sourceVersionOrHash,
            role: artifactInputBindings.role,
            sortOrder: artifactInputBindings.sortOrder,
          })
          .from(artifactInputBindings)
          .innerJoin(artifacts, eq(artifacts.id, artifactInputBindings.artifactId))
          .where(
            and(eq(artifacts.userId, userId), inArray(artifactInputBindings.artifactId, current)),
          )
          .orderBy(asc(artifactInputBindings.sortOrder)),
        this.database
          .select({ id: artifacts.id, sourceArtifactId: artifacts.sourceArtifactId })
          .from(artifacts)
          .where(and(eq(artifacts.userId, userId), inArray(artifacts.id, current))),
      ]);
      const next: string[] = [];
      for (const binding of bindings) {
        if (
          binding.sourceType === 'asset' &&
          binding.role === sourceRole &&
          binding.sourceAssetId
        ) {
          const existing = sources.get(binding.sourceAssetId);
          sources.set(
            binding.sourceAssetId,
            existing === undefined || existing === binding.sourceVersion
              ? binding.sourceVersion
              : '',
          );
        }
        if (binding.sourceType === 'artifact' && binding.sourceArtifactId) {
          next.push(binding.sourceArtifactId);
        }
      }
      for (const row of artifactRows) {
        if (row.sourceArtifactId) next.push(row.sourceArtifactId);
      }
      frontier = [...new Set(next)];
    }
    if (sources.size > MAX_SESSION_SOURCE_CANDIDATES) {
      throw new Error('SESSION_IMAGE_CANDIDATE_LIMIT_EXCEEDED');
    }
    return [...sources].map(([id, version]) => ({ id, version }));
  }
}

function mergeHistoricalSources(
  earliest: SessionImageCandidate[],
  latest: SessionImageCandidate[],
): SessionImageCandidate[] {
  const sources = [
    ...new Map([...earliest, ...latest].map((source) => [source.object_id, source])).values(),
  ];
  if (sources.length > MAX_SESSION_SOURCE_CANDIDATES) {
    throw new Error('SESSION_IMAGE_CANDIDATE_LIMIT_EXCEEDED');
  }
  return sources.map((source, index) =>
    sessionImageCandidateSchema.parse({
      ...source,
      binding_key: `session-source-${index + 1}`,
      candidate_position: index + 1,
      position: index,
    }),
  );
}
