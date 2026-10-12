import {
  AGENT_TRANSCRIPT_SUMMARY_PROJECTION_VERSION,
  agentTranscriptCompactionItemSchema,
  buildTranscriptSummarySourceDigest,
  assertTranscriptSummarySourceDigest,
  persistedAgentTranscriptSummarySchema,
  type AgentSessionSummaryContent,
  type AgentTranscriptCompactionItem,
  type AgentTranscriptSummarySourceItem,
  type AgentBrainModelSnapshot,
  type PersistedAgentTranscriptSummary,
} from '@ecom-forge/agent';
import { canonicalJson } from '@ecom-forge/shared';
import { z } from 'zod';

import { transcriptValue, userContentSchema } from './agent-transcript-view-shared.js';
import type { AuthorizedAgentTranscriptItem } from './agent-transcript.repository.js';

/**
 * Pure planning + checkpoint construction for `summary v2` (`02` §11.0, `05` summary v2).
 *
 * The compaction window must cover a contiguous, terminal range whose protocol calls are all
 * closed; the active tail (including the current user message and any pending call) is never
 * summarized. Everything here is deterministic and free of database/network access so it can be
 * reasoned about and unit tested independently of the persistence transaction.
 */

const summaryUsageSchema = z.strictObject({
  input_tokens: z.int().nonnegative(),
  cached_input_tokens: z.int().nonnegative().optional(),
  output_tokens: z.int().nonnegative(),
  reasoning_output_tokens: z.int().nonnegative().optional(),
});

export interface TranscriptCompactionPlan {
  coveredItems: readonly AuthorizedAgentTranscriptItem[];
  projection: readonly AgentTranscriptCompactionItem[];
  sourceItems: readonly AgentTranscriptSummarySourceItem[];
  coveredFromSequence: string;
  coveredThroughSequence: string;
}

function semanticText(value: unknown): string {
  // The planner fits complete turns to the model window; never lose a correction by truncation.
  return typeof value === 'string' ? value : canonicalJson(value);
}

/** Project one owned, already-authorized transcript item into the ordered, text-safe form. */
export function projectTranscriptCompactionItem(
  item: AuthorizedAgentTranscriptItem,
): AgentTranscriptCompactionItem {
  const payload = item.item.payload_json;
  switch (payload.type) {
    case 'user_message': {
      const content = userContentSchema.parse(transcriptValue(payload.content, item));
      return agentTranscriptCompactionItemSchema.parse({
        type: 'user_message',
        item_id: item.item.id,
        current: false,
        content: content.text,
        attachment_count: content.attachments.length,
      });
    }
    case 'assistant_output':
      if (payload.mode === 'text') {
        return agentTranscriptCompactionItemSchema.parse({
          type: 'assistant_text',
          item_id: item.item.id,
          text: payload.text,
        });
      }
      return agentTranscriptCompactionItemSchema.parse({
        type: 'assistant_output',
        item_id: item.item.id,
        ...(payload.commentary ? { commentary: payload.commentary } : {}),
        calls: payload.calls.map((call) => ({
          name: call.name,
          intent_summary:
            call.name === 'agent_author_prompts@1'
              ? 'Authored generation prompts; preserve the paired result reference.'
              : semanticText(transcriptValue(call.arguments, item)),
        })),
      });
    case 'tool_result':
      return agentTranscriptCompactionItemSchema.parse({
        type: 'tool_result',
        item_id: item.item.id,
        name: payload.name,
        status: payload.status,
        result_summary:
          payload.name === 'load_skill@1'
            ? 'Loaded Skill knowledge; knowledge is supplied separately and must not be summarized.'
            : semanticText(transcriptValue(payload.result, item)),
      });
    case 'host_context':
      return agentTranscriptCompactionItemSchema.parse({
        type: 'host_context',
        item_id: item.item.id,
        name: payload.name,
        content_summary:
          payload.name === 'core_skill_knowledge@1'
            ? 'Core Skill knowledge is supplied separately and must not be summarized.'
            : semanticText(transcriptValue(payload.content, item)),
      });
    default:
      // `legacy_message`/`redacted` are never part of a native compaction window.
      throw new Error('AGENT_SESSION_COMPACTION_SOURCE_INVALID');
  }
}

/** The content-bearing identity of one covered item; carries the payload hash, never only its ID. */
export function transcriptSummarySourceItem(
  item: AuthorizedAgentTranscriptItem,
): AgentTranscriptSummarySourceItem {
  return {
    item_id: item.item.id,
    sequence_no: item.item.sequence_no,
    item_type: item.item.item_type as AgentTranscriptSummarySourceItem['item_type'],
    payload_digest: item.item.payload_digest,
  };
}

/**
 * Group consecutive items into turn segments. Segments are only compactable as a whole; the active
 * (last) segment always stays in the window.
 */
function turnSegments(
  items: readonly AuthorizedAgentTranscriptItem[],
): AuthorizedAgentTranscriptItem[][] {
  const segments: AuthorizedAgentTranscriptItem[][] = [];
  for (const item of items) {
    const current = segments.at(-1);
    const currentTurn = current?.[0]?.item.turn_id ?? null;
    if (current && currentTurn !== null && item.item.turn_id === currentTurn) {
      current.push(item);
    } else {
      segments.push([item]);
    }
  }
  return segments;
}

/** All ordinals must have a matching result before an assistant batch can be summarized. */
function isSegmentClosed(segment: readonly AuthorizedAgentTranscriptItem[]): boolean {
  return segment.every(
    ({ item }) =>
      item.payload_json.type !== 'assistant_output' ||
      item.payload_json.mode === 'text' ||
      item.payload_json.calls.every((call, ordinal) =>
        segment.some(
          ({ item: result }) =>
            result.payload_json.type === 'tool_result' &&
            result.reply_to_item_id === item.id &&
            result.call_ordinal === ordinal &&
            result.payload_json.name === call.name &&
            result.payload_json.arguments_digest === call.arguments_digest,
        ),
      ),
  );
}

/**
 * Select the largest contiguous, closed prefix of items whose projected compaction input still fits
 * the compaction window. The active tail is always retained, so the returned plan never covers the
 * last segment and never splits a user/assistant/tool boundary.
 */
export async function planTranscriptCompaction(input: {
  items: readonly AuthorizedAgentTranscriptItem[];
  activeTurnId?: string;
  terminalTurnIds?: ReadonlySet<string>;
  fits: (
    projection: readonly AgentTranscriptCompactionItem[],
    sourceItems: readonly AgentTranscriptSummarySourceItem[],
  ) => boolean | Promise<boolean>;
}): Promise<TranscriptCompactionPlan | null> {
  const segments = turnSegments(input.items);
  // The active tail is the final segment; it is never summarized.
  const compactable = segments.slice(0, Math.max(0, segments.length - 1));
  const closedSegments: AuthorizedAgentTranscriptItem[][] = [];
  for (const segment of compactable) {
    const turnId = segment[0]!.item.turn_id;
    if (
      !turnId ||
      turnId === input.activeTurnId ||
      (input.terminalTurnIds && !input.terminalTurnIds.has(turnId))
    )
      break;
    // A late item from this turn would make this segment only a partial turn.
    if (
      input.items.some(
        (entry) =>
          entry.item.turn_id === turnId &&
          BigInt(entry.item.sequence_no) > BigInt(segment.at(-1)!.item.sequence_no),
      )
    )
      break;
    if (!isSegmentClosed(segment)) break;
    closedSegments.push(segment);
  }
  // Shrink by whole segments until the projected compaction input fits the compaction window.
  for (let count = closedSegments.length; count > 0; count -= 1) {
    const covered = closedSegments.slice(0, count).flat();
    const projection = covered.map((item) => projectTranscriptCompactionItem(item));
    const sourceItems = covered.map((item) => transcriptSummarySourceItem(item));
    if (await input.fits(projection, sourceItems)) {
      return {
        coveredItems: covered,
        projection,
        sourceItems,
        coveredFromSequence: covered[0]!.item.sequence_no,
        coveredThroughSequence: covered.at(-1)!.item.sequence_no,
      };
    }
  }
  return null;
}

/** Collect the deduplicated resource dependencies declared by the covered items. */
export function collectResourceDependencies(
  items: readonly AuthorizedAgentTranscriptItem[],
): unknown[] {
  const seen = new Set<string>();
  const dependencies: unknown[] = [];
  for (const item of items) {
    for (const dependency of item.item.resource_dependencies_json) {
      const key = canonicalJson(dependency);
      if (seen.has(key)) continue;
      seen.add(key);
      dependencies.push(dependency);
    }
  }
  return dependencies;
}

/** Build the strict v2 checkpoint for an accepted compaction, including its content digest. */
export function buildTranscriptSummaryCheckpoint(input: {
  summaryVersion: number;
  historyGeneration: string;
  content: AgentSessionSummaryContent;
  coveredItems: readonly AuthorizedAgentTranscriptItem[];
  sourceItems: readonly AgentTranscriptSummarySourceItem[];
  coveredFromSequence: string;
  coveredThroughSequence: string;
  modelSnapshot: AgentBrainModelSnapshot;
  usage: z.infer<typeof summaryUsageSchema>;
  previous?: {
    checkpoint: PersistedAgentTranscriptSummary;
    sourceItems: readonly AgentTranscriptSummarySourceItem[];
  };
}): PersistedAgentTranscriptSummary {
  const previous = input.previous?.checkpoint;
  if (input.previous) {
    assertTranscriptSummarySourceDigest({
      projection_version: AGENT_TRANSCRIPT_SUMMARY_PROJECTION_VERSION,
      coverage: input.previous.checkpoint,
      items: input.previous.sourceItems,
      source_content_digest: input.previous.checkpoint.source_content_digest,
    });
    if (BigInt(previous!.covered_through_sequence) + 1n !== BigInt(input.coveredFromSequence))
      throw new Error('AGENT_SESSION_SUMMARY_SOURCE_INVALID');
  }
  const coveredFrom = previous?.covered_from_sequence ?? input.coveredFromSequence;
  const sourceTurnIds = [
    ...new Set([
      ...(previous?.source_turn_ids ?? []),
      ...input.coveredItems
        .map((item) => item.item.turn_id)
        .filter((value): value is string => value !== null),
    ]),
  ];
  const source_content_digest = buildTranscriptSummarySourceDigest({
    projection_version: AGENT_TRANSCRIPT_SUMMARY_PROJECTION_VERSION,
    coverage: {
      covered_from_sequence: coveredFrom,
      covered_through_sequence: input.coveredThroughSequence,
    },
    items: [...(input.previous?.sourceItems ?? []), ...input.sourceItems],
  });
  return persistedAgentTranscriptSummarySchema.parse({
    schema_version: 2,
    summary_version: input.summaryVersion,
    history_generation: input.historyGeneration,
    covered_from_sequence: coveredFrom,
    covered_through_sequence: input.coveredThroughSequence,
    source_content_digest,
    source_turn_ids: sourceTurnIds,
    resource_dependencies: [
      ...new Map(
        [
          ...(previous?.resource_dependencies ?? []),
          ...collectResourceDependencies(input.coveredItems),
        ].map((dependency) => [canonicalJson(dependency), dependency]),
      ).values(),
    ],
    model_snapshot: input.modelSnapshot,
    usage: summaryUsageSchema.parse(input.usage),
    content: input.content,
  });
}
