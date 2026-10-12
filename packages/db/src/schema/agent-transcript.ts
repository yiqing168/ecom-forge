import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { agentTurns, chatSessions } from './tables.js';

export const agentTranscriptPayloads = pgTable(
  'agent_transcript_payloads',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').notNull(),
    sessionId: uuid('session_id').notNull(),
    turnId: uuid('turn_id'),
    importAttemptId: uuid('import_attempt_id'),
    kind: text('kind').notNull(),
    schemaVersion: integer('schema_version').default(1).notNull(),
    contentJson: jsonb('content_json').notNull(),
    contentDigest: text('content_digest').notNull(),
    byteSize: integer('byte_size').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: 'agent_transcript_payloads_session_owner_fk',
      columns: [table.sessionId, table.userId],
      foreignColumns: [chatSessions.id, chatSessions.userId],
    }),
    foreignKey({
      name: 'agent_transcript_payloads_turn_owner_fk',
      columns: [table.turnId, table.userId, table.sessionId],
      foreignColumns: [agentTurns.id, agentTurns.userId, agentTurns.sessionId],
    }),
    uniqueIndex('agent_transcript_payloads_native_digest_unique')
      .on(table.turnId, table.kind, table.contentDigest)
      .where(sql`${table.importAttemptId} is null`),
    uniqueIndex('agent_transcript_payloads_import_digest_unique')
      .on(table.sessionId, table.importAttemptId, table.contentDigest)
      .where(sql`${table.importAttemptId} is not null`),
    index('agent_transcript_payloads_session_import_idx').on(
      table.sessionId,
      table.importAttemptId,
    ),
    check('agent_transcript_payloads_schema_version_valid', sql`${table.schemaVersion} = 1`),
    check(
      'agent_transcript_payloads_kind_valid',
      sql`${table.kind} in ('planning','authoring','tool','legacy_message')`,
    ),
    check(
      'agent_transcript_payloads_import_scope_valid',
      sql`(${table.kind} = 'legacy_message') = (${table.importAttemptId} is not null)
        and (${table.turnId} is not null or ${table.kind} = 'legacy_message')`,
    ),
    check(
      'agent_transcript_payloads_content_valid',
      sql`jsonb_typeof(${table.contentJson}) = 'object'
        and ${table.contentDigest} ~ '^[a-f0-9]{64}$'
        and ${table.byteSize} between 1 and 8388608`,
    ),
  ],
);

export const agentTranscriptItems = pgTable(
  'agent_transcript_items',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').notNull(),
    sessionId: uuid('session_id').notNull(),
    turnId: uuid('turn_id'),
    continuationNo: integer('continuation_no'),
    sequenceNo: bigint('sequence_no', { mode: 'bigint' }).notNull(),
    schemaVersion: integer('schema_version').default(1).notNull(),
    itemType: text('item_type').notNull(),
    sourceKey: text('source_key').notNull(),
    // These retain provenance when diagnostic/source rows expire; the writer validates ownership.
    sourceMessageId: uuid('source_message_id'),
    sourceTraceStepId: uuid('source_trace_step_id'),
    importAttemptId: uuid('import_attempt_id'),
    replyToItemId: uuid('reply_to_item_id'),
    callOrdinal: integer('call_ordinal'),
    payloadJson: jsonb('payload_json').notNull(),
    payloadDigest: text('payload_digest').notNull(),
    resourceDependenciesJson: jsonb('resource_dependencies_json').default([]).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: 'agent_transcript_items_session_owner_fk',
      columns: [table.sessionId, table.userId],
      foreignColumns: [chatSessions.id, chatSessions.userId],
    }),
    foreignKey({
      name: 'agent_transcript_items_turn_owner_fk',
      columns: [table.turnId, table.userId, table.sessionId],
      foreignColumns: [agentTurns.id, agentTurns.userId, agentTurns.sessionId],
    }),
    foreignKey({
      name: 'agent_transcript_items_reply_owner_fk',
      columns: [table.replyToItemId, table.userId, table.sessionId, table.turnId],
      foreignColumns: [table.id, table.userId, table.sessionId, table.turnId],
    }),
    uniqueIndex('agent_transcript_items_id_owner_unique').on(
      table.id,
      table.userId,
      table.sessionId,
      table.turnId,
    ),
    uniqueIndex('agent_transcript_items_session_sequence_unique').on(
      table.sessionId,
      table.sequenceNo,
    ),
    uniqueIndex('agent_transcript_items_session_source_unique').on(
      table.sessionId,
      table.sourceKey,
    ),
    uniqueIndex('agent_transcript_items_reply_ordinal_unique')
      .on(table.replyToItemId, table.callOrdinal)
      .where(sql`${table.itemType} = 'tool_result'`),
    index('agent_transcript_items_session_import_idx').on(table.sessionId, table.importAttemptId),
    index('agent_transcript_items_resource_dependencies_idx').using(
      'gin',
      table.resourceDependenciesJson.op('jsonb_path_ops'),
    ),
    check('agent_transcript_items_sequence_positive', sql`${table.sequenceNo} > 0`),
    check('agent_transcript_items_schema_version_valid', sql`${table.schemaVersion} = 1`),
    check(
      'agent_transcript_items_type_valid',
      sql`${table.itemType} in ('user_message','assistant_output','tool_result','host_context','legacy_message')`,
    ),
    check(
      'agent_transcript_items_turn_scope_valid',
      sql`((${table.itemType} = 'legacy_message' and
            (${table.continuationNo} is null or (${table.turnId} is not null and ${table.continuationNo} > 0)))
          or (${table.turnId} is not null and ${table.continuationNo} is not null and ${table.continuationNo} > 0))
        and ((${table.itemType} = 'legacy_message') = (${table.importAttemptId} is not null))`,
    ),
    check(
      'agent_transcript_items_reply_pair_valid',
      sql`(${table.itemType} = 'tool_result' and ${table.replyToItemId} is not null
          and ${table.callOrdinal} is not null and ${table.callOrdinal} between 0 and 3)
        or (${table.itemType} <> 'tool_result' and ${table.replyToItemId} is null and ${table.callOrdinal} is null)`,
    ),
    check(
      'agent_transcript_items_payload_valid',
      sql`jsonb_typeof(${table.payloadJson}) = 'object'
        and jsonb_typeof(${table.resourceDependenciesJson}) = 'array'
        and ${table.payloadDigest} ~ '^[a-f0-9]{64}$' and length(${table.sourceKey}) > 0`,
    ),
  ],
);
