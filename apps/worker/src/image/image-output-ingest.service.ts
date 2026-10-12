import { createHash } from 'node:crypto';

import {
  agentTurns,
  and,
  artifactInputBindings,
  artifacts,
  eq,
  storageChannels,
  storageCredentialVersions,
  storageValidationRuns,
  taskAttempts,
  tasks,
  workflowRuns,
  type Database,
} from '@ecom-forge/db';
import type { ProviderImageExecutionOutcome, ProviderImageOutputLease } from '@ecom-forge/provider';
import {
  creativeConstraintsSnapshotSchema,
  creativeExecutionProfileSchema,
  productFactsSnapshotSchema,
} from '@ecom-forge/compiler';
import { createQueueIntentInTransaction } from '@ecom-forge/queue';
import { canonicalSha256 } from '@ecom-forge/shared';
import { LocalPrivateStorage } from '@ecom-forge/storage';
import { z } from 'zod';
import sharp from 'sharp';

import type { WorkerConfig } from '../config/worker-config.js';
import type { WorkerWriteFence } from '../lifecycle/processing-fence.js';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.uuid();

const inputBindingSchema = z.strictObject({
  binding_key: z.string().min(1).max(128),
  kind: z.enum(['asset', 'artifact']),
  object_id: uuid,
  object_version: z.string().min(1).max(128),
  content_hash: sha256,
  role: z.enum([
    'product',
    'style_reference',
    'composition_reference',
    'identity_anchor',
    'semantic_reference',
    'edit_source',
    'other',
  ]),
  sort_order: z.int().min(0).max(15),
  provider_input: z.boolean().default(true),
  publication_revision: z.int().positive().nullable().default(null),
});

const storageSnapshotSchema = z.strictObject({
  schema_version: z.literal(1),
  purpose: z.literal('private_assets'),
  runtime_revision: z.int().positive(),
  channel_id: uuid,
  channel_revision: z.int().positive(),
  adapter_key: z.literal('local-private-v1'),
  endpoint_profile_key: z.literal('local'),
  region: z.string().nullable(),
  credential_version_id: uuid,
  validation_evidence_digest: sha256,
});

const imageTaskParamsSchema = z
  .strictObject({
    source: z.literal('chat'),
    schema_version: z.literal(1),
    operation: z.enum(['image.generate', 'image.edit']),
    goal_summary: z.string().min(1).max(500),
    creative_prompt: z.string().trim().min(1).max(128_000).optional(),
    creative_note: z.string().trim().min(1).max(600).optional(),
    aspect_ratio: z.string().regex(/^[1-9]\d{0,2}:[1-9]\d{0,2}$/),
    resolution_tier: z.enum(['1k', '2k', '4k']),
    output_count: z.int().min(1).max(16),
    output_count_source: z.enum(['user_explicit', 'skill_default']),
    model_snapshot: z.record(z.string(), z.unknown()),
    model_selection: z.record(z.string(), z.unknown()),
    input_bindings: z.array(inputBindingSchema).max(16),
    operation_key: sha256,
    depends_on: z.array(z.string()).max(64),
    storage_snapshot: storageSnapshotSchema,
    product_facts_snapshot: productFactsSnapshotSchema.optional(),
    creative_execution_profile: creativeExecutionProfileSchema.optional(),
    creative_constraints_snapshot: creativeConstraintsSnapshotSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.product_facts_snapshot) {
      const { snapshot_digest: digest, ...snapshot } = value.product_facts_snapshot;
      if (canonicalSha256(snapshot) !== digest) {
        context.addIssue({
          code: 'custom',
          path: ['product_facts_snapshot', 'snapshot_digest'],
          message: 'Product facts snapshot digest is invalid',
        });
      }
    }
  });

type ImageTaskParams = z.infer<typeof imageTaskParamsSchema>;
type SucceededImageOutcome = Extract<ProviderImageExecutionOutcome, { kind: 'succeeded' }>;

export interface IngestedImageArtifact {
  id: string;
  outputIndex: number;
  contentHash: string;
  storageKey: string;
}

export class ImageOutputIngestService {
  private readonly storage: LocalPrivateStorage;

  constructor(
    private readonly database: Database,
    private readonly config: WorkerConfig,
    private readonly writeFence: WorkerWriteFence,
  ) {
    this.storage = new LocalPrivateStorage(config.localUploadRoot);
  }

  async ingest(input: {
    taskId: string;
    workflowRunId: string;
    userId: string;
    attemptId: string;
    traceId: string;
    outcome: SucceededImageOutcome;
  }): Promise<IngestedImageArtifact[]> {
    if (!this.config.storageEnabled) throw new Error('IMAGE_STORAGE_DISABLED');
    const owned = await this.readOwned(input);
    const params = imageTaskParamsSchema.parse(owned.task.paramsSnapshot);
    await this.assertStorageClosure(params.storage_snapshot);
    if (input.outcome.outputs.length !== params.output_count) {
      throw new Error('IMAGE_OUTPUT_COUNT_MISMATCH');
    }
    assertBindingOrder(params.input_bindings);
    await this.storage.initialize();

    const stored: Array<{
      outputIndex: number;
      storageKey: string;
      contentHash: string;
      mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
      width: number;
      height: number;
      byteLength: number;
      providerOutputId: string;
    }> = [];
    for (const [outputIndex, output] of input.outcome.outputs.entries()) {
      stored.push(
        await this.consumeOutput({
          taskId: owned.task.id,
          attemptId: owned.attempt.id,
          outputIndex,
          output,
          rootPrefix: owned.channel.rootPrefix,
        }),
      );
    }

    this.writeFence.assertWritesAllowed();
    return this.database.transaction(async (transaction) => {
      const [locked] = await transaction
        .select({ task: tasks, attempt: taskAttempts, workflow: workflowRuns })
        .from(tasks)
        .innerJoin(taskAttempts, eq(taskAttempts.taskId, tasks.id))
        .innerJoin(workflowRuns, eq(workflowRuns.id, tasks.workflowRunId))
        .where(
          and(
            eq(tasks.id, input.taskId),
            eq(tasks.workflowRunId, input.workflowRunId),
            eq(workflowRuns.userId, input.userId),
            eq(taskAttempts.id, input.attemptId),
          ),
        )
        .for('update')
        .limit(1);
      if (
        !locked ||
        locked.task.status !== 'running' ||
        locked.attempt.status !== 'accepted' ||
        locked.attempt.dispatchState !== 'accepted'
      ) {
        throw new Error('IMAGE_OUTPUT_INGEST_STATE_INVALID');
      }

      const existing = await transaction.query.artifacts.findMany({
        where: eq(artifacts.taskId, locked.task.id),
      });
      if (existing.length > 0) {
        const replay = stored.map((output) => {
          const row = existing.find((artifact) => artifact.storageKey === output.storageKey);
          if (
            !row ||
            row.userId !== input.userId ||
            row.storageChannelId !== params.storage_snapshot.channel_id ||
            row.contentHash !== output.contentHash ||
            row.visibility !== 'quarantined'
          ) {
            throw new Error('IMAGE_OUTPUT_INGEST_REPLAY_CONFLICT');
          }
          return {
            id: row.id,
            outputIndex: output.outputIndex,
            contentHash: output.contentHash,
            storageKey: output.storageKey,
          };
        });
        if (existing.length !== replay.length) {
          throw new Error('IMAGE_OUTPUT_INGEST_REPLAY_CONFLICT');
        }
        return replay;
      }

      const turn = await resolveProducerTurn(
        transaction,
        locked.workflow.id,
        locked.task.parentTaskId,
      );
      if (!turn) throw new Error('IMAGE_OUTPUT_AGENT_TURN_MISSING');
      const originDomain = workflowOriginDomain(
        locked.workflow.planSnapshot,
        Boolean(params.product_facts_snapshot),
      );
      const sourceArtifactId =
        params.operation === 'image.edit'
          ? params.input_bindings.find(
              (binding) =>
                binding.kind === 'artifact' &&
                binding.role === 'edit_source' &&
                binding.provider_input,
            )?.object_id
          : undefined;
      const created: IngestedImageArtifact[] = [];
      for (const output of stored) {
        const [artifact] = await transaction
          .insert(artifacts)
          .values({
            taskId: locked.task.id,
            userId: input.userId,
            productId: locked.workflow.productId,
            type: 'image',
            storageChannelId: params.storage_snapshot.channel_id,
            storageKey: output.storageKey,
            contentHash: output.contentHash,
            metaJson: {
              schema_version: 1,
              output_index: output.outputIndex,
              provider_output_id_hash: createHash('sha256')
                .update(output.providerOutputId)
                .digest('hex'),
              media_type: output.mediaType,
              width: output.width,
              height: output.height,
              byte_length: output.byteLength,
            },
            paramsSnapshot: {
              schema_version: 1,
              operation: params.operation,
              operation_key: params.operation_key,
              model_snapshot_id: locked.task.modelId,
              model_version: locked.task.modelVersion,
              storage_snapshot: params.storage_snapshot,
              ...(params.creative_execution_profile
                ? { creative_execution_profile: params.creative_execution_profile }
                : {}),
              ...(params.creative_constraints_snapshot
                ? { creative_constraints_snapshot: params.creative_constraints_snapshot }
                : {}),
            },
            sourceArtifactId,
            sourceAction: params.operation === 'image.generate' ? 'generate' : 'edit',
            originDomain,
            producerMode: 'chat',
            producerSessionId: turn.sessionId,
            mutationOwner: 'chat_session',
            visibility: 'quarantined',
          })
          .returning({ id: artifacts.id });
        if (!artifact) throw new Error('IMAGE_ARTIFACT_INSERT_FAILED');
        if (params.input_bindings.length > 0) {
          await transaction.insert(artifactInputBindings).values(
            params.input_bindings.map((binding) => ({
              artifactId: artifact.id,
              sourceType: binding.kind,
              ...(binding.kind === 'asset'
                ? { sourceAssetId: binding.object_id }
                : { sourceArtifactId: binding.object_id }),
              sourceVersionOrHash: binding.object_version,
              role: binding.role,
              transformSnapshotJson: {
                schema_version: 1,
                binding_key: binding.binding_key,
                source_content_hash: binding.content_hash,
                provider_input: binding.provider_input,
                publication_revision: binding.publication_revision,
              },
              sortOrder: binding.sort_order,
            })),
          );
        }
        created.push({
          id: artifact.id,
          outputIndex: output.outputIndex,
          contentHash: output.contentHash,
          storageKey: output.storageKey,
        });
      }

      await transaction
        .update(taskAttempts)
        .set({
          status: 'succeeded',
          ...(input.outcome.cost_summary
            ? { providerReportedCost: input.outcome.cost_summary.amount }
            : {}),
          providerReceipt: input.outcome.receipt_summary,
          endedAt: input.outcome.completed_at,
        })
        .where(
          and(
            eq(taskAttempts.id, locked.attempt.id),
            eq(taskAttempts.status, 'accepted'),
            eq(taskAttempts.dispatchState, 'accepted'),
          ),
        );

      const moderationTasks = await transaction.query.tasks.findMany({
        where: and(eq(tasks.parentTaskId, locked.task.id), eq(tasks.type, 'moderation.image')),
        orderBy: (task, { asc }) => [asc(task.dagNodeId)],
      });
      if (moderationTasks.length !== stored.length) {
        throw new Error('IMAGE_MODERATION_TASK_SET_INVALID');
      }
      for (const moderationTask of moderationTasks) {
        const [queued] = await transaction
          .update(tasks)
          .set({ status: 'queued' })
          .where(and(eq(tasks.id, moderationTask.id), eq(tasks.status, 'pending')))
          .returning({ id: tasks.id });
        if (!queued) throw new Error('IMAGE_MODERATION_TASK_QUEUE_FAILED');
        await createQueueIntentInTransaction(transaction, {
          queueName: 'moderation',
          jobId: moderationTask.id,
          aggregateType: 'task',
          aggregateId: moderationTask.id,
          payloadVersion: 4,
          payload: {
            schema_version: 4,
            job_type: 'moderation.execute',
            trace_id: input.traceId,
            task_id: moderationTask.id,
            workflow_run_id: input.workflowRunId,
            user_id: input.userId,
          },
        });
      }
      return created;
    });
  }

  private async readOwned(input: {
    taskId: string;
    workflowRunId: string;
    userId: string;
    attemptId: string;
  }) {
    const [owned] = await this.database
      .select({ task: tasks, attempt: taskAttempts, workflow: workflowRuns })
      .from(tasks)
      .innerJoin(taskAttempts, eq(taskAttempts.taskId, tasks.id))
      .innerJoin(workflowRuns, eq(workflowRuns.id, tasks.workflowRunId))
      .where(
        and(
          eq(tasks.id, input.taskId),
          eq(tasks.workflowRunId, input.workflowRunId),
          eq(workflowRuns.userId, input.userId),
          eq(taskAttempts.id, input.attemptId),
        ),
      )
      .limit(1);
    if (!owned) throw new Error('IMAGE_OUTPUT_OWNERSHIP_INVALID');
    const params = imageTaskParamsSchema.parse(owned.task.paramsSnapshot);
    const channel = await this.database.query.storageChannels.findFirst({
      where: eq(storageChannels.id, params.storage_snapshot.channel_id),
    });
    if (!channel) throw new Error('IMAGE_STORAGE_CHANNEL_MISSING');
    return { ...owned, channel };
  }

  private async assertStorageClosure(snapshot: z.infer<typeof storageSnapshotSchema>) {
    const [channel, credential] = await Promise.all([
      this.database.query.storageChannels.findFirst({
        where: eq(storageChannels.id, snapshot.channel_id),
      }),
      this.database.query.storageCredentialVersions.findFirst({
        where: eq(storageCredentialVersions.id, snapshot.credential_version_id),
      }),
    ]);
    const validation = credential?.validationEvidenceDigest
      ? await this.database.query.storageValidationRuns.findFirst({
          where: and(
            eq(storageValidationRuns.storageChannelId, snapshot.channel_id),
            eq(storageValidationRuns.credentialVersionId, snapshot.credential_version_id),
            eq(storageValidationRuns.status, 'passed'),
            eq(storageValidationRuns.evidenceDigest, snapshot.validation_evidence_digest),
          ),
        })
      : undefined;
    if (
      !channel ||
      channel.revision !== snapshot.channel_revision ||
      channel.adapterKey !== snapshot.adapter_key ||
      channel.endpointProfileKey !== snapshot.endpoint_profile_key ||
      channel.region !== snapshot.region ||
      channel.status !== 'active' ||
      channel.activeCredentialVersionId !== snapshot.credential_version_id ||
      !credential ||
      credential.storageChannelId !== channel.id ||
      credential.status !== 'active' ||
      credential.validationEvidenceDigest !== snapshot.validation_evidence_digest ||
      !validation
    ) {
      throw new Error('IMAGE_STORAGE_CLOSURE_INVALID');
    }
  }

  private async consumeOutput(input: {
    taskId: string;
    attemptId: string;
    outputIndex: number;
    output: ProviderImageOutputLease;
    rootPrefix: string;
  }) {
    return input.output.consume(async (bytes) => {
      const metadata = input.output.metadata;
      const inspected = await inspectOutput(bytes, this.config);
      if (
        inspected.contentHash !== metadata.content_hash ||
        inspected.mediaType !== metadata.media_type ||
        inspected.width !== metadata.width ||
        inspected.height !== metadata.height ||
        bytes.byteLength !== metadata.byte_length
      ) {
        throw new Error('IMAGE_OUTPUT_METADATA_MISMATCH');
      }
      const extension = inspected.mediaType === 'image/jpeg' ? 'jpg' : inspected.mediaType.slice(6);
      const relativeKey = `artifacts/${input.taskId.slice(0, 2)}/${input.taskId}/quarantine/${input.attemptId}/${input.outputIndex}-${inspected.contentHash}.${extension}`;
      const storageKey = input.rootPrefix
        ? `${trimSlashes(input.rootPrefix)}/${relativeKey}`
        : relativeKey;
      await this.writeDeterministic(storageKey, bytes, inspected.contentHash);
      return {
        outputIndex: input.outputIndex,
        storageKey,
        contentHash: inspected.contentHash,
        mediaType: inspected.mediaType,
        width: inspected.width,
        height: inspected.height,
        byteLength: bytes.byteLength,
        providerOutputId: metadata.provider_output_id,
      };
    });
  }

  private async writeDeterministic(
    storageKey: string,
    bytes: Uint8Array,
    expectedHash: string,
  ): Promise<void> {
    try {
      const existing = await this.storage.read(storageKey);
      if (createHash('sha256').update(existing).digest('hex') !== expectedHash) {
        throw new Error('IMAGE_QUARANTINE_HASH_CONFLICT');
      }
      return;
    } catch (error) {
      if (error instanceof Error && error.message === 'IMAGE_QUARANTINE_HASH_CONFLICT') throw error;
    }
    try {
      await this.storage.writeExclusive(storageKey, bytes);
    } catch {
      const raced = await this.storage.read(storageKey);
      if (createHash('sha256').update(raced).digest('hex') !== expectedHash) {
        throw new Error('IMAGE_QUARANTINE_HASH_CONFLICT');
      }
    }
    const persisted = await this.storage.read(storageKey);
    if (createHash('sha256').update(persisted).digest('hex') !== expectedHash) {
      throw new Error('IMAGE_QUARANTINE_HASH_MISMATCH');
    }
  }
}

async function inspectOutput(bytes: Uint8Array, config: WorkerConfig) {
  if (bytes.byteLength <= 0 || bytes.byteLength > config.storageMaxImageBytes) {
    throw new Error('IMAGE_OUTPUT_SIZE_INVALID');
  }
  const metadata = await sharp(bytes, {
    failOn: 'error',
    limitInputPixels: config.storageMaxImagePixels,
    sequentialRead: true,
  }).metadata();
  const mediaType =
    metadata.format === 'png'
      ? ('image/png' as const)
      : metadata.format === 'jpeg'
        ? ('image/jpeg' as const)
        : metadata.format === 'webp'
          ? ('image/webp' as const)
          : undefined;
  if (!mediaType || !metadata.width || !metadata.height) {
    throw new Error('IMAGE_OUTPUT_FORMAT_INVALID');
  }
  if (
    metadata.width > config.storageMaxImageWidth ||
    metadata.height > config.storageMaxImageHeight ||
    metadata.width * metadata.height > config.storageMaxImagePixels
  ) {
    throw new Error('IMAGE_OUTPUT_DIMENSIONS_INVALID');
  }
  await sharp(bytes, { failOn: 'error', limitInputPixels: config.storageMaxImagePixels })
    .raw()
    .toBuffer();
  return {
    contentHash: createHash('sha256').update(bytes).digest('hex'),
    mediaType,
    width: metadata.width,
    height: metadata.height,
  };
}

function assertBindingOrder(bindings: ImageTaskParams['input_bindings']): void {
  const orders = bindings.map((binding) => binding.sort_order);
  if (new Set(orders).size !== orders.length) throw new Error('IMAGE_BINDING_ORDER_INVALID');
}

export function workflowOriginDomain(
  snapshot: unknown,
  hasProductFacts: boolean,
): 'creative' | 'commerce' {
  if (hasProductFacts) return 'commerce';
  const plan = snapshot as { canonical_plan?: { intent?: { kind?: string } } };
  return plan.canonical_plan?.intent?.kind === 'commerce_generate' ? 'commerce' : 'creative';
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, '');
}

export { imageTaskParamsSchema, storageSnapshotSchema };

export async function resolveProducerTurn(
  transaction: Parameters<Parameters<Database['transaction']>[0]>[0],
  workflowRunId: string,
  parentTaskId: string | null,
): Promise<{ sessionId: string } | undefined> {
  const direct = await transaction.query.agentTurns.findFirst({
    where: eq(agentTurns.workflowRunId, workflowRunId),
    columns: { sessionId: true },
  });
  if (direct) return direct;

  const visited = new Set<string>();
  let taskId = parentTaskId;
  while (taskId && visited.size < 16) {
    if (visited.has(taskId)) throw new Error('IMAGE_OUTPUT_TASK_LINEAGE_CYCLE');
    visited.add(taskId);
    const parent = await transaction.query.tasks.findFirst({
      where: eq(tasks.id, taskId),
      columns: { workflowRunId: true, parentTaskId: true },
    });
    if (!parent) return undefined;
    const turn = await transaction.query.agentTurns.findFirst({
      where: eq(agentTurns.workflowRunId, parent.workflowRunId),
      columns: { sessionId: true },
    });
    if (turn) return turn;
    taskId = parent.parentTaskId;
  }
  return undefined;
}
