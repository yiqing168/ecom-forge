import { randomInt, randomUUID } from 'node:crypto';

import {
  agentConfirmationContextSchema,
  agentConfirmationDependencies,
  agentConfirmedFactDependencySchema,
  authoredPromptsSchema,
  prepareAgentConfirmationContext,
  prepareAgentTranscriptItem,
  prepareAgentTranscriptPayload,
  type AgentTranscriptItem,
  type AgentTranscriptItemContracts,
} from '@ecom-forge/agent';
import { attachmentSnapshotSchema, type AttachmentSnapshot } from '@ecom-forge/compiler';
import {
  agentTranscriptItems,
  agentTranscriptPayloads,
  agentTraces,
  agentTraceSteps,
  agentTurns,
  agentTurnConfirmations,
  assets,
  chatMessages,
  chatSessions,
  createDatabaseClient,
  eq,
  productFactSets,
  products,
  runQuotes,
  skillCatalogReleases,
  skillPackages,
  skillPackageResources,
  skillPackageValidationReports,
  skillResourceSnapshots,
  skills,
  sql,
  users,
} from '@ecom-forge/db';
import { canonicalSha256, utf8Sha256 } from '@ecom-forge/shared';
import {
  getBuiltinSkillCatalog,
  parseSkillDefinition,
  validateSkillSelection,
  type SkillSelectionSnapshot,
} from '@ecom-forge/skills';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  AgentTranscriptRepository,
  type AgentTranscriptRepositoryOptions,
} from '../src/agent/agent-transcript.repository.js';
import type { ClaimedAgentTurn, Transaction } from '../src/agent/agent-turn.types.js';
import { recordModelStepDiagnostic } from '../src/agent/agent-model-step-diagnostic.js';
import {
  AgentTranscriptUserMessageAuthorizer,
  transcriptUserMessageContract,
  verifyTranscriptUserMessageSource,
} from '../src/agent/agent-transcript-message-binding.js';
import { AgentTranscriptConfirmationBinding } from '../src/agent/agent-transcript-confirmation-binding.js';
import { AgentTranscriptCoreSkillBinding } from '../src/agent/agent-transcript-skill-binding.js';
import { AgentTranscriptCoreSkillReader } from '../src/agent/agent-transcript-skill-reader.js';
import {
  prepareTranscriptCoreSkillContext,
  transcriptCoreSkillContextSchema,
  transcriptCoreSkillDependencies,
  transcriptSkillDependencySchema,
} from '../src/agent/agent-transcript-skill-context.js';
import {
  prepareTranscriptKnowledgeBatch,
  prepareTranscriptKnowledgeResult,
  transcriptKnowledgeToolContracts,
  verifyTranscriptKnowledgeResultSource,
} from '../src/agent/agent-transcript-tool-contracts.js';
import {
  prepareTranscriptModelInputBinding,
  prepareTranscriptModelOutputBinding,
} from '../src/agent/agent-transcript-model-binding.js';
import {
  prepareTranscriptTerminalOutput,
  prepareTranscriptTerminalResult,
  transcriptTerminalContracts,
} from '../src/agent/agent-transcript-terminal-contracts.js';
import {
  AgentTranscriptTerminalBinding,
  prepareTranscriptTerminalResultBinding,
} from '../src/agent/agent-transcript-terminal-binding.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || process.env.NODE_ENV === 'production') {
  throw new Error('Transcript read tests require an explicit isolated TEST_DATABASE_URL');
}
const target = new URL(databaseUrl);
if (!/^\/ecom_forge_test(?:_[a-z0-9_]+)?$/.test(target.pathname)) {
  throw new Error('Transcript read tests refuse a non-test database');
}
const resource = createDatabaseClient({
  databaseUrl,
  maxConnections: 2,
  statementTimeoutMs: 5_000,
});
const textContract = { schema: z.strictObject({ text: z.string() }) };
const unavailable = { schema: z.never() };
const contracts: AgentTranscriptItemContracts = {
  userMessage: textContract,
  legacyMessage: { ...textContract, privatePayloadKind: 'legacy_message' },
  hostContexts: [],
  resourceDependencySchema: z.never(),
  calls: [
    {
      name: 'agent_authoring@1',
      mode: 'terminal',
      arguments: { schema: authoredPromptsSchema, privatePayloadKind: 'authoring' },
      results: {
        succeeded: textContract,
        rejected: unavailable,
        not_executed: unavailable,
        unknown: unavailable,
      },
    },
  ],
};
const nativeContracts: AgentTranscriptItemContracts = {
  ...contracts,
  userMessage: transcriptUserMessageContract,
  resourceDependencySchema: attachmentSnapshotSchema,
};

beforeAll(async () => {
  const rows = await resource.db.execute(sql`select
    to_regclass('public.agent_transcript_items')::text as items,
    to_regclass('public.agent_transcript_payloads')::text as payloads`);
  if (!rows[0]?.items || !rows[0]?.payloads) {
    throw new Error(
      'Isolated database must already have migration 0038; this suite never migrates',
    );
  }
});
afterAll(() => resource.client.end());

interface Fixture {
  tx: Transaction;
  userId: string;
  sessionId: string;
  turnId: string;
  messageId: string;
  itemId: string;
  assistantId: string;
  payloadId: string;
  traceId: string;
  stepId: string;
  authored: z.infer<typeof authoredPromptsSchema>;
  attachments: AttachmentSnapshot[];
}

async function withFixture(check: (fixture: Fixture) => Promise<void>, native = false) {
  const userId = randomUUID();
  const sessionId = randomUUID();
  const turnId = randomUUID();
  const messageId = randomUUID();
  const itemId = randomUUID();
  const assistantId = randomUUID();
  const payloadId = randomUUID();
  const traceId = randomUUID();
  const stepId = randomUUID();
  const assetId = randomUUID();
  const attachments: AttachmentSnapshot[] = native
    ? [
        {
          binding_key: randomUUID(),
          kind: 'asset',
          object_id: assetId,
          object_version: 'a'.repeat(64),
          content_hash: 'a'.repeat(64),
          owner_user_id: userId,
          readable: true,
          mutable: false,
          producer_mode: null,
          producer_session_id: null,
          mutation_owner: null,
          source_action: null,
          media_type: 'image',
          lifecycle: 'active',
          visibility: 'private',
          role: 'semantic_reference',
          position: 7,
          publication_revision: null,
        },
      ]
    : [];
  const rollback = new Error('ROLLBACK_TRANSCRIPT_READ_FIXTURE');
  try {
    await resource.db.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout = '1s'`);
      await tx.execute(sql`set local statement_timeout = '5s'`);
      await tx.insert(users).values({
        id: userId,
        email: `${userId}@example.test`,
        displayName: 'Transcript read fixture',
      });
      await tx.insert(chatSessions).values({
        id: sessionId,
        userId,
        title: 'Transcript read fixture',
        transcriptNextSequence: 3n,
        transcriptGeneration: 1n,
        messageHistoryRevision: 1n,
        transcriptStateJson: {
          schema_version: 1,
          mode: 'active',
          integrity_version: 1,
          verified_through_sequence: '2',
          verified_digest: 'b'.repeat(64),
        },
      });
      await tx
        .insert(agentTurns)
        .values({ id: turnId, sessionId, userId, status: 'done', transcriptCaptureVersion: 1 });
      if (native) {
        await tx.insert(assets).values({
          id: assetId,
          userId,
          storageKey: `fixture/${assetId}`,
          thumbnailKey: `fixture/${assetId}/thumb`,
          contentHash: 'a'.repeat(64),
          fileSizeBytes: 128n,
          mimeType: 'image/png',
          kind: 'upload',
          origin: 'upload',
          status: 'ready',
        });
      }
      await tx
        .insert(chatMessages)
        .values({ id: messageId, sessionId, turnId, role: 'user', content: 'hello', attachments });
      await tx
        .insert(agentTraces)
        .values({ id: traceId, turnId, sessionId, userId, brainModelId: 'fixture' });
      // This fixture's model input is exactly the synthetic source message above.
      const modelInput = prepareTranscriptModelInputBinding(
        {
          step_id: stepId,
          continuation_no: 1,
          resource_dependencies: attachments,
        },
        native ? nativeContracts.resourceDependencySchema : contracts.resourceDependencySchema,
      );
      await tx.insert(agentTraceSteps).values({
        id: stepId,
        traceId,
        stepNo: 1,
        stepType: 'llm_call',
        actor: 'agent',
        status: 'started',
        inputSummary: { purpose: 'agent_step', continuation_no: 1, transcript_input: modelInput },
        outputSummary: {},
      });
      const authored = authoredPromptsSchema.parse({
        prompts: [
          {
            candidate_key: 'main',
            creative_prompt: 'Preserve the subject and the original light. '.repeat(2_000).trim(),
          },
        ],
      });
      const privateValue = prepareAgentTranscriptPayload(
        {
          id: payloadId,
          user_id: userId,
          session_id: sessionId,
          turn_id: turnId,
          import_attempt_id: null,
          schema_version: 1,
          kind: 'authoring',
          content_json: authored,
        },
        { kind: 'authoring', contentSchema: authoredPromptsSchema },
      );
      await tx.insert(agentTranscriptPayloads).values({
        id: payloadId,
        userId,
        sessionId,
        turnId,
        kind: 'authoring',
        contentJson: privateValue.record.content_json,
        contentDigest: privateValue.record.content_digest,
        byteSize: privateValue.record.byte_size,
      });
      const common = {
        user_id: userId,
        session_id: sessionId,
        turn_id: turnId,
        continuation_no: 1,
        schema_version: 1,
        source_trace_step_id: null,
        import_attempt_id: null,
        reply_to_item_id: null,
        call_ordinal: null,
        resource_dependencies_json: [],
        created_at: '2026-09-08T00:00:00.000Z',
      };
      for (const raw of [
        {
          ...common,
          id: itemId,
          sequence_no: '1',
          item_type: 'user_message',
          source_key: `message:${messageId}`,
          source_message_id: messageId,
          resource_dependencies_json: attachments,
          payload_json: {
            schema_version: 1,
            type: 'user_message',
            content: {
              type: 'inline',
              value: native ? { text: 'hello', attachments } : { text: 'hello' },
            },
          },
        },
        {
          ...common,
          id: assistantId,
          sequence_no: '2',
          item_type: 'assistant_output',
          source_key: `model:${stepId}:output`,
          source_message_id: null,
          source_trace_step_id: stepId,
          resource_dependencies_json: attachments,
          payload_json: {
            schema_version: 1,
            type: 'assistant_output',
            mode: 'terminal',
            calls: [
              {
                name: 'agent_authoring@1',
                arguments: privateValue.reference,
                arguments_digest: privateValue.record.content_digest,
                provider_call_id: null,
              },
            ],
          },
        },
      ]) {
        const { item } = prepareAgentTranscriptItem(raw, native ? nativeContracts : contracts);
        await tx.insert(agentTranscriptItems).values({
          id: item.id,
          userId,
          sessionId,
          turnId,
          continuationNo: item.continuation_no,
          sequenceNo: BigInt(item.sequence_no),
          itemType: item.item_type,
          sourceKey: item.source_key,
          sourceMessageId: item.source_message_id,
          sourceTraceStepId: item.source_trace_step_id,
          payloadJson: item.payload_json,
          payloadDigest: item.payload_digest,
          resourceDependenciesJson: item.resource_dependencies_json,
        });
        if (item.item_type === 'assistant_output') {
          await tx
            .update(agentTraceSteps)
            .set({
              status: 'succeeded',
              outputSummary: {
                transcript_output: prepareTranscriptModelOutputBinding(
                  item,
                  modelInput,
                  native ? nativeContracts : contracts,
                ),
              },
            })
            .where(eq(agentTraceSteps.id, stepId));
        }
      }
      await check({
        tx,
        userId,
        sessionId,
        turnId,
        messageId,
        itemId,
        assistantId,
        payloadId,
        traceId,
        stepId,
        authored,
        attachments,
      });
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
  expect(
    await resource.db.query.chatSessions.findFirst({ where: eq(chatSessions.id, sessionId) }),
  ).toBeUndefined();
}

describe('downstream model diagnostics preserve captured provenance', () => {
  it.each(['succeeded', 'failed', 'blocked'] as const)(
    'keeps accepted model history after a %s business result',
    (status) =>
      withFixture(async (fixture) => {
        const before = await fixture.tx.query.agentTraceSteps.findFirst({
          where: eq(agentTraceSteps.id, fixture.stepId),
        });
        await recordModelStepDiagnostic(fixture.tx, {
          claimed: { ...fixture, traceId: fixture.traceId } as unknown as ClaimedAgentTurn,
          llmStepId: fixture.stepId,
          transcriptCaptureVersion: 1,
          update: {
            outputSummary: { outcome: 'candidate_plan', compiler_result: status },
            ...(status !== 'succeeded' ? { status, errorCode: 'COMPILER_PLAN_REJECTED' } : {}),
          },
        });
        const after = await fixture.tx.query.agentTraceSteps.findFirst({
          where: eq(agentTraceSteps.id, fixture.stepId),
        });
        expect(after?.status).toBe('succeeded');
        expect(after?.errorCode).toBeNull();
        expect(after?.inputSummary).toEqual(before?.inputSummary);
        expect(after?.tokenUsageJson).toEqual(before?.tokenUsageJson);
        expect(after?.outputSummary).toMatchObject(
          z.record(z.string(), z.unknown()).parse(before!.outputSummary),
        );
        expect(after?.outputSummary).toHaveProperty('downstream.compiler_result', status);
        const read = await reader(fixture).readItem({
          userId: fixture.userId,
          sessionId: fixture.sessionId,
          itemId: fixture.assistantId,
        });
        expect(read.private_payloads[0]?.value).toEqual(fixture.authored);
      }),
  );

  it('rejects diagnostic writes for a non-capturing turn', () =>
    withFixture(async (fixture) => {
      const update = {
        status: 'blocked' as const,
        errorCode: 'COMPILER_PLAN_REJECTED',
        outputSummary: { outcome: 'candidate_plan', compiler_result: 'rejected' },
      };
      await expect(
        recordModelStepDiagnostic(fixture.tx, {
          claimed: fixture as unknown as ClaimedAgentTurn,
          llmStepId: fixture.stepId,
          transcriptCaptureVersion: null,
          update,
        }),
      ).rejects.toThrow('AGENT_TRANSCRIPT_CAPTURE_VERSION_INVALID');
    }));

  it.each(['userId', 'sessionId', 'turnId', 'traceId'] as const)(
    'refuses a foreign %s without changing the model step',
    (key) =>
      withFixture(async (fixture) => {
        const before = await fixture.tx.query.agentTraceSteps.findFirst({
          where: eq(agentTraceSteps.id, fixture.stepId),
        });
        await expect(
          recordModelStepDiagnostic(fixture.tx, {
            claimed: { ...fixture, [key]: randomUUID() } as unknown as ClaimedAgentTurn,
            llmStepId: fixture.stepId,
            transcriptCaptureVersion: 1,
            update: { outputSummary: { outcome: 'respond' } },
          }),
        ).rejects.toThrow('AGENT_MODEL_STEP_SOURCE_INVALID');
        expect(
          await fixture.tx.query.agentTraceSteps.findFirst({
            where: eq(agentTraceSteps.id, fixture.stepId),
          }),
        ).toEqual(before);
      }),
  );
});

function reader(fixture: Fixture, overrides: Partial<AgentTranscriptRepositoryOptions> = {}) {
  return new AgentTranscriptRepository(fixture.tx, {
    itemContracts: contracts,
    // Synthetic host authorization only. Production authorizers are a separate integration gate.
    authorizeDependencies: ({ dependencies }) => dependencies.length === 0,
    verifyMessageSource: ({ item, source }) =>
      item.payload_json.type === 'user_message' &&
      canonicalSha256(item.payload_json.content.value) ===
        canonicalSha256({ text: source.content }),
    ...overrides,
  });
}

function request(fixture: Fixture) {
  return { userId: fixture.userId, sessionId: fixture.sessionId, itemId: fixture.itemId };
}

const terminalContracts: AgentTranscriptItemContracts = {
  ...contracts,
  calls: transcriptTerminalContracts,
};

type TerminalFixture = Fixture & {
  result: AgentTranscriptItem;
  parent: AgentTranscriptItem;
  sourceId: string;
  repo: AgentTranscriptRepository;
};

async function withTerminalFixture(
  kind: 'message' | 'clarification' | 'quote' | 'authoring',
  check: (fixture: TerminalFixture) => Promise<void>,
) {
  return withFixture(async (fixture) => {
    const { tx, userId, sessionId, turnId, stepId } = fixture;
    const sourceId = randomUUID();
    const metadata = {
      id: fixture.assistantId,
      user_id: userId,
      session_id: sessionId,
      turn_id: turnId,
      continuation_no: 1,
      sequence_no: '2',
      schema_version: 1 as const,
      source_message_id: null,
      source_trace_step_id: stepId,
      import_attempt_id: null,
      reply_to_item_id: null,
      call_ordinal: null,
      resource_dependencies_json: [],
      created_at: '2026-09-08T00:00:00.000Z',
    };
    const usage = { input_tokens: 1, output_tokens: 2 };
    const plan = {
      schema_version: 1,
      intent: { kind: 'creative_generate', confidence: 1 },
      skill_id: 'fixture@1.0.0',
      source: 'chat',
      nodes: [
        {
          candidate_key: 'one',
          capability: 'image.generate',
          capability_version: 1,
          input_bindings: [],
          depends_on: [],
          params: {},
          expected_output: 'image',
        },
      ],
    };
    const outcome =
      kind === 'message'
        ? { type: 'respond', text: 'Fixture answer', usage }
        : kind === 'clarification'
          ? { type: 'request_clarification', question: 'Which one?', usage }
          : { type: kind === 'authoring' ? 'authoring_request' : 'candidate_plan', plan, usage };
    const prepared = prepareTranscriptTerminalOutput(
      {
        metadata,
        outcome,
        phase: 'planning',
        privatePayloadId: randomUUID(),
      },
      terminalContracts,
    );
    const parent = prepared.item;
    for (const payload of prepared.privatePayloads) {
      await tx.insert(agentTranscriptPayloads).values({
        id: payload.id,
        userId,
        sessionId,
        turnId,
        kind: payload.kind,
        contentJson: payload.content_json,
        contentDigest: payload.content_digest,
        byteSize: payload.byte_size,
      });
    }
    await tx
      .update(agentTranscriptItems)
      .set({
        payloadJson: parent.payload_json,
        payloadDigest: parent.payload_digest,
        createdAt: new Date(parent.created_at),
      })
      .where(eq(agentTranscriptItems.id, parent.id));
    let receipt: unknown;
    if (kind === 'message') {
      await tx.insert(chatMessages).values({
        id: sourceId,
        sessionId,
        turnId,
        role: 'assistant',
        content: 'Fixture answer',
      });
      receipt = {
        type: 'message_published',
        message_id: sourceId,
        content_digest: canonicalSha256({ text: 'Fixture answer' }),
      };
    } else if (kind === 'clarification') {
      const payload = {
        schema_version: 1,
        question: 'Which one?',
        options: [],
        allow_free_text: true,
        max_response_chars: 2000,
      };
      await tx.insert(agentTurnConfirmations).values({
        id: sourceId,
        userId,
        turnId,
        confirmationNo: 1,
        type: 'clarification',
        answerSchemaVersion: 1,
        publicPayloadJson: payload,
        payloadDigest: canonicalSha256(payload),
        expiresAt: new Date('2026-09-08T00:30:00.000Z'),
      });
      receipt = {
        type: 'confirmation_requested',
        confirmation_id: sourceId,
        payload_digest: canonicalSha256(payload),
      };
    } else if (kind === 'quote') {
      await tx.insert(runQuotes).values({
        id: sourceId,
        userId,
        source: 'chat',
        sourceId: turnId,
        promptPreview: {},
        estimatedCallCount: 1,
        estimatedTotalCredits: '0.00',
        idempotencyKey: sourceId,
        inputSignature: sourceId,
        submissionMode: 'auto_submit',
        planDigest: 'c'.repeat(64),
        authorizationDigest: 'd'.repeat(64),
        confirmationSnapshot: {},
        expiresAt: new Date('2026-09-08T00:30:00.000Z'),
      });
      receipt = { type: 'quote_created', quote_id: sourceId, plan_digest: 'c'.repeat(64) };
    } else {
      receipt = { type: 'authoring_required', plan_digest: canonicalSha256({ plan }) };
    }
    const result = prepareTranscriptTerminalResult(
      {
        metadata: { ...metadata, id: randomUUID(), sequence_no: '3' },
        parent,
        status: 'succeeded',
        result: receipt,
      },
      terminalContracts,
    );
    await tx.insert(agentTranscriptItems).values({
      id: result.id,
      userId,
      sessionId,
      turnId,
      continuationNo: 1,
      sequenceNo: 3n,
      itemType: 'tool_result',
      sourceKey: result.source_key,
      sourceTraceStepId: stepId,
      replyToItemId: parent.id,
      callOrdinal: 0,
      payloadJson: result.payload_json,
      payloadDigest: result.payload_digest,
      resourceDependenciesJson: result.resource_dependencies_json,
      createdAt: new Date(result.created_at),
    });
    const input = prepareTranscriptModelInputBinding(
      { step_id: stepId, continuation_no: 1, resource_dependencies: [] },
      terminalContracts.resourceDependencySchema,
    );
    await tx
      .update(agentTraceSteps)
      .set({
        outputSummary: {
          transcript_output: prepareTranscriptModelOutputBinding(parent, input, terminalContracts),
          transcript_result: prepareTranscriptTerminalResultBinding(
            result,
            parent,
            terminalContracts,
          ),
        },
      })
      .where(eq(agentTraceSteps.id, stepId));
    await tx
      .update(chatSessions)
      .set({ transcriptNextSequence: 4n })
      .where(eq(chatSessions.id, sessionId));
    const binder = new AgentTranscriptTerminalBinding(tx, terminalContracts);
    const repo = reader(fixture, {
      itemContracts: terminalContracts,
      verifyToolResultSource: (item) => binder.verifySource(item),
    });
    await check({ ...fixture, parent, result, sourceId, repo });
  });
}

describe('terminal source PostgreSQL reads', () => {
  it.each(['message', 'clarification', 'quote', 'authoring'] as const)(
    'reads a %s receipt from its actual persisted source',
    (kind) =>
      withTerminalFixture(kind, async (f) => {
        const result = await f.repo.readItem({ ...request(f), itemId: f.result.id });
        expect(result.item.payload_json).toEqual(f.result.payload_json);
        expect(result.private_payloads).toEqual([]);
      }),
  );

  it('rejects a changed public message without relying on an asynchronous sweeper', () =>
    withTerminalFixture('message', async (f) => {
      await f.tx
        .update(chatMessages)
        .set({ content: 'Changed' })
        .where(eq(chatMessages.id, f.sourceId));
      await expect(f.repo.readItem({ ...request(f), itemId: f.result.id })).rejects.toMatchObject({
        reason: 'source_invalid',
      });
    }));

  it('rejects a same-owner message moved to another turn', () =>
    withTerminalFixture('message', async (f) => {
      const other = randomUUID();
      await f.tx
        .insert(agentTurns)
        .values({ id: other, userId: f.userId, sessionId: f.sessionId, status: 'done' });
      await f.tx.update(chatMessages).set({ turnId: other }).where(eq(chatMessages.id, f.sourceId));
      await expect(f.repo.readItem({ ...request(f), itemId: f.result.id })).rejects.toMatchObject({
        reason: 'source_invalid',
      });
    }));

  it('rejects a changed confirmation payload even when its old digest remains', () =>
    withTerminalFixture('clarification', async (f) => {
      await f.tx
        .update(agentTurnConfirmations)
        .set({ publicPayloadJson: {} })
        .where(eq(agentTurnConfirmations.id, f.sourceId));
      await expect(f.repo.readItem({ ...request(f), itemId: f.result.id })).rejects.toMatchObject({
        reason: 'source_invalid',
      });
    }));

  it('rejects a quote bound to a different turn', () =>
    withTerminalFixture('quote', async (f) => {
      await f.tx
        .update(runQuotes)
        .set({ sourceId: randomUUID() })
        .where(eq(runQuotes.id, f.sourceId));
      await expect(f.repo.readItem({ ...request(f), itemId: f.result.id })).rejects.toMatchObject({
        reason: 'source_invalid',
      });
    }));

  it('does not require a quote to stay unsubmitted to remember its creation', () =>
    withTerminalFixture('quote', async (f) => {
      await f.tx.update(runQuotes).set({ status: 'expired' }).where(eq(runQuotes.id, f.sourceId));
      expect((await f.repo.readItem({ ...request(f), itemId: f.result.id })).item.id).toBe(
        f.result.id,
      );
    }));

  it('rejects a missing result marker before host authorization', () =>
    withTerminalFixture('message', async (f) => {
      const step = await f.tx.query.agentTraceSteps.findFirst({
        where: eq(agentTraceSteps.id, f.stepId),
      });
      const summary = step!.outputSummary as Record<string, unknown>;
      await f.tx
        .update(agentTraceSteps)
        .set({ outputSummary: { transcript_output: summary.transcript_output } })
        .where(eq(agentTraceSteps.id, f.stepId));
      let authorized = false;
      const binder = new AgentTranscriptTerminalBinding(f.tx, terminalContracts);
      const repo = reader(f, {
        itemContracts: terminalContracts,
        verifyToolResultSource: (input) => binder.verifySource(input),
        authorizeDependencies: () => {
          authorized = true;
          return true;
        },
      });
      await expect(repo.readItem({ ...request(f), itemId: f.result.id })).rejects.toMatchObject({
        reason: 'source_invalid',
      });
      expect(authorized).toBe(false);
    }));
});

function nativeReader(fixture: Fixture) {
  const authorizer = new AgentTranscriptUserMessageAuthorizer(fixture.tx);
  return reader(fixture, {
    itemContracts: nativeContracts,
    verifyMessageSource: verifyTranscriptUserMessageSource,
    authorizeDependencies: ({ item }) => authorizer.authorize(item),
  });
}

async function withConfirmationFixture(
  check: (
    fixture: Fixture & { confirmationId: string; productId: string; factSetId: string },
  ) => Promise<void>,
  productFacts = true,
) {
  await withFixture(async (fixture) => {
    const { tx, userId, sessionId, turnId } = fixture;
    const confirmationId = randomUUID(),
      productId = randomUUID(),
      factSetId = randomUUID(),
      hostId = randomUUID();
    const assetId = fixture.attachments[0]!.object_id;
    const facts = {
      product_name: 'Product',
      primary_colors: ['red', 'red'],
      logos: [],
      visible_text: [],
      materials: [],
      must_preserve: [],
      unknown_fields: [],
    };
    if (productFacts) {
      await tx.insert(products).values({ id: productId, userId, name: 'Product' });
      await tx.update(assets).set({ productId }).where(eq(assets.id, assetId));
      await tx.insert(productFactSets).values({
        id: factSetId,
        userId,
        productId,
        versionNo: 1,
        sourceAssetId: assetId,
        sourceVersion: 'a'.repeat(64),
        factsJson: { ...facts, primary_colors: ['red'] },
        confirmedBy: userId,
        confirmedAt: new Date(),
      });
      await tx
        .update(products)
        .set({ latestFactSetId: factSetId })
        .where(eq(products.id, productId));
    }
    const publicPayloadJson = productFacts
      ? {
          schema_version: 1,
          mode: 'create_product',
          source_asset_id: assetId,
          source_version: 'a'.repeat(64),
          candidate_facts: facts,
          required_fields: ['product_name'],
        }
      : {
          schema_version: 1,
          question: 'Choose one',
          options: [{ id: 'soft', label: 'Soft light' }],
          allow_free_text: true,
          max_response_chars: 2000,
        };
    const source = {
      id: confirmationId,
      turnId,
      userId,
      type: productFacts ? ('product_facts' as const) : ('clarification' as const),
      confirmationNo: 1,
      status: 'answered' as const,
      answerSchemaVersion: 1,
      publicPayloadJson,
      payloadDigest: canonicalSha256(publicPayloadJson),
      answerJson: productFacts
        ? { facts, product_id: productId, fact_set_id: factSetId, fact_set_version: 1 }
        : { selected_option_id: 'soft', selected_option_label: 'Soft light' },
      idempotencyKey: confirmationId,
      requestHash: 'b'.repeat(64),
      responseJson: {
        turn_id: turnId,
        user_status: 'thinking',
        revision: 3,
        continuation_no: 2,
        event_scope: `turn:${turnId}`,
        last_event_seq: 1,
      },
      answeredAt: new Date('2026-09-08T00:00:00.000Z'),
      expiresAt: new Date('2026-09-08T00:01:00.000Z'),
    };
    await tx.insert(agentTurnConfirmations).values(source);
    await tx.update(agentTurns).set({ continuationNo: 2 }).where(eq(agentTurns.id, turnId));
    await tx
      .update(chatSessions)
      .set({ transcriptNextSequence: 4n })
      .where(eq(chatSessions.id, sessionId));
    const content = prepareAgentConfirmationContext(source)!;
    const item = prepareAgentTranscriptItem(
      {
        id: hostId,
        user_id: userId,
        session_id: sessionId,
        turn_id: turnId,
        continuation_no: 2,
        sequence_no: '3',
        schema_version: 1,
        item_type: 'host_context',
        source_key: `confirmation:${confirmationId}:answered`,
        source_message_id: null,
        source_trace_step_id: null,
        import_attempt_id: null,
        reply_to_item_id: null,
        call_ordinal: null,
        payload_json: {
          schema_version: 1,
          type: 'host_context',
          name: 'confirmation_answer@1',
          content: { type: 'inline', value: content },
        },
        resource_dependencies_json: agentConfirmationDependencies(userId, content),
        created_at: '2026-09-08T00:00:00.000Z',
      },
      confirmationContracts,
    ).item;
    await tx.insert(agentTranscriptItems).values({
      id: hostId,
      userId,
      sessionId,
      turnId,
      continuationNo: 2,
      sequenceNo: 3n,
      itemType: item.item_type,
      sourceKey: item.source_key,
      payloadJson: item.payload_json,
      payloadDigest: item.payload_digest,
      resourceDependenciesJson: item.resource_dependencies_json,
    });
    await check({ ...fixture, itemId: hostId, confirmationId, productId, factSetId });
  }, true);
}

interface SkillFixture extends Fixture {
  packageId: string;
  reportId: string;
  snapshotId: string;
  releaseId: string;
  selection: SkillSelectionSnapshot;
}

async function withSkillFixture(check: (fixture: SkillFixture) => Promise<void>) {
  return withFixture(async (fixture) => {
    const { tx } = fixture;
    const packageId = randomUUID(),
      reportId = randomUUID(),
      snapshotId = randomUUID();
    const resourceId = randomUUID(),
      releaseId = randomUUID(),
      itemId = randomUUID();
    const slug = `transcript-${randomUUID()}`;
    const skillId = `${slug}@1.0.0`;
    const contentText = 'Preserve the original subject.\n';
    const contentHash = utf8Sha256(contentText);
    const definition = parseSkillDefinition({
      schema_version: 1,
      slug,
      version: '1.0.0',
      display_name: 'Transcript knowledge fixture',
      description: 'Test knowledge',
      category: 'test',
      kind: 'primary',
      visibility: 'public',
      domain: 'creative',
      stage: '1A',
      planning_view: { path: 'SKILL.md', content_hash: contentHash },
    });
    const definitionHash = canonicalSha256(definition);
    const packageDigest = canonicalSha256({ packageId });
    await tx.insert(skillPackages).values({
      id: packageId,
      status: 'approved',
      packageDigest,
      sourceType: 'first_party',
      quarantineStorageKey: `fixture/${packageId}`,
      uploadExpiresAt: new Date('2026-09-07T00:00:00.000Z'),
    });
    await tx.insert(skillPackageValidationReports).values({
      id: reportId,
      packageRecordId: packageId,
      packageRevision: 1,
      packageDigest,
      attemptNo: 1,
      status: 'passed',
      validatorContractVersion: 'fixture@1',
      platformEvalSuiteDigest: 'a'.repeat(64),
      reportJson: { fixture: true },
      reportDigest: canonicalSha256({ fixture: true }),
      completedAt: new Date(),
    });
    await tx
      .update(skillPackages)
      .set({ approvedValidationReportId: reportId })
      .where(eq(skillPackages.id, packageId));
    await tx.insert(skills).values({
      id: skillId,
      slug,
      name: definition.display_name,
      category: 'test',
      domain: 'creative',
      kind: 'primary',
      visibility: 'public',
      stage: '1A',
      version: '1.0.0',
      packageRecordId: packageId,
      definitionJson: definition,
      definitionHash,
      price: {},
      status: 'published',
      publishedAt: new Date(),
    });
    await tx.insert(skillPackageResources).values({
      id: resourceId,
      packageRecordId: packageId,
      resourcePath: `skills/${slug}/SKILL.md`,
      resourceType: 'skill_definition',
      mediaType: 'text/markdown',
      byteSize: Buffer.byteLength(contentText),
      contentHash,
      storageKey: `fixture/${resourceId}`,
      rightsMetadataJson: {},
      // The install contract permits a null informational skill_id on a package resource.
    });
    await tx.insert(skillResourceSnapshots).values({
      id: snapshotId,
      skillId,
      resourcePath: 'SKILL.md',
      resourceType: 'planning_view',
      contentHash,
      packageResourceId: resourceId,
      contentText,
      kvKey: `fixture/${snapshotId}`,
      summaryJson: {},
    });
    const manifest = {
      schema_version: 1,
      packages: [
        {
          package_record_id: packageId,
          validation_report_id: reportId,
          package_digest: packageDigest,
          skills: [
            {
              skill_id: skillId,
              definition_hash: definitionHash,
              resources: [
                {
                  skill_resource_snapshot_id: snapshotId,
                  package_resource_id: resourceId,
                  resource_path: 'SKILL.md',
                  content_hash: contentHash,
                },
              ],
            },
          ],
        },
      ],
    };
    const selection: SkillSelectionSnapshot = {
      primary_skill_id: skillId,
      primary_name: definition.display_name,
      primary_definition_hash: definitionHash,
      primary_package_record_id: packageId,
      primary_planning_resource: {
        resource_snapshot_id: snapshotId,
        package_resource_id: resourceId,
        resource_path: 'SKILL.md',
        resource_hash: contentHash,
      },
      primary_reference_resources: [],
      required_capabilities: [],
      default_output_count: 1,
      catalog_release_id: releaseId,
      catalog_version: canonicalSha256(manifest),
      preset_selections: [],
      required_auxiliary: [],
      optional_auxiliary: [],
    };
    await tx.insert(skillCatalogReleases).values({
      id: releaseId,
      releaseNo: randomInt(1, 2_000_000_000),
      status: 'published',
      releaseDigest: selection.catalog_version,
      manifestJson: manifest,
      reason: 'Rollback-only test fixture',
      createdBy: 'system',
      publishedAt: new Date(),
    });
    const stored = await bindSkillContext(fixture, selection, itemId);
    await check({ ...stored, packageId, reportId, snapshotId, releaseId, selection });
  });
}

async function bindSkillContext(
  fixture: Fixture,
  selection: SkillSelectionSnapshot,
  itemId = randomUUID(),
) {
  const { tx, userId, sessionId, turnId } = fixture;
  await tx
    .update(agentTurns)
    .set({
      primarySkillId: selection.primary_skill_id,
      skillSelectionSnapshotJson: selection,
      skillSelectionSnapshotHash: canonicalSha256(selection),
    })
    .where(eq(agentTurns.id, turnId));
  await tx
    .update(chatSessions)
    .set({ transcriptNextSequence: 4n })
    .where(eq(chatSessions.id, sessionId));
  const context = prepareTranscriptCoreSkillContext(selection);
  const item = prepareAgentTranscriptItem(
    {
      id: itemId,
      user_id: userId,
      session_id: sessionId,
      turn_id: turnId,
      continuation_no: 1,
      sequence_no: '3',
      schema_version: 1,
      item_type: 'host_context',
      source_key: `turn:${turnId}:continuation:1:core-skill`,
      source_message_id: null,
      source_trace_step_id: null,
      import_attempt_id: null,
      reply_to_item_id: null,
      call_ordinal: null,
      payload_json: {
        schema_version: 1,
        type: 'host_context',
        name: 'core_skill_knowledge@1',
        content: { type: 'inline', value: context },
      },
      resource_dependencies_json: transcriptCoreSkillDependencies(context),
      created_at: '2026-09-08T00:00:00.000Z',
    },
    skillContracts,
  ).item;
  await tx.insert(agentTranscriptItems).values({
    id: itemId,
    userId,
    sessionId,
    turnId,
    continuationNo: 1,
    sequenceNo: 3n,
    itemType: item.item_type,
    sourceKey: item.source_key,
    payloadJson: item.payload_json,
    payloadDigest: item.payload_digest,
    resourceDependenciesJson: item.resource_dependencies_json,
  });
  return { ...fixture, itemId };
}

const skillContracts: AgentTranscriptItemContracts = {
  ...contracts,
  hostContexts: [
    { name: 'core_skill_knowledge@1', content: { schema: transcriptCoreSkillContextSchema } },
  ],
  resourceDependencySchema: transcriptSkillDependencySchema,
};

function skillReader(fixture: Fixture) {
  const binding = new AgentTranscriptCoreSkillBinding(fixture.tx);
  return reader(fixture, {
    itemContracts: skillContracts,
    verifyHostContextSource: (item) => binding.verifySource(item),
    authorizeDependencies: ({ item }) => binding.authorizeDependencies(item),
  });
}

const knowledgeContracts: AgentTranscriptItemContracts = {
  ...nativeContracts,
  calls: transcriptKnowledgeToolContracts,
  resourceDependencySchema: z.union([attachmentSnapshotSchema, transcriptSkillDependencySchema]),
};

interface KnowledgeFixture extends Fixture {
  parent: AgentTranscriptItem;
  result: AgentTranscriptItem;
  options: AgentTranscriptRepositoryOptions;
}

async function withKnowledgeFixture(
  tool: 'inspect_image' | 'load_skill',
  check: (fixture: KnowledgeFixture) => Promise<void>,
) {
  const setup = async (fixture: Fixture) => {
    const { tx, userId, sessionId, turnId } = fixture;
    const sourceRequest = request(fixture);
    const sourceReader = tool === 'inspect_image' ? nativeReader(fixture) : skillReader(fixture);
    const source = await sourceReader.readItem(sourceRequest);
    const dependencies = source.item.resource_dependencies_json;
    const traceId = fixture.traceId,
      stepId = randomUUID();
    const modelInput = prepareTranscriptModelInputBinding(
      {
        step_id: stepId,
        continuation_no: 1,
        resource_dependencies: dependencies,
      },
      knowledgeContracts.resourceDependencySchema,
    );
    await tx.insert(agentTraceSteps).values({
      id: stepId,
      traceId,
      stepNo: 2,
      stepType: 'llm_call',
      actor: 'agent',
      status: 'started',
      inputSummary: { purpose: 'agent_step', continuation_no: 1, transcript_input: modelInput },
      outputSummary: {},
    });
    const session = await tx.query.chatSessions.findFirst({
      where: eq(chatSessions.id, sessionId),
    });
    const sequence = session!.transcriptNextSequence;
    const metadata = {
      id: randomUUID(),
      user_id: userId,
      session_id: sessionId,
      turn_id: turnId,
      continuation_no: 1,
      sequence_no: sequence.toString(),
      schema_version: 1 as const,
      source_message_id: null,
      source_trace_step_id: stepId,
      import_attempt_id: null,
      reply_to_item_id: null,
      call_ordinal: null,
      resource_dependencies_json: dependencies,
      created_at: '2026-09-08T00:00:00.000Z',
    };
    const skill =
      tool === 'load_skill' ? transcriptSkillDependencySchema.parse(dependencies[0]) : null;
    const parent = prepareTranscriptKnowledgeBatch(
      metadata,
      [
        {
          name: `${tool}@1`,
          call_id: 'fixture-call',
          arguments: skill
            ? { skill_id: skill.skill_id, view: 'planning' }
            : {
                binding_key: fixture.attachments[0]!.binding_key,
                detail: 'detail',
              },
        },
      ],
      knowledgeContracts,
    );
    const result = prepareTranscriptKnowledgeResult(
      {
        metadata: {
          ...metadata,
          id: randomUUID(),
          sequence_no: (sequence + 1n).toString(),
          source_trace_step_id: null,
        },
        parent,
        ordinal: 0,
        status: 'succeeded',
        result: skill
          ? {
              skill_id: skill.skill_id,
              view: 'planning',
              already_loaded: false,
              resources: [skill],
            }
          : {
              binding: fixture.attachments[0],
              detail: 'detail',
              materialized: true,
            },
      },
      knowledgeContracts,
    );
    for (const item of [parent, result]) {
      await tx.insert(agentTranscriptItems).values({
        id: item.id,
        userId,
        sessionId,
        turnId,
        continuationNo: item.continuation_no,
        sequenceNo: BigInt(item.sequence_no),
        itemType: item.item_type,
        sourceKey: item.source_key,
        sourceTraceStepId: item.source_trace_step_id,
        replyToItemId: item.reply_to_item_id,
        callOrdinal: item.call_ordinal,
        payloadJson: item.payload_json,
        payloadDigest: item.payload_digest,
        resourceDependenciesJson: item.resource_dependencies_json,
        createdAt: new Date(item.created_at),
      });
    }
    await tx
      .update(agentTraceSteps)
      .set({
        status: 'succeeded',
        outputSummary: {
          outcome: 'tool_calls',
          transcript_output: prepareTranscriptModelOutputBinding(
            parent,
            modelInput,
            knowledgeContracts,
          ),
        },
      })
      .where(eq(agentTraceSteps.id, stepId));
    await tx
      .update(chatSessions)
      .set({ transcriptNextSequence: sequence + 2n })
      .where(eq(chatSessions.id, sessionId));
    await check({
      ...fixture,
      itemId: result.id,
      parent,
      result,
      options: {
        itemContracts: knowledgeContracts,
        verifyToolResultSource: (input) =>
          verifyTranscriptKnowledgeResultSource(input, knowledgeContracts),
        // This fixture's model input is exactly one verified native input item. No general model-input authorizer is claimed.
        authorizeDependencies: async ({ dependencies: actual }) => {
          const current = await sourceReader.readItem(sourceRequest);
          return (
            canonicalSha256(actual) === canonicalSha256(current.item.resource_dependencies_json)
          );
        },
      },
    });
  };
  return tool === 'inspect_image' ? withFixture(setup, true) : withSkillFixture(setup);
}

describe('knowledge tool transcript PostgreSQL pairing', () => {
  it.each(['inspect_image', 'load_skill'] as const)(
    'reads an exactly paired %s result with live source authorization',
    (tool) =>
      withKnowledgeFixture(tool, async (fixture) => {
        const result = await new AgentTranscriptRepository(fixture.tx, fixture.options).readItem(
          request(fixture),
        );
        expect(result.item).toEqual(fixture.result);
        expect(result.private_payloads).toEqual([]);
      }),
  );

  it('rejects an image result even if the stored argument digest is changed to match a different original request', () =>
    withKnowledgeFixture('inspect_image', async (fixture) => {
      const payload = fixture.parent.payload_json;
      if (payload.type !== 'assistant_output') throw new Error('Unexpected fixture parent');
      const args = { binding_key: fixture.attachments[0]!.binding_key, detail: 'overview' };
      const changedParent = {
        ...payload,
        calls: [
          {
            ...payload.calls[0]!,
            arguments: { type: 'inline', value: args },
            arguments_digest: canonicalSha256(args),
          },
        ],
      };
      await fixture.tx
        .update(agentTranscriptItems)
        .set({ payloadJson: changedParent, payloadDigest: canonicalSha256(changedParent) })
        .where(eq(agentTranscriptItems.id, fixture.parent.id));
      const changedResult = {
        ...fixture.result.payload_json,
        arguments_digest: canonicalSha256(args),
      };
      await fixture.tx
        .update(agentTranscriptItems)
        .set({ payloadJson: changedResult, payloadDigest: canonicalSha256(changedResult) })
        .where(eq(agentTranscriptItems.id, fixture.result.id));
      await expect(
        new AgentTranscriptRepository(fixture.tx, fixture.options).readItem(request(fixture)),
      ).rejects.toMatchObject({ reason: 'source_invalid' });
    }));

  it('rejects a result that omits the model input dependencies', () =>
    withKnowledgeFixture('inspect_image', async (fixture) => {
      await fixture.tx
        .update(agentTranscriptItems)
        .set({ resourceDependenciesJson: [] })
        .where(eq(agentTranscriptItems.id, fixture.result.id));
      await expect(
        new AgentTranscriptRepository(fixture.tx, fixture.options).readItem(request(fixture)),
      ).rejects.toMatchObject({ reason: 'item_invalid' });
    }));

  it('rejects a validly hashed Skill result that changes the original view', () =>
    withKnowledgeFixture('load_skill', async (fixture) => {
      const payload = fixture.result.payload_json;
      if (payload.type !== 'tool_result' || payload.result.type !== 'inline')
        throw new Error('Unexpected fixture result');
      const value = payload.result.value as Record<string, unknown>;
      const changed = {
        ...payload,
        result: { type: 'inline', value: { ...value, view: 'references' } },
      };
      await fixture.tx
        .update(agentTranscriptItems)
        .set({ payloadJson: changed, payloadDigest: canonicalSha256(changed) })
        .where(eq(agentTranscriptItems.id, fixture.result.id));
      await expect(
        new AgentTranscriptRepository(fixture.tx, fixture.options).readItem(request(fixture)),
      ).rejects.toMatchObject({ reason: 'source_invalid' });
    }));

  it('rechecks live image ownership after host materialization', () =>
    withKnowledgeFixture('inspect_image', async (fixture) => {
      const repo = new AgentTranscriptRepository(fixture.tx, fixture.options);
      await expect(
        repo.readMaterializedItem(request(fixture), async () => {
          await fixture.tx
            .update(assets)
            .set({ status: 'deleted', deletedAt: new Date() })
            .where(eq(assets.id, fixture.attachments[0]!.object_id));
          return 'must not escape';
        }),
      ).rejects.toMatchObject({ reason: 'dependencies_unauthorized' });
    }));
});

describe('core Skill transcript PostgreSQL binding', () => {
  it.each([false, true])(
    'reads built-in knowledge through owned PostgreSQL history (version drift: %s)',
    (drift) =>
      withFixture(async (fixture) => {
        const catalog = await getBuiltinSkillCatalog();
        const primary = catalog.skills.find(
          (entry) =>
            entry.definition.kind === 'primary' && entry.definition.preset_slots.length === 0,
        )!;
        const selected = validateSkillSelection({
          selection: { primary_skill_id: primary.skillId, preset_selections: [] },
          definition: primary.definition,
          definitionHash: primary.definitionHash,
          packageRecordId: primary.packageRecordId,
          planningResource: primary.resources.get('SKILL.md')!,
          catalogReleaseId: primary.catalogReleaseId,
          catalogVersion: primary.catalogVersion,
          resourceSnapshots: primary.resources,
          dependencySnapshots: new Map(
            primary.definition.dependencies.map((dependency) => {
              const auxiliary = catalog.skills.find(
                (entry) => entry.skillId === dependency.skill_id,
              )!;
              return [
                dependency.skill_id,
                {
                  skill_id: auxiliary.skillId,
                  name: auxiliary.definition.display_name,
                  definition_hash: auxiliary.definitionHash,
                  package_record_id: auxiliary.packageRecordId,
                  planning_resource: auxiliary.resources.get('SKILL.md')!,
                  reference_resources: auxiliary.definition.references.map((ref) =>
                    auxiliary.resources.get(ref.path)!,
                  ),
                },
              ];
            }),
          ),
        }).snapshot;
        if (drift) selected.primary_skill_id = `${primary.definition.slug}@9999.0.0`;
        const stored = await bindSkillContext(fixture, selected);
        const reading = new AgentTranscriptCoreSkillReader(fixture.tx).read(request(stored));
        if (drift) {
          await expect(reading).rejects.toMatchObject({ reason: 'dependencies_unauthorized' });
        } else {
          const result = await reading;
          expect(result.resources[0]!.content).toBe(primary.resourceContent.get('SKILL.md'));
          expect(utf8Sha256(result.resources[0]!.content)).toBe(result.resources[0]!.resource_hash);
        }
      }),
  );

  it('materializes the exact authorized Skill text without storing it in the transcript', () =>
    withSkillFixture(async (fixture) => {
      const result = await new AgentTranscriptCoreSkillReader(fixture.tx).read(request(fixture));
      expect(result.resources[0]?.content).toBe('Preserve the original subject.\n');
      expect(result.history_generation).toBe('1');
      expect(Object.isFrozen(result.resources[0])).toBe(true);
      const stored = await fixture.tx.query.agentTranscriptItems.findFirst({
        where: eq(agentTranscriptItems.id, fixture.itemId),
      });
      expect(JSON.stringify(stored?.payloadJson)).not.toContain('Preserve the original subject');
    }));

  it('rejects body corruption even when the metadata hashes still match', () =>
    withSkillFixture(async (fixture) => {
      await fixture.tx
        .update(skillResourceSnapshots)
        .set({ contentText: 'Changed body' })
        .where(eq(skillResourceSnapshots.id, fixture.snapshotId));
      await expect(
        new AgentTranscriptCoreSkillReader(fixture.tx).read(request(fixture)),
      ).rejects.toMatchObject({ reason: 'payload_invalid' });
    }));

  it('rejects a missing Skill body instead of loading a newer version', () =>
    withSkillFixture(async (fixture) => {
      await fixture.tx
        .update(skillResourceSnapshots)
        .set({ contentText: null })
        .where(eq(skillResourceSnapshots.id, fixture.snapshotId));
      await expect(
        new AgentTranscriptCoreSkillReader(fixture.tx).read(request(fixture)),
      ).rejects.toMatchObject({ reason: 'payload_invalid' });
    }));

  it('does not query Skill text for a revoked package', () =>
    withSkillFixture(async (fixture) => {
      await fixture.tx
        .update(skillPackages)
        .set({ riskStatus: 'critical' })
        .where(eq(skillPackages.id, fixture.packageId));
      const snapshots = fixture.tx.query.skillResourceSnapshots;
      const findMany = snapshots.findMany.bind(snapshots);
      let bodyReads = 0;
      snapshots.findMany = ((config: Parameters<typeof findMany>[0]) => {
        if (config?.columns?.contentText) bodyReads++;
        return findMany(config);
      }) as typeof snapshots.findMany;
      await expect(
        new AgentTranscriptCoreSkillReader(fixture.tx).read(request(fixture)),
      ).rejects.toMatchObject({ reason: 'dependencies_unauthorized' });
      expect(bodyReads).toBe(0);
    }));

  it.each(['package', 'generation', 'archive'] as const)(
    'rejects %s changes occurring during body materialization',
    (change) =>
      withSkillFixture(async (fixture) => {
        const snapshots = fixture.tx.query.skillResourceSnapshots;
        const findMany = snapshots.findMany.bind(snapshots);
        snapshots.findMany = ((config: Parameters<typeof findMany>[0]) => {
          if (!config?.columns?.contentText) return findMany(config);
          return Promise.resolve(findMany(config)).then(async (rows) => {
            if (change === 'package') {
              await fixture.tx
                .update(skillPackages)
                .set({ riskStatus: 'critical' })
                .where(eq(skillPackages.id, fixture.packageId));
            } else {
              await fixture.tx
                .update(chatSessions)
                .set(
                  change === 'archive' ? { archivedAt: new Date() } : { transcriptGeneration: 2n },
                )
                .where(eq(chatSessions.id, fixture.sessionId));
            }
            return rows;
          });
        }) as typeof snapshots.findMany;
        await expect(
          new AgentTranscriptCoreSkillReader(fixture.tx).read(request(fixture)),
        ).rejects.toMatchObject({
          reason:
            change === 'package'
              ? 'dependencies_unauthorized'
              : change === 'archive'
                ? 'session_unavailable'
                : 'history_changed',
        });
      }),
  );

  it('reads real approved metadata with a null optional package-resource skill_id', () =>
    withSkillFixture(async (fixture) => {
      const result = await skillReader(fixture).readItem(request(fixture));
      expect(result.item.payload_json).toMatchObject({ name: 'core_skill_knowledge@1' });
      expect(result.private_payloads).toEqual([]);
    }));

  it('reads a normally retired release without using it as execution authorization', () =>
    withSkillFixture(async (fixture) => {
      await fixture.tx
        .update(skillCatalogReleases)
        .set({ status: 'retired', retiredAt: new Date() })
        .where(eq(skillCatalogReleases.id, fixture.releaseId));
      await expect(skillReader(fixture).readItem(request(fixture))).resolves.toBeDefined();
    }));

  it('rejects revoked knowledge even without a transcript generation change', () =>
    withSkillFixture(async (fixture) => {
      await fixture.tx
        .update(skillPackages)
        .set({ status: 'disabled', disabledAt: new Date() })
        .where(eq(skillPackages.id, fixture.packageId));
      await expect(skillReader(fixture).readItem(request(fixture))).rejects.toMatchObject({
        reason: 'dependencies_unauthorized',
      });
    }));

  it('uses live PostgreSQL time to reject overdue risk review before a sweeper runs', () =>
    withSkillFixture(async (fixture) => {
      await fixture.tx
        .update(skillPackages)
        .set({
          riskStatus: 'needs_review',
          riskReviewDueAt: sql`clock_timestamp() - interval '1 second'`,
        })
        .where(eq(skillPackages.id, fixture.packageId));
      await expect(skillReader(fixture).readItem(request(fixture))).rejects.toMatchObject({
        reason: 'dependencies_unauthorized',
      });
    }));

  it('rejects the original context after the owned turn selection changes', () =>
    withSkillFixture(async (fixture) => {
      const changed = { ...fixture.selection, primary_name: 'Changed' };
      await fixture.tx
        .update(agentTurns)
        .set({
          skillSelectionSnapshotJson: changed,
          skillSelectionSnapshotHash: canonicalSha256(changed),
        })
        .where(eq(agentTurns.id, fixture.turnId));
      await expect(skillReader(fixture).readItem(request(fixture))).rejects.toMatchObject({
        reason: 'source_invalid',
      });
    }));

  it('rejects a snapshot whose stored resource hash has drifted', () =>
    withSkillFixture(async (fixture) => {
      await fixture.tx
        .update(skillResourceSnapshots)
        .set({ contentHash: 'f'.repeat(64) })
        .where(eq(skillResourceSnapshots.id, fixture.snapshotId));
      await expect(skillReader(fixture).readItem(request(fixture))).rejects.toMatchObject({
        reason: 'dependencies_unauthorized',
      });
    }));

  it('rechecks package state before returning after an earlier successful authorization', () =>
    withSkillFixture(async (fixture) => {
      const binding = new AgentTranscriptCoreSkillBinding(fixture.tx);
      let calls = 0;
      const repo = reader(fixture, {
        itemContracts: skillContracts,
        verifyHostContextSource: (item) => binding.verifySource(item),
        authorizeDependencies: async ({ item }) => {
          const authorized = await binding.authorizeDependencies(item);
          if (++calls === 1) {
            await fixture.tx
              .update(skillPackages)
              .set({ riskStatus: 'critical' })
              .where(eq(skillPackages.id, fixture.packageId));
          }
          return authorized;
        },
      });
      await expect(repo.readItem(request(fixture))).rejects.toMatchObject({
        reason: 'dependencies_unauthorized',
      });
      expect(calls).toBe(2);
    }));
});

const confirmationContracts: AgentTranscriptItemContracts = {
  ...nativeContracts,
  hostContexts: [
    { name: 'confirmation_answer@1', content: { schema: agentConfirmationContextSchema } },
  ],
  resourceDependencySchema: z.union([attachmentSnapshotSchema, agentConfirmedFactDependencySchema]),
};

function confirmationReader(fixture: Fixture) {
  const binding = new AgentTranscriptConfirmationBinding(fixture.tx);
  return reader(fixture, {
    itemContracts: confirmationContracts,
    verifyHostContextSource: (item) => binding.verifySource(item),
    authorizeDependencies: ({ item }) => binding.authorizeDependencies(item),
  });
}

describe('confirmed transcript host PostgreSQL binding', () => {
  it('rechecks the confirmation source before returning authorized history', () =>
    withConfirmationFixture(async (fixture) => {
      const binding = new AgentTranscriptConfirmationBinding(fixture.tx);
      let passes = 0;
      const repo = reader(fixture, {
        itemContracts: confirmationContracts,
        verifyHostContextSource: (item) => binding.verifySource(item),
        authorizeDependencies: async ({ item }) => {
          const accepted = await binding.authorizeDependencies(item);
          passes += 1;
          if (passes === 1) {
            await fixture.tx
              .update(agentTurnConfirmations)
              .set({
                answerJson: { selected_option_id: 'soft', selected_option_label: 'Changed' },
              })
              .where(eq(agentTurnConfirmations.id, fixture.confirmationId));
          }
          return accepted;
        },
      });
      await expect(repo.readItem(request(fixture))).rejects.toMatchObject({
        reason: 'dependencies_unauthorized',
      });
      expect(passes).toBe(2);
    }, false));

  it('reads the full confirmed answer against actual normalized fact rows', () =>
    withConfirmationFixture(async (fixture) => {
      const result = await confirmationReader(fixture).readItem(request(fixture));
      expect(result.item.payload_json).toMatchObject({
        content: { value: { answer: { facts: { primary_colors: ['red', 'red'] } } } },
      });
      expect(result.item.resource_dependencies_json).toHaveLength(1);
    }));

  it('reads an answered clarification after its old pending TTL', () =>
    withConfirmationFixture(async (fixture) => {
      const result = await confirmationReader(fixture).readItem(request(fixture));
      expect(result.item.payload_json).toMatchObject({
        content: { value: { answer: { selected_option_label: 'Soft light' } } },
      });
    }, false));

  it('rejects a stored answer changed after capture', () =>
    withConfirmationFixture(async (fixture) => {
      await fixture.tx
        .update(agentTurnConfirmations)
        .set({ answerJson: { selected_option_id: 'soft', selected_option_label: 'Changed' } })
        .where(eq(agentTurnConfirmations.id, fixture.confirmationId));
      await expect(confirmationReader(fixture).readItem(request(fixture))).rejects.toMatchObject({
        reason: 'source_invalid',
      });
    }, false));

  it('rejects another continuation even when the confirmation and turn IDs exist', () =>
    withConfirmationFixture(async (fixture) => {
      await fixture.tx
        .update(agentTranscriptItems)
        .set({ continuationNo: 1 })
        .where(eq(agentTranscriptItems.id, fixture.itemId));
      await expect(confirmationReader(fixture).readItem(request(fixture))).rejects.toMatchObject({
        reason: 'source_invalid',
      });
    }));

  it('rejects tampered facts even when the confirmation answer is unchanged', () =>
    withConfirmationFixture(async (fixture) => {
      await fixture.tx
        .update(productFactSets)
        .set({ factsJson: { product_name: 'Tampered' } })
        .where(eq(productFactSets.id, fixture.factSetId));
      await expect(confirmationReader(fixture).readItem(request(fixture))).rejects.toMatchObject({
        reason: 'dependencies_unauthorized',
      });
    }));

  it('denies an archived product without waiting for transcript cleanup', () =>
    withConfirmationFixture(async (fixture) => {
      const repo = confirmationReader(fixture);
      await repo.readItem(request(fixture));
      await fixture.tx
        .update(products)
        .set({ status: 'archived' })
        .where(eq(products.id, fixture.productId));
      await expect(repo.readItem(request(fixture))).rejects.toMatchObject({
        reason: 'dependencies_unauthorized',
      });
    }));

  it('keeps the historical confirmation after a newer fact version becomes current', () =>
    withConfirmationFixture(async (fixture) => {
      const newFactId = randomUUID();
      await fixture.tx.insert(productFactSets).values({
        id: newFactId,
        userId: fixture.userId,
        productId: fixture.productId,
        versionNo: 2,
        sourceAssetId: fixture.attachments[0]!.object_id,
        sourceVersion: 'a'.repeat(64),
        factsJson: { product_name: 'Newer product description' },
        confirmedBy: fixture.userId,
        confirmedAt: new Date(),
      });
      await fixture.tx
        .update(products)
        .set({ latestFactSetId: newFactId })
        .where(eq(products.id, fixture.productId));
      const result = await confirmationReader(fixture).readItem(request(fixture));
      expect(result.item.payload_json).toMatchObject({
        content: { value: { answer: { fact_set_id: fixture.factSetId, fact_set_version: 1 } } },
      });
    }));

  it('denies source asset rebinding to another product', () =>
    withConfirmationFixture(async (fixture) => {
      await fixture.tx
        .update(assets)
        .set({ productId: null })
        .where(eq(assets.id, fixture.attachments[0]!.object_id));
      await expect(confirmationReader(fixture).readItem(request(fixture))).rejects.toMatchObject({
        reason: 'dependencies_unauthorized',
      });
    }));
});

describe('native transcript user message PostgreSQL binding', () => {
  it('reads a real source with an owned, ready attachment through the host authorizer', () =>
    withFixture(async (fixture) => {
      const result = await nativeReader(fixture).readItem(request(fixture));
      expect(result.item.payload_json).toMatchObject({
        content: {
          value: {
            text: 'hello',
            attachments: fixture.attachments,
          },
        },
      });
      expect(result.item.resource_dependencies_json).toEqual(fixture.attachments);
    }, true));

  it('rejects a source attachment role changed without updating the native history', () =>
    withFixture(async (fixture) => {
      await fixture.tx
        .update(chatMessages)
        .set({
          attachments: fixture.attachments.map((binding) => ({ ...binding, role: 'edit_source' })),
        })
        .where(eq(chatMessages.id, fixture.messageId));
      await expect(nativeReader(fixture).readItem(request(fixture))).rejects.toMatchObject({
        reason: 'source_invalid',
      });
    }, true));

  it('rejects omission of dependency indexing despite a valid user envelope digest', () =>
    withFixture(async (fixture) => {
      await fixture.tx
        .update(agentTranscriptItems)
        .set({ resourceDependenciesJson: [] })
        .where(eq(agentTranscriptItems.id, fixture.itemId));
      await expect(nativeReader(fixture).readItem(request(fixture))).rejects.toMatchObject({
        reason: 'dependencies_unauthorized',
      });
    }, true));

  it('does not reuse authorization after an asset is deleted without a generation bump', () =>
    withFixture(async (fixture) => {
      const repo = nativeReader(fixture);
      await repo.readItem(request(fixture));
      await fixture.tx
        .update(assets)
        .set({ status: 'deleted', deletedAt: new Date() })
        .where(eq(assets.id, fixture.attachments[0]!.object_id));
      await expect(repo.readItem(request(fixture))).rejects.toMatchObject({
        reason: 'dependencies_unauthorized',
      });
    }, true));

  it('reauthorizes after source validation and before returning the message', () =>
    withFixture(async (fixture) => {
      const authorizer = new AgentTranscriptUserMessageAuthorizer(fixture.tx);
      let checks = 0;
      const repo = reader(fixture, {
        itemContracts: nativeContracts,
        verifyMessageSource: verifyTranscriptUserMessageSource,
        authorizeDependencies: async ({ item }) => {
          checks += 1;
          if (checks === 2)
            await fixture.tx
              .update(assets)
              .set({ contentHash: 'c'.repeat(64) })
              .where(eq(assets.id, fixture.attachments[0]!.object_id));
          return authorizer.authorize(item);
        },
      });
      await expect(repo.readItem(request(fixture))).rejects.toMatchObject({
        reason: 'dependencies_unauthorized',
      });
      expect(checks).toBe(2);
    }, true));

  it('rejects a real attachment now owned by a different user', () =>
    withFixture(async (fixture) => {
      const otherUserId = randomUUID();
      await fixture.tx.insert(users).values({
        id: otherUserId,
        email: `${otherUserId}@example.test`,
        displayName: 'Other owner',
      });
      await fixture.tx
        .update(assets)
        .set({ userId: otherUserId })
        .where(eq(assets.id, fixture.attachments[0]!.object_id));
      await expect(nativeReader(fixture).readItem(request(fixture))).rejects.toMatchObject({
        reason: 'dependencies_unauthorized',
      });
    }, true));

  it('checks current user access rather than trusting a still-active transcript', () =>
    withFixture(async (fixture) => {
      await fixture.tx
        .update(users)
        .set({ riskStatus: 'frozen' })
        .where(eq(users.id, fixture.userId));
      await expect(nativeReader(fixture).readItem(request(fixture))).rejects.toMatchObject({
        reason: 'dependencies_unauthorized',
      });
    }, true));
});

describe('model output PostgreSQL provenance', () => {
  it('reads the original accepted terminal after the turn has advanced continuation', () =>
    withFixture(async (fixture) => {
      await fixture.tx
        .update(agentTurns)
        .set({ continuationNo: 2 })
        .where(eq(agentTurns.id, fixture.turnId));
      const result = await reader(fixture).readItem({
        ...request(fixture),
        itemId: fixture.assistantId,
      });
      expect(result.item.continuation_no).toBe(1);
      expect(result.private_payloads[0]?.value).toEqual(fixture.authored);
    }));

  it.each(['started', 'failed'] as const)(
    'rejects a real %s source before private authorization',
    (status) =>
      withFixture(async (fixture) => {
        await fixture.tx
          .update(agentTraceSteps)
          .set({ status })
          .where(eq(agentTraceSteps.id, fixture.stepId));
        await expectModelSourceFailure(fixture);
      }),
  );

  it.each(['input', 'output'] as const)(
    'rejects a successful step missing its %s evidence',
    (missing) =>
      withFixture(async (fixture) => {
        await fixture.tx
          .update(agentTraceSteps)
          .set(
            missing === 'input'
              ? { inputSummary: { purpose: 'agent_step', continuation_no: 1 } }
              : { outputSummary: { outcome: 'candidate_plan' } },
          )
          .where(eq(agentTraceSteps.id, fixture.stepId));
        await expectModelSourceFailure(fixture);
      }),
  );

  it.each(['compaction', 'continuation', 'error_code'])(
    'rejects mismatched model step %s',
    (changed) =>
      withFixture(async (fixture) => {
        const step = await fixture.tx.query.agentTraceSteps.findFirst({
          where: eq(agentTraceSteps.id, fixture.stepId),
        });
        const summary = step!.inputSummary as Record<string, unknown>;
        await fixture.tx
          .update(agentTraceSteps)
          .set(
            changed === 'error_code'
              ? { errorCode: 'AGENT_CALL_OUTCOME_UNKNOWN' }
              : {
                  inputSummary: {
                    ...summary,
                    ...(changed === 'compaction'
                      ? { purpose: 'session_compaction' }
                      : { continuation_no: 2 }),
                  },
                },
          )
          .where(eq(agentTraceSteps.id, fixture.stepId));
        await expectModelSourceFailure(fixture);
      }),
  );

  it('rejects a transplanted source step from another real tenant and session', () =>
    withFixture(async (fixture) => {
      const otherUser = randomUUID(),
        otherSession = randomUUID(),
        otherTurn = randomUUID();
      const otherTrace = randomUUID(),
        otherStep = randomUUID();
      await fixture.tx.insert(users).values({
        id: otherUser,
        email: `${otherUser}@example.test`,
        displayName: 'Other source owner',
      });
      await fixture.tx
        .insert(chatSessions)
        .values({ id: otherSession, userId: otherUser, title: 'Other source' });
      await fixture.tx.insert(agentTurns).values({
        id: otherTurn,
        sessionId: otherSession,
        userId: otherUser,
        status: 'done',
        transcriptCaptureVersion: 1,
      });
      await fixture.tx.insert(agentTraces).values({
        id: otherTrace,
        userId: otherUser,
        sessionId: otherSession,
        turnId: otherTurn,
        brainModelId: 'fixture',
      });
      const original = await fixture.tx.query.agentTraceSteps.findFirst({
        where: eq(agentTraceSteps.id, fixture.stepId),
      });
      await fixture.tx
        .insert(agentTraceSteps)
        .values({ ...original!, id: otherStep, traceId: otherTrace });
      await fixture.tx
        .update(agentTranscriptItems)
        .set({ sourceTraceStepId: otherStep, sourceKey: `model:${otherStep}:output` })
        .where(eq(agentTranscriptItems.id, fixture.assistantId));
      await expectModelSourceFailure(fixture, 'source_unavailable');
    }));

  it('rejects removed input dependencies even though the envelope hash is unchanged', () =>
    withFixture(async (fixture) => {
      await fixture.tx
        .update(agentTranscriptItems)
        .set({ resourceDependenciesJson: [] })
        .where(eq(agentTranscriptItems.id, fixture.assistantId));
      await expectModelSourceFailure(fixture, 'source_invalid', nativeContracts);
    }, true));

  it('rejects changed private-argument references even when every declared hash was recomputed', () =>
    withFixture(async (fixture) => {
      const source = await fixture.tx.query.agentTranscriptItems.findFirst({
        where: eq(agentTranscriptItems.id, fixture.assistantId),
      });
      const envelope = source!.payloadJson as Extract<
        AgentTranscriptItem['payload_json'],
        { type: 'assistant_output' }
      >;
      const changed = {
        ...envelope,
        calls: envelope.calls.map((call) => ({
          ...call,
          arguments: { ...call.arguments, content_digest: 'f'.repeat(64) },
          arguments_digest: 'f'.repeat(64),
        })),
      };
      await fixture.tx
        .update(agentTranscriptItems)
        .set({ payloadJson: changed, payloadDigest: canonicalSha256(changed) })
        .where(eq(agentTranscriptItems.id, fixture.assistantId));
      await expectModelSourceFailure(fixture);
    }));

  it('rejects relocating a valid accepted item to another sequence', () =>
    withFixture(async (fixture) => {
      await fixture.tx
        .update(chatSessions)
        .set({ transcriptNextSequence: 4n })
        .where(eq(chatSessions.id, fixture.sessionId));
      await fixture.tx
        .update(agentTranscriptItems)
        .set({ sequenceNo: 3n })
        .where(eq(agentTranscriptItems.id, fixture.assistantId));
      await expectModelSourceFailure(fixture);
    }));

  it('does not depend on mutable diagnostic outcome labels when the provenance is preserved', () =>
    withFixture(async (fixture) => {
      const step = await fixture.tx.query.agentTraceSteps.findFirst({
        where: eq(agentTraceSteps.id, fixture.stepId),
      });
      await fixture.tx
        .update(agentTraceSteps)
        .set({
          outputSummary: {
            ...(step!.outputSummary as Record<string, unknown>),
            outcome: 'terminal_finished',
            // Diagnostic additions belong in the tolerated `downstream` bag; a bare extra key
            // would be rejected by the strict summary schema during re-read verification.
            downstream: { latency_ms: 100 },
          },
        })
        .where(eq(agentTraceSteps.id, fixture.stepId));
      const result = await reader(fixture).readItem({
        ...request(fixture),
        itemId: fixture.assistantId,
      });
      expect(result.private_payloads[0]?.value).toEqual(fixture.authored);
    }));
});

async function expectModelSourceFailure(
  fixture: Fixture,
  reason = 'source_invalid',
  itemContracts = contracts,
) {
  let authorizationCalls = 0;
  const repo = reader(fixture, {
    itemContracts,
    authorizeDependencies: () => {
      authorizationCalls += 1;
      return true;
    },
  });
  await expect(
    repo.readItem({ ...request(fixture), itemId: fixture.assistantId }),
  ).rejects.toMatchObject({ reason });
  expect(authorizationCalls).toBe(0);
}

describe('owned transcript PostgreSQL reads', () => {
  it('reads newly appended history beyond the previous checkpoint', () =>
    withFixture(async (fixture) => {
      await fixture.tx
        .update(chatSessions)
        .set({
          transcriptStateJson: {
            schema_version: 1,
            mode: 'active',
            integrity_version: 1,
            verified_through_sequence: '1',
            verified_digest: 'b'.repeat(64),
          },
        })
        .where(eq(chatSessions.id, fixture.sessionId));
      const result = await reader(fixture).readItem({
        ...request(fixture),
        itemId: fixture.assistantId,
      });
      expect(result.item.sequence_no).toBe('2');
      expect(result.private_payloads[0]?.value).toEqual(fixture.authored);
    }));
  it('reads the real owned source and a complete large authoring payload', () =>
    withFixture(async (fixture) => {
      const repo = reader(fixture);
      const message = await repo.readItem(request(fixture));
      expect(message.item.source_message_id).toBe(fixture.messageId);
      const assistant = await repo.readItem({ ...request(fixture), itemId: fixture.assistantId });
      expect(assistant.private_payloads[0]?.value).toEqual(fixture.authored);
      expect(assistant.private_payloads[0]?.reference.byte_size).toBeGreaterThan(65_536);
    }));

  it('does not read a real item through a different tenant or session', () =>
    withFixture(async (fixture) => {
      const repo = reader(fixture);
      await expect(
        repo.readItem({ ...request(fixture), userId: randomUUID() }),
      ).rejects.toMatchObject({ reason: 'session_unavailable' });
      await expect(
        repo.readItem({ ...request(fixture), sessionId: randomUUID() }),
      ).rejects.toMatchObject({ reason: 'session_unavailable' });
    }));

  it('rejects an item from a different existing owned session', () =>
    withFixture(async (fixture) => {
      const otherSession = randomUUID();
      await fixture.tx
        .insert(chatSessions)
        .values({ id: otherSession, userId: fixture.userId, title: 'Other session' });
      const otherItem = randomUUID();
      const source = await fixture.tx.query.agentTranscriptItems.findFirst({
        where: eq(agentTranscriptItems.id, fixture.itemId),
      });
      await fixture.tx
        .insert(agentTurns)
        .values({ id: otherItem, userId: fixture.userId, sessionId: otherSession, status: 'done' });
      await fixture.tx.insert(agentTranscriptItems).values({
        ...source!,
        id: otherItem,
        sessionId: otherSession,
        turnId: otherItem,
        sourceKey: `other:${otherItem}`,
      });
      await expect(
        reader(fixture).readItem({ ...request(fixture), itemId: otherItem }),
      ).rejects.toMatchObject({ reason: 'item_unavailable' });
    }));

  it('refuses changed source content with matching ownership', () =>
    withFixture(async (fixture) => {
      await fixture.tx
        .update(chatMessages)
        .set({ content: 'changed' })
        .where(eq(chatMessages.id, fixture.messageId));
      await expect(reader(fixture).readItem(request(fixture))).rejects.toMatchObject({
        reason: 'source_invalid',
      });
    }));

  it('rejects cross-turn payload ownership in SQL, before content verification', () =>
    withFixture(async (fixture) => {
      const otherTurn = randomUUID();
      await fixture.tx.insert(agentTurns).values({
        id: otherTurn,
        sessionId: fixture.sessionId,
        userId: fixture.userId,
        status: 'done',
      });
      await fixture.tx
        .update(agentTranscriptPayloads)
        .set({ turnId: otherTurn })
        .where(eq(agentTranscriptPayloads.id, fixture.payloadId));
      await expect(
        reader(fixture).readItem({ ...request(fixture), itemId: fixture.assistantId }),
      ).rejects.toMatchObject({ reason: 'payload_unavailable' });
    }));

  it('rejects generation drift in the actual private payload query', () =>
    withFixture(async (fixture) => {
      const repo = reader(fixture, {
        authorizeDependencies: async () => {
          await fixture.tx
            .update(chatSessions)
            .set({ transcriptGeneration: 2n })
            .where(eq(chatSessions.id, fixture.sessionId));
          return true;
        },
      });
      await expect(
        repo.readItem({ ...request(fixture), itemId: fixture.assistantId }),
      ).rejects.toMatchObject({ reason: 'payload_unavailable' });
    }));

  it('does not materialize a private payload after the session is archived during authorization', () =>
    withFixture(async (fixture) => {
      const repo = reader(fixture, {
        authorizeDependencies: async () => {
          await fixture.tx
            .update(chatSessions)
            .set({ archivedAt: new Date() })
            .where(eq(chatSessions.id, fixture.sessionId));
          return true;
        },
      });
      await expect(
        repo.readItem({ ...request(fixture), itemId: fixture.assistantId }),
      ).rejects.toMatchObject({ reason: 'payload_unavailable' });
    }));

  it('refuses tampered private content despite a still-matching reference digest', () =>
    withFixture(async (fixture) => {
      await fixture.tx
        .update(agentTranscriptPayloads)
        .set({ contentJson: { prompts: [] } })
        .where(eq(agentTranscriptPayloads.id, fixture.payloadId));
      await expect(
        reader(fixture).readItem({ ...request(fixture), itemId: fixture.assistantId }),
      ).rejects.toMatchObject({ reason: 'payload_invalid' });
    }));
});
