import {
  type AgentTranscriptItem,
  type AgentTranscriptItemContracts,
  type AgentTranscriptPayloadReference,
  type AgentTranscriptValueContract,
  transcriptSequenceSchema,
  verifyAgentTranscriptPayload,
  validateAgentTranscriptProtocol,
} from '@ecom-forge/agent';
import {
  agentTranscriptItems,
  agentTranscriptPayloads,
  agentTraceSteps,
  agentTraces,
  agentTurns,
  and,
  asc,
  chatMessages,
  chatSessions,
  eq,
  desc,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  sql,
  type Database,
} from '@ecom-forge/db';
import { canonicalJson } from '@ecom-forge/shared';
import { z } from 'zod';
import { WORKER_RUNTIME_DEFAULTS as limits } from '../config/runtime-defaults.js';

import { emitTranscriptMetric } from './agent-transcript-metrics.js';
import { verifyTranscriptModelOutputSource } from './agent-transcript-model-binding.js';
import { verifyStoredTranscriptItem } from './agent-transcript-storage-mapping.js';

const uuidSchema = z.uuid().toLowerCase();
const readInputSchema = z.strictObject({
  userId: uuidSchema,
  sessionId: uuidSchema,
  itemId: uuidSchema,
});
const windowInputSchema = z.strictObject({
  userId: uuidSchema,
  sessionId: uuidSchema,
  expectedGeneration: transcriptSequenceSchema,
  firstSequence: transcriptSequenceSchema,
  throughSequence: transcriptSequenceSchema,
  requireClosed: z.boolean(),
});
const activeStateSchema = z.strictObject({
  schema_version: z.literal(1),
  mode: z.literal('active'),
  integrity_version: z.literal(1),
  verified_through_sequence: z.union([z.literal('0'), transcriptSequenceSchema]),
  verified_digest: z.string().regex(/^[a-f0-9]{64}$/),
});

type ReadInput = z.infer<typeof readInputSchema>;
interface SessionFence {
  generation: bigint;
  messageRevision: bigint;
  nextSequence: bigint;
}
type PayloadRow = typeof agentTranscriptPayloads.$inferSelect;
type SourceMessage = Pick<
  typeof chatMessages.$inferSelect,
  | 'id'
  | 'sessionId'
  | 'turnId'
  | 'role'
  | 'content'
  | 'attachments'
  | 'toolCalls'
  | 'skillSnapshots'
  | 'pendingApproval'
>;

export type AgentTranscriptReadFailure =
  | 'input_invalid'
  | 'storage_unavailable'
  | 'session_unavailable'
  | 'session_state_invalid'
  | 'history_changed'
  | 'item_unavailable'
  | 'item_invalid'
  | 'source_unavailable'
  | 'source_invalid'
  | 'source_verifier_missing'
  | 'dependencies_unauthorized'
  | 'dependency_authorizer_missing'
  | 'payload_unavailable'
  | 'payload_invalid'
  | 'redacted_unavailable';

export class AgentTranscriptReadError extends Error {
  constructor(readonly reason: AgentTranscriptReadFailure) {
    super('AGENT_TRANSCRIPT_READ_FAILED');
    this.name = 'AgentTranscriptReadError';
  }
}

export interface AgentTranscriptRepositoryOptions {
  itemContracts: AgentTranscriptItemContracts;
  /** Verify exact host message/import semantics, not merely the source UUID. */
  verifyMessageSource?: (input: {
    item: AgentTranscriptItem;
    source: Readonly<SourceMessage>;
  }) => boolean | Promise<boolean>;
  /** Verify the event's real domain source before any private payload is materialized. */
  verifyHostContextSource?: (item: AgentTranscriptItem) => boolean | Promise<boolean>;
  /** Bind result semantics to its verified original call, not just name/argument digest. */
  verifyToolResultSource?: (input: {
    item: AgentTranscriptItem;
    parent: AgentTranscriptItem;
  }) => boolean | Promise<boolean>;
  /** Re-establish complete, live dependencies from host truth, including empty lists. */
  authorizeDependencies?: (input: {
    item: AgentTranscriptItem;
    dependencies: readonly unknown[];
  }) => boolean | Promise<boolean>;
  materializeResources?: (
    item: AgentTranscriptItem,
  ) => Promise<readonly TranscriptResourceContent[]>;
}

export interface TranscriptResourceContent {
  readonly resource_snapshot_id: string;
  readonly resource_hash: string;
  readonly skill_id: string;
  readonly resource_path: string;
  readonly content: string;
}

export interface AuthorizedAgentTranscriptPayload {
  readonly reference: AgentTranscriptPayloadReference;
  readonly value: unknown;
}

export interface AuthorizedAgentTranscriptItem {
  readonly item: AgentTranscriptItem;
  readonly history_generation: string;
  readonly private_payloads: readonly AuthorizedAgentTranscriptPayload[];
  readonly resource_contents?: readonly TranscriptResourceContent[];
}

/** Read-only materialization, not a protocol-window or execution authorization. */
export class AgentTranscriptRepository {
  constructor(
    private readonly database: Pick<Database, 'query' | 'select'>,
    private readonly options: AgentTranscriptRepositoryOptions,
  ) {}

  async readItem(raw: ReadInput): Promise<AuthorizedAgentTranscriptItem> {
    return this.readMaterializedItem(raw, (item) => item);
  }

  /** Read the current native transcript without requiring callers to guess the tail sequence. */
  async readCurrentWindow(input: {
    userId: string;
    sessionId: string;
    expectedGeneration: string;
    firstSequence?: string;
    requireClosed?: boolean;
  }) {
    const parsed = windowInputSchema.omit({ throughSequence: true }).safeParse({
      ...input,
      firstSequence: input.firstSequence ?? '1',
      requireClosed: input.requireClosed ?? false,
    });
    if (!parsed.success) fail('input_invalid');
    const session = await this.readSession(parsed.data);
    if (session.generation !== BigInt(parsed.data.expectedGeneration)) fail('history_changed');
    const firstSequence = parsed.data.firstSequence;
    const through = session.nextSequence - 1n;
    if (BigInt(firstSequence) > session.nextSequence) fail('input_invalid');
    if (through < BigInt(firstSequence)) {
      await this.verifyWindowStart(parsed.data, BigInt(firstSequence));
      const current = await this.readSession(parsed.data);
      if (
        current.generation !== session.generation ||
        current.messageRevision !== session.messageRevision ||
        current.nextSequence !== session.nextSequence
      )
        fail('history_changed');
      return Object.freeze({
        items: Object.freeze([]),
        protocol: Object.freeze({
          protocol_closed: true,
          through_sequence_no: null,
          pending_calls: [],
          unresolved_payload_references: [],
        }),
        history_generation: input.expectedGeneration,
        byte_size: 0,
      });
    }
    const window = await this.readWindow({
      userId: input.userId,
      sessionId: input.sessionId,
      expectedGeneration: input.expectedGeneration,
      firstSequence,
      throughSequence: through.toString(),
      requireClosed: input.requireClosed ?? false,
    });
    const current = await this.readSession(parsed.data);
    if (
      current.generation !== session.generation ||
      current.messageRevision !== session.messageRevision ||
      current.nextSequence !== session.nextSequence
    )
      fail('history_changed');
    return window;
  }

  async readWindow(raw: z.infer<typeof windowInputSchema>) {
    try {
      const parsed = windowInputSchema.safeParse(raw);
      if (!parsed.success) fail('input_invalid');
      const input = parsed.data;
      const first = BigInt(input.firstSequence);
      const through = BigInt(input.throughSequence);
      const initial = await this.readSession(input);
      if (initial.generation.toString() !== input.expectedGeneration) fail('history_changed');
      if (
        first > through ||
        through >= initial.nextSequence ||
        through - first >= BigInt(limits.agentTranscriptReadMaxItems)
      )
        fail('input_invalid');
      await this.verifyWindowStart(input, first);
      const items: AuthorizedAgentTranscriptItem[] = [];
      let cursor = first;
      let bytes = 0;
      while (cursor <= through) {
        const rows = await this.database.query.agentTranscriptItems.findMany({
          where: and(
            eq(agentTranscriptItems.userId, input.userId),
            eq(agentTranscriptItems.sessionId, input.sessionId),
            gte(agentTranscriptItems.sequenceNo, cursor),
            lte(agentTranscriptItems.sequenceNo, through),
          ),
          orderBy: [asc(agentTranscriptItems.sequenceNo)],
          limit: limits.agentTranscriptReadPageItems,
          columns: { id: true, sequenceNo: true },
        });
        if (!rows.length) fail('item_unavailable');
        for (const row of rows) {
          if (row.sequenceNo !== cursor) fail('item_invalid');
          const item = await this.readItem({
            userId: input.userId,
            sessionId: input.sessionId,
            itemId: row.id,
          });
          if (
            item.history_generation !== input.expectedGeneration ||
            BigInt(item.item.sequence_no) !== cursor
          )
            fail('history_changed');
          bytes +=
            Buffer.byteLength(canonicalJson(item.item)) +
            item.private_payloads.reduce((sum, payload) => sum + payload.reference.byte_size, 0) +
            (item.resource_contents ?? []).reduce(
              (sum, resource) => sum + Buffer.byteLength(resource.content, 'utf8'),
              0,
            );
          if (bytes > limits.agentTranscriptReadMaxBytes) fail('input_invalid');
          items.push(item);
          cursor += 1n;
        }
      }
      const protocol = validateAgentTranscriptProtocol(
        {
          scope: { user_id: input.userId, session_id: input.sessionId },
          first_sequence_no: input.firstSequence,
          require_closed: input.requireClosed,
          items: items.map((item) => item.item),
        },
        this.options.itemContracts,
      );
      // A later item may take time to authorize. Recheck earlier dependencies at the final fence.
      for (const item of items) await this.authorizeDependencies(item.item);
      const current = await this.readSession(input);
      if (
        current.generation !== initial.generation ||
        current.messageRevision !== initial.messageRevision ||
        current.nextSequence !== initial.nextSequence
      )
        fail('history_changed');
      return Object.freeze({
        items: Object.freeze(items),
        protocol,
        history_generation: input.expectedGeneration,
        byte_size: bytes,
      });
    } catch (error) {
      if (error instanceof AgentTranscriptReadError) {
        emitIntegrityFailure(error.reason);
        throw error;
      }
      // An unexpected failure while materializing this window is an infrastructure problem, not
      // evidence that the captured history is inconsistent. Reporting it as `item_invalid` claimed
      // the session was corrupt and polluted the integrity metric operations watch. Match
      // `readMaterializedItem`, which already classifies this case as `storage_unavailable`
      // (`INTEGRITY_FAILURE_REASONS` deliberately excludes it from the integrity metric).
      emitIntegrityFailure('storage_unavailable');
      fail('storage_unavailable');
    }
  }

  private async verifyWindowStart(
    input: Pick<z.infer<typeof windowInputSchema>, 'userId' | 'sessionId'>,
    first: bigint,
  ) {
    if (first === 1n) return;
    const parent = await this.database.query.agentTranscriptItems.findFirst({
      where: and(
        eq(agentTranscriptItems.userId, input.userId),
        eq(agentTranscriptItems.sessionId, input.sessionId),
        eq(agentTranscriptItems.itemType, 'assistant_output'),
        lt(agentTranscriptItems.sequenceNo, first),
      ),
      orderBy: [desc(agentTranscriptItems.sequenceNo)],
      columns: { sequenceNo: true },
    });
    if (!parent) return;
    const tail = await this.database.query.agentTranscriptItems.findMany({
      where: and(
        eq(agentTranscriptItems.userId, input.userId),
        eq(agentTranscriptItems.sessionId, input.sessionId),
        gte(agentTranscriptItems.sequenceNo, parent.sequenceNo),
        lt(agentTranscriptItems.sequenceNo, first),
      ),
      orderBy: [asc(agentTranscriptItems.sequenceNo)],
      limit: limits.agentTranscriptAppendTailItems,
    });
    if (BigInt(tail.length) !== first - parent.sequenceNo) fail('item_invalid');
    validateAgentTranscriptProtocol(
      {
        scope: { user_id: input.userId, session_id: input.sessionId },
        first_sequence_no: parent.sequenceNo.toString(),
        require_closed: true,
        items: tail.map((row) => this.verifyItem(row, input)),
      },
      this.options.itemContracts,
    );
  }

  /** Host-only read callback, fenced on both sides; never use it to execute a tool. */
  async readMaterializedItem<T>(
    raw: ReadInput,
    materialize: (item: AuthorizedAgentTranscriptItem) => T | Promise<T>,
  ): Promise<T> {
    try {
      return await this.readOwnedItem(raw, materialize);
    } catch (error) {
      if (error instanceof AgentTranscriptReadError) {
        emitIntegrityFailure(error.reason);
        throw error;
      }
      emitIntegrityFailure('storage_unavailable');
      fail('storage_unavailable');
    }
  }

  private async readOwnedItem<T>(
    raw: ReadInput,
    materialize: (item: AuthorizedAgentTranscriptItem) => T | Promise<T>,
  ): Promise<T> {
    const parsed = readInputSchema.safeParse(raw);
    if (!parsed.success) fail('input_invalid');
    const input = parsed.data;
    const initial = await this.readSession(input);
    const row = await this.database.query.agentTranscriptItems.findFirst({
      where: and(
        eq(agentTranscriptItems.id, input.itemId),
        eq(agentTranscriptItems.userId, input.userId),
        eq(agentTranscriptItems.sessionId, input.sessionId),
      ),
    });
    if (!row) fail('item_unavailable');
    const item = this.verifyItem(row, input);
    if (item.id !== input.itemId) fail('item_invalid');
    if (item.payload_json.type === 'redacted') fail('redacted_unavailable');
    if (BigInt(item.sequence_no) >= initial.nextSequence) fail('session_state_invalid');

    await this.verifySources(item);
    const parent = await this.readParent(item, input);
    if (parent) {
      await this.verifySources(parent);
      if (!this.options.verifyToolResultSource) fail('source_verifier_missing');
      try {
        if ((await this.options.verifyToolResultSource({ item, parent })) !== true)
          fail('source_invalid');
      } catch {
        fail('source_invalid');
      }
      await this.authorizeDependencies(parent);
    }
    await this.authorizeDependencies(item);
    // Read gate (Q1): live permissions/lifecycle are re-checked BEFORE any private payload is
    // materialized, so a revoked/isolated resource is rejected without waiting for the sweeper.
    const payloads = await this.readPrivatePayloads(item, initial);
    const resources = await this.options.materializeResources?.(item);
    const result = await materialize(
      Object.freeze({
        item,
        history_generation: initial.generation.toString(),
        private_payloads: Object.freeze(payloads),
        ...(resources?.length ? { resource_contents: resources } : {}),
      }),
    );

    // Resource revocation need not wait for the transcript cleanup generation bump.
    if (parent) await this.authorizeDependencies(parent);
    await this.authorizeDependencies(item);
    // Authorization can await host I/O. Never return a view invalidated while it was read.
    const current = await this.readSession(input);
    if (
      current.generation !== initial.generation ||
      current.messageRevision !== initial.messageRevision ||
      current.nextSequence <= BigInt(item.sequence_no)
    ) {
      fail('history_changed');
    }
    return result;
  }

  private async readSession(input: Pick<ReadInput, 'userId' | 'sessionId'>): Promise<SessionFence> {
    const row = await this.database.query.chatSessions.findFirst({
      where: and(
        eq(chatSessions.id, input.sessionId),
        eq(chatSessions.userId, input.userId),
        isNull(chatSessions.archivedAt),
      ),
      columns: {
        id: true,
        userId: true,
        archivedAt: true,
        transcriptStateJson: true,
        transcriptGeneration: true,
        transcriptNextSequence: true,
        messageHistoryRevision: true,
      },
    });
    if (
      !row ||
      row.id !== input.sessionId ||
      row.userId !== input.userId ||
      row.archivedAt !== null
    )
      fail('session_unavailable');
    const state = activeStateSchema.safeParse(row.transcriptStateJson);
    if (!state.success) fail('session_state_invalid');
    const verifiedThrough = BigInt(state.data.verified_through_sequence);
    if (
      typeof row.transcriptGeneration !== 'bigint' ||
      row.transcriptGeneration < 1n ||
      typeof row.transcriptNextSequence !== 'bigint' ||
      row.transcriptNextSequence <= verifiedThrough ||
      typeof row.messageHistoryRevision !== 'bigint' ||
      row.messageHistoryRevision < 0n
    )
      fail('session_state_invalid');
    return {
      generation: row.transcriptGeneration,
      messageRevision: row.messageHistoryRevision,
      nextSequence: row.transcriptNextSequence,
    };
  }

  private async readParent(item: AgentTranscriptItem, input: ReadInput) {
    if (item.payload_json.type !== 'tool_result') return null;
    const row = await this.database.query.agentTranscriptItems.findFirst({
      where: and(
        eq(agentTranscriptItems.id, item.reply_to_item_id!),
        eq(agentTranscriptItems.userId, item.user_id),
        eq(agentTranscriptItems.sessionId, item.session_id),
        eq(agentTranscriptItems.turnId, item.turn_id!),
      ),
    });
    if (!row) fail('source_unavailable');
    const parent = this.verifyItem(row, input);
    const payload = parent.payload_json;
    if (payload.type === 'redacted') fail('redacted_unavailable');
    if (
      payload.type !== 'assistant_output' ||
      parent.id !== item.reply_to_item_id ||
      parent.turn_id !== item.turn_id ||
      BigInt(parent.sequence_no) >= BigInt(item.sequence_no) ||
      parent.continuation_no! > item.continuation_no!
    )
      fail('item_invalid');
    const call = payload.calls[item.call_ordinal!];
    if (
      !call ||
      call.name !== item.payload_json.name ||
      call.arguments_digest !== item.payload_json.arguments_digest
    ) {
      fail('item_invalid');
    }
    const dependencies = new Set(item.resource_dependencies_json.map(canonicalJson));
    if (
      parent.resource_dependencies_json.some(
        (dependency) => !dependencies.has(canonicalJson(dependency)),
      )
    ) {
      fail('item_invalid');
    }
    return parent;
  }

  private verifyItem(
    row: typeof agentTranscriptItems.$inferSelect,
    input: Pick<ReadInput, 'userId' | 'sessionId'>,
  ) {
    try {
      return verifyStoredTranscriptItem(
        row,
        { user_id: input.userId, session_id: input.sessionId },
        this.options.itemContracts,
      );
    } catch {
      fail('item_invalid');
    }
  }

  private async verifySources(item: AgentTranscriptItem): Promise<void> {
    if (item.turn_id) {
      const turn = await this.database.query.agentTurns.findFirst({
        where: and(
          eq(agentTurns.id, item.turn_id),
          eq(agentTurns.sessionId, item.session_id),
          eq(agentTurns.userId, item.user_id),
        ),
        columns: {
          id: true,
          userId: true,
          sessionId: true,
          continuationNo: true,
          transcriptCaptureVersion: true,
        },
      });
      if (!turn) fail('source_unavailable');
      if (
        turn.id !== item.turn_id ||
        turn.userId !== item.user_id ||
        turn.sessionId !== item.session_id ||
        (item.continuation_no !== null && turn.continuationNo < item.continuation_no) ||
        (item.item_type !== 'legacy_message' && turn.transcriptCaptureVersion !== 1)
      )
        fail('source_invalid');
    }
    if (item.source_message_id) {
      const source = await this.database.query.chatMessages.findFirst({
        where: and(
          eq(chatMessages.id, item.source_message_id),
          eq(chatMessages.sessionId, item.session_id),
          item.turn_id ? eq(chatMessages.turnId, item.turn_id) : isNull(chatMessages.turnId),
        ),
        columns: {
          id: true,
          sessionId: true,
          turnId: true,
          role: true,
          content: true,
          attachments: true,
          toolCalls: true,
          skillSnapshots: true,
          pendingApproval: true,
        },
      });
      if (!source) fail('source_unavailable');
      const payload = item.payload_json;
      if (
        source.id !== item.source_message_id ||
        source.sessionId !== item.session_id ||
        source.turnId !== item.turn_id ||
        (payload.type === 'user_message' && source.role !== 'user') ||
        (payload.type === 'legacy_message' && source.role !== payload.role)
      )
        fail('source_invalid');
      if (!this.options.verifyMessageSource) fail('source_verifier_missing');
      try {
        if ((await this.options.verifyMessageSource({ item, source })) !== true)
          fail('source_invalid');
      } catch {
        fail('source_invalid');
      }
    }
    if (item.payload_json.type === 'host_context') {
      if (!this.options.verifyHostContextSource) fail('source_verifier_missing');
      try {
        if ((await this.options.verifyHostContextSource(item)) !== true) fail('source_invalid');
      } catch {
        fail('source_invalid');
      }
    }
    if (!item.source_trace_step_id) {
      if (item.payload_json.type === 'assistant_output') fail('source_invalid');
      return;
    }
    if (!item.turn_id) fail('source_invalid');
    const trace = await this.database.query.agentTraces.findFirst({
      where: and(
        eq(agentTraces.turnId, item.turn_id),
        eq(agentTraces.sessionId, item.session_id),
        eq(agentTraces.userId, item.user_id),
      ),
      columns: { id: true, turnId: true, sessionId: true, userId: true },
    });
    if (
      !trace ||
      trace.turnId !== item.turn_id ||
      trace.sessionId !== item.session_id ||
      trace.userId !== item.user_id
    )
      fail('source_invalid');
    const step = await this.database.query.agentTraceSteps.findFirst({
      where: and(
        eq(agentTraceSteps.id, item.source_trace_step_id),
        eq(agentTraceSteps.traceId, trace.id),
      ),
      columns: {
        id: true,
        traceId: true,
        stepType: true,
        actor: true,
        status: true,
        errorCode: true,
        inputSummary: true,
        outputSummary: true,
      },
    });
    if (!step) fail('source_unavailable');
    if (step.id !== item.source_trace_step_id || step.traceId !== trace.id) fail('source_invalid');
    if (
      item.payload_json.type === 'assistant_output' &&
      !verifyTranscriptModelOutputSource(item, step, this.options.itemContracts)
    )
      fail('source_invalid');
  }

  private async authorizeDependencies(item: AgentTranscriptItem): Promise<void> {
    if (!this.options.authorizeDependencies) fail('dependency_authorizer_missing');
    try {
      const accepted = await this.options.authorizeDependencies({
        item,
        dependencies: item.resource_dependencies_json,
      });
      if (accepted !== true) fail('dependencies_unauthorized');
    } catch {
      fail('dependencies_unauthorized');
    }
  }

  private async readPrivatePayloads(
    item: AgentTranscriptItem,
    fence: SessionFence,
  ): Promise<AuthorizedAgentTranscriptPayload[]> {
    const rows = new Map<string, PayloadRow>();
    const values = new Map<string, AuthorizedAgentTranscriptPayload>();
    for (const { reference, contract } of privatePayloadUses(item, this.options.itemContracts)) {
      let row = rows.get(reference.payload_id);
      if (!row) {
        const readableSession = this.database
          .select({ id: chatSessions.id })
          .from(chatSessions)
          .where(
            and(
              eq(chatSessions.id, item.session_id),
              eq(chatSessions.userId, item.user_id),
              isNull(chatSessions.archivedAt),
              eq(chatSessions.transcriptGeneration, fence.generation),
              eq(chatSessions.messageHistoryRevision, fence.messageRevision),
              sql`${chatSessions.transcriptStateJson}->>'mode' = 'active'`,
            ),
          );
        row = await this.database.query.agentTranscriptPayloads.findFirst({
          where: and(
            eq(agentTranscriptPayloads.id, reference.payload_id),
            eq(agentTranscriptPayloads.userId, item.user_id),
            eq(agentTranscriptPayloads.sessionId, item.session_id),
            item.turn_id
              ? eq(agentTranscriptPayloads.turnId, item.turn_id)
              : isNull(agentTranscriptPayloads.turnId),
            item.import_attempt_id
              ? eq(agentTranscriptPayloads.importAttemptId, item.import_attempt_id)
              : isNull(agentTranscriptPayloads.importAttemptId),
            inArray(agentTranscriptPayloads.sessionId, readableSession),
          ),
        });
        if (!row) fail('payload_unavailable');
        rows.set(reference.payload_id, row);
      }
      // Shared IDs still need validation at every use site: tool schemas can differ.
      try {
        const value = verifyAgentTranscriptPayload(
          {
            scope: {
              user_id: item.user_id,
              session_id: item.session_id,
              turn_id: item.turn_id,
              import_attempt_id: item.import_attempt_id,
            },
            reference,
            record: {
              id: row.id,
              user_id: row.userId,
              session_id: row.sessionId,
              turn_id: row.turnId,
              import_attempt_id: row.importAttemptId,
              schema_version: row.schemaVersion,
              kind: row.kind,
              content_json: row.contentJson,
              content_digest: row.contentDigest,
              byte_size: row.byteSize,
            },
          },
          { kind: reference.kind, contentSchema: contract.schema },
        );
        values.set(reference.payload_id, Object.freeze({ reference, value }));
      } catch {
        fail('payload_invalid');
      }
    }
    return [...values.values()];
  }
}

export function privatePayloadUses(
  item: AgentTranscriptItem,
  contracts: AgentTranscriptItemContracts,
) {
  const uses: Array<{
    reference: AgentTranscriptPayloadReference;
    contract: AgentTranscriptValueContract;
  }> = [];
  const add = (
    value: { type: 'inline'; value: unknown } | AgentTranscriptPayloadReference,
    contract: AgentTranscriptValueContract,
  ) => {
    if (value.type === 'private_payload') uses.push({ reference: value, contract });
  };
  const payload = item.payload_json;
  switch (payload.type) {
    case 'assistant_output':
      if (payload.mode === 'text') break;
      for (const call of payload.calls) {
        const contract = contracts.calls.find((candidate) => candidate.name === call.name);
        if (!contract) fail('item_invalid');
        add(call.arguments, contract.arguments);
      }
      break;
    case 'tool_result': {
      const contract = contracts.calls.find((candidate) => candidate.name === payload.name);
      if (!contract) fail('item_invalid');
      add(payload.result, contract.results[payload.status]);
      break;
    }
    case 'host_context': {
      const contract = contracts.hostContexts.find((candidate) => candidate.name === payload.name);
      if (!contract) fail('item_invalid');
      add(payload.content, contract.content);
      break;
    }
    case 'legacy_message':
      add(payload.content, contracts.legacyMessage);
      break;
  }
  return uses;
}

/** Read failures that indicate captured history no longer verifies against its sources. */
const INTEGRITY_FAILURE_REASONS: ReadonlySet<AgentTranscriptReadFailure> = new Set([
  'session_state_invalid',
  'item_unavailable',
  'item_invalid',
  'source_unavailable',
  'source_invalid',
  'dependencies_unauthorized',
  'payload_unavailable',
  'payload_invalid',
]);

function emitIntegrityFailure(reason: AgentTranscriptReadFailure): void {
  if (!INTEGRITY_FAILURE_REASONS.has(reason)) return;
  emitTranscriptMetric({
    metric: 'transcript_integrity_failure',
    format: 'transcript_v1',
    result: 'failure',
    value: 1,
  });
}

function fail(reason: AgentTranscriptReadFailure): never {
  throw new AgentTranscriptReadError(reason);
}
