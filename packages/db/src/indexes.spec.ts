import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { agentTranscriptItems, agentTranscriptPayloads } from './schema/agent-transcript.js';

import {
  agentTraceSteps,
  artifacts,
  assetUploadIntents,
  assets,
  creditLedger,
  creditReservations,
  eventOutbox,
  inviteCodeRedemptions,
  mailDeliveries,
  productFactSets,
  products,
  providerCallbackEvents,
  providerCircuitStates,
  queueDispatchIntents,
  referrals,
  registrationClaims,
  registrationRewardClaims,
  runQuotes,
  taskAttempts,
  tasks,
  workflowRuns,
} from './schema/tables.js';

function indexNames(table: Parameters<typeof getTableConfig>[0]): string[] {
  return getTableConfig(table)
    .indexes.map((item) => item.config.name)
    .filter((name): name is string => name !== undefined);
}

describe('query-driven indexes', () => {
  it.each([
    [workflowRuns, 'workflow_runs_user_status_created_idx'],
    [tasks, 'tasks_workflow_status_idx'],
    [tasks, 'tasks_workflow_dag_node_idx'],
    [taskAttempts, 'task_attempts_task_attempt_unique'],
    [taskAttempts, 'task_attempts_provider_request_unique'],
    [taskAttempts, 'task_attempts_dispatch_started_idx'],
    [taskAttempts, 'task_attempts_status_ended_idx'],
    [taskAttempts, 'task_attempts_poll_recovery_idx'],
    [providerCallbackEvents, 'provider_callback_events_provider_dedup_unique'],
    [providerCallbackEvents, 'provider_callback_events_status_next_process_idx'],
    [providerCallbackEvents, 'provider_callback_events_provider_request_idx'],
    [providerCallbackEvents, 'provider_callback_events_attempt_received_idx'],
    [providerCircuitStates, 'provider_circuit_states_scope_key_unique'],
    [providerCircuitStates, 'provider_circuit_states_status_probe_idx'],
    [providerCircuitStates, 'provider_circuit_states_provider_status_idx'],
    [artifacts, 'artifacts_user_product_created_idx'],
    [artifacts, 'artifacts_user_created_idx'],
    [artifacts, 'artifacts_storage_key_idx'],
    [artifacts, 'artifacts_task_idx'],
    [assets, 'assets_storage_key_idx'],
    [assets, 'assets_user_product_created_idx'],
    [assets, 'assets_user_folder_created_idx'],
    [assets, 'assets_user_status_created_idx'],
    [assets, 'assets_user_source_artifact_active_unique'],
    [assetUploadIntents, 'asset_upload_intents_user_key_unique'],
    [assetUploadIntents, 'asset_upload_intents_asset_unique'],
    [assetUploadIntents, 'asset_upload_intents_status_expires_idx'],
    [creditLedger, 'credit_ledger_user_created_idx'],
    [creditLedger, 'credit_ledger_workflow_run_idx'],
    [creditLedger, 'credit_ledger_idempotency_key_unique'],
    [creditReservations, 'credit_reservations_idempotency_key_unique'],
    [runQuotes, 'run_quotes_idempotency_key_unique'],
    [runQuotes, 'run_quotes_active_input_unique'],
    [products, 'products_user_updated_idx'],
    [products, 'products_user_sku_idx'],
    [productFactSets, 'product_fact_sets_product_created_idx'],
    [productFactSets, 'product_fact_sets_product_version_unique'],
    [eventOutbox, 'event_outbox_scope_sequence_unique'],
    [agentTraceSteps, 'agent_trace_steps_trace_step_unique'],
    [agentTranscriptItems, 'agent_transcript_items_session_sequence_unique'],
    [agentTranscriptItems, 'agent_transcript_items_session_source_unique'],
    [agentTranscriptItems, 'agent_transcript_items_reply_ordinal_unique'],
    [agentTranscriptItems, 'agent_transcript_items_session_import_idx'],
    [agentTranscriptItems, 'agent_transcript_items_resource_dependencies_idx'],
    [agentTranscriptPayloads, 'agent_transcript_payloads_native_digest_unique'],
    [agentTranscriptPayloads, 'agent_transcript_payloads_import_digest_unique'],
    [agentTranscriptPayloads, 'agent_transcript_payloads_session_import_idx'],
    [agentTraceSteps, 'agent_trace_steps_tool_args_created_idx'],
    [inviteCodeRedemptions, 'invite_code_redemptions_code_user_unique'],
    [referrals, 'referrals_invitee_unique'],
    [registrationClaims, 'registration_claims_idempotency_key_unique'],
    [registrationClaims, 'registration_claims_ticket_hash_unique'],
    [registrationClaims, 'registration_claims_active_email_unique'],
    [registrationClaims, 'registration_claims_invite_status_expires_idx'],
    [registrationRewardClaims, 'registration_reward_claims_campaign_user_unique'],
    [registrationRewardClaims, 'registration_reward_claims_campaign_mailbox_unique'],
    [queueDispatchIntents, 'queue_dispatch_intents_queue_job_unique'],
    [queueDispatchIntents, 'queue_dispatch_intents_status_next_attempt_idx'],
    [queueDispatchIntents, 'queue_dispatch_intents_aggregate_idx'],
    [mailDeliveries, 'mail_deliveries_idempotency_key_unique'],
    [mailDeliveries, 'mail_deliveries_status_updated_idx'],
    [mailDeliveries, 'mail_deliveries_provider_status_created_idx'],
  ] as const)('creates %s for a documented high-frequency query', (table, indexName) => {
    expect(indexNames(table)).toContain(indexName);
  });
});
