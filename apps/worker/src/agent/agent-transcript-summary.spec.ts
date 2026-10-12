import { randomUUID } from 'node:crypto';

import {
  deterministicFakeAgentModelSnapshot,
  persistedAgentTranscriptSummarySchema,
  assertTranscriptSummarySourceDigest,
  buildTranscriptSummarySourceDigest,
  AGENT_TRANSCRIPT_SUMMARY_PROJECTION_VERSION,
  type AgentBrainModelSnapshot,
  type AgentSessionSummaryContent,
} from '@ecom-forge/agent';
import { canonicalSha256 } from '@ecom-forge/shared';
import { describe, expect, it } from 'vitest';

import {
  buildTranscriptSummaryCheckpoint,
  collectResourceDependencies,
  planTranscriptCompaction,
  projectTranscriptCompactionItem,
  transcriptSummarySourceItem,
} from './agent-transcript-summary.js';
import type { AuthorizedAgentTranscriptItem } from './agent-transcript.repository.js';

const modelSnapshot: AgentBrainModelSnapshot = deterministicFakeAgentModelSnapshot({
  maxInputTokens: 96_000,
  maxOutputTokens: 8_192,
});
const usage = { input_tokens: 5, output_tokens: 2 };
const content: AgentSessionSummaryContent = {
  goals: ['keep the subject'],
  confirmed_preferences: [],
  constraints: [],
  key_decisions: [],
  open_questions: [],
};

// Real turn ids are UUIDs; the strict v2 checkpoint stores them in `source_turn_ids`.
const TURN_1 = '11111111-1111-4111-8111-111111111111';
const TURN_2 = '22222222-2222-4222-8222-222222222222';
const TURN_3 = '33333333-3333-4333-8333-333333333333';

const digest = (seed: string) => canonicalSha256(seed);

interface ItemInput {
  id?: string;
  sequence_no: string;
  item_type: AuthorizedAgentTranscriptItem['item']['item_type'];
  turn_id?: string | null;
  reply_to_item_id?: string | null;
  payload_json: unknown;
  payload_digest?: string;
  resource_dependencies_json?: unknown[];
}

/** Build a minimal, synthetic authorized item for the pure planner (no database). */
function item(input: ItemInput): AuthorizedAgentTranscriptItem {
  return {
    item: {
      id: input.id ?? randomUUID(),
      user_id: randomUUID(),
      session_id: randomUUID(),
      turn_id: input.turn_id ?? randomUUID(),
      continuation_no: 1,
      sequence_no: input.sequence_no,
      schema_version: 1,
      item_type: input.item_type,
      source_key: `fixture:${input.sequence_no}`,
      source_message_id: null,
      source_trace_step_id: null,
      import_attempt_id: null,
      reply_to_item_id: input.reply_to_item_id ?? null,
      call_ordinal: input.item_type === 'tool_result' ? 0 : null,
      payload_json: input.payload_json,
      resource_dependencies_json: input.resource_dependencies_json ?? [],
      created_at: '2026-09-08T00:00:00.000Z',
      payload_digest: input.payload_digest ?? digest(input.sequence_no),
    },
    history_generation: '1',
    private_payloads: [],
  } as unknown as AuthorizedAgentTranscriptItem;
}

function userMessage(sequence: string, turn: string, text: string) {
  return item({
    sequence_no: sequence,
    item_type: 'user_message',
    turn_id: turn,
    payload_json: {
      schema_version: 1,
      type: 'user_message',
      content: { type: 'inline', value: { text, attachments: [] } },
    },
  });
}

function assistantCall(sequence: string, turn: string, id: string) {
  return item({
    id,
    sequence_no: sequence,
    item_type: 'assistant_output',
    turn_id: turn,
    payload_json: {
      schema_version: 1,
      type: 'assistant_output',
      mode: 'tools',
      calls: [
        {
          name: 'inspect_image@1',
          arguments: { type: 'inline', value: { binding_key: 'binding-1', detail: 'detail' } },
          arguments_digest: digest('args'),
          provider_call_id: null,
        },
      ],
    },
  });
}

function toolResult(sequence: string, turn: string, parentId: string) {
  return item({
    sequence_no: sequence,
    item_type: 'tool_result',
    turn_id: turn,
    reply_to_item_id: parentId,
    payload_json: {
      schema_version: 1,
      type: 'tool_result',
      name: 'inspect_image@1',
      arguments_digest: digest('args'),
      status: 'succeeded',
      result: { type: 'inline', value: { ok: true } },
    },
  });
}

function hostContext(sequence: string, turn: string) {
  return item({
    sequence_no: sequence,
    item_type: 'host_context',
    turn_id: turn,
    payload_json: {
      schema_version: 1,
      type: 'host_context',
      name: 'core_skill_knowledge@1',
      content: { type: 'inline', value: { note: 'loaded skill' } },
    },
  });
}

/** A closed turn: user -> assistant(tool) -> tool_result. */
function closedTurn(turn: string, base: number): AuthorizedAgentTranscriptItem[] {
  const assistantId = randomUUID();
  return [
    userMessage(String(base), turn, `goal-${base}`),
    assistantCall(String(base + 1), turn, assistantId),
    toolResult(String(base + 2), turn, assistantId),
  ];
}

describe('native transcript summary planner', () => {
  it('preserves public commentary with its knowledge calls during compaction', () => {
    const source = assistantCall('2', TURN_1, randomUUID());
    const withCommentary = item({
      sequence_no: '2',
      item_type: 'assistant_output',
      turn_id: TURN_1,
      payload_json: {
        ...source.item.payload_json,
        commentary: 'I will inspect the latest photo before choosing a direction.',
      },
    });
    expect(projectTranscriptCompactionItem(withCommentary)).toMatchObject({
      type: 'assistant_output',
      commentary: 'I will inspect the latest photo before choosing a direction.',
      calls: [{ name: 'inspect_image@1' }],
    });
  });
  it('retains a user correction past character 400 and does not summarize core knowledge', () => {
    const text = `${'context '.repeat(75)}Correction: keep the blue label.`;
    const message = item({
      sequence_no: '1',
      item_type: 'host_context',
      turn_id: TURN_1,
      payload_json: {
        schema_version: 1,
        type: 'host_context',
        name: 'confirmation_answer@1',
        content: { type: 'inline', value: { response_text: text } },
      },
    });
    expect(JSON.stringify(projectTranscriptCompactionItem(message))).toContain(
      'Correction: keep the blue label.',
    );
    expect(JSON.stringify(projectTranscriptCompactionItem(hostContext('2', TURN_1)))).not.toContain(
      'loaded skill',
    );
  });
  it('retains a multi-call batch until every ordinal has a matching result', async () => {
    const closed = closedTurn(TURN_1, 1);
    const payload = closed[1]!.item.payload_json;
    if (payload.type !== 'assistant_output' || payload.mode === 'text') throw new Error('fixture');
    payload.calls.push({ ...payload.calls[0]! });
    expect(
      await planTranscriptCompaction({
        items: [...closed, userMessage('4', TURN_2, 'current')],
        fits: () => true,
      }),
    ).toBeNull();
  });

  it('retains an active turn even if late history follows it', async () => {
    expect(
      await planTranscriptCompaction({
        items: [...closedTurn(TURN_1, 1), userMessage('4', TURN_2, 'late')],
        activeTurnId: TURN_1,
        fits: () => true,
      }),
    ).toBeNull();
  });

  it('retains nonterminal and split turns', async () => {
    const first = closedTurn(TURN_1, 1);
    const last = userMessage('5', TURN_1, 'late same turn');
    expect(
      await planTranscriptCompaction({
        items: [...first, userMessage('4', TURN_2, 'current')],
        terminalTurnIds: new Set(),
        fits: () => true,
      }),
    ).toBeNull();
    expect(
      await planTranscriptCompaction({
        items: [...first, userMessage('4', TURN_2, 'current'), last],
        fits: () => true,
      }),
    ).toBeNull();
  });
  it('covers the largest contiguous closed prefix and never the active tail', async () => {
    const closed = closedTurn(TURN_1, 1);
    const active = userMessage('4', TURN_2, 'current request');
    const plan = await planTranscriptCompaction({
      items: [...closed, active],
      fits: () => true,
    });
    expect(plan).not.toBeNull();
    expect(plan!.coveredFromSequence).toBe('1');
    expect(plan!.coveredThroughSequence).toBe('3');
    expect(plan!.coveredItems).toHaveLength(3);
    expect(plan!.projection.map((entry) => entry.type)).toEqual([
      'user_message',
      'assistant_output',
      'tool_result',
    ]);
    expect(plan!.sourceItems).toHaveLength(3);
    // The active turn is never summarized.
    expect(plan!.coveredItems.some((entry) => entry.item.turn_id === TURN_2)).toBe(false);
  });

  it('never covers the open, active assistant batch', async () => {
    const closed = closedTurn(TURN_1, 1);
    const openAssistant = assistantCall('4', TURN_2, randomUUID());
    const active = userMessage('5', TURN_2, 'current');
    const plan = await planTranscriptCompaction({
      items: [...closed, openAssistant, active],
      fits: () => true,
    });
    // turn-1 is a closed prefix, so it is covered; the open active turn is left in the window.
    expect(plan!.coveredThroughSequence).toBe('3');
  });

  it('shrinks by whole segments until the compaction input fits', async () => {
    const first = closedTurn(TURN_1, 1);
    const second = closedTurn(TURN_2, 4);
    const active = userMessage('7', TURN_3, 'current');
    let seen = 0;
    const plan = await planTranscriptCompaction({
      items: [...first, ...second, active],
      // Only a single closed segment is allowed to fit.
      fits: (projection) => {
        seen += 1;
        return projection.length <= 3;
      },
    });
    expect(seen).toBeGreaterThan(1);
    expect(plan!.coveredThroughSequence).toBe('3');
    expect(plan!.coveredItems).toHaveLength(3);
  });

  it('returns null when no closed boundary precedes the active tail', async () => {
    const active = userMessage('1', TURN_1, 'only turn');
    expect(await planTranscriptCompaction({ items: [active], fits: () => true })).toBeNull();
    expect(await planTranscriptCompaction({ items: [], fits: () => true })).toBeNull();
  });

  it('projects host_context and tool_result without flattening them into user text', () => {
    const host = hostContext('3', TURN_1);
    const result = toolResult('2', TURN_1, randomUUID());
    const assistant = assistantCall('1', TURN_1, randomUUID());
    expect(projectTranscriptCompactionItem(host).type).toBe('host_context');
    expect(projectTranscriptCompactionItem(result)).toMatchObject({
      type: 'tool_result',
      status: 'succeeded',
    });
    expect(projectTranscriptCompactionItem(assistant)).toMatchObject({ type: 'assistant_output' });
  });

  it('rejects a legacy_message item as a compaction source', () => {
    const legacy = item({
      sequence_no: '1',
      item_type: 'legacy_message',
      payload_json: {
        schema_version: 1,
        type: 'legacy_message',
        role: 'user',
        content: { type: 'inline', value: { text: 'old' } },
        source_content_digest: digest('legacy'),
      },
    });
    expect(() => projectTranscriptCompactionItem(legacy)).toThrow(
      'AGENT_SESSION_COMPACTION_SOURCE_INVALID',
    );
  });
});

describe('native transcript summary checkpoint', () => {
  it('retains reasoning usage through the strict checkpoint schemas without adding to total output', () => {
    const closed = closedTurn(TURN_1, 1);
    const reasoningUsage = { ...usage, reasoning_output_tokens: 1 };
    const checkpoint = buildTranscriptSummaryCheckpoint({
      summaryVersion: 1,
      historyGeneration: '2',
      content,
      coveredItems: closed,
      sourceItems: closed.map(transcriptSummarySourceItem),
      coveredFromSequence: '1',
      coveredThroughSequence: '3',
      modelSnapshot,
      usage: reasoningUsage,
    });
    expect(persistedAgentTranscriptSummarySchema.parse(checkpoint).usage).toEqual(reasoningUsage);
    expect(checkpoint.usage.output_tokens).toBe(2);
  });
  it('inherits all source identities and dependencies when compacting a second time', () => {
    const first = closedTurn(TURN_1, 1);
    const second = closedTurn(TURN_2, 4);
    first[0] = {
      ...first[0]!,
      item: { ...first[0]!.item, resource_dependencies_json: [{ old_resource: 'revocable' }] },
    };
    const checkpoint = buildTranscriptSummaryCheckpoint({
      summaryVersion: 1,
      historyGeneration: '2',
      content,
      coveredItems: first,
      sourceItems: first.map(transcriptSummarySourceItem),
      coveredFromSequence: '1',
      coveredThroughSequence: '3',
      modelSnapshot,
      usage,
    });
    const merged = buildTranscriptSummaryCheckpoint({
      summaryVersion: 2,
      historyGeneration: '3',
      content,
      coveredItems: second,
      sourceItems: second.map(transcriptSummarySourceItem),
      coveredFromSequence: '4',
      coveredThroughSequence: '6',
      modelSnapshot,
      usage,
      previous: { checkpoint, sourceItems: first.map(transcriptSummarySourceItem) },
    });
    expect(merged.source_turn_ids).toEqual([TURN_1, TURN_2]);
    expect(merged.covered_from_sequence).toBe('1');
    expect(merged.resource_dependencies).toEqual([{ old_resource: 'revocable' }]);
    expect(merged.source_content_digest).toBe(
      buildTranscriptSummarySourceDigest({
        projection_version: AGENT_TRANSCRIPT_SUMMARY_PROJECTION_VERSION,
        coverage: merged,
        items: [...first, ...second].map(transcriptSummarySourceItem),
      }),
    );
  });
  it('builds a strict v2 checkpoint with a content-bearing digest', async () => {
    const closed = closedTurn(TURN_1, 1);
    const active = userMessage('4', TURN_2, 'current');
    const plan = (await planTranscriptCompaction({
      items: [...closed, active],
      fits: () => true,
    }))!;
    const checkpoint = buildTranscriptSummaryCheckpoint({
      summaryVersion: 1,
      historyGeneration: '2',
      content,
      coveredItems: plan.coveredItems,
      sourceItems: plan.sourceItems,
      coveredFromSequence: plan.coveredFromSequence,
      coveredThroughSequence: plan.coveredThroughSequence,
      modelSnapshot,
      usage,
    });
    expect(checkpoint).toMatchObject({
      schema_version: 2,
      summary_version: 1,
      history_generation: '2',
      covered_from_sequence: '1',
      covered_through_sequence: '3',
      usage,
    });
    expect(checkpoint.source_turn_ids).toEqual([TURN_1]);
    expect(checkpoint.model_snapshot).toEqual(modelSnapshot);
    // The digest is derived from item content, never from an ID-only list.
    expect(checkpoint.source_content_digest).not.toBe(
      canonicalSha256(plan.sourceItems.map((source) => source.item_id)),
    );
    expect(checkpoint.source_content_digest).toBe(
      buildTranscriptSummarySourceDigest({
        projection_version: AGENT_TRANSCRIPT_SUMMARY_PROJECTION_VERSION,
        coverage: { covered_from_sequence: '1', covered_through_sequence: '3' },
        items: plan.sourceItems,
      }),
    );
  });

  it('rejects an ID-only digest and a changed payload digest', async () => {
    const closed = closedTurn(TURN_1, 1);
    const active = userMessage('4', TURN_2, 'current');
    const plan = (await planTranscriptCompaction({
      items: [...closed, active],
      fits: () => true,
    }))!;
    const coverage = { covered_from_sequence: '1', covered_through_sequence: '3' };
    expect(() =>
      assertTranscriptSummarySourceDigest({
        projection_version: AGENT_TRANSCRIPT_SUMMARY_PROJECTION_VERSION,
        coverage,
        items: plan.sourceItems,
        source_content_digest: canonicalSha256(plan.sourceItems.map((source) => source.item_id)),
      }),
    ).toThrow('AGENT_SESSION_COMPACTION_SOURCE_DIGEST_INVALID');
    const tampered = plan.sourceItems.map((entry, index) =>
      index === 0 ? { ...entry, payload_digest: digest('tampered') } : entry,
    );
    expect(() =>
      assertTranscriptSummarySourceDigest({
        projection_version: AGENT_TRANSCRIPT_SUMMARY_PROJECTION_VERSION,
        coverage,
        items: tampered,
        source_content_digest: buildTranscriptSummarySourceDigest({
          projection_version: AGENT_TRANSCRIPT_SUMMARY_PROJECTION_VERSION,
          coverage,
          items: plan.sourceItems,
        }),
      }),
    ).toThrow('AGENT_SESSION_COMPACTION_SOURCE_DIGEST_INVALID');
  });

  it('rejects a legacy v1 summary masquerading as a v2 checkpoint', () => {
    const v1 = {
      schema_version: 1,
      summary_version: 1,
      content,
      source_message_ids: [randomUUID()],
      source_message_digest: digest('ids'),
      through_turn_id: randomUUID(),
      model_snapshot_hash: digest('snapshot'),
      usage,
    };
    expect(persistedAgentTranscriptSummarySchema.safeParse(v1).success).toBe(false);
  });

  it('deduplicates resource dependencies in declared order', () => {
    const dependency = { binding_key: 'binding-1', kind: 'asset' };
    const withDependency = item({
      sequence_no: '1',
      item_type: 'user_message',
      turn_id: TURN_1,
      payload_json: {
        schema_version: 1,
        type: 'user_message',
        content: { type: 'inline', value: { text: 'x', attachments: [] } },
      },
      resource_dependencies_json: [dependency, dependency],
    });
    expect(collectResourceDependencies([withDependency])).toEqual([dependency]);
  });

  it('keeps the ordered source identity for each covered item', () => {
    const [first] = closedTurn(TURN_1, 1);
    expect(transcriptSummarySourceItem(first!)).toEqual({
      item_id: first!.item.id,
      sequence_no: '1',
      item_type: 'user_message',
      payload_digest: first!.item.payload_digest,
    });
  });
});
