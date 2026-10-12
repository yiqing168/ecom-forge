import { createHash } from 'node:crypto';

import {
  and,
  artifactEvaluations,
  artifacts,
  contentReviewCases,
  eq,
  inArray,
  sql,
  taskAttempts,
  tasks,
  workflowRuns,
  type Database,
} from '@ecom-forge/db';
import { LocalPrivateStorage } from '@ecom-forge/storage';
import {
  NOOP_EVENT_WAKE_PUBLISHER,
  type EventWake,
  type EventWakePublisher,
} from '@ecom-forge/shared';
import sharp from 'sharp';

import type { WorkerConfig } from '../config/worker-config.js';
import { appendOutboxEventInTransaction } from '../database/outbox.repository.js';
import { advanceTaskInTransaction } from '../database/workflow-state.repository.js';
import type { WorkerWriteFence } from '../lifecycle/processing-fence.js';

export class ImagePublicationService {
  private readonly storage: LocalPrivateStorage;

  constructor(
    private readonly database: Database,
    private readonly config: WorkerConfig,
    private readonly writeFence: WorkerWriteFence,
    private readonly eventWakePublisher: EventWakePublisher = NOOP_EVENT_WAKE_PUBLISHER,
  ) {
    this.storage = new LocalPrivateStorage(config.localUploadRoot);
  }

  async publish(input: {
    artifactId: string;
    evaluationId: string;
    moderationTaskId: string;
    moderationAttemptId: string;
    workflowRunId: string;
    userId: string;
    manualReviewCaseId?: string;
  }): Promise<void> {
    const artifact = await this.database.query.artifacts.findFirst({
      where: and(eq(artifacts.id, input.artifactId), eq(artifacts.userId, input.userId)),
    });
    if (!artifact) throw new Error('IMAGE_PUBLICATION_ARTIFACT_MISSING');
    if (artifact.visibility !== 'quarantined') {
      if (artifact.visibility === 'private' && artifact.publishedStorageKey) return;
      throw new Error('IMAGE_PUBLICATION_STATE_INVALID');
    }
    if (artifact.publishedStorageKey) return;
    await this.storage.initialize();
    const source = await this.storage.read(artifact.storageKey);
    if (!artifact.contentHash || digest(source) !== artifact.contentHash) {
      throw new Error('IMAGE_PUBLICATION_SOURCE_HASH_DRIFT');
    }
    const { bytes: publishedBytes, pixelHash } = await stripMetadata(source, this.config);
    const publishedHash = digest(publishedBytes);
    const rootPrefix = rootPrefixFromKey(artifact.storageKey);
    const relativeKey = `artifacts/${artifact.id.slice(0, 2)}/${artifact.id}/published/${publishedHash}.png`;
    const publishedKey = rootPrefix ? `${rootPrefix}/${relativeKey}` : relativeKey;
    const thumbnailBytes = await createThumbnail(publishedBytes, this.config);
    const thumbnailHash = digest(thumbnailBytes);
    const thumbnailRelativeKey = `artifacts/${artifact.id.slice(0, 2)}/${artifact.id}/published/thumb-${thumbnailHash}.webp`;
    const thumbnailKey = rootPrefix
      ? `${rootPrefix}/${thumbnailRelativeKey}`
      : thumbnailRelativeKey;
    await this.writeDeterministic(publishedKey, publishedBytes, publishedHash);
    await this.writeDeterministic(thumbnailKey, thumbnailBytes, thumbnailHash);

    this.writeFence.assertWritesAllowed();
    const wakes = await this.database.transaction(async (transaction) => {
      const [moderationClosure] = await transaction
        .select({ parentTaskId: tasks.parentTaskId })
        .from(tasks)
        .where(eq(tasks.id, input.moderationTaskId))
        .limit(1);
      if (!moderationClosure?.parentTaskId) {
        throw new Error('IMAGE_PUBLICATION_PARENT_TASK_MISSING');
      }
      const [generationTask] = await transaction
        .select()
        .from(tasks)
        .where(eq(tasks.id, moderationClosure.parentTaskId))
        .for('update')
        .limit(1);
      if (!generationTask) throw new Error('IMAGE_PUBLICATION_PARENT_TASK_MISSING');

      const [owned] = await transaction
        .select({
          artifact: artifacts,
          evaluation: artifactEvaluations,
          moderationTask: tasks,
          moderationAttempt: taskAttempts,
          workflow: workflowRuns,
        })
        .from(artifacts)
        .innerJoin(artifactEvaluations, eq(artifactEvaluations.artifactId, artifacts.id))
        .innerJoin(tasks, eq(tasks.id, artifactEvaluations.taskId))
        .innerJoin(taskAttempts, eq(taskAttempts.id, artifactEvaluations.taskAttemptId))
        .innerJoin(workflowRuns, eq(workflowRuns.id, tasks.workflowRunId))
        .where(
          and(
            eq(artifacts.id, input.artifactId),
            eq(artifactEvaluations.id, input.evaluationId),
            eq(tasks.id, input.moderationTaskId),
            eq(taskAttempts.id, input.moderationAttemptId),
            eq(workflowRuns.id, input.workflowRunId),
            eq(workflowRuns.userId, input.userId),
          ),
        )
        .for('update')
        .limit(1);
      if (!owned) throw new Error('IMAGE_PUBLICATION_OWNERSHIP_INVALID');
      if (owned.artifact.visibility === 'private' && owned.artifact.publishedStorageKey) {
        return [];
      }
      if (
        !(
          owned.evaluation.status === 'pass' &&
          owned.moderationTask.status === 'running' &&
          owned.moderationAttempt.status === 'accepted' &&
          owned.moderationAttempt.dispatchState === 'accepted' &&
          input.manualReviewCaseId === undefined
        ) &&
        !(await this.isManualReleaseValid(transaction, owned, input.manualReviewCaseId))
      ) {
        throw new Error('IMAGE_PUBLICATION_APPROVAL_INVALID');
      }
      const [published] = await transaction
        .update(artifacts)
        .set({
          publishedStorageKey: publishedKey,
          publishedContentHash: publishedHash,
          thumbnailKey,
          publicationSnapshot: {
            schema_version: 1,
            source_content_hash: owned.artifact.contentHash,
            published_content_hash: publishedHash,
            thumbnail_content_hash: thumbnailHash,
            pixel_hash: pixelHash,
            metadata_policy: 'strip-nonessential-v1',
            product_watermark_applied: false,
            ai_generation_label_embedded: false,
            evaluation_id: owned.evaluation.id,
            evaluator_version: owned.evaluation.evaluatorVersion,
            release_basis:
              input.manualReviewCaseId === undefined ? 'automatic_pass' : 'manual_review_release',
            ...(input.manualReviewCaseId
              ? { content_review_case_id: input.manualReviewCaseId }
              : {}),
          },
          publicationRevision: sql`${artifacts.publicationRevision} + 1`,
        })
        .where(
          and(
            eq(artifacts.id, owned.artifact.id),
            eq(artifacts.visibility, 'quarantined'),
            eq(artifacts.publicationRevision, owned.artifact.publicationRevision),
          ),
        )
        .returning({ id: artifacts.id });
      if (!published) throw new Error('IMAGE_PUBLICATION_CAS_FAILED');
      const expectedAttemptStatus = input.manualReviewCaseId ? 'outcome_unknown' : 'accepted';
      const expectedDispatchState = input.manualReviewCaseId ? 'outcome_unknown' : 'accepted';
      const [completedAttempt] = await transaction
        .update(taskAttempts)
        .set({ status: 'succeeded', dispatchState: 'accepted', endedAt: new Date() })
        .where(
          and(
            eq(taskAttempts.id, owned.moderationAttempt.id),
            eq(taskAttempts.status, expectedAttemptStatus),
            eq(taskAttempts.dispatchState, expectedDispatchState),
          ),
        )
        .returning({ id: taskAttempts.id });
      if (!completedAttempt) throw new Error('IMAGE_PUBLICATION_ATTEMPT_CAS_FAILED');
      const moderationTransition = await advanceTaskInTransaction(transaction, {
        taskId: owned.moderationTask.id,
        workflowRunId: owned.workflow.id,
        userId: owned.workflow.userId,
        from: input.manualReviewCaseId ? 'waiting_manual_review' : 'running',
        to: 'succeeded',
        now: new Date(),
      });
      const result: EventWake[] = moderationTransition.wake ? [moderationTransition.wake] : [];
      const siblings = await transaction.query.tasks.findMany({
        where: and(eq(tasks.parentTaskId, generationTask.id), eq(tasks.type, 'moderation.image')),
        columns: { status: true },
      });
      if (siblings.every((task) => task.status === 'succeeded')) {
        const generationAttempt = await transaction.query.taskAttempts.findFirst({
          where: and(
            eq(taskAttempts.taskId, generationTask.id),
            eq(taskAttempts.status, 'succeeded'),
          ),
        });
        const reservationId = owned.workflow.reservationId;
        if (!generationAttempt || !reservationId) {
          throw new Error('IMAGE_PUBLICATION_SETTLEMENT_CLOSURE_INVALID');
        }
        const outputArtifacts = await transaction.query.artifacts.findMany({
          where: eq(artifacts.taskId, generationTask.id),
          columns: { id: true, visibility: true, publishedStorageKey: true },
        });
        if (
          outputArtifacts.length !== siblings.length ||
          outputArtifacts.some(
            (item) => item.visibility !== 'quarantined' || !item.publishedStorageKey,
          )
        ) {
          throw new Error('IMAGE_PUBLICATION_OUTPUT_SET_INVALID');
        }
        const outputArtifactIds = outputArtifacts.map((item) => item.id).sort();
        const opened = await transaction
          .update(artifacts)
          .set({ visibility: 'private' })
          .where(
            and(inArray(artifacts.id, outputArtifactIds), eq(artifacts.visibility, 'quarantined')),
          )
          .returning({ id: artifacts.id });
        if (opened.length !== outputArtifactIds.length) {
          throw new Error('IMAGE_PUBLICATION_VISIBILITY_CAS_FAILED');
        }
        const generationTransition = await advanceTaskInTransaction(transaction, {
          taskId: generationTask.id,
          workflowRunId: owned.workflow.id,
          userId: owned.workflow.userId,
          from: 'running',
          to: 'succeeded',
          now: new Date(),
          settlement: {
            taskAttemptId: generationAttempt.id,
            reservationId,
            ...(generationAttempt.providerReportedCost
              ? { providerReportedCost: generationAttempt.providerReportedCost }
              : {}),
            artifactIds: outputArtifactIds,
          },
        });
        if (generationTransition.wake) result.push(generationTransition.wake);
        for (const artifactId of outputArtifactIds) {
          const artifactEvent = await appendOutboxEventInTransaction(transaction, {
            scopeType: 'workflow_run',
            scopeId: owned.workflow.id,
            eventType: 'artifact.created',
            payload: {
              artifact_id: artifactId,
              task_id: generationTask.id,
              visibility: 'private',
            },
            retentionTier: 'critical',
          });
          result.push({
            schema_version: 1,
            scope_type: 'workflow_run',
            scope_id: owned.workflow.id,
            event_seq: artifactEvent.eventSeq,
          });
        }
      }
      return result;
    });
    await Promise.all(
      wakes.map((wake) => this.eventWakePublisher.publish(wake).catch(() => undefined)),
    );
  }

  private async isManualReleaseValid(
    transaction: Parameters<Parameters<Database['transaction']>[0]>[0],
    owned: {
      artifact: typeof artifacts.$inferSelect;
      evaluation: typeof artifactEvaluations.$inferSelect;
      moderationTask: typeof tasks.$inferSelect;
      moderationAttempt: typeof taskAttempts.$inferSelect;
    },
    reviewCaseId: string | undefined,
  ): Promise<boolean> {
    if (
      !reviewCaseId ||
      owned.evaluation.status !== 'unknown' ||
      owned.moderationTask.status !== 'waiting_manual_review' ||
      owned.moderationAttempt.status !== 'outcome_unknown' ||
      owned.moderationAttempt.dispatchState !== 'outcome_unknown'
    ) {
      return false;
    }
    const review = await transaction.query.contentReviewCases.findFirst({
      where: and(
        eq(contentReviewCases.id, reviewCaseId),
        eq(contentReviewCases.artifactId, owned.artifact.id),
        eq(contentReviewCases.evaluationId, owned.evaluation.id),
        eq(contentReviewCases.status, 'released'),
      ),
    });
    return Boolean(review?.decision === 'release' && review.decidedByAdminId && review.decidedAt);
  }

  private async writeDeterministic(key: string, bytes: Uint8Array, expectedHash: string) {
    try {
      const existing = await this.storage.read(key);
      if (digest(existing) !== expectedHash) throw new Error('IMAGE_PUBLICATION_HASH_CONFLICT');
      return;
    } catch (error) {
      if (error instanceof Error && error.message === 'IMAGE_PUBLICATION_HASH_CONFLICT')
        throw error;
    }
    try {
      await this.storage.writeExclusive(key, bytes);
    } catch {
      const raced = await this.storage.read(key);
      if (digest(raced) !== expectedHash) throw new Error('IMAGE_PUBLICATION_HASH_CONFLICT');
    }
    if (digest(await this.storage.read(key)) !== expectedHash) {
      throw new Error('IMAGE_PUBLICATION_HASH_MISMATCH');
    }
  }
}

async function stripMetadata(bytes: Uint8Array, config: WorkerConfig) {
  const source = sharp(bytes, {
    failOn: 'error',
    limitInputPixels: config.storageMaxImagePixels,
    sequentialRead: true,
  });
  const sourceRaw = await source.clone().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const published = await source
    .clone()
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
  const publishedRaw = await sharp(published, {
    failOn: 'error',
    limitInputPixels: config.storageMaxImagePixels,
  })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const sourcePixelHash = digest(sourceRaw.data);
  if (
    sourceRaw.info.width !== publishedRaw.info.width ||
    sourceRaw.info.height !== publishedRaw.info.height ||
    sourcePixelHash !== digest(publishedRaw.data)
  ) {
    throw new Error('IMAGE_PUBLICATION_PIXEL_DRIFT');
  }
  return { bytes: published, pixelHash: sourcePixelHash };
}

async function createThumbnail(bytes: Uint8Array, config: WorkerConfig): Promise<Buffer> {
  return sharp(bytes, {
    failOn: 'error',
    limitInputPixels: config.storageMaxImagePixels,
    sequentialRead: true,
  })
    .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82, effort: 4 })
    .toBuffer();
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function rootPrefixFromKey(storageKey: string): string {
  const marker = '/artifacts/';
  const index = storageKey.indexOf(marker);
  return index < 0 ? '' : storageKey.slice(0, index);
}
