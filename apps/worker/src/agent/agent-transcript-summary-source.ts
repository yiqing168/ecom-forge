import {
  AGENT_TRANSCRIPT_SUMMARY_PROJECTION_VERSION,
  assertTranscriptSummarySourceDigest,
  validateAgentTranscriptProtocol,
  type PersistedAgentTranscriptSummary,
} from '@ecom-forge/agent';
import {
  agentTranscriptItems,
  agentTurns,
  and,
  asc,
  eq,
  gt,
  inArray,
  lte,
  type Database,
} from '@ecom-forge/db';
import { canonicalJson } from '@ecom-forge/shared';

import { nativeTranscriptContracts } from './agent-transcript-native.js';
import { NativeTranscriptDependencies } from './agent-transcript-native-reader.js';
import { verifyStoredTranscriptItem } from './agent-transcript-storage-mapping.js';
import type { AgentReadQuery } from './agent-turn.types.js';

/** Rebuild proof and live authorization separately, without materializing private content. */
export async function readTranscriptSummarySource(
  database: Pick<Database, 'select' | 'query'>,
  input: { userId: string; sessionId: string; throughSequence: string; activeTurnId: string },
  read: AgentReadQuery = async (build) => build(),
) {
  const scope = { user_id: input.userId, session_id: input.sessionId };
  const items = [];
  let cursor = 0n;
  const through = BigInt(input.throughSequence);
  while (cursor < through) {
    const rows = await read(() =>
      database
        .select()
        .from(agentTranscriptItems)
        .where(
          and(
            eq(agentTranscriptItems.userId, input.userId),
            eq(agentTranscriptItems.sessionId, input.sessionId),
            gt(agentTranscriptItems.sequenceNo, cursor),
            lte(agentTranscriptItems.sequenceNo, through),
          ),
        )
        .orderBy(asc(agentTranscriptItems.sequenceNo))
        .limit(200),
    );
    if (rows.length === 0) throw new Error('AGENT_SESSION_SUMMARY_SOURCE_INVALID');
    for (const row of rows) {
      if (
        row.sequenceNo !== cursor + 1n ||
        row.turnId === input.activeTurnId ||
        row.turnId === null
      )
        throw new Error('AGENT_SESSION_SUMMARY_SOURCE_INVALID');
      items.push(verifyStoredTranscriptItem(row, scope, nativeTranscriptContracts));
      cursor = row.sequenceNo;
    }
  }
  validateAgentTranscriptProtocol(
    { scope, first_sequence_no: '1', require_closed: true, items },
    nativeTranscriptContracts,
  );
  const turnIds = [...new Set(items.map((item) => item.turn_id!))];
  if (turnIds.length === 0 || turnIds.length > 2048)
    throw new Error('AGENT_SESSION_SUMMARY_SOURCE_INVALID');
  const turns = await read(() =>
    database
      .select()
      .from(agentTurns)
      .where(
        and(
          eq(agentTurns.userId, input.userId),
          eq(agentTurns.sessionId, input.sessionId),
          inArray(agentTurns.id, turnIds),
        ),
      ),
  );
  if (
    turns.length !== turnIds.length ||
    turns.some(
      (turn) =>
        !turn.endedAt ||
        !['done', 'blocked', 'failed', 'cancelled', 'superseded'].includes(turn.status),
    )
  )
    throw new Error('AGENT_SESSION_SUMMARY_SOURCE_INVALID');
  const [later] = await read(() =>
    database
      .select({ id: agentTranscriptItems.id })
      .from(agentTranscriptItems)
      .where(
        and(
          eq(agentTranscriptItems.userId, input.userId),
          eq(agentTranscriptItems.sessionId, input.sessionId),
          inArray(agentTranscriptItems.turnId, turnIds),
          gt(agentTranscriptItems.sequenceNo, through),
        ),
      )
      .limit(1),
  );
  if (later) throw new Error('AGENT_SESSION_SUMMARY_SOURCE_INVALID');
  const dependencies = [
    ...new Map(
      items
        .flatMap((item) => item.resource_dependencies_json)
        .map((dependency) => [canonicalJson(dependency), dependency]),
    ).values(),
  ];
  const authorized = await new NativeTranscriptDependencies(database, read).authorize(
    input.userId,
    dependencies,
    input.sessionId,
  );
  return {
    authorized,
    sourceItems: items.map((item) => ({
      item_id: item.id,
      sequence_no: item.sequence_no,
      item_type: item.item_type as
        'user_message' | 'assistant_output' | 'tool_result' | 'host_context',
      payload_digest: item.payload_digest,
    })),
    sourceTurnIds: turnIds,
    resourceDependencies: dependencies,
  };
}

export function verifyTranscriptSummarySource(
  summary: PersistedAgentTranscriptSummary,
  source: Awaited<ReturnType<typeof readTranscriptSummarySource>>,
) {
  if (
    summary.covered_from_sequence !== '1' ||
    canonicalJson(summary.source_turn_ids) !== canonicalJson(source.sourceTurnIds) ||
    canonicalJson(summary.resource_dependencies) !== canonicalJson(source.resourceDependencies)
  )
    throw new Error('AGENT_SESSION_SUMMARY_SOURCE_INVALID');
  assertTranscriptSummarySourceDigest({
    projection_version: AGENT_TRANSCRIPT_SUMMARY_PROJECTION_VERSION,
    coverage: summary,
    items: source.sourceItems,
    source_content_digest: summary.source_content_digest,
  });
}
