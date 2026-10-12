import { performance } from 'node:perf_hooks';

import {
  prepareAgentTranscriptItem,
  transcriptSequenceSchema,
  validateAgentTranscriptProtocol,
  verifyAgentTranscriptItem,
  verifyAgentTranscriptPayload,
  type AgentTranscriptItem,
  type AgentTranscriptItemContracts,
  type AgentTranscriptPayloadRecord,
  type AgentTranscriptPayloadReference,
} from '@ecom-forge/agent';
import {
  agentTranscriptItems,
  agentTranscriptPayloads,
  and,
  asc,
  chatSessions,
  desc,
  eq,
  gte,
  isNull,
} from '@ecom-forge/db';
import { canonicalJson } from '@ecom-forge/shared';

import { WORKER_RUNTIME_DEFAULTS as limits } from '../config/runtime-defaults.js';
import { emitTranscriptMetric, transcriptMetricValue } from './agent-transcript-metrics.js';
import { privatePayloadUses } from './agent-transcript.repository.js';
import {
  transcriptItemValues,
  verifyStoredTranscriptItem,
} from './agent-transcript-storage-mapping.js';
import {
  AgentTranscriptWriteError,
  type AgentTranscriptWriteScope,
} from './agent-transcript-write-transaction.js';

export interface AgentTranscriptAppendBatch {
  items: readonly AgentTranscriptItem[];
  privatePayloads: readonly AgentTranscriptPayloadRecord[];
}

/** Caller owns source authorization and must commit domain receipts/usage in the same scope. */
export async function appendNativeTranscriptBatch(
  scope: AgentTranscriptWriteScope,
  batch: AgentTranscriptAppendBatch,
  contracts: AgentTranscriptItemContracts,
): Promise<{ items: readonly AgentTranscriptItem[]; appendedCount: number }> {
  const startedAt = performance.now();
  try {
    const result = await append(scope, batch, contracts);
    emitTranscriptMetric({
      metric: 'transcript_append_latency',
      format: 'transcript_v1',
      result: 'ok',
      value: transcriptMetricValue(performance.now() - startedAt),
    });
    emitTranscriptMetric({
      metric: 'transcript_bytes',
      format: 'transcript_v1',
      value: transcriptMetricValue(batchByteSize(batch)),
    });
    return result;
  } catch (error) {
    emitTranscriptMetric({
      metric: 'transcript_append_latency',
      format: 'transcript_v1',
      result: 'failure',
      value: transcriptMetricValue(performance.now() - startedAt),
    });
    if (error instanceof AgentTranscriptWriteError) throw error;
    return scope.abort();
  }
}

function batchByteSize(batch: AgentTranscriptAppendBatch): number {
  const envelope = batch.items.reduce(
    (total, item) => total + Buffer.byteLength(canonicalJson(item.payload_json), 'utf8'),
    0,
  );
  const payloads = batch.privatePayloads.reduce((total, record) => total + record.byte_size, 0);
  return envelope + payloads;
}

async function append(
  scope: AgentTranscriptWriteScope,
  batch: AgentTranscriptAppendBatch,
  contracts: AgentTranscriptItemContracts,
) {
  if (
    !Array.isArray(batch.items) ||
    !batch.items.length ||
    batch.items.length > limits.agentTranscriptAppendMaxItems ||
    !Array.isArray(batch.privatePayloads) ||
    batch.privatePayloads.length > limits.agentTranscriptAppendMaxItems * 4
  )
    scope.abort();
  const owned = { user_id: scope.userId, session_id: scope.sessionId };
  const checked = batch.items.map(
    (record) => verifyAgentTranscriptItem({ scope: owned, record }, contracts).item,
  );
  if (
    new Set(checked.map((item) => item.id)).size !== checked.length ||
    new Set(checked.map((item) => item.source_key)).size !== checked.length ||
    checked.some(
      (item) =>
        item.turn_id !== scope.turnId ||
        item.import_attempt_id !== null ||
        item.continuation_no! > scope.continuationNo ||
        item.payload_json.type === 'redacted',
    ) ||
    checked.reduce(
      (total, item) => total + Buffer.byteLength(canonicalJson(item.payload_json)),
      0,
    ) > limits.agentTranscriptAppendEnvelopeBytes
  )
    scope.abort();

  const session = await scope.query((tx) =>
    tx.query.chatSessions.findFirst({
      where: and(eq(chatSessions.id, scope.sessionId), eq(chatSessions.userId, scope.userId)),
      columns: { transcriptNextSequence: true, transcriptGeneration: true },
    }),
  );
  if (!session || session.transcriptGeneration !== scope.generation) scope.abort();
  const start = BigInt(transcriptSequenceSchema.parse(session.transcriptNextSequence.toString()));
  const payloads = await resolvePayloads(scope, checked, batch.privatePayloads, contracts);
  let next = start;
  const aliases = new Map<string, string>();
  const items: AgentTranscriptItem[] = [];
  const additions: AgentTranscriptItem[] = [];
  for (const original of checked) {
    const payload = rebindPayloads(original, payloads.references);
    const reply = original.reply_to_item_id
      ? (aliases.get(original.reply_to_item_id) ?? original.reply_to_item_id)
      : null;
    const sourceKey = reply
      ? `assistant:${reply}:result:${original.call_ordinal}`
      : original.source_key;
    const row = await scope.query((tx) =>
      tx.query.agentTranscriptItems.findFirst({
        where: and(
          eq(agentTranscriptItems.userId, scope.userId),
          eq(agentTranscriptItems.sessionId, scope.sessionId),
          eq(agentTranscriptItems.sourceKey, sourceKey),
        ),
      }),
    );
    const stored = row ? verifyStoredTranscriptItem(row, owned, contracts) : null;
    if (stored?.payload_json.type === 'redacted') scope.abort();
    const metadata = { ...original };
    delete (metadata as { payload_digest?: string }).payload_digest;
    const item = prepareAgentTranscriptItem(
      {
        ...metadata,
        id: stored?.id ?? original.id,
        sequence_no: stored?.sequence_no ?? transcriptSequenceSchema.parse(next.toString()),
        created_at: stored?.created_at ?? original.created_at,
        reply_to_item_id: reply,
        source_key: sourceKey,
        payload_json: payload,
      },
      contracts,
    ).item;
    if (stored) {
      if (BigInt(stored.sequence_no) >= start || canonicalJson(stored) !== canonicalJson(item))
        scope.abort();
      items.push(stored);
    } else {
      if (item.continuation_no !== scope.continuationNo) scope.abort();
      items.push(item);
      additions.push(item);
      next += 1n;
    }
    aliases.set(original.id, item.id);
  }
  // The counter itself must remain representable, even after the last valid bigint item.
  transcriptSequenceSchema.parse(next.toString());
  const tail = await readProtocolTail(scope, start, contracts);
  validateAgentTranscriptProtocol(
    {
      scope: owned,
      first_sequence_no: tail[0]?.sequence_no ?? start.toString(),
      items: [...tail, ...additions],
      require_closed: false,
    },
    contracts,
  );

  const needed = new Set(
    additions.flatMap((item) =>
      privatePayloadUses(item, contracts).map(({ reference }) => reference.payload_id),
    ),
  );
  const pendingPayloads = payloads.additions.filter((record) => needed.has(record.id));
  if (pendingPayloads.length) {
    await scope.query((tx) =>
      tx.insert(agentTranscriptPayloads).values(
        pendingPayloads.map((record) => ({
          id: record.id,
          userId: record.user_id,
          sessionId: record.session_id,
          turnId: record.turn_id,
          importAttemptId: null,
          kind: record.kind,
          schemaVersion: record.schema_version,
          contentJson: record.content_json,
          contentDigest: record.content_digest,
          byteSize: record.byte_size,
        })),
      ),
    );
  }
  if (additions.length) {
    await scope.query((tx) =>
      tx.insert(agentTranscriptItems).values(additions.map(transcriptItemValues)),
    );
    const updated = await scope.query((tx) =>
      tx
        .update(chatSessions)
        .set({ transcriptNextSequence: next })
        .where(
          and(
            eq(chatSessions.id, scope.sessionId),
            eq(chatSessions.userId, scope.userId),
            eq(chatSessions.transcriptGeneration, scope.generation),
            eq(chatSessions.transcriptNextSequence, start),
          ),
        )
        .returning({ id: chatSessions.id }),
    );
    if (updated.length !== 1) scope.abort();
  }
  return { items: Object.freeze(items), appendedCount: additions.length };
}

async function resolvePayloads(
  scope: AgentTranscriptWriteScope,
  items: readonly AgentTranscriptItem[],
  supplied: readonly AgentTranscriptPayloadRecord[],
  contracts: AgentTranscriptItemContracts,
) {
  const records = new Map(supplied.map((record) => [record.id.toLowerCase(), record]));
  if (records.size !== supplied.length) scope.abort();
  const seen = new Set<string>();
  const canonical = new Map<string, AgentTranscriptPayloadRecord>();
  const references = new Map<string, AgentTranscriptPayloadReference>();
  const additions: AgentTranscriptPayloadRecord[] = [];
  let bytes = 0;
  for (const item of items) {
    for (const { reference, contract } of privatePayloadUses(item, contracts)) {
      let record = records.get(reference.payload_id);
      if (!record) {
        const row = await scope.query((tx) =>
          tx.query.agentTranscriptPayloads.findFirst({
            where: and(
              eq(agentTranscriptPayloads.id, reference.payload_id),
              eq(agentTranscriptPayloads.userId, scope.userId),
              eq(agentTranscriptPayloads.sessionId, scope.sessionId),
              eq(agentTranscriptPayloads.turnId, scope.turnId),
              isNull(agentTranscriptPayloads.importAttemptId),
            ),
          }),
        );
        if (!row) scope.abort();
        record = payloadRecord(row);
      }
      const payloadScope = {
        user_id: scope.userId,
        session_id: scope.sessionId,
        turn_id: scope.turnId,
        import_attempt_id: null,
      };
      const content = verifyAgentTranscriptPayload(
        { scope: payloadScope, reference, record },
        { kind: reference.kind, contentSchema: contract.schema },
      );
      record = {
        ...payloadScope,
        id: reference.payload_id,
        schema_version: 1,
        kind: reference.kind,
        content_json: content,
        content_digest: reference.content_digest,
        byte_size: reference.byte_size,
      };
      seen.add(reference.payload_id);
      const key = `${record.kind}:${record.content_digest}`;
      let target = canonical.get(key);
      if (!target) {
        const existing = await scope.query((tx) =>
          tx.query.agentTranscriptPayloads.findFirst({
            where: and(
              eq(agentTranscriptPayloads.userId, scope.userId),
              eq(agentTranscriptPayloads.sessionId, scope.sessionId),
              eq(agentTranscriptPayloads.turnId, scope.turnId),
              isNull(agentTranscriptPayloads.importAttemptId),
              eq(agentTranscriptPayloads.kind, record.kind),
              eq(agentTranscriptPayloads.contentDigest, record.content_digest),
            ),
          }),
        );
        target = existing ? payloadRecord(existing) : record;
        if (!existing) additions.push(target);
        canonical.set(key, target);
        bytes += target.byte_size;
        if (bytes > limits.agentTranscriptAppendPayloadBytes) scope.abort();
      }
      const canonicalReference = { ...reference, payload_id: target.id };
      verifyAgentTranscriptPayload(
        { scope: payloadScope, reference: canonicalReference, record: target },
        { kind: reference.kind, contentSchema: contract.schema },
      );
      references.set(reference.payload_id, Object.freeze(canonicalReference));
    }
  }
  if (supplied.some((record) => !seen.has(record.id.toLowerCase()))) scope.abort();
  return { references, additions };
}

function payloadRecord(
  row: typeof agentTranscriptPayloads.$inferSelect,
): AgentTranscriptPayloadRecord {
  return {
    id: row.id,
    user_id: row.userId,
    session_id: row.sessionId,
    turn_id: row.turnId,
    import_attempt_id: row.importAttemptId,
    schema_version: row.schemaVersion as 1,
    kind: row.kind as AgentTranscriptPayloadRecord['kind'],
    content_json: row.contentJson,
    content_digest: row.contentDigest,
    byte_size: row.byteSize,
  };
}

function rebindPayloads(
  item: AgentTranscriptItem,
  references: Map<string, AgentTranscriptPayloadReference>,
) {
  const payload = structuredClone(item.payload_json);
  const resolve = (value: { type: 'inline'; value: unknown } | AgentTranscriptPayloadReference) => {
    if (value.type === 'inline') return value;
    const reference = references.get(value.payload_id);
    if (!reference) throw new Error('AGENT_TRANSCRIPT_PAYLOAD_UNRESOLVED');
    return reference;
  };
  if (payload.type === 'assistant_output' && payload.mode !== 'text') {
    for (const call of payload.calls) call.arguments = resolve(call.arguments);
  } else if (payload.type === 'tool_result') payload.result = resolve(payload.result);
  else if (payload.type === 'host_context' || payload.type === 'legacy_message')
    payload.content = resolve(payload.content);
  return payload;
}

async function readProtocolTail(
  scope: AgentTranscriptWriteScope,
  next: bigint,
  contracts: AgentTranscriptItemContracts,
) {
  const last = await scope.query((tx) =>
    tx.query.agentTranscriptItems.findFirst({
      where: and(
        eq(agentTranscriptItems.userId, scope.userId),
        eq(agentTranscriptItems.sessionId, scope.sessionId),
        eq(agentTranscriptItems.itemType, 'assistant_output'),
      ),
      orderBy: [desc(agentTranscriptItems.sequenceNo)],
      columns: { sequenceNo: true },
    }),
  );
  if (!last) return [];
  const rows = await scope.query((tx) =>
    tx.query.agentTranscriptItems.findMany({
      where: and(
        eq(agentTranscriptItems.userId, scope.userId),
        eq(agentTranscriptItems.sessionId, scope.sessionId),
        gte(agentTranscriptItems.sequenceNo, last.sequenceNo),
      ),
      orderBy: [asc(agentTranscriptItems.sequenceNo)],
      limit: limits.agentTranscriptAppendTailItems + 1,
    }),
  );
  if (
    !rows.length ||
    rows.length > limits.agentTranscriptAppendTailItems ||
    rows[0]!.sequenceNo !== last.sequenceNo ||
    rows.at(-1)!.sequenceNo + 1n !== next
  )
    scope.abort();
  return rows.map((row) =>
    verifyStoredTranscriptItem(
      row,
      { user_id: scope.userId, session_id: scope.sessionId },
      contracts,
    ),
  );
}
