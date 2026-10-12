import { canonicalSha256 } from '@ecom-forge/shared';
import { z } from 'zod';

import {
  agentBrainModelSnapshotSchema,
  agentSessionSummaryContentSchema,
} from './brain-contract.js';
import { transcriptSequenceSchema } from './transcript-item.js';

/**
 * Strict `summary v2` contract for transcript_v1 sessions (`02` §11.0, `05` summary v2).
 *
 * A v2 checkpoint covers a contiguous, terminal, protocol-closed range of the native transcript.
 * Its `source_content_digest` is derived from each covered item's content-bearing identity
 * (item type + `payload_digest`), never from an ID-only list. Legacy `schema_version: 1` summaries
 * remain a distinct strict shape; the two must never masquerade for one another.
 */

const uuidSchema = z.uuid().toLowerCase();
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const versionedNameSchema = z.string().regex(/^[a-z][a-z0-9_.-]*@[1-9]\d*$/);
const tokenUsageSchema = z.strictObject({
  input_tokens: z.int().nonnegative(),
  cached_input_tokens: z.int().nonnegative().optional(),
  output_tokens: z.int().nonnegative(),
  reasoning_output_tokens: z.int().nonnegative().optional(),
});

/** Version of the transcript-to-text projection used to build a compaction input and its digest. */
export const AGENT_TRANSCRIPT_SUMMARY_PROJECTION_VERSION = 1 as const;

const transcriptItemTypeSchema = z.enum([
  'user_message',
  'assistant_output',
  'tool_result',
  'host_context',
]);

/**
 * Ordered, text-safe semantic projection of one already-closed transcript item. It reuses the
 * transcript item type vocabulary so `host_context` and `tool_result` stay typed instead of being
 * flattened into ordinary user/assistant text (`02` §11.0 "不得伪装为用户新指令").
 */
export const agentTranscriptCompactionItemSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('user_message'),
    item_id: uuidSchema,
    current: z.boolean(),
    content: z.string(),
    attachment_count: z.int().nonnegative().max(9),
  }),
  z.strictObject({
    type: z.literal('assistant_output'),
    item_id: uuidSchema,
    commentary: z.string().trim().min(1).max(2_000).optional(),
    calls: z
      .array(
        z.strictObject({
          name: versionedNameSchema,
          intent_summary: z.string(),
        }),
      )
      .min(1)
      .max(4),
  }),
  z.strictObject({
    type: z.literal('assistant_text'),
    item_id: uuidSchema,
    text: z.string().min(1).max(8_000),
  }),
  z.strictObject({
    type: z.literal('tool_result'),
    item_id: uuidSchema,
    name: versionedNameSchema,
    status: z.enum(['succeeded', 'rejected', 'not_executed', 'unknown']),
    result_summary: z.string(),
  }),
  z.strictObject({
    type: z.literal('host_context'),
    item_id: uuidSchema,
    name: versionedNameSchema,
    content_summary: z.string(),
  }),
]);

export type AgentTranscriptCompactionItem = z.infer<typeof agentTranscriptCompactionItemSchema>;

/** The content-bearing identity of one covered item, used to derive the checkpoint digest. */
export const agentTranscriptSummarySourceItemSchema = z.strictObject({
  item_id: uuidSchema,
  sequence_no: transcriptSequenceSchema,
  item_type: transcriptItemTypeSchema,
  /** The item's canonical content/payload hash, not its ID. */
  payload_digest: digestSchema,
});

export type AgentTranscriptSummarySourceItem = z.infer<
  typeof agentTranscriptSummarySourceItemSchema
>;

export interface TranscriptSummaryCoverage {
  covered_from_sequence: string;
  covered_through_sequence: string;
}

/**
 * Derive the checkpoint `source_content_digest`. It covers the ordered items, each item's content
 * hash and the projection version, so it can never be reduced to a list of IDs.
 */
export function buildTranscriptSummarySourceDigest(input: {
  projection_version: number;
  coverage: TranscriptSummaryCoverage;
  items: readonly AgentTranscriptSummarySourceItem[];
}): string {
  return canonicalSha256({
    projection_version: input.projection_version,
    covered_from_sequence: input.coverage.covered_from_sequence,
    covered_through_sequence: input.coverage.covered_through_sequence,
    items: input.items.map((item) => ({
      item_id: item.item_id,
      sequence_no: item.sequence_no,
      item_type: item.item_type,
      payload_digest: item.payload_digest,
    })),
  });
}

/**
 * Fail closed unless the checkpoint digest matches the actual covered window. An ID-only digest (or
 * any other mismatch) is rejected with the existing `AGENT_SESSION_COMPACTION_*` family.
 */
export function assertTranscriptSummarySourceDigest(input: {
  projection_version: number;
  coverage: TranscriptSummaryCoverage;
  items: readonly AgentTranscriptSummarySourceItem[];
  source_content_digest: string;
}): void {
  const recomputed = buildTranscriptSummarySourceDigest({
    projection_version: input.projection_version,
    coverage: input.coverage,
    items: input.items,
  });
  if (recomputed !== input.source_content_digest) {
    throw new Error('AGENT_SESSION_COMPACTION_SOURCE_DIGEST_INVALID');
  }
}

/** Strict v2 checkpoint stored inside `chat_sessions.summary_json` (`schema_version: 2`). */
export const persistedAgentTranscriptSummarySchema = z
  .strictObject({
    schema_version: z.literal(2),
    summary_version: z.int().positive(),
    /**
     * `transcript_generation` observed when the checkpoint was published (decimal string). `0`
     * is the pre-compaction generation, so it is allowed alongside a positive sequence.
     */
    history_generation: z.union([z.literal('0'), transcriptSequenceSchema]),
    covered_from_sequence: transcriptSequenceSchema,
    covered_through_sequence: transcriptSequenceSchema,
    source_content_digest: digestSchema,
    source_turn_ids: z.array(uuidSchema).min(1).max(2048),
    resource_dependencies: z.array(z.unknown()),
    model_snapshot: agentBrainModelSnapshotSchema,
    usage: tokenUsageSchema,
    content: agentSessionSummaryContentSchema,
  })
  .superRefine((value, context) => {
    if (BigInt(value.covered_from_sequence) > BigInt(value.covered_through_sequence)) {
      context.addIssue({
        code: 'custom',
        path: ['covered_through_sequence'],
        message: 'covered_from_sequence must not exceed covered_through_sequence',
      });
    }
    if (new Set(value.source_turn_ids).size !== value.source_turn_ids.length) {
      context.addIssue({
        code: 'custom',
        path: ['source_turn_ids'],
        message: 'Summary source turn ids must be unique',
      });
    }
  });

export type PersistedAgentTranscriptSummary = z.infer<typeof persistedAgentTranscriptSummarySchema>;
