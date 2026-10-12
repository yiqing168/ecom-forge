import { canonicalJson } from '@ecom-forge/shared';
import { z } from 'zod';

import {
  type AgentTranscriptCall,
  type AgentTranscriptItem,
  type AgentTranscriptItemContracts,
  AgentTranscriptItemError,
  type AgentTranscriptResultStatus,
  parseItemMetadata,
  transcriptScopeSchema,
  transcriptSequenceSchema,
  verifyAgentTranscriptItem,
  withTranscriptItemErrors,
} from './transcript-item.js';
import { freezeTranscriptJson } from './transcript-json.js';
import type { AgentTranscriptPayloadReference } from './transcript-payload.js';

const windowSchema = z.strictObject({
  scope: transcriptScopeSchema,
  first_sequence_no: transcriptSequenceSchema,
  require_closed: z.boolean(),
  items: z.array(z.unknown()),
});
const callIdentitySchema = z.strictObject({
  assistant_item_id: z.uuid().toLowerCase(),
  call_ordinal: z.int().min(0).max(3),
});

export function agentTranscriptWireCallId(input: unknown): string {
  return withTranscriptItemErrors(() => {
    const identity = parseItemMetadata(callIdentitySchema, input);
    return `call_${identity.assistant_item_id.replaceAll('-', '')}_${identity.call_ordinal}`;
  });
}

interface OpenBatch {
  item: AgentTranscriptItem;
  calls: AgentTranscriptCall[];
  results: Map<number, AgentTranscriptResultStatus>;
}

/** Structural protocol only; the repository must prove scope and the closed start boundary. */
export function validateAgentTranscriptProtocol(
  input: unknown,
  contracts: AgentTranscriptItemContracts,
) {
  return withTranscriptItemErrors(() => {
    const window = parseItemMetadata(windowSchema, input);
    let expected = BigInt(window.first_sequence_no);
    let batch: OpenBatch | null = null;
    const ids = new Set<string>();
    const sources = new Set<string>();
    const unresolved: Array<{ item_id: string; reference: AgentTranscriptPayloadReference }> = [];
    for (const raw of window.items) {
      const prepared = verifyAgentTranscriptItem({ scope: window.scope, record: raw }, contracts);
      const item = prepared.item;
      if (BigInt(item.sequence_no) !== expected)
        throw new AgentTranscriptItemError('sequence_invalid');
      expected += 1n;
      if (ids.has(item.id) || sources.has(item.source_key))
        throw new AgentTranscriptItemError('duplicate_item');
      ids.add(item.id);
      sources.add(item.source_key);
      unresolved.push(
        ...prepared.unresolved_payload_references.map((reference) => ({
          item_id: item.id,
          reference,
        })),
      );
      const payload = item.payload_json;
      if (payload.type === 'redacted') throw new AgentTranscriptItemError('redacted_unavailable');
      if (payload.type === 'assistant_output') {
        if (batch) throw new AgentTranscriptItemError('protocol_unclosed');
        if (payload.mode !== 'text') batch = { item, calls: payload.calls, results: new Map() };
      } else if (payload.type === 'tool_result') {
        if (
          !batch ||
          item.reply_to_item_id !== batch.item.id ||
          item.turn_id !== batch.item.turn_id ||
          item.continuation_no! < batch.item.continuation_no!
        ) {
          throw new AgentTranscriptItemError('pair_invalid');
        }
        const ordinal = item.call_ordinal!;
        const call = batch.calls[ordinal];
        if (
          !call ||
          batch.results.has(ordinal) ||
          call.name !== payload.name ||
          call.arguments_digest !== payload.arguments_digest
        ) {
          throw new AgentTranscriptItemError('pair_invalid');
        }
        const dependencies = new Set(item.resource_dependencies_json.map(canonicalJson));
        if (
          batch.item.resource_dependencies_json.some(
            (dependency) => !dependencies.has(canonicalJson(dependency)),
          )
        ) {
          throw new AgentTranscriptItemError('dependency_missing');
        }
        batch.results.set(ordinal, payload.status);
        // Completion order can differ from call order. Check both sides of each failed ordinal.
        for (const [failedOrdinal, status] of batch.results) {
          if (status === 'succeeded') continue;
          for (const [laterOrdinal, laterStatus] of batch.results) {
            if (laterOrdinal > failedOrdinal && laterStatus !== 'not_executed') {
              throw new AgentTranscriptItemError('result_after_failure');
            }
          }
        }
        if (batch.results.size === batch.calls.length) batch = null;
      }
    }
    if (batch && window.require_closed) throw new AgentTranscriptItemError('protocol_unclosed');
    const pendingBatch = batch;
    const pending = pendingBatch
      ? pendingBatch.calls.flatMap((call, ordinal) =>
          pendingBatch.results.has(ordinal)
            ? []
            : [
                {
                  assistant_item_id: pendingBatch.item.id,
                  turn_id: pendingBatch.item.turn_id!,
                  call_ordinal: ordinal,
                  name: call.name,
                  arguments_digest: call.arguments_digest,
                  wire_call_id: agentTranscriptWireCallId({
                    assistant_item_id: pendingBatch.item.id,
                    call_ordinal: ordinal,
                  }),
                },
              ],
        )
      : [];
    return freezeTranscriptJson({
      protocol_closed: batch === null,
      through_sequence_no: window.items.length === 0 ? null : (expected - 1n).toString(),
      pending_calls: pending,
      unresolved_payload_references: unresolved,
    });
  });
}
