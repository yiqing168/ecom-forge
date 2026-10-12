import { canonicalSha256 } from '@ecom-forge/shared';
import { describe, expect, it } from 'vitest';

import { deterministicFakeAgentModelSnapshot } from './brain-contract.js';
import type { AgentTranscriptSummarySourceItem } from './transcript-summary.js';
import {
  AGENT_TRANSCRIPT_SUMMARY_PROJECTION_VERSION,
  agentTranscriptCompactionItemSchema,
  assertTranscriptSummarySourceDigest,
  buildTranscriptSummarySourceDigest,
  persistedAgentTranscriptSummarySchema,
} from './transcript-summary.js';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const TURN_A = '11111111-1111-4111-8111-111111111111';
const TURN_B = '22222222-2222-4222-8222-222222222222';
const ITEM_A = '33333333-3333-4333-8333-333333333333';
const ITEM_B = '44444444-4444-4444-8444-444444444444';

const modelSnapshot = deterministicFakeAgentModelSnapshot({
  maxInputTokens: 1_000,
  maxOutputTokens: 100,
});

const content = {
  goals: ['Ship the compacted checkpoint'],
  confirmed_preferences: [],
  constraints: [],
  key_decisions: [],
  open_questions: [],
};

function sourceItems(): AgentTranscriptSummarySourceItem[] {
  return [
    { item_id: ITEM_A, sequence_no: '1', item_type: 'user_message', payload_digest: DIGEST_A },
    {
      item_id: ITEM_B,
      sequence_no: '2',
      item_type: 'tool_result',
      payload_digest: DIGEST_B,
    },
  ];
}

function checkpoint(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 2,
    summary_version: 1,
    history_generation: '0',
    covered_from_sequence: '1',
    covered_through_sequence: '2',
    source_content_digest: buildTranscriptSummarySourceDigest({
      projection_version: AGENT_TRANSCRIPT_SUMMARY_PROJECTION_VERSION,
      coverage: { covered_from_sequence: '1', covered_through_sequence: '2' },
      items: sourceItems(),
    }),
    source_turn_ids: [TURN_A, TURN_B],
    resource_dependencies: [],
    model_snapshot: modelSnapshot,
    usage: { input_tokens: 10, output_tokens: 5 },
    content,
    ...overrides,
  };
}

describe('persistedAgentTranscriptSummarySchema', () => {
  it('accepts a strict v2 checkpoint', () => {
    expect(persistedAgentTranscriptSummarySchema.safeParse(checkpoint()).success).toBe(true);
  });

  it('rejects a legacy v1 summary masquerading as a v2 checkpoint', () => {
    const v1 = {
      schema_version: 1,
      summary_version: 1,
      content,
      source_message_ids: [ITEM_A],
      source_message_digest: canonicalSha256([ITEM_A]),
      through_turn_id: TURN_A,
      model_snapshot_hash: DIGEST_A,
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    expect(persistedAgentTranscriptSummarySchema.safeParse(v1).success).toBe(false);
  });

  it('rejects a coverage range whose start exceeds its end', () => {
    expect(
      persistedAgentTranscriptSummarySchema.safeParse(
        checkpoint({ covered_from_sequence: '4', covered_through_sequence: '2' }),
      ).success,
    ).toBe(false);
  });

  it('rejects duplicate source turn ids', () => {
    expect(
      persistedAgentTranscriptSummarySchema.safeParse(
        checkpoint({ source_turn_ids: [TURN_A, TURN_A] }),
      ).success,
    ).toBe(false);
  });
});

describe('buildTranscriptSummarySourceDigest', () => {
  it('is stable for the same ordered items and coverage', () => {
    const first = buildTranscriptSummarySourceDigest({
      projection_version: AGENT_TRANSCRIPT_SUMMARY_PROJECTION_VERSION,
      coverage: { covered_from_sequence: '1', covered_through_sequence: '2' },
      items: sourceItems(),
    });
    const second = buildTranscriptSummarySourceDigest({
      projection_version: AGENT_TRANSCRIPT_SUMMARY_PROJECTION_VERSION,
      coverage: { covered_from_sequence: '1', covered_through_sequence: '2' },
      items: sourceItems(),
    });
    expect(first).toBe(second);
  });
});

describe('assertTranscriptSummarySourceDigest', () => {
  const coverage = { covered_from_sequence: '1', covered_through_sequence: '2' };

  it('accepts the digest derived from the actual covered window', () => {
    const items = sourceItems();
    const digest = buildTranscriptSummarySourceDigest({
      projection_version: AGENT_TRANSCRIPT_SUMMARY_PROJECTION_VERSION,
      coverage,
      items,
    });
    expect(() =>
      assertTranscriptSummarySourceDigest({
        projection_version: AGENT_TRANSCRIPT_SUMMARY_PROJECTION_VERSION,
        coverage,
        items,
        source_content_digest: digest,
      }),
    ).not.toThrow();
  });

  it('rejects an ID-only digest that ignores the covered content', () => {
    const items = sourceItems();
    const idOnlyDigest = canonicalSha256(items.map((item) => item.item_id));
    expect(() =>
      assertTranscriptSummarySourceDigest({
        projection_version: AGENT_TRANSCRIPT_SUMMARY_PROJECTION_VERSION,
        coverage,
        items,
        source_content_digest: idOnlyDigest,
      }),
    ).toThrow('AGENT_SESSION_COMPACTION_SOURCE_DIGEST_INVALID');
  });

  it('rejects a digest that no longer matches a changed payload', () => {
    const items = sourceItems();
    const digest = buildTranscriptSummarySourceDigest({
      projection_version: AGENT_TRANSCRIPT_SUMMARY_PROJECTION_VERSION,
      coverage,
      items,
    });
    const tampered = [{ ...items[0]!, payload_digest: DIGEST_B }, items[1]!];
    expect(() =>
      assertTranscriptSummarySourceDigest({
        projection_version: AGENT_TRANSCRIPT_SUMMARY_PROJECTION_VERSION,
        coverage,
        items: tampered,
        source_content_digest: digest,
      }),
    ).toThrow('AGENT_SESSION_COMPACTION_SOURCE_DIGEST_INVALID');
  });
});

describe('agentTranscriptCompactionItemSchema', () => {
  it('accepts the ordered semantic projection item types', () => {
    expect(
      agentTranscriptCompactionItemSchema.safeParse({
        type: 'host_context',
        item_id: ITEM_A,
        name: 'phase@1',
        content_summary: 'phase=planning',
      }).success,
    ).toBe(true);
    expect(
      agentTranscriptCompactionItemSchema.safeParse({
        type: 'tool_result',
        item_id: ITEM_B,
        name: 'inspect_image@1',
        status: 'succeeded',
        result_summary: 'overview captured',
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown projection item type', () => {
    expect(
      agentTranscriptCompactionItemSchema.safeParse({
        type: 'system',
        item_id: ITEM_A,
        content_summary: 'nope',
      }).success,
    ).toBe(false);
  });
});
