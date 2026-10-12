import { and, artifacts, assets, assetUploadIntents, eq, inArray } from '@ecom-forge/db';
import type { Database } from '@ecom-forge/db';
import type { AttachmentSnapshot } from '@ecom-forge/compiler';
import { Logger } from '@nestjs/common';

import { agentError } from './agent.errors.js';
import type { CreateTurnInput } from './agent.schemas.js';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export class AgentBindingService {
  private readonly logger = new Logger(AgentBindingService.name);

  async resolve(
    transaction: Transaction,
    input: {
      userId: string;
      sessionId: string;
      attachments: CreateTurnInput['attachments'];
    },
  ): Promise<AttachmentSnapshot[]> {
    if (input.attachments.length === 0) return [];
    const requested = await this.normalizeUploads(transaction, input.userId, input.attachments);
    const assetIds = requested
      .filter((item) => item.resource_type === 'asset')
      .map((item) => item.resource_id);
    const artifactIds = requested
      .filter((item) => item.resource_type === 'artifact')
      .map((item) => item.resource_id);
    const [assetRows, artifactRows] = await Promise.all([
      assetIds.length
        ? transaction
            .select()
            .from(assets)
            .where(and(eq(assets.userId, input.userId), inArray(assets.id, assetIds)))
        : [],
      artifactIds.length
        ? transaction
            .select()
            .from(artifacts)
            .where(and(eq(artifacts.userId, input.userId), inArray(artifacts.id, artifactIds)))
        : [],
    ]);
    const assetById = new Map(assetRows.map((row) => [row.id, row]));
    const artifactById = new Map(artifactRows.map((row) => [row.id, row]));
    return requested.map((item) => {
      if (item.resource_type === 'asset') {
        const resource = assetById.get(item.resource_id);
        if (!resource || resource.status !== 'ready' || !resource.contentHash) {
          this.logRejection('asset_not_ready');
          agentError('REFERENCE_NOT_AVAILABLE');
        }
        if (item.resource_version !== resource.contentHash) {
          this.logRejection('asset_version_drift');
          agentError('REFERENCE_NOT_AVAILABLE');
        }
        return {
          binding_key: item.binding_id,
          kind: 'asset' as const,
          object_id: resource.id,
          object_version: resource.contentHash,
          content_hash: resource.contentHash,
          owner_user_id: resource.userId,
          readable: true,
          mutable: false,
          producer_mode: null,
          producer_session_id: null,
          mutation_owner: null,
          source_action: null,
          media_type: 'image' as const,
          lifecycle: 'active' as const,
          visibility: 'private' as const,
          role: item.role,
          position: item.position,
          publication_revision: null,
        };
      }
      const resource = artifactById.get(item.resource_id);
      const publishedVersion = resource?.publishedContentHash ?? resource?.contentHash;
      if (
        !resource ||
        !publishedVersion ||
        resource.visibility === 'quarantined' ||
        resource.visibility === 'deleted'
      ) {
        this.logRejection('artifact_not_available');
        agentError('REFERENCE_NOT_AVAILABLE');
      }
      if (item.resource_version !== publishedVersion) {
        this.logRejection('artifact_version_drift');
        agentError('REFERENCE_NOT_AVAILABLE');
      }
      if (
        item.role === 'edit_source' &&
        (!resource.publishedStorageKey ||
          !resource.publishedContentHash ||
          !resource.publicationSnapshot ||
          resource.producerMode !== 'chat' ||
          resource.producerSessionId !== input.sessionId ||
          resource.mutationOwner !== 'chat_session')
      ) {
        this.logRejection('edit_source_not_mutable');
        agentError('REFERENCE_NOT_AVAILABLE');
      }
      return {
        binding_key: item.binding_id,
        kind: 'artifact' as const,
        object_id: resource.id,
        object_version: publishedVersion,
        content_hash: publishedVersion,
        owner_user_id: resource.userId,
        readable: true,
        mutable:
          resource.producerMode === 'chat' &&
          resource.producerSessionId === input.sessionId &&
          resource.mutationOwner === 'chat_session',
        producer_mode: resource.producerMode,
        producer_session_id: resource.producerSessionId,
        mutation_owner: resource.mutationOwner,
        source_action: resource.sourceAction,
        media_type: resource.type === 'text' ? ('text' as const) : ('image' as const),
        lifecycle: 'active' as const,
        visibility: resource.visibility,
        role: item.role,
        position: item.position,
        publication_revision: resource.publishedContentHash ? resource.publicationRevision : null,
      };
    });
  }

  private async normalizeUploads(
    transaction: Transaction,
    userId: string,
    attachments: CreateTurnInput['attachments'],
  ): Promise<NormalizedAttachment[]> {
    const uploadIds = attachments
      .filter((item) => item.resource_type === 'upload')
      .map((item) => item.resource_id);
    const uploadRows = uploadIds.length
      ? await transaction
          .select()
          .from(assetUploadIntents)
          .where(
            and(eq(assetUploadIntents.userId, userId), inArray(assetUploadIntents.id, uploadIds)),
          )
      : [];
    const uploads = new Map(uploadRows.map((row) => [row.id, row]));
    const normalized: NormalizedAttachment[] = [];
    for (const item of attachments) {
      if (item.resource_type !== 'upload') {
        normalized.push({ ...item, resource_type: item.resource_type });
        continue;
      }
      const upload = uploads.get(item.resource_id);
      if (!upload || upload.status !== 'completed') {
        this.logRejection('upload_not_completed');
        agentError('AGENT_CONTEXT_UNAVAILABLE');
      }
      normalized.push({ ...item, resource_type: 'asset', resource_id: upload.assetId });
    }
    return normalized;
  }

  private logRejection(reason: string): void {
    this.logger.warn({
      event: 'agent_binding_rejected',
      metric: 'agent_binding_rejection_total',
      reason,
    });
  }
}

type NormalizedAttachment = Omit<CreateTurnInput['attachments'][number], 'resource_type'> & {
  resource_type: 'asset' | 'artifact';
};
