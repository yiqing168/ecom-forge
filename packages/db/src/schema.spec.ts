import { getTableName } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { agentTranscriptItems, agentTranscriptPayloads } from './schema/agent-transcript.js';

import {
  ADMIN_ACTOR_TYPES,
  ADMIN_AUDIT_RESULTS,
  ADMIN_AUTH_CHALLENGE_PURPOSES,
  ADMIN_AUTH_CHALLENGE_STATUSES,
  ADMIN_CREDENTIAL_STATUSES,
  ADMIN_CREDENTIAL_TYPES,
  ADMIN_ENROLLMENT_TOKEN_STATUSES,
  ADMIN_PRINCIPAL_STATUSES,
  ADMIN_SESSION_STATUSES,
  AGENT_CONFIRMATION_STATUSES,
  AGENT_CONFIRMATION_TYPES,
  ARTIFACT_VISIBILITIES,
  ASSET_STATUSES,
  ASSET_UPLOAD_STATUSES,
  DISPATCH_STATES,
  LEDGER_TYPES,
  MAIL_DELIVERY_STATUSES,
  MAIL_PURPOSES,
  PROVIDER_CALLBACK_STATUSES,
  PROVIDER_CIRCUIT_SCOPES,
  PROVIDER_CIRCUIT_STATUSES,
  REGISTRATION_CLAIM_STATUSES,
  REGISTRATION_REWARD_DECISIONS,
  SKILL_CATALOG_RELEASE_STATUSES,
  SKILL_KINDS,
  SKILL_PACKAGE_RISK_STATUSES,
  SKILL_PACKAGE_STATUSES,
  SKILL_PACKAGE_VALIDATION_STATUSES,
  SKILL_VISIBILITIES,
  TASK_ATTEMPT_STATUSES,
  TASK_STATUSES,
  WORKFLOW_RUN_STATUSES,
} from '@ecom-forge/types';

import {
  adminActorTypeEnum,
  adminAuditResultEnum,
  adminAuthChallengePurposeEnum,
  adminAuthChallengeStatusEnum,
  adminCredentialStatusEnum,
  adminCredentialTypeEnum,
  adminEnrollmentTokenStatusEnum,
  adminPrincipalStatusEnum,
  adminSessionStatusEnum,
  agentConfirmationStatusEnum,
  agentConfirmationTypeEnum,
  artifactVisibilityEnum,
  assetStatusEnum,
  assetUploadStatusEnum,
  mailDeliveryStatusEnum,
  mailPurposeEnum,
  providerCallbackStatusEnum,
  providerCircuitScopeEnum,
  providerCircuitStatusEnum,
  registrationClaimStatusEnum,
  registrationRewardDecisionEnum,
  skillCatalogReleaseStatusEnum,
  skillKindEnum,
  skillPackageRiskStatusEnum,
  skillPackageStatusEnum,
  skillPackageValidationStatusEnum,
  skillVisibilityEnum,
} from './schema/enums.js';
import {
  adminAuditLogs,
  adminAuthChallenges,
  adminCredentials,
  adminEnrollmentTokens,
  adminIdempotencyRecords,
  adminMfaRecoveryCodes,
  adminPrincipals,
  adminRoleBindings,
  adminSessions,
  agentSessionMutations,
  agentTurnConfirmations,
  agentTraceSteps,
  agentTraces,
  agentTurns,
  appeals,
  artifactEvaluations,
  artifacts,
  assetEmbeddings,
  assetFolders,
  assetUploadIntents,
  assets,
  authAccounts,
  authSessions,
  authVerifications,
  canvases,
  chatMessages,
  chatSessions,
  creditAccounts,
  creditLedger,
  creditReservations,
  billableSkus,
  eventOutbox,
  inviteCodeRedemptions,
  inviteCodeBatches,
  inviteCampaigns,
  inviteCodes,
  mailDeliveries,
  memberships,
  models,
  modelCatalogEntries,
  modelPocRuns,
  nodeVersions,
  notifications,
  platformSpecRules,
  productFactSets,
  products,
  providerCallbackEvents,
  providerCircuitStates,
  providerChannels,
  providerCredentialValidationRuns,
  providerCredentialVersions,
  queueDispatchIntents,
  resourceWriteRequests,
  referrals,
  registrationClaims,
  registrationRewardClaims,
  rewardCampaigns,
  riskConfirmations,
  runQuotes,
  pricingCatalogReleases,
  pricingCatalogState,
  shareReports,
  shares,
  skillResourceSnapshots,
  skillCatalogReleases,
  skillCatalogState,
  skillPackageResources,
  skillPackageValidationReports,
  skillPackages,
  skills,
  storageChannels,
  storageCredentialVersions,
  storageRuntimeState,
  storageValidationRuns,
  taskAttempts,
  tasks,
  templateUnlocks,
  templates,
  userActivityLogs,
  userPreferences,
  users,
  workerHeartbeats,
  workflowRuns,
} from './schema/tables.js';

const allTables = [
  users,
  authSessions,
  authAccounts,
  authVerifications,
  adminPrincipals,
  adminCredentials,
  adminEnrollmentTokens,
  adminAuthChallenges,
  adminSessions,
  adminRoleBindings,
  adminMfaRecoveryCodes,
  adminIdempotencyRecords,
  registrationClaims,
  registrationRewardClaims,
  rewardCampaigns,
  inviteCampaigns,
  inviteCodeBatches,
  inviteCodes,
  inviteCodeRedemptions,
  referrals,
  userActivityLogs,
  creditAccounts,
  creditLedger,
  creditReservations,
  runQuotes,
  appeals,
  workflowRuns,
  tasks,
  taskAttempts,
  providerCallbackEvents,
  providerCircuitStates,
  providerChannels,
  providerCredentialVersions,
  providerCredentialValidationRuns,
  storageChannels,
  storageCredentialVersions,
  storageValidationRuns,
  storageRuntimeState,
  modelPocRuns,
  modelCatalogEntries,
  billableSkus,
  pricingCatalogReleases,
  pricingCatalogState,
  workerHeartbeats,
  eventOutbox,
  queueDispatchIntents,
  mailDeliveries,
  chatSessions,
  agentSessionMutations,
  chatMessages,
  agentTranscriptItems,
  agentTranscriptPayloads,
  agentTurns,
  agentTurnConfirmations,
  agentTraces,
  agentTraceSteps,
  skillResourceSnapshots,
  skillPackages,
  skillPackageResources,
  skillPackageValidationReports,
  skillCatalogReleases,
  skillCatalogState,
  products,
  productFactSets,
  assetFolders,
  assets,
  assetUploadIntents,
  resourceWriteRequests,
  artifacts,
  artifactEvaluations,
  riskConfirmations,
  skills,
  models,
  adminAuditLogs,
  memberships,
  canvases,
  nodeVersions,
  templates,
  templateUnlocks,
  platformSpecRules,
  shares,
  shareReports,
  assetEmbeddings,
  userPreferences,
  notifications,
] as const;

describe('database schema contract', () => {
  it('declares every 1A table and later-stage placeholder exactly once', () => {
    const names = allTables.map((table) => getTableName(table));

    expect(names).toHaveLength(85);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(
      expect.arrayContaining([
        'users',
        'credit_ledger',
        'workflow_runs',
        'agent_turns',
        'agent_transcript_items',
        'agent_transcript_payloads',
        'agent_session_mutations',
        'products',
        'artifacts',
        'asset_upload_intents',
        'resource_write_requests',
        'platform_spec_rules',
        'notifications',
        'registration_claims',
        'registration_reward_claims',
        'mail_deliveries',
        'queue_dispatch_intents',
        'provider_callback_events',
        'provider_circuit_states',
        'agent_turn_confirmations',
        'skill_packages',
        'skill_package_resources',
        'skill_package_validation_reports',
        'skill_catalog_releases',
        'skill_catalog_state',
        'admin_enrollment_tokens',
        'provider_credential_validation_runs',
        'storage_validation_runs',
        'model_catalog_entries',
        'billable_skus',
        'pricing_catalog_state',
      ]),
    );
  });

  it('keeps shared state values aligned with the data contract', () => {
    expect(WORKFLOW_RUN_STATUSES).toContain('disputed');
    expect(TASK_STATUSES).toContain('waiting_manual_review');
    expect(TASK_ATTEMPT_STATUSES).toContain('outcome_unknown');
    expect(DISPATCH_STATES).toEqual(['not_dispatched', 'accepted', 'outcome_unknown']);
    expect(LEDGER_TYPES).toContain('reservation_freeze');
    expect(artifactVisibilityEnum.enumValues).toEqual([...ARTIFACT_VISIBILITIES]);
    expect(artifactVisibilityEnum.enumValues).toContain('quarantined');
    expect(assetStatusEnum.enumValues).toEqual([...ASSET_STATUSES]);
    expect(assetUploadStatusEnum.enumValues).toEqual([...ASSET_UPLOAD_STATUSES]);
    expect(registrationClaimStatusEnum.enumValues).toEqual([...REGISTRATION_CLAIM_STATUSES]);
    expect(registrationRewardDecisionEnum.enumValues).toEqual([...REGISTRATION_REWARD_DECISIONS]);
    expect(mailDeliveryStatusEnum.enumValues).toEqual([...MAIL_DELIVERY_STATUSES]);
    expect(mailPurposeEnum.enumValues).toEqual([...MAIL_PURPOSES]);
    expect(providerCallbackStatusEnum.enumValues).toEqual([...PROVIDER_CALLBACK_STATUSES]);
    expect(providerCircuitScopeEnum.enumValues).toEqual([...PROVIDER_CIRCUIT_SCOPES]);
    expect(providerCircuitStatusEnum.enumValues).toEqual([...PROVIDER_CIRCUIT_STATUSES]);
    expect(agentConfirmationTypeEnum.enumValues).toEqual([...AGENT_CONFIRMATION_TYPES]);
    expect(agentConfirmationStatusEnum.enumValues).toEqual([...AGENT_CONFIRMATION_STATUSES]);
    expect(skillKindEnum.enumValues).toEqual([...SKILL_KINDS]);
    expect(skillVisibilityEnum.enumValues).toEqual([...SKILL_VISIBILITIES]);
    expect(skillPackageStatusEnum.enumValues).toEqual([...SKILL_PACKAGE_STATUSES]);
    expect(skillPackageValidationStatusEnum.enumValues).toEqual([
      ...SKILL_PACKAGE_VALIDATION_STATUSES,
    ]);
    expect(skillPackageRiskStatusEnum.enumValues).toEqual([...SKILL_PACKAGE_RISK_STATUSES]);
    expect(skillCatalogReleaseStatusEnum.enumValues).toEqual([...SKILL_CATALOG_RELEASE_STATUSES]);
    expect(adminActorTypeEnum.enumValues).toEqual([...ADMIN_ACTOR_TYPES]);
    expect(adminAuditResultEnum.enumValues).toEqual([...ADMIN_AUDIT_RESULTS]);
    expect(adminPrincipalStatusEnum.enumValues).toEqual([...ADMIN_PRINCIPAL_STATUSES]);
    expect(adminCredentialTypeEnum.enumValues).toEqual([...ADMIN_CREDENTIAL_TYPES]);
    expect(adminCredentialStatusEnum.enumValues).toEqual([...ADMIN_CREDENTIAL_STATUSES]);
    expect(adminEnrollmentTokenStatusEnum.enumValues).toEqual([...ADMIN_ENROLLMENT_TOKEN_STATUSES]);
    expect(adminAuthChallengePurposeEnum.enumValues).toEqual([...ADMIN_AUTH_CHALLENGE_PURPOSES]);
    expect(adminAuthChallengeStatusEnum.enumValues).toEqual([...ADMIN_AUTH_CHALLENGE_STATUSES]);
    expect(adminSessionStatusEnum.enumValues).toEqual([...ADMIN_SESSION_STATUSES]);
  });

  it('models S14 control-plane identity and reliable validation state', () => {
    expect(getTableConfig(adminEnrollmentTokens).columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['token_hash', 'status', 'expires_at', 'revision']),
    );
    expect(getTableConfig(adminCredentials).indexes.map((item) => item.config.name)).toEqual(
      expect.arrayContaining([
        'admin_credentials_active_type_unique',
        'admin_credentials_pending_type_unique',
      ]),
    );
    expect(getTableConfig(providerChannels).checks.map((item) => item.name)).toContain(
      'provider_channels_region_key_normalized',
    );
    expect(
      getTableConfig(modelCatalogEntries)
        .indexes.filter((item) => item.config.unique)
        .map((item) => item.config.name),
    ).toContain('model_catalog_entries_approved_default_category_unique');
    expect(getTableConfig(storageChannels).checks.map((item) => item.name)).toContain(
      'storage_channels_region_key_normalized',
    );
    expect(
      getTableConfig(providerCredentialValidationRuns).columns.map((column) => column.name),
    ).toEqual(
      expect.arrayContaining([
        'probe_contract_version',
        'queue_dispatch_intent_id',
        'requested_by_admin_id',
      ]),
    );
    expect(getTableConfig(storageValidationRuns).columns.map((column) => column.name)).toContain(
      'probe_prefix_digest',
    );
  });

  it('models artifact quarantine and its evaluation evidence', () => {
    const artifactConfig = getTableConfig(artifacts);
    const artifactColumns = artifactConfig.columns.map((column) => column.name);
    const evaluationColumns = getTableConfig(artifactEvaluations).columns.map(
      (column) => column.name,
    );

    expect(artifactColumns).toEqual(
      expect.arrayContaining(['visibility', 'storage_key', 'user_id', 'task_id']),
    );
    expect(evaluationColumns).toEqual(
      expect.arrayContaining(['artifact_id', 'evaluator_type', 'status']),
    );
    expect(artifactConfig.checks.map((item) => item.name)).toContain(
      'artifacts_chat_producer_session_required',
    );
  });

  it('treats null parent folders as equal for root-name uniqueness', () => {
    const [folderNameConstraint] = getTableConfig(assetFolders).uniqueConstraints;

    expect(folderNameConstraint?.getName()).toBe('asset_folders_user_parent_name_unique');
    expect(folderNameConstraint?.nullsNotDistinct).toBe(true);
  });

  it('models S10 upload and asset lifecycle invariants', () => {
    const assetConfig = getTableConfig(assets);
    const uploadConfig = getTableConfig(assetUploadIntents);
    const productConfig = getTableConfig(products);
    const factConfig = getTableConfig(productFactSets);

    expect(assetConfig.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'display_name',
        'thumbnail_key',
        'status',
        'processing_revision',
        'processing_error_code',
      ]),
    );
    expect(assetConfig.checks.map((item) => item.name)).toEqual(
      expect.arrayContaining(['assets_deleted_pair', 'assets_ready_fields', 'assets_origin_shape']),
    );
    expect(uploadConfig.indexes.map((item) => item.config.name)).toEqual(
      expect.arrayContaining([
        'asset_upload_intents_user_key_unique',
        'asset_upload_intents_asset_unique',
        'asset_upload_intents_status_expires_idx',
      ]),
    );
    expect(productConfig.columns.map((column) => column.name)).toContain('revision');
    expect(factConfig.columns.map((column) => column.name)).toContain('version_no');
  });

  it('uses fixed-scale numeric columns for every monetary value', () => {
    const moneyColumns = [
      creditAccounts.balance,
      creditAccounts.frozen,
      creditLedger.amount,
      creditLedger.balanceAfter,
      creditLedger.frozenAfter,
      creditReservations.estimatedAmount,
      creditReservations.settledAmount,
      creditReservations.releasedAmount,
      runQuotes.estimatedTotalCredits,
      tasks.costEstimate,
      taskAttempts.providerReportedCost,
      appeals.refundAmount,
      agentTraces.estimatedCost,
      agentTraces.reservedCost,
      agentTraceSteps.estimatedCost,
      templates.price,
    ];

    expect(moneyColumns.map((column) => column.getSQLType())).toEqual(
      moneyColumns.map(() => 'numeric(18, 2)'),
    );
  });

  it('enforces S08 turn idempotency, selection snapshots, and processing leases', () => {
    const turnConfig = getTableConfig(agentTurns);
    const confirmationConfig = getTableConfig(agentTurnConfirmations);

    expect(
      turnConfig.indexes.filter((item) => item.config.unique).map((item) => item.config.name),
    ).toEqual(
      expect.arrayContaining([
        'agent_turns_user_create_key_unique',
        'agent_turns_user_interrupt_key_unique',
        'agent_turns_session_active_unique',
      ]),
    );
    expect(turnConfig.checks.map((item) => item.name)).toEqual(
      expect.arrayContaining([
        'agent_turns_processing_lease_pair',
        'agent_turns_skill_selection_triplet',
        'agent_turns_create_idempotency_triplet',
        'agent_turns_interrupt_idempotency_triplet',
        'agent_turns_model_selection_pair',
        'agent_turns_generation_preferences_pair',
      ]),
    );
    expect(
      confirmationConfig.indexes
        .filter((item) => item.config.unique)
        .map((item) => item.config.name),
    ).toEqual(
      expect.arrayContaining([
        'agent_turn_confirmations_turn_no_unique',
        'agent_turn_confirmations_user_key_unique',
      ]),
    );
  });

  it('models S11 session archival, keyset listing, and mutation idempotency', () => {
    const sessionConfig = getTableConfig(chatSessions);
    const mutationConfig = getTableConfig(agentSessionMutations);

    expect(sessionConfig.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['revision', 'archived_at']),
    );
    expect(sessionConfig.indexes.map((item) => item.config.name)).toContain(
      'chat_sessions_user_archived_updated_id_idx',
    );
    expect(sessionConfig.checks.map((item) => item.name)).toContain(
      'chat_sessions_revision_positive',
    );
    expect(
      mutationConfig.indexes.filter((item) => item.config.unique).map((item) => item.config.name),
    ).toContain('agent_session_mutations_user_operation_key_unique');
    expect(mutationConfig.checks.map((item) => item.name)).toContain(
      'agent_session_mutations_operation_valid',
    );
  });

  it('models immutable Skill package validation and atomic catalog releases', () => {
    expect(
      getTableConfig(skillPackages)
        .indexes.filter((item) => item.config.unique)
        .map((item) => item.config.name),
    ).toContain('skill_packages_identity_unique');
    expect(
      getTableConfig(skillPackageResources)
        .indexes.filter((item) => item.config.unique)
        .map((item) => item.config.name),
    ).toContain('skill_package_resources_path_unique');
    expect(
      getTableConfig(skillPackageValidationReports)
        .indexes.filter((item) => item.config.unique)
        .map((item) => item.config.name),
    ).toEqual(
      expect.arrayContaining([
        'skill_package_validation_attempt_unique',
        'skill_package_validation_digest_unique',
        'skill_package_validation_intent_unique',
      ]),
    );
    expect(
      getTableConfig(skillCatalogReleases)
        .indexes.filter((item) => item.config.unique)
        .map((item) => item.config.name),
    ).toEqual(
      expect.arrayContaining([
        'skill_catalog_releases_no_unique',
        'skill_catalog_releases_digest_unique',
      ]),
    );
  });
});
