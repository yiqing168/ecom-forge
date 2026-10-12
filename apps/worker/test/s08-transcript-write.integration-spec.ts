import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import {
  deterministicFakeAgentModelSnapshot,
  callPositionKey,
  prepareAgentTranscriptItem,
  type AgentBrainStepOutcome,
  type AgentTranscriptItemContracts,
} from '@ecom-forge/agent';
import {
  agentTranscriptItems,
  agentTranscriptPayloads,
  agentTraceSteps,
  agentTraces,
  agentTurns,
  chatMessages,
  chatSessions,
  createDatabaseClient,
  eq,
  eventOutbox,
  sql,
  users,
  isIsolatedTranscriptDatabasePath,
} from '@ecom-forge/db';
import { canonicalSha256 } from '@ecom-forge/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  AgentTranscriptWriteTransactions,
  type AgentTranscriptWriteInput,
  type AgentTranscriptWriteScope,
} from '../src/agent/agent-transcript-write-transaction.js';
import { appendNativeTranscriptBatch } from '../src/agent/agent-transcript-append.js';
import {
  prepareTranscriptTerminalOutput,
  prepareTranscriptTerminalResult,
  transcriptTerminalContracts,
} from '../src/agent/agent-transcript-terminal-contracts.js';
import { AgentLlmCostRepository } from '../src/agent/agent-llm-cost.repository.js';
import type { ClaimedAgentTurn } from '../src/agent/agent-turn.types.js';
import type { TranscriptModelCapture } from '../src/agent/agent-transcript-model-capture.js';
import { nativeTranscriptContracts } from '../src/agent/agent-transcript-native.js';
import { readNativeTranscriptRecovery } from '../src/agent/agent-transcript-recovery.js';
import { AgentTurnTerminalRepository } from '../src/agent/agent-turn-terminal.repository.js';
import { AgentTurnToolRepository } from '../src/agent/agent-turn-tool.repository.js';
import { createNativeTranscriptReader } from '../src/agent/agent-transcript-native-reader.js';
import { closeInterruptedTranscriptTail } from '../src/agent/agent-transcript-results.js';
import { validateAuthoringBatchOutcome } from '../src/agent/agent-authoring-outcome.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (
  !databaseUrl ||
  process.env.NODE_ENV === 'production' ||
  !isIsolatedTranscriptDatabasePath(new URL(databaseUrl).pathname)
) {
  throw new Error('Transcript write tests require an explicit isolated TEST_DATABASE_URL');
}
const applicationName = `transcript-write-${randomUUID()}`;
const resource = createDatabaseClient({
  databaseUrl,
  maxConnections: 4,
  statementTimeoutMs: 5_000,
  applicationName,
});
const writer = new AgentTranscriptWriteTransactions(resource.db);
const state = (mode: 'shadow' | 'active' = 'shadow') => ({
  schema_version: 1,
  mode,
  integrity_version: 1,
  verified_through_sequence: '0',
  verified_digest: 'a'.repeat(64),
});

beforeAll(async () => {
  const [row] = await resource.db.execute(
    sql`select to_regclass('public.agent_transcript_items')::text as items`,
  );
  if (!row?.items)
    throw new Error(
      'Migration 0038 must already be installed; this suite never migrates or clears a database',
    );
});
afterAll(() => resource.client.end());

// Committed, namespaced synthetic fixtures are needed for independent-connection lock tests.
// They remain in the isolated test database; no user data is cleared or migrated here.
async function fixture(
  options: {
    session?: Partial<typeof chatSessions.$inferInsert>;
    turn?: Partial<typeof agentTurns.$inferInsert>;
    leaseMs?: number;
  } = {},
): Promise<AgentTranscriptWriteInput> {
  const input = {
    userId: randomUUID(),
    sessionId: randomUUID(),
    turnId: randomUUID(),
    owner: randomUUID(),
    revision: 1,
    continuationNo: 1,
    expectedGeneration: '1',
  };
  await resource.db.transaction(async (tx) => {
    await tx.insert(users).values({
      id: input.userId,
      email: `write-${input.userId}@example.test`,
      displayName: 'Transcript write fixture',
    });
    await tx.insert(chatSessions).values({
      id: input.sessionId,
      userId: input.userId,
      title: 'Transcript write fixture',
      transcriptStateJson: state(),
      ...options.session,
    });
    await tx.insert(agentTurns).values({
      id: input.turnId,
      sessionId: input.sessionId,
      userId: input.userId,
      status: 'planning',
      processingOwner: input.owner,
      processingLeaseExpiresAt: sql`clock_timestamp() + (${options.leaseMs ?? 30_000} * interval '1 millisecond')`,
      transcriptCaptureVersion: 1,
      ...options.turn,
    });
  });
  return input;
}

async function mark(scope: AgentTranscriptWriteScope) {
  await scope.query((tx) =>
    tx
      .update(chatSessions)
      .set({
        transcriptNextSequence: scope.nextSequence + 1n,
        messageHistoryRevision: scope.messageRevision + 1n,
      })
      .where(eq(chatSessions.id, scope.sessionId)),
  );
  await scope.query((tx) =>
    tx.insert(chatMessages).values({
      sessionId: scope.sessionId,
      turnId: scope.turnId,
      role: 'assistant',
      content: 'Synthetic transaction projection',
    }),
  );
}

async function expectUnchanged(input: AgentTranscriptWriteInput) {
  const row = await resource.db.query.chatSessions.findFirst({
    where: eq(chatSessions.id, input.sessionId),
  });
  expect(row?.transcriptNextSequence).toBe(1n);
  expect(row?.messageHistoryRevision).toBe(0n);
  expect(
    await resource.db.query.chatMessages.findMany({
      where: eq(chatMessages.sessionId, input.sessionId),
    }),
  ).toEqual([]);
}

function gate() {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release };
}

const appendContracts: AgentTranscriptItemContracts = {
  userMessage: { schema: z.strictObject({ text: z.string() }) },
  legacyMessage: { schema: z.never() },
  calls: transcriptTerminalContracts,
  hostContexts: [],
  resourceDependencySchema: z.never(),
};

// Semantic storage fixtures, not production model/source authorization or usage capture.
function planningBatch(input: AgentTranscriptWriteInput, stepId: string, text = 'Original draft') {
  const metadata = {
    id: randomUUID(),
    user_id: input.userId,
    session_id: input.sessionId,
    turn_id: input.turnId,
    continuation_no: input.continuationNo,
    sequence_no: '1',
    schema_version: 1 as const,
    source_message_id: null,
    source_trace_step_id: stepId,
    import_attempt_id: null,
    reply_to_item_id: null,
    call_ordinal: null,
    resource_dependencies_json: [],
    created_at: '2026-09-08T00:00:00.000Z',
  };
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
        params: { creative_prompt: text },
        expected_output: 'image',
      },
    ],
  };
  const prepared = prepareTranscriptTerminalOutput(
    {
      metadata,
      outcome: { type: 'authoring_request', plan, usage: { input_tokens: 1, output_tokens: 1 } },
      phase: 'planning',
      privatePayloadId: randomUUID(),
    },
    appendContracts,
  );
  const result = prepareTranscriptTerminalResult(
    {
      metadata: { ...metadata, id: randomUUID(), sequence_no: '2' },
      parent: prepared.item,
      status: 'succeeded',
      result: { type: 'authoring_required', plan_digest: canonicalSha256({ plan }) },
    },
    appendContracts,
  );
  return { items: [prepared.item, result], privatePayloads: prepared.privatePayloads };
}

async function appendState(input: AgentTranscriptWriteInput) {
  return {
    session: await resource.db.query.chatSessions.findFirst({
      where: eq(chatSessions.id, input.sessionId),
    }),
    items: await resource.db.query.agentTranscriptItems.findMany({
      where: eq(agentTranscriptItems.sessionId, input.sessionId),
      orderBy: (table, { asc }) => [asc(table.sequenceNo)],
    }),
    payloads: await resource.db.query.agentTranscriptPayloads.findMany({
      where: eq(agentTranscriptPayloads.sessionId, input.sessionId),
    }),
  };
}

const costRepository = new AgentLlmCostRepository(resource.db);
const testModel = deterministicFakeAgentModelSnapshot({
  maxInputTokens: 272_000,
  maxOutputTokens: 8_192,
});

async function modelFixture(captureVersion: 1 | null = 1) {
  const input = await fixture({ turn: { transcriptCaptureVersion: captureVersion } });
  const traceId = randomUUID();
  await resource.db.insert(agentTraces).values({
    id: traceId,
    turnId: input.turnId,
    sessionId: input.sessionId,
    userId: input.userId,
    brainModelId: 'synthetic-transcript-capture',
  });
  const claimed = { ...input, traceId, modelSnapshot: testModel } as unknown as ClaimedAgentTurn;
  const transcript: TranscriptModelCapture = {
    expectedGeneration: '1',
    phase: 'planning',
    resourceDependencies: [],
    contracts: appendContracts,
  };
  const request = {
    claimed,
    revision: input.revision,
    round: 1,
    modelSnapshot: testModel,
    exposureCost: '0.02',
    turnBudgetCost: '0.15',
    requestedInputTokens: 1,
    requestedMaxOutputTokens: 100,
  };
  return { input, request, transcript };
}

async function reserveModel() {
  const fixture = await modelFixture();
  const result = await costRepository.reserve({
    ...fixture.request,
    transcript: fixture.transcript,
  });
  if (!result || result.kind !== 'reserved') throw new Error('SYNTHETIC_RESERVATION_EXPECTED');
  const outcome: AgentBrainStepOutcome = {
    type: 'respond',
    text: 'Synthetic original response',
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  return {
    ...fixture,
    settle: { ...fixture.request, step: result.step, outcome, transcript: fixture.transcript },
  };
}

async function reserveNativeModel(outcome: AgentBrainStepOutcome) {
  const f = await modelFixture();
  await resource.db
    .update(chatSessions)
    .set({ transcriptStateJson: state('active') })
    .where(eq(chatSessions.id, f.input.sessionId));
  await resource.db
    .update(agentTurns)
    .set({ executionFormat: 'transcript_v1' })
    .where(eq(agentTurns.id, f.input.turnId));
  const claimed = { ...f.request.claimed, transcriptCaptureVersion: 1, transcriptGeneration: '1' };
  const transcript = {
    ...f.transcript,
    contracts: nativeTranscriptContracts,
    ...(outcome.type === 'authoring_batch' ? { phase: 'authoring' as const } : {}),
  };
  const request = { ...f.request, claimed, transcript };
  const reserved = await costRepository.reserve(request);
  if (reserved?.kind !== 'reserved') throw new Error('SYNTHETIC_RESERVATION_EXPECTED');
  const settle = { ...request, step: reserved.step, outcome };
  await costRepository.settle(settle);
  return { ...f, request, settle, claimed, step: reserved.step };
}

describe('native transcript domain receipts PostgreSQL', () => {
  const terminal = new AgentTurnTerminalRepository(resource.db);
  const tool = new AgentTurnToolRepository(resource.db);
  const response: AgentBrainStepOutcome = {
    type: 'respond',
    text: 'Synthetic original response',
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  it('saves an authoring checkpoint once under concurrent replay without creating a quote or workflow', async () => {
    const outcome: AgentBrainStepOutcome = {
      type: 'authoring_batch',
      authoring_output: {
        name: 'agent_author_prompts@1',
        arguments: {
          prompts: [{ candidate_key: 'first', creative_prompt: 'Synthetic complete brief.' }],
        },
        provider_call_id: 'original-batch',
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const f = await reserveNativeModel(outcome);
    const request = { claimed: f.claimed, revision: 1, llmStepId: f.step.stepId };
    const results = await Promise.all([
      terminal.saveAuthoringBatch(request),
      terminal.saveAuthoringBatch(request),
    ]);
    expect(results).toEqual([true, true]);
    const saved = await appendState(f.input);
    expect(saved.items).toHaveLength(2);
    expect(saved.payloads).toHaveLength(1);
    expect(saved.items[1]!.payloadJson).toMatchObject({
      type: 'tool_result',
      result: { value: { type: 'authoring_batch_saved' } },
    });
    const reader = createNativeTranscriptReader(resource.db);
    expect(
      (
        await reader.readWindow({
          userId: f.input.userId,
          sessionId: f.input.sessionId,
          expectedGeneration: '1',
          firstSequence: '1',
          throughSequence: '2',
          requireClosed: true,
        })
      ).protocol.protocol_closed,
    ).toBe(true);
    expect(
      await resource.db.query.eventOutbox.findMany({
        where: eq(eventOutbox.scopeId, f.input.turnId),
      }),
    ).toHaveLength(0);
    expect(await costRepository.settle(f.settle)).toBeNull();
    expect((await appendState(f.input)).items).toHaveLength(2);
    await expect(
      terminal.saveAuthoringBatch({ ...request, claimed: { ...f.claimed, owner: randomUUID() } }),
    ).rejects.toThrow('AGENT_TRANSCRIPT_WRITE_FAILED');
    expect((await appendState(f.input)).items).toHaveLength(2);
  });

  it('commits the response message, terminal receipt and public outbox together', async () => {
    const f = await reserveNativeModel(response);
    expect(
      await terminal.completeResponse({
        claimed: f.claimed,
        revision: 1,
        llmStepId: f.step.stepId,
        text: response.text,
      }),
    ).toBeTruthy();
    const saved = await appendState(f.input);
    expect(saved.items).toHaveLength(2);
    expect(saved.items[1]?.payloadJson).toMatchObject({ type: 'tool_result', status: 'succeeded' });
    expect(
      await resource.db.query.agentTurns.findFirst({ where: eq(agentTurns.id, f.input.turnId) }),
    ).toMatchObject({ status: 'done', processingOwner: null });
    expect(
      await resource.db.query.chatMessages.findMany({
        where: eq(chatMessages.turnId, f.input.turnId),
      }),
    ).toHaveLength(1);
    expect(
      await resource.db.query.eventOutbox.findMany({
        where: eq(eventOutbox.scopeId, f.input.turnId),
      }),
    ).toHaveLength(3);
    const window = await createNativeTranscriptReader(resource.db).readWindow({
      userId: f.input.userId,
      sessionId: f.input.sessionId,
      expectedGeneration: '1',
      firstSequence: '1',
      throughSequence: '2',
      requireClosed: true,
    });
    expect(window.items).toHaveLength(2);
    expect(window.protocol.protocol_closed).toBe(true);
    await expect(
      createNativeTranscriptReader(resource.db).readWindow({
        userId: f.input.userId,
        sessionId: f.input.sessionId,
        expectedGeneration: '1',
        firstSequence: '2',
        throughSequence: '2',
        requireClosed: true,
      }),
    ).rejects.toThrow('AGENT_TRANSCRIPT_READ_FAILED');
  });

  it.each([undefined, 'respond', 'chat_text'] as const)(
    'rejects mismatched publication text in mode %s without public side effects',
    async (mode) => {
      const f = await reserveNativeModel(response);
      await expect(
        terminal.completeResponse({
          claimed: f.claimed,
          revision: 1,
          llmStepId: f.step.stepId,
          text: 'Changed publication text',
          ...(mode ? { mode } : {}),
        }),
      ).rejects.toThrow('AGENT_TRANSCRIPT_WRITE_FAILED');
      expect((await appendState(f.input)).items).toHaveLength(1);
      expect(
        await resource.db.query.chatMessages.findMany({
          where: eq(chatMessages.turnId, f.input.turnId),
        }),
      ).toHaveLength(0);
      expect(
        await resource.db.query.eventOutbox.findMany({
          where: eq(eventOutbox.scopeId, f.input.turnId),
        }),
      ).toHaveLength(0);
    },
  );

  it('publishes one response when two transactions finish the same claimed turn concurrently', async () => {
    const f = await reserveNativeModel(response);
    const input = {
      claimed: f.claimed,
      revision: 1,
      llmStepId: f.step.stepId,
      text: response.text,
    };
    const results = await Promise.allSettled([
      new AgentTurnTerminalRepository(resource.db).completeResponse(input),
      new AgentTurnTerminalRepository(resource.db).completeResponse(input),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled' && result.value !== null),
    ).toHaveLength(1);
    for (const result of results) {
      if (result.status === 'rejected') {
        expect(String(result.reason)).toContain('AGENT_TRANSCRIPT_WRITE_FAILED');
      }
    }
    expect(
      await resource.db.query.chatMessages.findMany({
        where: eq(chatMessages.turnId, f.input.turnId),
      }),
    ).toHaveLength(1);
    expect(
      await resource.db.query.eventOutbox.findMany({
        where: eq(eventOutbox.scopeId, f.input.turnId),
      }),
    ).toHaveLength(3);
    expect((await appendState(f.input)).items).toHaveLength(2);
  });

  it('recovers a settled response through the terminal path without settling its cost twice', async () => {
    const f = await reserveNativeModel(response);
    const before = await resource.db.query.agentTraces.findFirst({
      where: eq(agentTraces.id, f.claimed.traceId),
    });
    expect(
      await costRepository.settle({
        ...f.settle,
        maxOutputTokenTotal: 8_192,
        publishRespond: true,
      }),
    ).toBeNull();
    const published = await terminal.completeResponse({
      claimed: f.claimed,
      revision: 1,
      llmStepId: f.step.stepId,
      text: response.text,
    });
    expect(published?.eventSeq).toBeDefined();
    const [after, messages, items] = await Promise.all([
      resource.db.query.agentTraces.findFirst({ where: eq(agentTraces.id, f.claimed.traceId) }),
      resource.db.query.chatMessages.findMany({ where: eq(chatMessages.turnId, f.input.turnId) }),
      resource.db.query.agentTranscriptItems.findMany({
        where: eq(agentTranscriptItems.turnId, f.input.turnId),
      }),
    ]);
    expect(after?.estimatedCost).toBe(before?.estimatedCost);
    expect(after?.inputTokenTotal).toBe(before?.inputTokenTotal);
    expect(messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
    expect(items.filter((item) => item.itemType === 'tool_result')).toHaveLength(1);
  });

  it('does not publish an already settled but unpublished response through a second settlement', async () => {
    const f = await reserveNativeModel(response);
    const step = await resource.db.query.agentTraceSteps.findFirst({
      where: eq(agentTraceSteps.id, f.step.stepId),
    });
    expect(step?.status).toBe('succeeded');
    expect(
      await costRepository.settle({
        ...f.settle,
        maxOutputTokenTotal: 8_192,
        publishRespond: true,
      }),
    ).toBeNull();
    const messages = await resource.db.query.chatMessages.findMany({
      where: eq(chatMessages.turnId, f.input.turnId),
    });
    expect(messages.filter((message) => message.role === 'assistant')).toHaveLength(0);
  });

  it('rolls back the message, result and trace changes when publishing fails', async () => {
    const f = await reserveNativeModel(response);
    await resource.db.insert(eventOutbox).values({
      scopeType: 'turn',
      scopeId: f.input.turnId,
      eventSeq: 2147483647,
      eventType: 'synthetic.max_sequence',
      payload: {},
    });
    const before = await appendState(f.input);
    const step = await resource.db.query.agentTraceSteps.findFirst({
      where: eq(agentTraceSteps.id, f.step.stepId),
    });
    await expect(
      terminal.completeResponse({
        claimed: f.claimed,
        revision: 1,
        llmStepId: f.step.stepId,
        text: response.text,
      }),
    ).rejects.toThrow('AGENT_TRANSCRIPT_WRITE_FAILED');
    expect(await appendState(f.input)).toEqual(before);
    expect(
      await resource.db.query.agentTraceSteps.findFirst({
        where: eq(agentTraceSteps.id, f.step.stepId),
      }),
    ).toEqual(step);
    expect(
      await resource.db.query.chatMessages.findMany({
        where: eq(chatMessages.turnId, f.input.turnId),
      }),
    ).toEqual([]);
    expect(
      await resource.db.query.agentTurns.findFirst({ where: eq(agentTurns.id, f.input.turnId) }),
    ).toMatchObject({ status: 'planning', processingOwner: f.input.owner });
  });

  it('closes a rejected terminal once without changing accepted model provenance', async () => {
    const f = await reserveNativeModel(response);
    const request = {
      claimed: f.claimed,
      revision: 1,
      llmStepId: f.step.stepId,
      rule: 'synthetic_rule',
    };
    expect(await terminal.recordPublicTextRejection(request)).toBe(true);
    const before = await appendState(f.input);
    const steps = await resource.db.query.agentTraceSteps.findMany({
      where: eq(agentTraceSteps.traceId, f.claimed.traceId),
    });
    expect(await terminal.recordPublicTextRejection(request)).toBe(true);
    expect(await appendState(f.input)).toEqual(before);
    expect(
      await resource.db.query.agentTraceSteps.findMany({
        where: eq(agentTraceSteps.traceId, f.claimed.traceId),
      }),
    ).toEqual(steps);
    expect(await costRepository.settle(f.settle)).toBeNull();
  });

  it('closes every unexecuted call after tool failure and replays without new steps or events', async () => {
    const calls = ['optional-a@1.0.0', 'optional-b@1.0.0'].map((skillId, index) => ({
      name: 'load_skill@1',
      call_id: `call-${index}`,
      arguments: { skill_id: skillId, view: 'planning' },
    }));
    const f = await reserveNativeModel({
      type: 'tool_calls',
      calls,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const request = {
      claimed: f.claimed,
      revision: 1,
      llmStepId: f.step.stepId,
      callOrdinal: 0,
      callCount: 2,
      callPositionKey: callPositionKey({
        turnId: f.input.turnId,
        continuationNo: 1,
        llmStepNo: f.step.stepNo,
        callIndex: 0,
      }),
      toolName: 'load_skill@1',
      argsHash: canonicalSha256(calls[0]!.arguments),
      toolFingerprint: 'b'.repeat(64),
      errorCode: 'SKILL_NOT_AVAILABLE',
      diagnosticCode: 'synthetic_unavailable',
      errorKey: 'c'.repeat(64),
      progressHash: 'd'.repeat(64),
    };
    expect(await tool.finishToolFailure(request)).toBeTruthy();
    const before = await appendState(f.input);
    expect(before.items.map((item) => (item.payloadJson as { status?: string }).status)).toEqual([
      undefined,
      'rejected',
      'not_executed',
    ]);
    const steps = await resource.db.query.agentTraceSteps.findMany({
      where: eq(agentTraceSteps.traceId, f.claimed.traceId),
    });
    expect(await tool.finishToolFailure(request)).toEqual({ eventSeq: 0 });
    expect(await appendState(f.input)).toEqual(before);
    expect(
      await resource.db.query.agentTraceSteps.findMany({
        where: eq(agentTraceSteps.traceId, f.claimed.traceId),
      }),
    ).toEqual(steps);
    expect(
      await resource.db.query.eventOutbox.findMany({
        where: eq(eventOutbox.scopeId, f.input.turnId),
      }),
    ).toHaveLength(1);
    expect(
      (
        await createNativeTranscriptReader(resource.db).readWindow({
          userId: f.input.userId,
          sessionId: f.input.sessionId,
          expectedGeneration: '1',
          firstSequence: '1',
          throughSequence: '3',
          requireClosed: true,
        })
      ).protocol.protocol_closed,
    ).toBe(true);
    await expect(
      tool.finishToolFailure({ ...request, errorCode: 'DIFFERENT_ERROR' }),
    ).rejects.toThrow('AGENT_TRANSCRIPT_WRITE_FAILED');
  });

  it.each(['owner', 'generation'] as const)(
    'rejects an old %s before any domain write',
    async (change) => {
      const f = await reserveNativeModel(response);
      const before = await appendState(f.input);
      const claimed = {
        ...f.claimed,
        ...(change === 'owner' ? { owner: randomUUID() } : { transcriptGeneration: '2' }),
      };
      await expect(
        terminal.completeResponse({
          claimed,
          revision: 1,
          llmStepId: f.step.stepId,
          text: response.text,
        }),
      ).rejects.toThrow('AGENT_TRANSCRIPT_WRITE_FAILED');
      expect(await appendState(f.input)).toEqual(before);
      expect(
        await resource.db.query.chatMessages.findMany({
          where: eq(chatMessages.turnId, f.input.turnId),
        }),
      ).toEqual([]);
    },
  );

  it('materializes a pending private draft only while all live dependencies remain authorized', async () => {
    const input = await fixture();
    const plan = (
      planningBatch(input, randomUUID()).privatePayloads[0]!.content_json as {
        plan: Record<string, unknown>;
      }
    ).plan;
    const f = await reserveNativeModel({ type: 'authoring_request', plan, usage: response.usage });
    const reader = createNativeTranscriptReader(resource.db);
    const request = {
      userId: f.input.userId,
      sessionId: f.input.sessionId,
      expectedGeneration: '1',
      firstSequence: '1',
      throughSequence: '1',
      requireClosed: false,
    };
    const pending = await reader.readWindow(request);
    expect(pending.protocol.pending_calls).toHaveLength(1);
    expect(pending.items[0]?.private_payloads[0]?.value).toEqual({ plan });
    await expect(reader.readWindow({ ...request, requireClosed: true })).rejects.toThrow(
      'AGENT_TRANSCRIPT_READ_FAILED',
    );
    expect(
      await terminal.beginAuthoring({ claimed: f.claimed, revision: 1, llmStepId: f.step.stepId }),
    ).toBe(true);
    expect(
      await terminal.beginAuthoring({ claimed: f.claimed, revision: 1, llmStepId: f.step.stepId }),
    ).toBe(true);
    expect(
      (await reader.readWindow({ ...request, throughSequence: '2', requireClosed: true })).protocol
        .protocol_closed,
    ).toBe(true);
    await resource.db
      .update(users)
      .set({ riskStatus: 'frozen' })
      .where(eq(users.id, f.input.userId));
    const payloadRead = vi.spyOn(resource.db.query.agentTranscriptPayloads, 'findFirst');
    try {
      await expect(reader.readWindow(request)).rejects.toThrow('AGENT_TRANSCRIPT_READ_FAILED');
      expect(payloadRead).not.toHaveBeenCalled();
    } finally {
      payloadRead.mockRestore();
    }
  });

  it('rejects a changed stored receipt binding instead of silently replaying it', async () => {
    const f = await reserveNativeModel(response);
    const request = {
      claimed: f.claimed,
      revision: 1,
      llmStepId: f.step.stepId,
      rule: 'synthetic_rule',
    };
    await terminal.recordPublicTextRejection(request);
    await resource.db
      .update(agentTraceSteps)
      .set({ outputSummary: sql`${agentTraceSteps.outputSummary} - 'transcript_result'` })
      .where(eq(agentTraceSteps.id, f.step.stepId));
    await expect(terminal.recordPublicTextRejection(request)).rejects.toThrow(
      'AGENT_TRANSCRIPT_WRITE_FAILED',
    );
  });
});

describe('cost repository atomic transcript model capture PostgreSQL', () => {
  it.each(['cancelled', 'superseded'] as const)(
    'closes a %s predecessor before a new turn without executing its pending action',
    async (status) => {
      const f = await reserveNativeModel({
        type: 'respond',
        text: 'Unpublished',
        usage: { input_tokens: 5, output_tokens: 2 },
      });
      const next = { ...f.input, turnId: randomUUID(), owner: randomUUID() };
      await resource.db.transaction(async (tx) => {
        await tx
          .update(agentTurns)
          .set({
            status,
            endedAt: new Date(),
            processingOwner: null,
            processingLeaseExpiresAt: null,
          })
          .where(eq(agentTurns.id, f.input.turnId));
        await tx.insert(agentTurns).values({
          id: next.turnId,
          userId: next.userId,
          sessionId: next.sessionId,
          status: 'planning',
          executionFormat: 'transcript_v1',
          transcriptCaptureVersion: 1,
          processingOwner: next.owner,
          processingLeaseExpiresAt: new Date(Date.now() + 30_000),
        });
      });
      await writer.run(next, closeInterruptedTranscriptTail);
      await writer.run(next, closeInterruptedTranscriptTail);
      const window = await createNativeTranscriptReader(resource.db).readCurrentWindow({
        userId: next.userId,
        sessionId: next.sessionId,
        expectedGeneration: '1',
        requireClosed: true,
      });
      expect(window.items).toHaveLength(2);
      expect(window.items[1]!.item).toMatchObject({
        turn_id: f.input.turnId,
        payload_json: {
          type: 'tool_result',
          status: 'not_executed',
          result: {
            type: 'inline',
            value: {
              reason: status === 'superseded' ? 'turn_superseded' : 'turn_interrupted',
            },
          },
        },
      });
      expect(
        await resource.db.query.chatMessages.findMany({
          where: eq(chatMessages.turnId, f.input.turnId),
        }),
      ).toEqual([]);
    },
  );
  it('freezes input provenance before a model call without creating a fabricated output', async () => {
    const f = await reserveModel();
    const step = await resource.db.query.agentTraceSteps.findFirst({
      where: eq(agentTraceSteps.id, f.settle.step.stepId),
    });
    expect(step).toMatchObject({
      status: 'started',
      estimatedCost: '0.02',
      outputSummary: {},
      inputSummary: {
        transcript_phase: 'planning',
        reserved_exposure_cost_cny: '0.02',
        transcript_input: {
          step_id: f.settle.step.stepId,
          resource_dependencies_digest: canonicalSha256([]),
        },
      },
    });
    expect((await appendState(f.input)).items).toEqual([]);
  });

  it('commits a full private plan, accepted marker and usage atomically', async () => {
    const f = await reserveModel();
    const plan = (
      planningBatch(f.input, randomUUID(), 'Original creative direction. '.repeat(4000))
        .privatePayloads[0]!.content_json as { plan: Record<string, unknown> }
    ).plan;
    const outcome: AgentBrainStepOutcome = {
      type: 'authoring_request',
      plan,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    expect(await costRepository.settle({ ...f.settle, outcome })).toEqual({
      budgetExceeded: false,
      pricingDrift: false,
    });
    const state = await appendState(f.input);
    expect(state.items).toHaveLength(1);
    expect(state.payloads).toHaveLength(1);
    expect(state.payloads[0]?.contentJson).toEqual({ plan });
    expect(state.payloads[0]?.byteSize).toBeGreaterThan(65_536);
    expect(state.session?.transcriptNextSequence).toBe(2n);
    const step = await resource.db.query.agentTraceSteps.findFirst({
      where: eq(agentTraceSteps.id, f.settle.step.stepId),
    });
    expect(step).toMatchObject({
      status: 'succeeded',
      estimatedCost: '0.01',
      tokenUsageJson: outcome.usage,
    });
    expect(step?.outputSummary).toHaveProperty(
      'transcript_output.assistant_item_id',
      state.items[0]?.id,
    );
    expect(JSON.stringify(step)).not.toContain('Original creative direction');
    expect(
      await resource.db.query.agentTraces.findFirst({
        where: eq(agentTraces.id, f.request.claimed.traceId),
      }),
    ).toMatchObject({
      reservedCost: '0.00',
      estimatedCost: '0.01',
      inputTokenTotal: 1,
      outputTokenTotal: 1,
    });
  });

  it('settles concurrent duplicate results exactly once and preserves the original item identity', async () => {
    const f = await reserveModel();
    const results = await Promise.all([
      costRepository.settle(f.settle),
      costRepository.settle(f.settle),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const before = await appendState(f.input);
    expect(await costRepository.settle(f.settle)).toBeNull();
    expect(await appendState(f.input)).toEqual(before);
    expect(before.items).toHaveLength(1);
    expect(
      await resource.db.query.agentTraces.findFirst({
        where: eq(agentTraces.id, f.request.claimed.traceId),
      }),
    ).toMatchObject({
      reservedCost: '0.00',
      estimatedCost: '0.01',
      inputTokenTotal: 1,
      outputTokenTotal: 1,
    });
  });

  it.each(['text', 'usage'] as const)('rejects a conflicting duplicate %s', async (change) => {
    const f = await reserveModel();
    await costRepository.settle(f.settle);
    const before = await appendState(f.input);
    await expect(
      costRepository.settle({
        ...f.settle,
        outcome: {
          type: 'respond',
          text: change === 'text' ? 'Changed output' : 'Synthetic original response',
          usage: { input_tokens: 1, output_tokens: change === 'usage' ? 2 : 1 },
        },
      }),
    ).rejects.toThrow('AGENT_TRANSCRIPT_WRITE_FAILED');
    expect(await appendState(f.input)).toEqual(before);
  });

  it.each(['phase', 'dependencies', 'model', 'exposure', 'stepNo'] as const)(
    'rejects %s drift before accepting the response',
    async (change) => {
      const f = await reserveModel();
      const request = { ...f.settle, transcript: { ...f.transcript }, step: { ...f.settle.step } };
      if (change === 'phase') request.transcript.phase = 'authoring';
      if (change === 'dependencies')
        request.transcript.resourceDependencies = [{ kind: 'invented' }];
      if (change === 'model') request.modelSnapshot = { ...testModel, version: 'changed' };
      if (change === 'exposure') request.step.exposureCost = '0.01';
      if (change === 'stepNo') request.step.stepNo += 1;
      await expect(costRepository.settle(request)).rejects.toThrow('AGENT_TRANSCRIPT_WRITE_FAILED');
      expect((await appendState(f.input)).items).toEqual([]);
      expect(
        await resource.db.query.agentTraceSteps.findFirst({
          where: eq(agentTraceSteps.id, f.settle.step.stepId),
        }),
      ).toMatchObject({ status: 'started', estimatedCost: '0.02' });
    },
  );

  it.each(['output_truncated', 'tool_json_parse', 'tool_schema'] as const)(
    'persists %s diagnostics and usage without inventing an accepted model call',
    async (category) => {
      const f = await reserveModel();
      const transcript = { ...f.settle.transcript, contracts: nativeTranscriptContracts };
      const outputDiagnostic = {
        category,
        finish_reason:
          category === 'output_truncated' ? ('length' as const) : ('tool-calls' as const),
        requested_max_output_tokens: f.request.requestedMaxOutputTokens,
      };
      const request = {
        ...f.settle,
        transcript,
        outcome: {
          type: 'invalid_tool_input' as const,
          error_code: 'AGENT_BRAIN_TOOL_INPUT_INVALID' as const,
          tool: 'agent_candidate_plan',
          paths: ['plan.nodes'],
          output_diagnostic: outputDiagnostic,
          usage: { input_tokens: 1, output_tokens: 1, reasoning_output_tokens: 1 },
        },
      };
      expect(await costRepository.settle(request)).not.toBeNull();
      expect(await costRepository.settle(request)).toBeNull();
      expect((await appendState(f.input)).items).toMatchObject([
        {
          itemType: 'host_context',
          sourceKey: `policy:${f.settle.step.stepId}:invalid-tool-input`,
          payloadJson: {
            type: 'host_context',
            name: 'runtime_policy@1',
            content: {
              type: 'inline',
              value: {
                public_error_code: 'AGENT_BRAIN_TOOL_INPUT_INVALID',
                tool: 'agent_candidate_plan',
                paths: ['plan.nodes'],
                output_diagnostic: outputDiagnostic,
              },
            },
          },
        },
      ]);
      expect(
        await resource.db.query.agentTraceSteps.findFirst({
          where: eq(agentTraceSteps.id, f.settle.step.stepId),
        }),
      ).toMatchObject({
        status: 'failed',
        errorCode: 'AGENT_BRAIN_TOOL_INPUT_INVALID',
        estimatedCost: '0.01',
        outputSummary: { diagnostic: { output_diagnostic: outputDiagnostic } },
        tokenUsageJson: request.outcome.usage,
      });
    },
  );

  it.each(['extra_key', 'repeated_prompt'] as const)(
    'settles rejected authoring %s once and preserves repair feedback after a database read',
    async (variant) => {
      const f = await modelFixture();
      await resource.db
        .update(chatSessions)
        .set({ transcriptStateJson: state('active') })
        .where(eq(chatSessions.id, f.input.sessionId));
      const draft = {
        nodes: [
          { candidate_key: 'accepted', params: { creative_prompt: 'Accepted source brief.' } },
          { candidate_key: 'pending', params: {} },
        ],
      };
      const before = structuredClone(draft);
      const prompts =
        variant === 'extra_key'
          ? [
              { candidate_key: 'pending', creative_prompt: 'A new source brief.' },
              { candidate_key: 'extra', creative_prompt: 'An unrequested brief.' },
            ]
          : [{ candidate_key: 'pending', creative_prompt: 'Accepted source brief.' }];
      const outcome = await validateAuthoringBatchOutcome({
        outcome: {
          type: 'authoring_batch',
          authoring_output: {
            name: 'agent_author_prompts@1',
            arguments: { prompts },
            provider_call_id: 'rejected-batch',
          },
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        draft,
        completedKeys: ['accepted'],
        rejectsRepeatedPrompt: () => true,
      });
      expect(outcome.type).toBe('invalid_tool_input');
      const transcript = {
        ...f.transcript,
        contracts: nativeTranscriptContracts,
        phase: 'authoring' as const,
      };
      const reserved = await costRepository.reserve({ ...f.request, transcript });
      if (reserved?.kind !== 'reserved') throw new Error('SYNTHETIC_RESERVATION_EXPECTED');
      const request = { ...f.request, transcript, step: reserved.step, outcome };
      expect(await costRepository.settle(request)).not.toBeNull();
      expect(await costRepository.settle(request)).toBeNull();
      const stored = await appendState(f.input);
      expect(stored.payloads).toEqual([]);
      expect(stored.items).toHaveLength(1);
      expect(stored.items[0]?.payloadJson).toMatchObject({
        type: 'host_context',
        name: 'runtime_policy@1',
        content: { value: { tool: 'agent_author_prompts', repair_attempt: 1, retryable: true } },
      });
      const window = await createNativeTranscriptReader(resource.db).readWindow({
        userId: f.input.userId,
        sessionId: f.input.sessionId,
        expectedGeneration: '1',
        firstSequence: '1',
        throughSequence: '1',
        requireClosed: true,
      });
      expect(window.protocol.protocol_closed).toBe(true);
      expect(window.items[0]?.item.payload_json).toMatchObject({
        type: 'host_context',
        name: 'runtime_policy@1',
        content: { value: { repair_attempt: 1, remaining_repair_attempts: 3 } },
      });
      expect(
        await resource.db.query.agentTraceSteps.findFirst({
          where: eq(agentTraceSteps.id, reserved.step.stepId),
        }),
      ).toMatchObject({
        status: 'failed',
        errorCode: 'AGENT_BRAIN_TOOL_INPUT_INVALID',
        estimatedCost: '0.01',
        tokenUsageJson: outcome.usage,
      });
      expect(draft).toEqual(before);
      expect(
        await resource.db.query.eventOutbox.findMany({
          where: eq(eventOutbox.scopeId, f.input.turnId),
        }),
      ).toEqual([]);
    },
  );

  it('refuses a missing capture input on reserve and settle instead of falling back to legacy', async () => {
    const f = await reserveModel();
    await expect(costRepository.reserve(f.request)).rejects.toThrow(
      'AGENT_TRANSCRIPT_CAPTURE_REQUIRED',
    );
    const { transcript, ...settle } = f.settle;
    void transcript;
    // @ts-expect-error Exercise a malformed runtime caller missing the required capture.
    await expect(costRepository.settle(settle)).rejects.toThrow(
      'AGENT_TRANSCRIPT_CAPTURE_REQUIRED',
    );
    expect((await appendState(f.input)).items).toEqual([]);
  });

  it('does not let a caller enable capture on a legacy turn', async () => {
    const f = await modelFixture(null);
    await expect(
      costRepository.reserve({ ...f.request, transcript: f.transcript }),
    ).rejects.toThrow('AGENT_TRANSCRIPT_WRITE_FAILED');
    expect(
      await resource.db.query.agentTraceSteps.findMany({
        where: eq(agentTraceSteps.traceId, f.request.claimed.traceId),
      }),
    ).toEqual([]);
  });

  it('does not recreate a missing accepted item during duplicate settlement', async () => {
    const f = await reserveModel();
    await costRepository.settle(f.settle);
    const saved = await appendState(f.input);
    const original = saved.items[0]!;
    // Synthetic fixture corruption, never a repair of application data.
    await resource.db.delete(agentTranscriptItems).where(eq(agentTranscriptItems.id, original.id));
    const before = await appendState(f.input);
    await expect(costRepository.settle(f.settle)).rejects.toThrow('AGENT_TRANSCRIPT_WRITE_FAILED');
    expect(await appendState(f.input)).toEqual(before);
    expect(before.session?.transcriptNextSequence).toBe(2n);
  });

  it('rejects corrupted private content on settlement replay without changing accounting', async () => {
    const f = await reserveModel();
    const plan = (
      planningBatch(f.input, randomUUID()).privatePayloads[0]!.content_json as {
        plan: Record<string, unknown>;
      }
    ).plan;
    const settle = {
      ...f.settle,
      outcome: { type: 'authoring_request' as const, plan, usage: f.settle.outcome.usage },
    };
    await costRepository.settle(settle);
    const payload = (await appendState(f.input)).payloads[0]!;
    await resource.db
      .update(agentTranscriptPayloads)
      .set({ contentJson: { tampered: true } })
      .where(eq(agentTranscriptPayloads.id, payload.id));
    const before = await appendState(f.input);
    const trace = await resource.db.query.agentTraces.findFirst({
      where: eq(agentTraces.id, f.request.claimed.traceId),
    });
    await expect(costRepository.settle(settle)).rejects.toThrow('AGENT_TRANSCRIPT_WRITE_FAILED');
    expect(await appendState(f.input)).toEqual(before);
    expect(
      await resource.db.query.agentTraces.findFirst({
        where: eq(agentTraces.id, f.request.claimed.traceId),
      }),
    ).toEqual(trace);
  });

  it('rolls back the inserted private payload/item when the final trace SQL fails', async () => {
    const f = await reserveModel();
    await resource.db
      .update(agentTraces)
      .set({ inputTokenTotal: 2_147_483_647 })
      .where(eq(agentTraces.id, f.request.claimed.traceId));
    const plan = (
      planningBatch(f.input, randomUUID()).privatePayloads[0]!.content_json as {
        plan: Record<string, unknown>;
      }
    ).plan;
    await expect(
      costRepository.settle({
        ...f.settle,
        outcome: {
          type: 'authoring_request',
          plan,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
    ).rejects.toThrow('AGENT_TRANSCRIPT_WRITE_FAILED');
    const state = await appendState(f.input);
    expect(state.items).toEqual([]);
    expect(state.payloads).toEqual([]);
    expect(state.session?.transcriptNextSequence).toBe(1n);
    expect(
      await resource.db.query.agentTraceSteps.findFirst({
        where: eq(agentTraceSteps.id, f.settle.step.stepId),
      }),
    ).toMatchObject({ status: 'started', outputSummary: {}, estimatedCost: '0.02' });
  });
});

describe('native transcript atomic append PostgreSQL', () => {
  it('commits a complete private draft/call/result and counter in one owned transaction', async () => {
    const input = await fixture();
    const batch = planningBatch(input, randomUUID(), 'Complete original text. '.repeat(4000));
    const result = await writer.run(input, (scope) =>
      appendNativeTranscriptBatch(scope, batch, appendContracts),
    );
    expect(result.appendedCount).toBe(2);
    expect(result.items.map((item) => item.sequence_no)).toEqual(['1', '2']);
    const state = await appendState(input);
    expect(state.session?.transcriptNextSequence).toBe(3n);
    expect(state.session?.transcriptGeneration).toBe(1n);
    expect(state.items).toHaveLength(2);
    expect(state.payloads).toHaveLength(1);
    expect(state.payloads[0]?.contentJson).toEqual(batch.privatePayloads[0]?.content_json);
    expect(state.payloads[0]?.byteSize).toBeGreaterThan(65_536);
  });

  it('deduplicates source and content even with newly allocated item/payload IDs', async () => {
    const input = await fixture();
    const step = randomUUID();
    const first = await writer.run(input, (scope) =>
      appendNativeTranscriptBatch(scope, planningBatch(input, step), appendContracts),
    );
    const second = await writer.run(input, (scope) =>
      appendNativeTranscriptBatch(scope, planningBatch(input, step), appendContracts),
    );
    expect(second).toEqual({ items: first.items, appendedCount: 0 });
    expect((await appendState(input)).payloads).toHaveLength(1);
    expect((await appendState(input)).session?.transcriptNextSequence).toBe(3n);
  });

  it('reuses a same-turn payload for a distinct accepted source without merging calls', async () => {
    const input = await fixture();
    await writer.run(input, (scope) =>
      appendNativeTranscriptBatch(scope, planningBatch(input, randomUUID()), appendContracts),
    );
    const second = await writer.run(input, (scope) =>
      appendNativeTranscriptBatch(scope, planningBatch(input, randomUUID()), appendContracts),
    );
    expect(second.items.map((item) => item.sequence_no)).toEqual(['3', '4']);
    const state = await appendState(input);
    expect(state.items).toHaveLength(4);
    expect(state.payloads).toHaveLength(1);
  });

  it('serializes concurrent duplicate responses into one group', async () => {
    const input = await fixture();
    const step = randomUUID();
    const results = await Promise.all(
      [0, 1].map(() =>
        writer.run(input, (scope) =>
          appendNativeTranscriptBatch(scope, planningBatch(input, step), appendContracts),
        ),
      ),
    );
    expect(results.map((result) => result.appendedCount).sort()).toEqual([0, 2]);
    expect(results[0]?.items).toEqual(results[1]?.items);
    expect((await appendState(input)).items).toHaveLength(2);
  });

  it('assigns disjoint contiguous ranges to concurrent distinct groups', async () => {
    const input = await fixture();
    const results = await Promise.all(
      [0, 1].map(() =>
        writer.run(input, (scope) =>
          appendNativeTranscriptBatch(scope, planningBatch(input, randomUUID()), appendContracts),
        ),
      ),
    );
    expect(
      results.flatMap((result) => result.items.map((item) => item.sequence_no)).sort(),
    ).toEqual(['1', '2', '3', '4']);
    expect((await appendState(input)).session?.transcriptNextSequence).toBe(5n);
  });

  it('rejects a source-content conflict without adding a payload or consuming sequence numbers', async () => {
    const input = await fixture();
    const step = randomUUID();
    await writer.run(input, (scope) =>
      appendNativeTranscriptBatch(scope, planningBatch(input, step), appendContracts),
    );
    const before = await appendState(input);
    await expect(
      writer.run(input, (scope) =>
        appendNativeTranscriptBatch(
          scope,
          planningBatch(input, step, 'Different'),
          appendContracts,
        ),
      ),
    ).rejects.toMatchObject({ reason: 'scope_rejected' });
    expect(await appendState(input)).toEqual(before);
  });

  it('closes the actual pending batch before allowing the next model output', async () => {
    const input = await fixture();
    const batch = planningBatch(input, randomUUID());
    await writer.run(input, (scope) =>
      appendNativeTranscriptBatch(scope, { ...batch, items: [batch.items[0]!] }, appendContracts),
    );
    await expect(
      writer.run(input, (scope) =>
        appendNativeTranscriptBatch(scope, planningBatch(input, randomUUID()), appendContracts),
      ),
    ).rejects.toMatchObject({ reason: 'scope_rejected' });
    await writer.run(input, (scope) =>
      appendNativeTranscriptBatch(
        scope,
        { items: [batch.items[1]!], privatePayloads: [] },
        appendContracts,
      ),
    );
    expect((await appendState(input)).session?.transcriptNextSequence).toBe(3n);
  });

  it('uses the current locked counter for multiple appends within one scope', async () => {
    const input = await fixture();
    await writer.run(input, async (scope) => {
      await appendNativeTranscriptBatch(scope, planningBatch(input, randomUUID()), appendContracts);
      await appendNativeTranscriptBatch(scope, planningBatch(input, randomUUID()), appendContracts);
    });
    expect((await appendState(input)).session?.transcriptNextSequence).toBe(5n);
  });

  it('poisons earlier message writes even when the caller catches a validation error', async () => {
    const input = await fixture();
    await expect(
      writer.run(input, async (scope) => {
        await scope.query((tx) =>
          tx.insert(chatMessages).values({
            sessionId: input.sessionId,
            turnId: input.turnId,
            role: 'assistant',
            content: 'Must roll back',
          }),
        );
        try {
          await appendNativeTranscriptBatch(
            scope,
            { items: [], privatePayloads: [] },
            appendContracts,
          );
        } catch {
          /* Prove that catching cannot commit a partial projection. */
        }
      }),
    ).rejects.toMatchObject({ reason: 'scope_rejected' });
    await expectUnchanged(input);
  });

  it.each(['missing', 'extra', 'cross_owner', 'tampered'] as const)(
    'rejects %s private payloads atomically',
    async (kind) => {
      const input = await fixture();
      const batch = planningBatch(input, randomUUID());
      const record = batch.privatePayloads[0]!;
      const payloads =
        kind === 'missing'
          ? []
          : kind === 'extra'
            ? [record, { ...record, id: randomUUID() }]
            : [
                {
                  ...record,
                  ...(kind === 'cross_owner'
                    ? { user_id: randomUUID() }
                    : { content_json: { plan: {} } }),
                },
              ];
      await expect(
        writer.run(input, (scope) =>
          appendNativeTranscriptBatch(
            scope,
            { ...batch, privatePayloads: payloads },
            appendContracts,
          ),
        ),
      ).rejects.toMatchObject({ reason: 'scope_rejected' });
      const state = await appendState(input);
      expect(state.items).toEqual([]);
      expect(state.payloads).toEqual([]);
      expect(state.session?.transcriptNextSequence).toBe(1n);
    },
  );

  it('does not reuse corrupted private content just because the stored digest matches', async () => {
    const input = await fixture();
    await writer.run(input, (scope) =>
      appendNativeTranscriptBatch(scope, planningBatch(input, randomUUID()), appendContracts),
    );
    const before = await appendState(input);
    await resource.db
      .update(agentTranscriptPayloads)
      .set({ contentJson: {} })
      .where(eq(agentTranscriptPayloads.id, before.payloads[0]!.id));
    await expect(
      writer.run(input, (scope) =>
        appendNativeTranscriptBatch(scope, planningBatch(input, randomUUID()), appendContracts),
      ),
    ).rejects.toMatchObject({ reason: 'scope_rejected' });
    expect((await appendState(input)).items).toHaveLength(2);
  });

  it('normalizes payload UUID metadata before linking a newly inserted payload', async () => {
    const input = await fixture();
    const batch = planningBatch(input, randomUUID());
    const record = batch.privatePayloads[0]!;
    const result = await writer.run(input, (scope) =>
      appendNativeTranscriptBatch(
        scope,
        {
          ...batch,
          privatePayloads: [
            { ...record, id: record.id.toUpperCase(), user_id: record.user_id.toUpperCase() },
          ],
        },
        appendContracts,
      ),
    );
    const state = await appendState(input);
    expect(state.payloads[0]?.id).toBe(record.id);
    expect(result.items[0]?.payload_json).toMatchObject({
      calls: [{ arguments: { payload_id: record.id } }],
    });
  });

  it('rolls back newly inserted payloads when the item insert fails', async () => {
    const input = await fixture();
    const first = await writer.run(input, (scope) =>
      appendNativeTranscriptBatch(scope, planningBatch(input, randomUUID()), appendContracts),
    );
    await writer.run(input, (scope) =>
      appendNativeTranscriptBatch(scope, planningBatch(input, randomUUID()), appendContracts),
    );
    const before = await appendState(input);
    const batch = planningBatch(input, randomUUID(), 'New content');
    const raw = batch.items[0]!;
    const metadata = { ...raw };
    delete (metadata as { payload_digest?: string }).payload_digest;
    const collision = prepareAgentTranscriptItem(
      { ...metadata, id: first.items[0]!.id },
      appendContracts,
    ).item;
    await expect(
      writer.run(input, (scope) =>
        appendNativeTranscriptBatch(
          scope,
          { items: [collision], privatePayloads: batch.privatePayloads },
          appendContracts,
        ),
      ),
    ).rejects.toMatchObject({ reason: 'storage_unavailable' });
    expect(await appendState(input)).toEqual(before);
  });

  it('never resurrects a revoked source through an old idempotent append', async () => {
    const input = await fixture();
    const step = randomUUID();
    const first = await writer.run(input, (scope) =>
      appendNativeTranscriptBatch(scope, planningBatch(input, step), appendContracts),
    );
    const tombstone = {
      schema_version: 1,
      type: 'redacted',
      reason: 'resource_revoked',
      original_payload_digest: first.items[0]!.payload_digest,
      redacted_at: '2026-09-08T01:00:00.000Z',
    };
    await resource.db
      .update(agentTranscriptItems)
      .set({ payloadJson: tombstone, payloadDigest: canonicalSha256(tombstone) })
      .where(eq(agentTranscriptItems.id, first.items[0]!.id));
    const before = await appendState(input);
    await expect(
      writer.run(input, (scope) =>
        appendNativeTranscriptBatch(scope, planningBatch(input, step), appendContracts),
      ),
    ).rejects.toMatchObject({ reason: 'scope_rejected' });
    expect(await appendState(input)).toEqual(before);
  });
});

async function waitForWriterLock() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [row] = await resource.db.execute(
      sql`select exists(select 1 from pg_stat_activity where application_name = ${applicationName} and wait_event_type = 'Lock') as waiting`,
    );
    if (row?.waiting === true) return;
    await delay(5);
  }
  throw new Error('Fixture writer did not enter a PostgreSQL lock wait');
}

describe('owned transcript write transaction PostgreSQL fencing', () => {
  it.each(['shadow', 'active'] as const)(
    'commits related fixture projections under a %s session without enabling capture',
    async (mode) => {
      const input = await fixture({ session: { transcriptStateJson: state(mode) } });
      const result = await writer.run(input, async (scope) => {
        expect(Object.isFrozen(scope)).toBe(true);
        await mark(scope);
        return scope.nextSequence.toString();
      });
      expect(result).toBe('1');
      const session = await resource.db.query.chatSessions.findFirst({
        where: eq(chatSessions.id, input.sessionId),
      });
      expect(session).toMatchObject({
        transcriptNextSequence: 2n,
        transcriptGeneration: 1n,
        messageHistoryRevision: 1n,
        transcriptStateJson: state(mode),
      });
      const turn = await resource.db.query.agentTurns.findFirst({
        where: eq(agentTurns.id, input.turnId),
      });
      expect(turn?.executionFormat).toBe('legacy_v1');
    },
  );

  it('rolls back every projection when the callback fails and sanitizes its exception', async () => {
    const input = await fixture();
    await expect(
      writer.run(input, async (scope) => {
        await mark(scope);
        throw new Error('private prompt content');
      }),
    ).rejects.toMatchObject({
      reason: 'storage_unavailable',
      message: 'AGENT_TRANSCRIPT_WRITE_FAILED',
    });
    await expectUnchanged(input);
  });

  it('surfaces a deterministic domain invariant as domain_conflict with a controlled detail', async () => {
    const input = await fixture();
    await expect(
      writer.run(input, async (scope) => {
        await mark(scope);
        throw new Error('AGENT_TRACE_MISSING');
      }),
    ).rejects.toMatchObject({
      reason: 'domain_conflict',
      detail: 'AGENT_TRACE_MISSING',
      message: 'AGENT_TRANSCRIPT_WRITE_FAILED',
    });
    await expectUnchanged(input);
  });

  it.each(['off', 'backfill', 'invalid'])('rejects %s before the write callback', async (mode) => {
    const input = await fixture({ session: { transcriptStateJson: { schema_version: 1, mode } } });
    const operation = vi.fn();
    await expect(writer.run(input, operation)).rejects.toMatchObject({
      reason: 'session_state_invalid',
    });
    expect(operation).not.toHaveBeenCalled();
  });

  it.each([
    { transcriptStateJson: { ...state(), extra: true } },
    { transcriptStateJson: { ...state(), verified_through_sequence: '1' } },
  ])('rejects an invalid integrity checkpoint: %j', async (session) => {
    const input = await fixture({ session });
    const operation = vi.fn();
    await expect(writer.run(input, operation)).rejects.toMatchObject({
      reason: 'session_state_invalid',
    });
    expect(operation).not.toHaveBeenCalled();
  });

  it('rejects an archived session', async () => {
    const input = await fixture({ session: { archivedAt: new Date() } });
    await expect(writer.run(input, vi.fn())).rejects.toMatchObject({
      reason: 'session_unavailable',
    });
  });

  it.each([
    'userId',
    'sessionId',
    'turnId',
    'owner',
    'revision',
    'continuationNo',
    'expectedGeneration',
  ] as const)('rejects a stale or different %s before writes', async (key) => {
    const input = await fixture();
    const changed = {
      ...input,
      [key]:
        key === 'revision' || key === 'continuationNo'
          ? 2
          : key === 'expectedGeneration'
            ? '2'
            : randomUUID(),
    };
    const operation = vi.fn();
    await expect(writer.run(changed, operation)).rejects.toMatchObject({
      message: 'AGENT_TRANSCRIPT_WRITE_FAILED',
    });
    expect(operation).not.toHaveBeenCalled();
    await expectUnchanged(input);
  });

  it.each([
    { transcriptCaptureVersion: null },
    { status: 'done' as const },
    { status: 'waiting_user_confirmation' as const },
    { processingOwner: null, processingLeaseExpiresAt: null },
    { processingLeaseExpiresAt: new Date('2020-01-01T00:00:00.000Z') },
  ])('rejects an unowned or uncaptured turn: %j', async (turn) => {
    const input = await fixture({ turn });
    const operation = vi.fn();
    await expect(writer.run(input, operation)).rejects.toMatchObject({ reason: 'turn_stale' });
    expect(operation).not.toHaveBeenCalled();
  });

  it('keeps bigint sequence values lossless', async () => {
    const input = await fixture({ session: { transcriptNextSequence: 9_007_199_254_740_995n } });
    const sequence = await writer.run(input, async (scope) => {
      await mark(scope);
      return scope.nextSequence;
    });
    expect(sequence).toBe(9_007_199_254_740_995n);
  });

  it('rechecks the original lease before committing a callback that clears its owner', async () => {
    const input = await fixture({ leaseMs: 500 });
    await expect(
      writer.run(input, async (scope) => {
        await mark(scope);
        await scope.query((tx) =>
          tx
            .update(agentTurns)
            .set({ status: 'done', processingOwner: null, processingLeaseExpiresAt: null })
            .where(eq(agentTurns.id, scope.turnId)),
        );
        await delay(700);
      }),
    ).rejects.toMatchObject({ reason: 'lease_expired' });
    await expectUnchanged(input);
    const turn = await resource.db.query.agentTurns.findFirst({
      where: eq(agentTurns.id, input.turnId),
    });
    expect(turn?.status).toBe('planning');
  });

  it('serializes concurrent writers without losing sequence or revision increments', async () => {
    const input = await fixture();
    const sequences = await Promise.all(
      [1, 2].map(() =>
        writer.run(input, async (scope) => {
          await mark(scope);
          return scope.nextSequence.toString();
        }),
      ),
    );
    expect(sequences.sort()).toEqual(['1', '2']);
    const session = await resource.db.query.chatSessions.findFirst({
      where: eq(chatSessions.id, input.sessionId),
    });
    expect(session).toMatchObject({ transcriptNextSequence: 3n, messageHistoryRevision: 2n });
  });

  it('waits for the session lock before trying to lock the turn', async () => {
    const input = await fixture();
    const held = gate(),
      release = gate();
    const holder = resource.db.transaction(async (tx) => {
      await tx
        .select()
        .from(chatSessions)
        .where(eq(chatSessions.id, input.sessionId))
        .for('no key update');
      held.release();
      await release.ready;
    });
    await held.ready;
    const writing = writer.run(input, mark);
    try {
      await waitForWriterLock();
      await resource.db.transaction(async (tx) => {
        await tx
          .select()
          .from(agentTurns)
          .where(eq(agentTurns.id, input.turnId))
          .for('update', { noWait: true });
      });
    } finally {
      release.release();
      await holder;
      await writing;
    }
  });

  it('bounds lock waiting and does not run the callback after lock timeout', async () => {
    const input = await fixture();
    const held = gate(),
      release = gate();
    const holder = resource.db.transaction(async (tx) => {
      await tx
        .select()
        .from(chatSessions)
        .where(eq(chatSessions.id, input.sessionId))
        .for('no key update');
      held.release();
      await release.ready;
    });
    await held.ready;
    const operation = vi.fn();
    try {
      const bounded = new AgentTranscriptWriteTransactions(resource.db, {
        lockTimeoutMs: 100,
        transactionTimeoutMs: 5000,
      });
      await expect(bounded.run(input, operation)).rejects.toMatchObject({ reason: 'lock_timeout' });
      expect(operation).not.toHaveBeenCalled();
    } finally {
      release.release();
      await holder;
    }
    await expectUnchanged(input);
  });

  it('cannot swallow a SQL error and commit earlier writes', async () => {
    const input = await fixture();
    await expect(
      writer.run(input, async (scope) => {
        await mark(scope);
        await scope.query((tx) => tx.execute(sql`select 1 / 0`)).catch(() => undefined);
      }),
    ).rejects.toMatchObject({ reason: 'storage_unavailable' });
    await expectUnchanged(input);
  });

  it('poisons the scope when queries overlap, even when both errors are caught', async () => {
    const input = await fixture();
    await expect(
      writer.run(input, async (scope) => {
        await mark(scope);
        await Promise.allSettled([
          scope.query((tx) => tx.execute(sql`select 1`)),
          scope.query((tx) => tx.execute(sql`select 2`)),
        ]);
      }),
    ).rejects.toMatchObject({ reason: 'concurrent_query' });
    await expectUnchanged(input);
  });

  it('revokes a retained scope after a successful transaction', async () => {
    const input = await fixture();
    let retained!: AgentTranscriptWriteScope;
    await writer.run(input, (scope) => {
      retained = scope;
      return Promise.resolve();
    });
    await expect(retained.query((tx) => tx.execute(sql`select 1`))).rejects.toMatchObject({
      reason: 'scope_closed',
    });
  });

  it('does not refresh the total transaction budget after each short statement', async () => {
    const input = await fixture();
    const bounded = new AgentTranscriptWriteTransactions(resource.db, {
      lockTimeoutMs: 100,
      transactionTimeoutMs: 600,
    });
    let completed = 0;
    await expect(
      bounded.run(input, async (scope) => {
        await mark(scope);
        for (let index = 0; index < 3; index += 1) {
          await scope.query((tx) => tx.execute(sql`select pg_sleep(0.25)`));
          completed += 1;
        }
      }),
    ).rejects.toMatchObject({ reason: 'transaction_expired' });
    expect(completed).toBeLessThan(3);
    await expectUnchanged(input);
  });

  it.each(['sql', 'idle'] as const)(
    'rolls back a %s overrun and prevents late callback writes',
    async (mode) => {
      const input = await fixture();
      const bounded = new AgentTranscriptWriteTransactions(resource.db, {
        lockTimeoutMs: 100,
        transactionTimeoutMs: 600,
      });
      const release = gate();
      const finished = gate();
      let retained!: AgentTranscriptWriteScope;
      const writing = bounded.run(input, async (scope) => {
        retained = scope;
        try {
          await mark(scope);
          if (mode === 'sql') await scope.query((tx) => tx.execute(sql`select pg_sleep(2)`));
          else await release.ready;
        } finally {
          finished.release();
        }
      });
      try {
        await expect(writing).rejects.toMatchObject({ reason: 'transaction_expired' });
      } finally {
        release.release();
        await finished.ready;
      }
      await expect(retained.query((tx) => tx.execute(sql`select 1`))).rejects.toMatchObject({
        reason: 'transaction_expired',
      });
      await expectUnchanged(input);
    },
  );
});

describe('native transcript recovery zones PostgreSQL', () => {
  const tool = new AgentTurnToolRepository(resource.db);
  const reader = createNativeTranscriptReader(resource.db);

  /** A two-call knowledge batch captured through the real reserve/settle path. */
  async function reserveKnowledgeBatch() {
    const calls = ['optional-a@1.0.0', 'optional-b@1.0.0'].map((skillId, index) => ({
      name: 'load_skill@1' as const,
      call_id: `call-knowledge-${index}`,
      arguments: { skill_id: skillId, view: 'planning' },
    }));
    const outcome: AgentBrainStepOutcome = {
      type: 'tool_calls',
      calls,
      usage: { input_tokens: 3, output_tokens: 1 },
    };
    const f = await reserveNativeModel(outcome);
    const recover = async () => {
      const window = await reader.readCurrentWindow({
        userId: f.input.userId,
        sessionId: f.input.sessionId,
        expectedGeneration: '1',
      });
      return readNativeTranscriptRecovery(resource.db, window.items, f.claimed);
    };
    return { ...f, outcome, recover };
  }

  it('restores the original batch unchanged when the crash happens before any execution', async () => {
    const f = await reserveKnowledgeBatch();
    const recovery = await f.recover();
    expect(recovery.pending).toBeDefined();
    expect(recovery.pending?.completedOrdinals).toEqual([]);
    expect(recovery.pending?.outcome).toMatchObject({
      type: 'tool_calls',
      usage: { input_tokens: 3, output_tokens: 1 },
    });
    // Recovery replays the accepted semantics; it must not invent or reorder calls.
    expect(
      recovery.pending?.outcome.type === 'tool_calls'
        ? recovery.pending.outcome.calls.map((call) => call.call_id)
        : [],
    ).toEqual(['call-knowledge-0', 'call-knowledge-1']);
  });

  it('never resumes a batch that the writer closed with a rejected member', async () => {
    const f = await reserveKnowledgeBatch();
    const request = {
      claimed: f.claimed,
      revision: 1,
      llmStepId: f.step.stepId,
      callOrdinal: 0,
      callCount: 2,
      callPositionKey: callPositionKey({
        turnId: f.input.turnId,
        continuationNo: 1,
        llmStepNo: f.step.stepNo,
        callIndex: 0,
      }),
      toolName: 'load_skill@1',
      argsHash: canonicalSha256(f.outcome.calls[0]!.arguments),
      toolFingerprint: 'b'.repeat(64),
      errorCode: 'SKILL_NOT_AVAILABLE',
      diagnosticCode: 'synthetic_unavailable',
      errorKey: 'c'.repeat(64),
      progressHash: 'd'.repeat(64),
    };
    expect(await tool.finishToolFailure(request)).toBeTruthy();
    // A closed batch with a non-succeeded member is not resumable: replay only, no re-dispatch,
    // and the recovery must not hand the caller a pending execution to run again.
    const recovery = await f.recover();
    expect(recovery.pending).toBeUndefined();
  });
});
