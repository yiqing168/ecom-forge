import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import {
  agentTraceActorEnum,
  agentTraceStatusEnum,
  agentTraceStepStatusEnum,
  agentTraceStepTypeEnum,
  agentTurnStatusEnum,
  adminAuthChallengePurposeEnum,
  adminAuthChallengeStatusEnum,
  adminActorTypeEnum,
  adminAuditResultEnum,
  adminCredentialStatusEnum,
  adminCredentialTypeEnum,
  adminEnrollmentTokenStatusEnum,
  adminPrincipalStatusEnum,
  adminSessionStatusEnum,
  agentConfirmationStatusEnum,
  agentConfirmationTypeEnum,
  appealStatusEnum,
  assetEmbeddingStatusEnum,
  artifactTypeEnum,
  artifactVisibilityEnum,
  assetKindEnum,
  assetOriginEnum,
  assetStatusEnum,
  assetUploadStatusEnum,
  chatMessageRoleEnum,
  contentReviewDecisionEnum,
  contentReviewStatusEnum,
  contentSafetyPreflightStatusEnum,
  dispatchStateEnum,
  evaluationStatusEnum,
  evaluatorTypeEnum,
  ledgerTypeEnum,
  mailDeliveryStatusEnum,
  mailPurposeEnum,
  modelCatalogCategoryEnum,
  modelCatalogEntryStatusEnum,
  membershipSourceEnum,
  membershipTierEnum,
  modelStatusEnum,
  moderationCapabilityEnum,
  mutationOwnerEnum,
  originDomainEnum,
  platformRuleStatusEnum,
  producerModeEnum,
  productStatusEnum,
  providerCallbackStatusEnum,
  providerCircuitScopeEnum,
  providerCircuitStatusEnum,
  billableSkuStatusEnum,
  inviteCampaignStatusEnum,
  pricingCatalogReleaseStatusEnum,
  queueDispatchStatusEnum,
  referralRewardStatusEnum,
  registrationClaimStatusEnum,
  registrationRewardDecisionEnum,
  rewardCampaignKindEnum,
  rewardCampaignStatusEnum,
  reservationStatusEnum,
  retentionTierEnum,
  riskDecisionEnum,
  runQuoteStatusEnum,
  runQuoteSubmissionModeEnum,
  shareReportReasonEnum,
  shareReportStatusEnum,
  skillResourceTypeEnum,
  skillCatalogReleaseStatusEnum,
  skillKindEnum,
  skillPackageRiskStatusEnum,
  skillPackageStatusEnum,
  skillPackageValidationStatusEnum,
  skillStatusEnum,
  skillVisibilityEnum,
  sourceActionEnum,
  taskAttemptStatusEnum,
  taskStatusEnum,
  templateTypeEnum,
  templateUnlockTypeEnum,
  triggerModeEnum,
  userActivityTypeEnum,
  userRiskStatusEnum,
  userRoleEnum,
  workerStatusEnum,
  workflowRunStatusEnum,
} from './enums.js';

const createdAt = () => timestamp('created_at', { withTimezone: true }).defaultNow().notNull();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).defaultNow().notNull();
const money = (name: string) => numeric(name, { mode: 'string', precision: 18, scale: 2 });

export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    email: varchar('email', { length: 320 }).notNull(),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    displayName: varchar('display_name', { length: 120 }).notNull(),
    role: userRoleEnum('role').default('user').notNull(),
    riskStatus: userRiskStatusEnum('risk_status').default('normal').notNull(),
    riskRevision: integer('risk_revision').default(1).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('users_email_unique').on(table.email),
    index('users_risk_status_idx').on(table.riskStatus),
  ],
);

// Better Auth owns these three tables; names are explicit to keep auth data separate.
export const authSessions = pgTable(
  'auth_sessions',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text('token').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('auth_sessions_token_unique').on(table.token),
    index('auth_sessions_user_id_idx').on(table.userId),
  ],
);

export const authAccounts = pgTable(
  'auth_accounts',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    password: text('password'),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', {
      withTimezone: true,
    }),
    scope: text('scope'),
    idToken: text('id_token'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('auth_accounts_provider_account_unique').on(table.providerId, table.accountId),
    index('auth_accounts_user_id_idx').on(table.userId),
  ],
);

export const authVerifications = pgTable(
  'auth_verifications',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index('auth_verifications_identifier_idx').on(table.identifier)],
);

export const adminPrincipals = pgTable(
  'admin_principals',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    identifierHash: text('identifier_hash').notNull(),
    identifierKeyId: text('identifier_key_id').notNull(),
    identifierHint: text('identifier_hint').notNull(),
    displayName: text('display_name').notNull(),
    status: adminPrincipalStatusEnum('status').default('pending_enrollment').notNull(),
    authzVersion: integer('authz_version').default(1).notNull(),
    revision: integer('revision').default(1).notNull(),
    disabledReason: text('disabled_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('admin_principals_identifier_unique').on(
      table.identifierKeyId,
      table.identifierHash,
    ),
    index('admin_principals_status_idx').on(table.status),
    check('admin_principals_authz_version_positive', sql`${table.authzVersion} > 0`),
    check('admin_principals_revision_positive', sql`${table.revision} > 0`),
  ],
);

export const adminCredentials = pgTable(
  'admin_credentials',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    adminPrincipalId: uuid('admin_principal_id')
      .notNull()
      .references(() => adminPrincipals.id),
    credentialType: adminCredentialTypeEnum('credential_type').notNull(),
    credentialPublicId: text('credential_public_id'),
    passwordHash: text('password_hash'),
    passwordHashMetadata: jsonb('password_hash_metadata'),
    secretCiphertext: text('secret_ciphertext'),
    secretNonce: text('secret_nonce'),
    secretAuthTag: text('secret_auth_tag'),
    secretKeyId: text('secret_key_id'),
    totpLastUsedStep: integer('totp_last_used_step'),
    status: adminCredentialStatusEnum('status').default('pending').notNull(),
    revision: integer('revision').default(1).notNull(),
    createdAt: createdAt(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('admin_credentials_active_type_unique')
      .on(table.adminPrincipalId, table.credentialType)
      .where(sql`${table.status} = 'active'`),
    uniqueIndex('admin_credentials_pending_type_unique')
      .on(table.adminPrincipalId, table.credentialType)
      .where(sql`${table.status} = 'pending'`),
    uniqueIndex('admin_credentials_public_id_unique')
      .on(table.credentialPublicId)
      .where(sql`${table.credentialPublicId} is not null`),
    index('admin_credentials_principal_status_idx').on(table.adminPrincipalId, table.status),
    check('admin_credentials_revision_positive', sql`${table.revision} > 0`),
    check(
      'admin_credentials_shape',
      sql`(${table.credentialType} = 'password' and ${table.passwordHash} is not null and ${table.secretCiphertext} is null and ${table.totpLastUsedStep} is null) or (${table.credentialType} = 'totp' and ${table.passwordHash} is null and ${table.secretCiphertext} is not null and ${table.secretNonce} is not null and ${table.secretAuthTag} is not null and ${table.secretKeyId} is not null)`,
    ),
  ],
);

export const adminEnrollmentTokens = pgTable(
  'admin_enrollment_tokens',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    adminPrincipalId: uuid('admin_principal_id')
      .notNull()
      .references(() => adminPrincipals.id),
    tokenHash: text('token_hash').notNull(),
    keyId: text('key_id').notNull(),
    status: adminEnrollmentTokenStatusEnum('status').default('issued').notNull(),
    attemptCount: integer('attempt_count').default(0).notNull(),
    maxAttempts: integer('max_attempts').default(5).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    usedAt: timestamp('used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdByAdminId: uuid('created_by_admin_id').references(() => adminPrincipals.id),
    revision: integer('revision').default(1).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('admin_enrollment_tokens_hash_unique').on(table.tokenHash),
    uniqueIndex('admin_enrollment_tokens_live_principal_unique')
      .on(table.adminPrincipalId)
      .where(sql`${table.status} in ('issued', 'claimed')`),
    index('admin_enrollment_tokens_status_expires_idx').on(table.status, table.expiresAt),
    check(
      'admin_enrollment_tokens_attempt_bounds',
      sql`${table.attemptCount} >= 0 and ${table.maxAttempts} > 0 and ${table.attemptCount} <= ${table.maxAttempts}`,
    ),
    check('admin_enrollment_tokens_revision_positive', sql`${table.revision} > 0`),
  ],
);

export const adminAuthChallenges = pgTable(
  'admin_auth_challenges',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    adminPrincipalId: uuid('admin_principal_id')
      .notNull()
      .references(() => adminPrincipals.id),
    purpose: adminAuthChallengePurposeEnum('purpose').notNull(),
    challengeTokenHash: text('challenge_token_hash').notNull(),
    challengeKeyId: text('challenge_key_id').notNull(),
    identifierRekeyHash: text('identifier_rekey_hash'),
    identifierRekeyKeyId: text('identifier_rekey_key_id'),
    status: adminAuthChallengeStatusEnum('status').default('pending').notNull(),
    attemptCount: integer('attempt_count').default(0).notNull(),
    maxAttempts: integer('max_attempts').default(5).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('admin_auth_challenges_token_unique').on(table.challengeTokenHash),
    index('admin_auth_challenges_status_expires_idx').on(table.status, table.expiresAt),
    check(
      'admin_auth_challenges_attempt_bounds',
      sql`${table.attemptCount} >= 0 and ${table.maxAttempts} > 0 and ${table.attemptCount} <= ${table.maxAttempts}`,
    ),
  ],
);

export const adminSessions = pgTable(
  'admin_sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    adminPrincipalId: uuid('admin_principal_id')
      .notNull()
      .references(() => adminPrincipals.id),
    sessionTokenHash: text('session_token_hash').notNull(),
    sessionKeyId: text('session_key_id').notNull(),
    csrfTokenHash: text('csrf_token_hash').notNull(),
    csrfKeyId: text('csrf_key_id').notNull(),
    status: adminSessionStatusEnum('status').default('active').notNull(),
    authzVersionSnapshot: integer('authz_version_snapshot').notNull(),
    mfaLevel: text('mfa_level').default('totp').notNull(),
    mfaVerifiedAt: timestamp('mfa_verified_at', { withTimezone: true }).notNull(),
    stepUpAt: timestamp('step_up_at', { withTimezone: true }),
    recoveryRestricted: boolean('recovery_restricted').default(false).notNull(),
    sourceIpHash: text('source_ip_hash'),
    userAgentHash: text('user_agent_hash'),
    sessionExpiresAt: timestamp('session_expires_at', { withTimezone: true }).notNull(),
    idleExpiresAt: timestamp('idle_expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('admin_sessions_token_unique').on(table.sessionTokenHash),
    index('admin_sessions_principal_status_expires_idx').on(
      table.adminPrincipalId,
      table.status,
      table.sessionExpiresAt,
    ),
  ],
);

export const adminRoleBindings = pgTable(
  'admin_role_bindings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    adminPrincipalId: uuid('admin_principal_id')
      .notNull()
      .references(() => adminPrincipals.id),
    roleKey: text('role_key').notNull(),
    scopeType: text('scope_type').default('global').notNull(),
    scopeKey: text('scope_key').default('global').notNull(),
    permissionSnapshotHash: text('permission_snapshot_hash').notNull(),
    revision: integer('revision').default(1).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('admin_role_bindings_scope_unique').on(
      table.adminPrincipalId,
      table.roleKey,
      table.scopeType,
      table.scopeKey,
    ),
    index('admin_role_bindings_principal_idx').on(table.adminPrincipalId),
  ],
);

export const adminMfaRecoveryCodes = pgTable(
  'admin_mfa_recovery_codes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    adminPrincipalId: uuid('admin_principal_id')
      .notNull()
      .references(() => adminPrincipals.id),
    codeHash: text('code_hash').notNull(),
    keyId: text('key_id').notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('admin_mfa_recovery_codes_hash_unique').on(table.keyId, table.codeHash),
    index('admin_mfa_recovery_codes_principal_idx').on(table.adminPrincipalId),
  ],
);

export const adminIdempotencyRecords = pgTable(
  'admin_idempotency_records',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    actorAdminId: uuid('actor_admin_id')
      .notNull()
      .references(() => adminPrincipals.id),
    idempotencyKeyHash: text('idempotency_key_hash').notNull(),
    operation: text('operation').notNull(),
    requestHash: text('request_hash').notNull(),
    status: text('status').default('pending').notNull(),
    targetType: text('target_type'),
    targetId: uuid('target_id'),
    responseStatus: integer('response_status'),
    responseJson: jsonb('response_json'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('admin_idempotency_records_principal_key_unique').on(
      table.actorAdminId,
      table.operation,
      table.idempotencyKeyHash,
    ),
    index('admin_idempotency_records_expires_idx').on(table.expiresAt),
    check(
      'admin_idempotency_records_status_valid',
      sql`${table.status} in ('pending','completed')`,
    ),
    check(
      'admin_idempotency_records_completion_shape',
      sql`${table.status} <> 'completed' or (${table.responseStatus} is not null and ${table.responseJson} is not null and ${table.completedAt} is not null)`,
    ),
  ],
);

export const registrationClaims = pgTable(
  'registration_claims',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    inviteCodeId: uuid('invite_code_id')
      .notNull()
      .references((): AnyPgColumn => inviteCodes.id),
    userId: uuid('user_id').references(() => users.id),
    emailHash: text('email_hash').notNull(),
    pendingEmail: varchar('pending_email', { length: 320 }),
    pendingDisplayName: varchar('pending_display_name', { length: 120 }),
    pendingPasswordHash: text('pending_password_hash'),
    agreementVersion: varchar('agreement_version', { length: 64 }),
    ticketHash: text('ticket_hash'),
    ticketNonce: text('ticket_nonce'),
    ticketVersion: integer('ticket_version').default(1).notNull(),
    status: registrationClaimStatusEnum('status').default('pending').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('registration_claims_idempotency_key_unique').on(table.idempotencyKey),
    uniqueIndex('registration_claims_ticket_hash_unique')
      .on(table.ticketHash)
      .where(sql`${table.ticketHash} is not null`),
    uniqueIndex('registration_claims_active_email_unique')
      .on(table.emailHash)
      .where(sql`${table.status} in ('pending', 'verified')`),
    index('registration_claims_invite_status_expires_idx').on(
      table.inviteCodeId,
      table.status,
      table.expiresAt,
    ),
    check('registration_claims_ticket_version_positive', sql`${table.ticketVersion} > 0`),
  ],
);

export const rewardCampaigns = pgTable(
  'reward_campaigns',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    campaignKey: text('campaign_key').notNull(),
    versionNo: integer('version_no').notNull(),
    kind: rewardCampaignKindEnum('kind').notNull(),
    status: rewardCampaignStatusEnum('status').default('draft').notNull(),
    grantCredits: money('grant_credits').notNull(),
    maxGrants: integer('max_grants').notNull(),
    budgetCredits: money('budget_credits').notNull(),
    grantedCount: integer('granted_count').default(0).notNull(),
    grantedCredits: money('granted_credits').default('0.00').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    eligibilityPolicyJson: jsonb('eligibility_policy_json').default({}).notNull(),
    revision: integer('revision').default(1).notNull(),
    createdByAdminId: uuid('created_by_admin_id').references(() => adminPrincipals.id),
    createdAt: createdAt(),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('reward_campaigns_key_version_unique').on(table.campaignKey, table.versionNo),
    uniqueIndex('reward_campaigns_active_key_unique')
      .on(table.campaignKey)
      .where(sql`${table.status} = 'active'`),
    index('reward_campaigns_status_window_idx').on(table.status, table.startsAt, table.expiresAt),
    check('reward_campaigns_version_positive', sql`${table.versionNo} > 0`),
    check('reward_campaigns_grant_positive', sql`${table.grantCredits} > 0`),
    check('reward_campaigns_max_grants_positive', sql`${table.maxGrants} > 0`),
    check('reward_campaigns_budget_nonnegative', sql`${table.budgetCredits} >= 0`),
    check(
      'reward_campaigns_projection_bounds',
      sql`${table.grantedCount} >= 0 and ${table.grantedCount} <= ${table.maxGrants} and ${table.grantedCredits} >= 0 and ${table.grantedCredits} <= ${table.budgetCredits}`,
    ),
  ],
);

export const registrationRewardClaims = pgTable(
  'registration_reward_claims',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    campaignKey: text('campaign_key').notNull(),
    rewardCampaignId: uuid('reward_campaign_id').references(() => rewardCampaigns.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    mailboxFingerprint: text('mailbox_fingerprint').notNull(),
    fingerprintKeyId: text('fingerprint_key_id').notNull(),
    fingerprintRulesVersion: text('fingerprint_rules_version').notNull(),
    deviceHash: text('device_hash'),
    ipPrefixHash: text('ip_prefix_hash'),
    decision: registrationRewardDecisionEnum('decision').default('pending').notNull(),
    reasonCode: text('reason_code'),
    ledgerId: uuid('ledger_id').references((): AnyPgColumn => creditLedger.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('registration_reward_claims_campaign_user_unique').on(
      table.campaignKey,
      table.userId,
    ),
    uniqueIndex('registration_reward_claims_campaign_mailbox_unique').on(
      table.campaignKey,
      table.mailboxFingerprint,
    ),
    check(
      'registration_reward_claims_granted_ledger_required',
      sql`${table.decision} <> 'granted' or ${table.ledgerId} is not null`,
    ),
  ],
);

export const skills = pgTable(
  'skills',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    category: text('category').notNull(),
    domain: originDomainEnum('domain').notNull(),
    kind: skillKindEnum('kind'),
    visibility: skillVisibilityEnum('visibility'),
    stage: text('stage').notNull(),
    version: text('version').notNull(),
    packageRecordId: uuid('package_record_id').references((): AnyPgColumn => skillPackages.id),
    skillDigest: text('skill_digest'),
    definitionJson: jsonb('definition_json').notNull(),
    definitionHash: text('definition_hash'),
    sortOrder: integer('sort_order').default(0).notNull(),
    price: jsonb('price').notNull(),
    status: skillStatusEnum('status').default('draft').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('skills_slug_version_unique').on(table.slug, table.version)],
);

export const providerChannels = pgTable(
  'provider_channels',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    provider: text('provider').notNull(),
    adapterKey: text('adapter_key').notNull(),
    displayName: text('display_name').notNull(),
    baseUrl: text('base_url').notNull(),
    endpointProfileKey: text('endpoint_profile_key').notNull(),
    region: text('region'),
    regionKey: text('region_key').default('').notNull(),
    status: text('status').default('draft').notNull(),
    activeCredentialVersionId: uuid('active_credential_version_id').references(
      (): AnyPgColumn => providerCredentialVersions.id,
    ),
    revision: integer('revision').default(1).notNull(),
    createdByAdminId: uuid('created_by_admin_id').references(() => adminPrincipals.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
  },
  (table) => [
    index('provider_channels_status_idx').on(table.status),
    check('provider_channels_status_valid', sql`${table.status} in ('draft','active','disabled')`),
    check(
      'provider_channels_region_key_normalized',
      sql`${table.regionKey} = coalesce(${table.region}, '')`,
    ),
    check('provider_channels_base_url_https', sql`${table.baseUrl} like 'https://%'`),
    check('provider_channels_revision_positive', sql`${table.revision} > 0`),
  ],
);

export const providerCredentialVersions = pgTable(
  'provider_credential_versions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    providerChannelId: uuid('provider_channel_id')
      .notNull()
      .references(() => providerChannels.id),
    versionNo: integer('version_no').notNull(),
    secretCiphertext: text('secret_ciphertext').notNull(),
    secretNonce: text('secret_nonce').notNull(),
    secretAuthTag: text('secret_auth_tag').notNull(),
    secretKeyId: text('secret_key_id').notNull(),
    keyHint: text('key_hint').notNull(),
    status: text('status').default('pending_validation').notNull(),
    validationEvidenceDigest: text('validation_evidence_digest'),
    revision: integer('revision').default(1).notNull(),
    createdAt: createdAt(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('provider_credential_versions_channel_version_unique').on(
      table.providerChannelId,
      table.versionNo,
    ),
    uniqueIndex('provider_credential_versions_active_channel_unique')
      .on(table.providerChannelId)
      .where(sql`${table.status} = 'active'`),
    index('provider_credential_versions_channel_status_idx').on(
      table.providerChannelId,
      table.status,
    ),
    check('provider_credential_versions_version_positive', sql`${table.versionNo} > 0`),
    check(
      'provider_credential_versions_status_valid',
      sql`${table.status} in ('pending_validation','valid','validation_unknown','active','invalid','revoked')`,
    ),
  ],
);

export const providerCredentialValidationRuns = pgTable(
  'provider_credential_validation_runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    providerChannelId: uuid('provider_channel_id')
      .notNull()
      .references(() => providerChannels.id),
    credentialVersionId: uuid('credential_version_id')
      .notNull()
      .references(() => providerCredentialVersions.id),
    probeContractVersion: text('probe_contract_version').notNull(),
    queueIntentId: uuid('queue_dispatch_intent_id').references(
      (): AnyPgColumn => queueDispatchIntents.id,
    ),
    status: text('status').default('queued').notNull(),
    attemptNo: integer('attempt_no').default(1).notNull(),
    processingOwner: text('processing_owner'),
    processingLeaseExpiresAt: timestamp('processing_lease_expires_at', { withTimezone: true }),
    evidenceDigest: text('evidence_digest'),
    resultSummaryJson: jsonb('result_summary_json'),
    revision: integer('revision').default(1).notNull(),
    requestedByAdminId: uuid('requested_by_admin_id')
      .notNull()
      .references(() => adminPrincipals.id),
    createdAt: createdAt(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('provider_credential_validation_runs_attempt_unique').on(
      table.credentialVersionId,
      table.attemptNo,
    ),
    uniqueIndex('provider_credential_validation_runs_intent_unique')
      .on(table.queueIntentId)
      .where(sql`${table.queueIntentId} is not null`),
    uniqueIndex('provider_credential_validation_runs_active_unique')
      .on(table.credentialVersionId)
      .where(sql`${table.status} in ('queued','running')`),
    index('provider_credential_validation_runs_status_lease_idx').on(
      table.status,
      table.processingLeaseExpiresAt,
    ),
    check('provider_credential_validation_runs_attempt_positive', sql`${table.attemptNo} > 0`),
    check('provider_credential_validation_runs_revision_positive', sql`${table.revision} > 0`),
    check(
      'provider_credential_validation_runs_owner_lease_pair',
      sql`(${table.processingOwner} is null) = (${table.processingLeaseExpiresAt} is null)`,
    ),
    check(
      'provider_credential_validation_runs_running_owner',
      sql`(${table.status} = 'running' and ${table.processingOwner} is not null) or (${table.status} <> 'running' and ${table.processingOwner} is null)`,
    ),
    check(
      'provider_credential_validation_runs_status_valid',
      sql`${table.status} in ('queued','running','passed','failed','outcome_unknown','cancelled')`,
    ),
  ],
);

export const storageChannels = pgTable(
  'storage_channels',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    purpose: text('purpose').notNull(),
    adapterKey: text('adapter_key').notNull(),
    endpointProfileKey: text('endpoint_profile_key').notNull(),
    region: text('region'),
    regionKey: text('region_key').default('').notNull(),
    bucket: text('bucket').notNull(),
    rootPrefix: text('root_prefix').notNull(),
    status: text('status').default('draft').notNull(),
    activeCredentialVersionId: uuid('active_credential_version_id').references(
      (): AnyPgColumn => storageCredentialVersions.id,
    ),
    revision: integer('revision').default(1).notNull(),
    createdByAdminId: uuid('created_by_admin_id').references(() => adminPrincipals.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('storage_channels_identity_unique').on(
      table.purpose,
      table.adapterKey,
      table.endpointProfileKey,
      table.regionKey,
      table.bucket,
      table.rootPrefix,
    ),
    index('storage_channels_status_idx').on(table.status),
    check('storage_channels_status_valid', sql`${table.status} in ('draft','active','disabled')`),
    check(
      'storage_channels_region_key_normalized',
      sql`${table.regionKey} = coalesce(${table.region}, '')`,
    ),
    check('storage_channels_revision_positive', sql`${table.revision} > 0`),
  ],
);

export const storageCredentialVersions = pgTable(
  'storage_credential_versions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    storageChannelId: uuid('storage_channel_id')
      .notNull()
      .references(() => storageChannels.id),
    versionNo: integer('version_no').notNull(),
    secretBundleCiphertext: text('secret_bundle_ciphertext').notNull(),
    secretNonce: text('secret_nonce').notNull(),
    secretAuthTag: text('secret_auth_tag').notNull(),
    secretKeyId: text('secret_key_id').notNull(),
    keyHint: text('key_hint').notNull(),
    status: text('status').default('pending_validation').notNull(),
    validationEvidenceDigest: text('validation_evidence_digest'),
    revision: integer('revision').default(1).notNull(),
    createdAt: createdAt(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('storage_credential_versions_channel_version_unique').on(
      table.storageChannelId,
      table.versionNo,
    ),
    uniqueIndex('storage_credential_versions_active_channel_unique')
      .on(table.storageChannelId)
      .where(sql`${table.status} = 'active'`),
    index('storage_credential_versions_channel_status_idx').on(
      table.storageChannelId,
      table.status,
    ),
    check('storage_credential_versions_version_positive', sql`${table.versionNo} > 0`),
    check(
      'storage_credential_versions_status_valid',
      sql`${table.status} in ('pending_validation','valid','validation_unknown','active','invalid','revoked')`,
    ),
  ],
);

export const storageValidationRuns = pgTable(
  'storage_validation_runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    storageChannelId: uuid('storage_channel_id')
      .notNull()
      .references(() => storageChannels.id),
    credentialVersionId: uuid('credential_version_id')
      .notNull()
      .references(() => storageCredentialVersions.id),
    probeContractVersion: text('probe_contract_version').notNull(),
    queueIntentId: uuid('queue_dispatch_intent_id').references(
      (): AnyPgColumn => queueDispatchIntents.id,
    ),
    status: text('status').default('queued').notNull(),
    attemptNo: integer('attempt_no').default(1).notNull(),
    processingOwner: text('processing_owner'),
    processingLeaseExpiresAt: timestamp('processing_lease_expires_at', { withTimezone: true }),
    evidenceDigest: text('evidence_digest'),
    resultSummaryJson: jsonb('result_summary_json'),
    probePrefixDigest: text('probe_prefix_digest').notNull(),
    revision: integer('revision').default(1).notNull(),
    requestedByAdminId: uuid('requested_by_admin_id')
      .notNull()
      .references(() => adminPrincipals.id),
    createdAt: createdAt(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('storage_validation_runs_attempt_unique').on(
      table.credentialVersionId,
      table.attemptNo,
    ),
    uniqueIndex('storage_validation_runs_intent_unique')
      .on(table.queueIntentId)
      .where(sql`${table.queueIntentId} is not null`),
    uniqueIndex('storage_validation_runs_active_unique')
      .on(table.credentialVersionId)
      .where(sql`${table.status} in ('queued','running')`),
    index('storage_validation_runs_status_lease_idx').on(
      table.status,
      table.processingLeaseExpiresAt,
    ),
    check('storage_validation_runs_attempt_positive', sql`${table.attemptNo} > 0`),
    check('storage_validation_runs_revision_positive', sql`${table.revision} > 0`),
    check(
      'storage_validation_runs_owner_lease_pair',
      sql`(${table.processingOwner} is null) = (${table.processingLeaseExpiresAt} is null)`,
    ),
    check(
      'storage_validation_runs_running_owner',
      sql`(${table.status} = 'running' and ${table.processingOwner} is not null) or (${table.status} <> 'running' and ${table.processingOwner} is null)`,
    ),
    check(
      'storage_validation_runs_status_valid',
      sql`${table.status} in ('queued','running','passed','failed','outcome_unknown','cancelled')`,
    ),
  ],
);

export const storageRuntimeState = pgTable('storage_runtime_state', {
  purpose: text('purpose').primaryKey(),
  activeChannelId: uuid('active_channel_id').references(() => storageChannels.id),
  runtimeRevision: integer('runtime_revision').default(1).notNull(),
  updatedAt: updatedAt(),
});

export const models = pgTable(
  'models',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    provider: text('provider').notNull(),
    providerChannelId: uuid('provider_channel_id').references(() => providerChannels.id),
    protocolFamily: text('protocol_family'),
    apiVariant: text('api_variant'),
    modelId: text('model_id').notNull(),
    version: text('version').notNull(),
    capabilityContractJson: jsonb('capability_contract_json').notNull(),
    pricingJson: jsonb('pricing_json').notNull(),
    quotaJson: jsonb('quota_json').notNull(),
    status: modelStatusEnum('status').notNull(),
    statusEvidenceDigest: text('status_evidence_digest'),
    statusOperatorId: text('status_operator_id'),
    statusReason: text('status_reason'),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('models_provider_model_version_unique').on(
      table.provider,
      table.modelId,
      table.version,
    ),
    check(
      'models_protocol_variant_valid',
      sql`(
        (${table.protocolFamily} is null and ${table.apiVariant} is null)
        or (
          ${table.protocolFamily} in ('openai', 'anthropic', 'google')
          and ${table.apiVariant} in ('openai_chat_completions', 'openai_responses', 'anthropic_messages', 'google_generate_content', 'openai_images')
          and (
            (${table.protocolFamily} = 'openai' and ${table.apiVariant} in ('openai_chat_completions', 'openai_responses', 'openai_images'))
            or (${table.protocolFamily} = 'anthropic' and ${table.apiVariant} = 'anthropic_messages')
            or (${table.protocolFamily} = 'google' and ${table.apiVariant} = 'google_generate_content' and (${table.capabilityContractJson}->>'contract_kind' = 'agent_brain') is true)
          )
          and (${table.apiVariant} <> 'openai_images' or ${table.capabilityContractJson}->>'media_kind' = 'image')
        )
      )`,
    ),
  ],
);

export const modelPocRuns = pgTable(
  'model_poc_runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    modelSnapshotId: uuid('model_snapshot_id')
      .notNull()
      .references(() => models.id),
    providerChannelId: uuid('provider_channel_id')
      .notNull()
      .references(() => providerChannels.id),
    credentialVersionId: uuid('credential_version_id')
      .notNull()
      .references(() => providerCredentialVersions.id),
    probeSuiteVersion: text('probe_suite_version').notNull(),
    requestedSpecKeysJson: jsonb('requested_spec_keys_json').notNull(),
    requestedSpecKeysDigest: text('requested_spec_keys_digest').notNull(),
    queueIntentId: uuid('queue_dispatch_intent_id').references(
      (): AnyPgColumn => queueDispatchIntents.id,
    ),
    status: text('status').default('queued').notNull(),
    attemptNo: integer('attempt_no').default(1).notNull(),
    processingOwner: text('processing_owner'),
    processingLeaseExpiresAt: timestamp('processing_lease_expires_at', { withTimezone: true }),
    evidenceDigest: text('evidence_digest'),
    resultSummaryJson: jsonb('result_summary_json'),
    revision: integer('revision').default(1).notNull(),
    requestedByAdminId: uuid('requested_by_admin_id')
      .notNull()
      .references(() => adminPrincipals.id),
    createdAt: createdAt(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('model_poc_runs_attempt_unique').on(table.modelSnapshotId, table.attemptNo),
    uniqueIndex('model_poc_runs_intent_unique')
      .on(table.queueIntentId)
      .where(sql`${table.queueIntentId} is not null`),
    uniqueIndex('model_poc_runs_active_unique')
      .on(table.modelSnapshotId)
      .where(sql`${table.status} in ('queued','running')`),
    index('model_poc_runs_status_lease_idx').on(table.status, table.processingLeaseExpiresAt),
    check('model_poc_runs_attempt_positive', sql`${table.attemptNo} > 0`),
    check('model_poc_runs_revision_positive', sql`${table.revision} > 0`),
    check(
      'model_poc_runs_owner_lease_pair',
      sql`(${table.processingOwner} is null) = (${table.processingLeaseExpiresAt} is null)`,
    ),
    check(
      'model_poc_runs_running_owner',
      sql`(${table.status} = 'running' and ${table.processingOwner} is not null) or (${table.status} <> 'running' and ${table.processingOwner} is null)`,
    ),
    check(
      'model_poc_runs_status_valid',
      sql`${table.status} in ('queued','running','passed','failed','outcome_unknown','cancelled')`,
    ),
  ],
);

export const moderationRuntimeStates = pgTable(
  'moderation_runtime_states',
  {
    capability: moderationCapabilityEnum('capability').primaryKey(),
    activeModelSnapshotId: uuid('active_model_snapshot_id').references(() => models.id),
    runtimeRevision: integer('runtime_revision').default(1).notNull(),
    updatedByAdminId: uuid('updated_by_admin_id').references(() => adminPrincipals.id),
    updatedAt: updatedAt(),
  },
  (table) => [
    check('moderation_runtime_states_revision_positive', sql`${table.runtimeRevision} > 0`),
  ],
);

export const modelCatalogEntries = pgTable(
  'model_catalog_entries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    modelSnapshotId: uuid('model_snapshot_id')
      .notNull()
      .references(() => models.id),
    publicSlug: text('public_slug').notNull(),
    versionNo: integer('version_no').notNull(),
    category: modelCatalogCategoryEnum('category').notNull(),
    displayName: text('display_name').notNull(),
    description: text('description').notNull(),
    publicCapabilitiesJson: jsonb('public_capabilities_json').notNull(),
    rolloutJson: jsonb('rollout_json').default({ stage: 'local', percentage: 0 }).notNull(),
    userSelectable: boolean('user_selectable').default(true).notNull(),
    isDefault: boolean('is_default').default(false).notNull(),
    sortOrder: integer('sort_order').default(0).notNull(),
    status: modelCatalogEntryStatusEnum('status').default('draft').notNull(),
    revision: integer('revision').default(1).notNull(),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('model_catalog_entries_slug_version_unique').on(table.publicSlug, table.versionNo),
    uniqueIndex('model_catalog_entries_snapshot_category_unique').on(
      table.modelSnapshotId,
      table.category,
    ),
    index('model_catalog_entries_category_status_sort_idx').on(
      table.category,
      table.status,
      table.sortOrder,
    ),
    uniqueIndex('model_catalog_entries_approved_default_category_unique')
      .on(table.category)
      .where(sql`${table.isDefault} = true and ${table.status} = 'approved'`),
    check('model_catalog_entries_version_positive', sql`${table.versionNo} > 0`),
    check('model_catalog_entries_revision_positive', sql`${table.revision} > 0`),
  ],
);

export const billableSkus = pgTable(
  'billable_skus',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    logicalSkuKey: text('logical_sku_key').notNull(),
    versionNo: integer('version_no').notNull(),
    modelCatalogEntryId: uuid('model_catalog_entry_id')
      .notNull()
      .references(() => modelCatalogEntries.id),
    operation: text('operation').notNull(),
    matcherJson: jsonb('matcher_json').notNull(),
    matcherHash: text('matcher_hash').notNull(),
    unitKind: text('unit_kind').notNull(),
    unitRuleJson: jsonb('unit_rule_json').notNull(),
    providerRateCardKey: text('provider_rate_card_key').notNull(),
    providerCostPerUnitCny: money('provider_cost_per_unit_cny'),
    creditsPerUnit: money('credits_per_unit').notNull(),
    status: billableSkuStatusEnum('status').default('draft').notNull(),
    revision: integer('revision').default(1).notNull(),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('billable_skus_key_version_unique').on(table.logicalSkuKey, table.versionNo),
    uniqueIndex('billable_skus_entry_matcher_version_unique').on(
      table.modelCatalogEntryId,
      table.operation,
      table.matcherHash,
      table.versionNo,
    ),
    index('billable_skus_entry_status_idx').on(table.modelCatalogEntryId, table.status),
    check('billable_skus_version_positive', sql`${table.versionNo} > 0`),
    check('billable_skus_revision_positive', sql`${table.revision} > 0`),
    check(
      'billable_skus_cost_nonnegative',
      sql`${table.providerCostPerUnitCny} is null or ${table.providerCostPerUnitCny} >= 0`,
    ),
    check('billable_skus_credits_nonnegative', sql`${table.creditsPerUnit} >= 0`),
    check(
      'billable_skus_unit_kind_valid',
      sql`${table.unitKind} in ('image','second','segment','megapixel','request','token','included')`,
    ),
  ],
);

export const pricingCatalogReleases = pgTable(
  'pricing_catalog_releases',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    releaseNo: integer('release_no').notNull(),
    status: pricingCatalogReleaseStatusEnum('status').default('draft').notNull(),
    baseReleaseId: uuid('base_release_id').references((): AnyPgColumn => pricingCatalogReleases.id),
    manifestJson: jsonb('manifest_json').notNull(),
    releaseDigest: text('release_digest').notNull(),
    revision: integer('revision').default(1).notNull(),
    reason: text('reason').notNull(),
    createdByAdminId: uuid('created_by_admin_id').references(() => adminPrincipals.id),
    createdAt: createdAt(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('pricing_catalog_releases_no_unique').on(table.releaseNo),
    index('pricing_catalog_releases_status_created_idx').on(table.status, table.createdAt),
    check('pricing_catalog_releases_no_positive', sql`${table.releaseNo} > 0`),
    check('pricing_catalog_releases_revision_positive', sql`${table.revision} > 0`),
  ],
);

export const pricingCatalogState = pgTable('pricing_catalog_state', {
  id: text('id').primaryKey(),
  activeReleaseId: uuid('active_release_id').references(() => pricingCatalogReleases.id),
  catalogRevision: integer('catalog_revision').default(1).notNull(),
  updatedAt: updatedAt(),
});

export const modelConfigurations = pgTable(
  'model_configurations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    purpose: text('purpose').notNull(),
    modelSnapshotId: uuid('model_snapshot_id')
      .notNull()
      .references(() => models.id),
    moderationModelSnapshotId: uuid('moderation_model_snapshot_id').references(() => models.id),
    providerChannelId: uuid('provider_channel_id')
      .notNull()
      .references(() => providerChannels.id),
    credentialVersionId: uuid('credential_version_id')
      .notNull()
      .references(() => providerCredentialVersions.id),
    creditsJson: jsonb('credits_json'),
    status: text('status').default('active').notNull(),
    revision: integer('revision').default(1).notNull(),
    createdByAdminId: uuid('created_by_admin_id').references(() => adminPrincipals.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('model_configurations_snapshot_unique').on(table.modelSnapshotId),
    uniqueIndex('model_configurations_moderation_snapshot_unique').on(
      table.moderationModelSnapshotId,
    ),
    index('model_configurations_status_updated_idx').on(table.status, table.updatedAt),
    check('model_configurations_purpose_valid', sql`${table.purpose} in ('brain','image','video')`),
    check('model_configurations_status_valid', sql`${table.status} in ('active','deleted')`),
    check('model_configurations_revision_positive', sql`${table.revision} > 0`),
  ],
);

export const chatSessions = pgTable(
  'chat_sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    title: text('title').notNull(),
    primarySkillSlug: text('primary_skill_slug'),
    creativeDirectionSnapshotJson: jsonb('creative_direction_snapshot_json'),
    creativeDirectionSnapshotHash: varchar('creative_direction_snapshot_hash', { length: 64 }),
    revision: integer('revision').default(1).notNull(),
    todoJson: jsonb('todo_json').default([]).notNull(),
    planPreview: jsonb('plan_preview'),
    summaryJson: jsonb('summary_json').default({}).notNull(),
    summaryVersion: integer('summary_version').default(0).notNull(),
    messageHistoryRevision: bigint('message_history_revision', { mode: 'bigint' })
      .default(sql`0`)
      .notNull(),
    transcriptNextSequence: bigint('transcript_next_sequence', { mode: 'bigint' })
      .default(sql`1`)
      .notNull(),
    transcriptGeneration: bigint('transcript_generation', { mode: 'bigint' })
      .default(sql`1`)
      .notNull(),
    transcriptStateJson: jsonb('transcript_state_json')
      .default({ schema_version: 1, mode: 'off' })
      .notNull(),
    summaryThroughTurnId: uuid('summary_through_turn_id').references(
      (): AnyPgColumn => agentTurns.id,
    ),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('chat_sessions_user_updated_idx').on(table.userId, table.updatedAt),
    uniqueIndex('chat_sessions_id_user_unique').on(table.id, table.userId),
    index('chat_sessions_user_archived_updated_id_idx').on(
      table.userId,
      table.archivedAt,
      table.updatedAt,
      table.id,
    ),
    check('chat_sessions_revision_positive', sql`${table.revision} > 0`),
    check(
      'chat_sessions_creative_direction_pair_valid',
      sql`(${table.creativeDirectionSnapshotJson} is null and ${table.creativeDirectionSnapshotHash} is null) or (${table.creativeDirectionSnapshotJson} is not null and ${table.creativeDirectionSnapshotHash} ~ '^[a-f0-9]{64}$' and ${table.creativeDirectionSnapshotHash} is not null)`,
    ),
    check(
      'chat_sessions_transcript_counters_valid',
      sql`${table.messageHistoryRevision} >= 0 and ${table.transcriptNextSequence} > 0 and ${table.transcriptGeneration} > 0`,
    ),
    check(
      'chat_sessions_transcript_state_valid',
      sql`(jsonb_typeof(${table.transcriptStateJson}) = 'object'
        and ${table.transcriptStateJson}->'schema_version' = '1'::jsonb
        and ${table.transcriptStateJson}->>'mode' in ('off','backfill','shadow','active','invalid')) is true`,
    ),
    check(
      'chat_sessions_primary_skill_slug_valid',
      sql`${table.primarySkillSlug} is null or ${table.primarySkillSlug} ~ '^[a-z0-9][a-z0-9-]*$'`,
    ),
  ],
);

export const agentSessionMutations = pgTable(
  'agent_session_mutations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => chatSessions.id),
    operation: text('operation').notNull(),
    idempotencyKeyHash: text('idempotency_key_hash').notNull(),
    requestHash: text('request_hash').notNull(),
    responseJson: jsonb('response_json').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('agent_session_mutations_user_operation_key_unique').on(
      table.userId,
      table.operation,
      table.idempotencyKeyHash,
    ),
    index('agent_session_mutations_session_created_idx').on(table.sessionId, table.createdAt),
    check(
      'agent_session_mutations_operation_valid',
      sql`${table.operation} in ('rename','archive')`,
    ),
  ],
);

export const products = pgTable(
  'products',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    skuCode: text('sku_code'),
    name: text('name').notNull(),
    primaryAssetId: uuid('primary_asset_id').references((): AnyPgColumn => assets.id),
    latestFactSetId: uuid('latest_fact_set_id').references((): AnyPgColumn => productFactSets.id),
    status: productStatusEnum('status').default('active').notNull(),
    revision: integer('revision').default(1).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('products_user_updated_idx').on(table.userId, table.updatedAt),
    index('products_user_sku_idx').on(table.userId, table.skuCode),
    uniqueIndex('products_user_sku_unique')
      .on(table.userId, table.skuCode)
      .where(sql`${table.skuCode} is not null`),
    check('products_revision_positive', sql`${table.revision} > 0`),
  ],
);

export const runQuotes = pgTable(
  'run_quotes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    source: triggerModeEnum('source').notNull(),
    sourceId: uuid('source_id'),
    productId: uuid('product_id').references(() => products.id),
    workflowRunId: uuid('workflow_run_id').references((): AnyPgColumn => workflowRuns.id),
    status: runQuoteStatusEnum('status').default('quoted').notNull(),
    promptPreview: jsonb('prompt_preview').notNull(),
    itemsSnapshot: jsonb('items_snapshot').default([]).notNull(),
    estimatedCallCount: integer('estimated_call_count').notNull(),
    estimatedTotalCredits: money('estimated_total_credits').notNull(),
    hasUnknownPrice: boolean('has_unknown_price').default(false).notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    inputSignature: text('input_signature').notNull(),
    submissionMode: runQuoteSubmissionModeEnum('submission_mode'),
    planDigest: text('plan_digest'),
    authorizationDigest: text('authorization_digest'),
    confirmationSnapshot: jsonb('confirmation_snapshot').notNull(),
    planSnapshot: jsonb('plan_snapshot').default({}).notNull(),
    skillSnapshot: jsonb('skill_snapshot').default({}).notNull(),
    pricingSnapshot: jsonb('pricing_snapshot').default({}).notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('run_quotes_workflow_run_unique').on(table.workflowRunId),
    uniqueIndex('run_quotes_idempotency_key_unique').on(table.idempotencyKey),
    uniqueIndex('run_quotes_active_input_unique')
      .on(table.userId, table.source, table.inputSignature)
      .where(sql`${table.status} = 'quoted'`),
    uniqueIndex('run_quotes_active_chat_source_unique')
      .on(table.source, table.sourceId)
      .where(
        sql`${table.source} = 'chat' and ${table.sourceId} is not null and ${table.status} in ('quoted','submitted')`,
      ),
    index('run_quotes_status_expires_idx').on(table.status, table.expiresAt),
    check('run_quotes_call_count_nonnegative', sql`${table.estimatedCallCount} >= 0`),
    check('run_quotes_estimated_credits_nonnegative', sql`${table.estimatedTotalCredits} >= 0`),
    check(
      'run_quotes_s09_snapshot_fields',
      sql`(${table.submissionMode} is null and ${table.planDigest} is null and ${table.authorizationDigest} is null and ${table.sourceId} is null) or (${table.submissionMode} is not null and ${table.planDigest} is not null and ((${table.source} = 'chat' and ${table.sourceId} is not null and ${table.authorizationDigest} is not null) or (${table.source} <> 'chat' and ${table.authorizationDigest} is null)))`,
    ),
  ],
);

export const creditReservations = pgTable(
  'credit_reservations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    workflowRunId: uuid('workflow_run_id').references((): AnyPgColumn => workflowRuns.id),
    estimatedAmount: money('estimated_amount').notNull(),
    settledAmount: money('settled_amount').default('0.00').notNull(),
    releasedAmount: money('released_amount').default('0.00').notNull(),
    status: reservationStatusEnum('status').default('created').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('credit_reservations_workflow_run_unique').on(table.workflowRunId),
    uniqueIndex('credit_reservations_idempotency_key_unique').on(table.idempotencyKey),
    check(
      'credit_reservations_amounts_nonnegative',
      sql`${table.estimatedAmount} >= 0 and ${table.settledAmount} >= 0 and ${table.releasedAmount} >= 0`,
    ),
  ],
);

export const workflowRuns = pgTable(
  'workflow_runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    productId: uuid('product_id').references(() => products.id),
    triggerMode: triggerModeEnum('trigger_mode').notNull(),
    runQuoteId: uuid('run_quote_id').references(() => runQuotes.id),
    reservationId: uuid('reservation_id').references(() => creditReservations.id),
    status: workflowRunStatusEnum('status').default('reserved').notNull(),
    revision: integer('revision').default(1).notNull(),
    planSnapshot: jsonb('plan_snapshot').notNull(),
    skillSnapshot: jsonb('skill_snapshot').notNull(),
    pricingSnapshot: jsonb('pricing_snapshot').notNull(),
    createdAt: createdAt(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('workflow_runs_run_quote_unique').on(table.runQuoteId),
    uniqueIndex('workflow_runs_reservation_unique').on(table.reservationId),
    index('workflow_runs_user_status_created_idx').on(table.userId, table.status, table.createdAt),
    check(
      'workflow_runs_quote_reservation_pair',
      sql`(${table.runQuoteId} is null) = (${table.reservationId} is null)`,
    ),
    check('workflow_runs_revision_positive', sql`${table.revision} > 0`),
  ],
);

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workflowRunId: uuid('workflow_run_id')
      .notNull()
      .references(() => workflowRuns.id),
    parentTaskId: uuid('parent_task_id').references((): AnyPgColumn => tasks.id),
    type: text('type').notNull(),
    status: taskStatusEnum('status').default('pending').notNull(),
    modelId: uuid('model_id').references(() => models.id),
    modelVersion: text('model_version'),
    costEstimate: money('cost_estimate').notNull(),
    costActual: money('cost_actual'),
    idempotencyKey: text('idempotency_key').notNull(),
    dagNodeId: text('dag_node_id').notNull(),
    dagJson: jsonb('dag_json').notNull(),
    paramsSnapshot: jsonb('params_snapshot').notNull(),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    createdAt: createdAt(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('tasks_idempotency_key_unique').on(table.idempotencyKey),
    index('tasks_workflow_status_idx').on(table.workflowRunId, table.status),
    index('tasks_workflow_dag_node_idx').on(table.workflowRunId, table.dagNodeId),
    check('tasks_cost_estimate_nonnegative', sql`${table.costEstimate} >= 0`),
    check(
      'tasks_cost_actual_nonnegative',
      sql`${table.costActual} is null or ${table.costActual} >= 0`,
    ),
  ],
);

export const taskAttempts = pgTable(
  'task_attempts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id),
    attemptNo: integer('attempt_no').notNull(),
    status: taskAttemptStatusEnum('status').default('created').notNull(),
    dispatchState: dispatchStateEnum('dispatch_state').default('not_dispatched').notNull(),
    provider: text('provider').notNull(),
    providerRequestId: text('provider_request_id'),
    providerReceipt: jsonb('provider_receipt').default({}).notNull(),
    providerReportedCost: money('provider_reported_cost'),
    rawErrorSummary: jsonb('raw_error_summary'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
    nextPollAt: timestamp('next_poll_at', { withTimezone: true }),
    pollCount: integer('poll_count').default(0).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('task_attempts_task_attempt_unique').on(table.taskId, table.attemptNo),
    uniqueIndex('task_attempts_provider_request_unique')
      .on(table.provider, table.providerRequestId)
      .where(sql`${table.providerRequestId} is not null`),
    index('task_attempts_task_status_idx').on(table.taskId, table.status),
    index('task_attempts_dispatch_started_idx').on(table.dispatchState, table.startedAt),
    index('task_attempts_status_ended_idx').on(table.status, table.endedAt),
    index('task_attempts_poll_recovery_idx')
      .on(table.status, table.nextPollAt)
      .where(sql`${table.status} in ('accepted', 'polling')`),
    check('task_attempts_attempt_positive', sql`${table.attemptNo} > 0`),
    check('task_attempts_poll_count_nonnegative', sql`${table.pollCount} >= 0`),
    check(
      'task_attempts_provider_cost_nonnegative',
      sql`${table.providerReportedCost} is null or ${table.providerReportedCost} >= 0`,
    ),
  ],
);

export const providerCallbackEvents = pgTable(
  'provider_callback_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    provider: text('provider').notNull(),
    dedupKey: text('dedup_key').notNull(),
    providerEventIdHint: text('provider_event_id_hint'),
    providerRequestId: text('provider_request_id'),
    taskAttemptId: uuid('task_attempt_id').references(() => taskAttempts.id),
    status: providerCallbackStatusEnum('status').default('queued').notNull(),
    normalizedPayloadJson: jsonb('normalized_payload_json').default({}).notNull(),
    rawSummaryJson: jsonb('raw_summary_json').default({}).notNull(),
    signatureKeyId: text('signature_key_id').notNull(),
    bodyDigest: text('body_digest').notNull(),
    errorCode: text('error_code'),
    processingCount: integer('processing_count').default(0).notNull(),
    nextProcessAt: timestamp('next_process_at', { withTimezone: true }),
    receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('provider_callback_events_provider_dedup_unique').on(
      table.provider,
      table.dedupKey,
    ),
    index('provider_callback_events_status_next_process_idx').on(table.status, table.nextProcessAt),
    index('provider_callback_events_provider_request_idx').on(
      table.provider,
      table.providerRequestId,
    ),
    index('provider_callback_events_attempt_received_idx').on(
      table.taskAttemptId,
      table.receivedAt,
    ),
    check('provider_callback_events_processing_nonnegative', sql`${table.processingCount} >= 0`),
  ],
);

export const providerCircuitStates = pgTable(
  'provider_circuit_states',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    scopeType: providerCircuitScopeEnum('scope_type').notNull(),
    scopeKey: text('scope_key').notNull(),
    provider: text('provider').notNull(),
    modelId: uuid('model_id').references(() => models.id),
    status: providerCircuitStatusEnum('status').default('closed').notNull(),
    revision: integer('revision').default(0).notNull(),
    reasonCode: text('reason_code'),
    windowStartedAt: timestamp('window_started_at', { withTimezone: true }).defaultNow().notNull(),
    sampleCount: integer('sample_count').default(0).notNull(),
    failureCount: integer('failure_count').default(0).notNull(),
    unknownCount: integer('unknown_count').default(0).notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    probeAfter: timestamp('probe_after', { withTimezone: true }),
    probeOwner: text('probe_owner'),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('provider_circuit_states_scope_key_unique').on(table.scopeKey),
    index('provider_circuit_states_status_probe_idx').on(table.status, table.probeAfter),
    index('provider_circuit_states_provider_status_idx').on(table.provider, table.status),
    check('provider_circuit_states_revision_nonnegative', sql`${table.revision} >= 0`),
    check(
      'provider_circuit_states_counts_nonnegative',
      sql`${table.sampleCount} >= 0 and ${table.failureCount} >= 0 and ${table.unknownCount} >= 0`,
    ),
    check(
      'provider_circuit_states_model_scope',
      sql`(${table.scopeType} = 'model' and ${table.modelId} is not null) or (${table.scopeType} = 'provider' and ${table.modelId} is null)`,
    ),
  ],
);

export const assetFolders = pgTable(
  'asset_folders',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    parentFolderId: uuid('parent_folder_id').references((): AnyPgColumn => assetFolders.id),
    name: text('name').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('asset_folders_user_parent_name_unique')
      .on(table.userId, table.parentFolderId, table.name)
      .nullsNotDistinct(),
  ],
);

export const assets = pgTable(
  'assets',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    productId: uuid('product_id').references(() => products.id),
    folderId: uuid('folder_id').references(() => assetFolders.id),
    displayName: text('display_name').default('未命名素材').notNull(),
    storageChannelId: uuid('storage_channel_id').references(() => storageChannels.id),
    storageKey: text('storage_key').notNull(),
    thumbnailKey: text('thumbnail_key'),
    contentHash: text('content_hash'),
    fileSizeBytes: bigint('file_size_bytes', { mode: 'bigint' }).notNull(),
    mimeType: text('mime_type'),
    metaJson: jsonb('meta_json').default({}).notNull(),
    kind: assetKindEnum('kind').notNull(),
    origin: assetOriginEnum('origin').notNull(),
    sourceArtifactId: uuid('source_artifact_id').references((): AnyPgColumn => artifacts.id),
    status: assetStatusEnum('status').default('uploading').notNull(),
    processingRevision: integer('processing_revision').default(1).notNull(),
    processingErrorCode: text('processing_error_code'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('assets_storage_key_idx').on(table.storageKey),
    index('assets_user_product_created_idx').on(table.userId, table.productId, table.createdAt),
    index('assets_user_folder_created_idx').on(table.userId, table.folderId, table.createdAt),
    index('assets_user_status_created_idx').on(table.userId, table.status, table.createdAt),
    uniqueIndex('assets_user_source_artifact_active_unique')
      .on(table.userId, table.sourceArtifactId)
      .where(sql`${table.sourceArtifactId} is not null and ${table.deletedAt} is null`),
    check('assets_file_size_nonnegative', sql`${table.fileSizeBytes} >= 0`),
    check('assets_processing_revision_positive', sql`${table.processingRevision} > 0`),
    check(
      'assets_deleted_pair',
      sql`(${table.status} = 'deleted') = (${table.deletedAt} is not null)`,
    ),
    check(
      'assets_ready_fields',
      sql`${table.status} <> 'ready' or (${table.contentHash} is not null and ${table.mimeType} is not null and ${table.thumbnailKey} is not null)`,
    ),
    check(
      'assets_origin_shape',
      sql`(${table.kind} = 'upload' and ${table.origin} = 'upload' and ${table.sourceArtifactId} is null) or (${table.kind} = 'generated' and ${table.origin} in ('creative_artifact','commerce_artifact') and ${table.sourceArtifactId} is not null) or ${table.kind} = 'imported'`,
    ),
  ],
);

export const assetUploadIntents = pgTable(
  'asset_upload_intents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id),
    storageChannelId: uuid('storage_channel_id').references(() => storageChannels.id),
    status: assetUploadStatusEnum('status').default('pending').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    responseJson: jsonb('response_json').notNull(),
    declaredMimeType: text('declared_mime_type').notNull(),
    maxSizeBytes: bigint('max_size_bytes', { mode: 'bigint' }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('asset_upload_intents_user_key_unique').on(table.userId, table.idempotencyKey),
    uniqueIndex('asset_upload_intents_asset_unique').on(table.assetId),
    index('asset_upload_intents_status_expires_idx').on(table.status, table.expiresAt),
    check('asset_upload_intents_max_size_positive', sql`${table.maxSizeBytes} > 0`),
    check(
      'asset_upload_intents_completed_pair',
      sql`(${table.status} = 'completed') = (${table.completedAt} is not null)`,
    ),
  ],
);

export const resourceWriteRequests = pgTable(
  'resource_write_requests',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    operation: text('operation').notNull(),
    idempotencyKeyHash: text('idempotency_key_hash').notNull(),
    requestHash: text('request_hash').notNull(),
    status: text('status').default('completed').notNull(),
    responseStatus: integer('response_status'),
    responseJson: jsonb('response_json'),
    createdAt: createdAt(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('resource_write_requests_user_operation_key_unique').on(
      table.userId,
      table.operation,
      table.idempotencyKeyHash,
    ),
    index('resource_write_requests_user_created_idx').on(table.userId, table.createdAt),
    check('resource_write_requests_status_allowed', sql`${table.status} in ('completed')`),
    check(
      'resource_write_requests_completed_fields',
      sql`${table.status} <> 'completed' or (${table.responseStatus} is not null and ${table.responseJson} is not null and ${table.completedAt} is not null)`,
    ),
  ],
);

export const productFactSets = pgTable(
  'product_fact_sets',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    productId: uuid('product_id').references(() => products.id),
    versionNo: integer('version_no').default(1).notNull(),
    sourceAssetId: uuid('source_asset_id')
      .notNull()
      .references(() => assets.id),
    factsJson: jsonb('facts_json').notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    confirmedBy: uuid('confirmed_by')
      .notNull()
      .references(() => users.id),
    sourceVersion: text('source_version').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index('product_fact_sets_product_created_idx').on(table.productId, table.createdAt),
    uniqueIndex('product_fact_sets_product_version_unique').on(table.productId, table.versionNo),
    check('product_fact_sets_version_positive', sql`${table.versionNo} > 0`),
  ],
);

export const artifacts = pgTable(
  'artifacts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    productId: uuid('product_id').references(() => products.id),
    type: artifactTypeEnum('type').notNull(),
    storageChannelId: uuid('storage_channel_id').references(() => storageChannels.id),
    storageKey: text('storage_key').notNull(),
    contentHash: text('content_hash'),
    publishedStorageKey: text('published_storage_key'),
    publishedContentHash: text('published_content_hash'),
    publicationSnapshot: jsonb('publication_snapshot'),
    publicationRevision: integer('publication_revision').default(1).notNull(),
    thumbnailKey: text('thumbnail_key'),
    metaJson: jsonb('meta_json').notNull(),
    paramsSnapshot: jsonb('params_snapshot').notNull(),
    sourceArtifactId: uuid('source_artifact_id').references((): AnyPgColumn => artifacts.id),
    sourceAction: sourceActionEnum('source_action').notNull(),
    canvasNodeId: uuid('canvas_node_id'),
    originDomain: originDomainEnum('origin_domain').notNull(),
    producerMode: producerModeEnum('producer_mode').notNull(),
    producerSessionId: uuid('producer_session_id').references(() => chatSessions.id),
    mutationOwner: mutationOwnerEnum('mutation_owner').notNull(),
    visibility: artifactVisibilityEnum('visibility').default('quarantined').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index('artifacts_task_idx').on(table.taskId),
    index('artifacts_user_product_created_idx').on(table.userId, table.productId, table.createdAt),
    index('artifacts_user_created_idx').on(table.userId, table.createdAt),
    index('artifacts_storage_key_idx').on(table.storageKey),
    uniqueIndex('artifacts_published_storage_key_unique')
      .on(table.publishedStorageKey)
      .where(sql`${table.publishedStorageKey} is not null`),
    check('artifacts_publication_revision_positive', sql`${table.publicationRevision} > 0`),
    check(
      'artifacts_publication_fields_complete',
      sql`(${table.publishedStorageKey} is null and ${table.publishedContentHash} is null and ${table.publicationSnapshot} is null) or (${table.publishedStorageKey} is not null and ${table.publishedContentHash} is not null and ${table.publicationSnapshot} is not null)`,
    ),
    check(
      'artifacts_chat_producer_session_required',
      sql`(${table.producerMode} = 'chat') = (${table.producerSessionId} is not null)`,
    ),
  ],
);

export const artifactInputBindings = pgTable(
  'artifact_input_bindings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    artifactId: uuid('artifact_id')
      .notNull()
      .references(() => artifacts.id),
    sourceType: text('source_type').notNull(),
    sourceAssetId: uuid('source_asset_id').references(() => assets.id),
    sourceArtifactId: uuid('source_artifact_id').references(() => artifacts.id),
    sourceVersionOrHash: text('source_version_or_hash').notNull(),
    role: text('role').notNull(),
    transformSnapshotJson: jsonb('transform_snapshot_json'),
    sortOrder: integer('sort_order').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('artifact_input_bindings_artifact_order_unique').on(
      table.artifactId,
      table.sortOrder,
    ),
    index('artifact_input_bindings_asset_idx').on(table.sourceAssetId),
    index('artifact_input_bindings_source_artifact_idx').on(table.sourceArtifactId),
    check('artifact_input_bindings_order_nonnegative', sql`${table.sortOrder} >= 0`),
    check(
      'artifact_input_bindings_source_shape',
      sql`(${table.sourceType} = 'asset' and ${table.sourceAssetId} is not null and ${table.sourceArtifactId} is null) or (${table.sourceType} = 'artifact' and ${table.sourceAssetId} is null and ${table.sourceArtifactId} is not null)`,
    ),
  ],
);

export const artifactEvaluations = pgTable(
  'artifact_evaluations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    artifactId: uuid('artifact_id')
      .notNull()
      .references(() => artifacts.id),
    taskId: uuid('task_id').references(() => tasks.id),
    taskAttemptId: uuid('task_attempt_id').references(() => taskAttempts.id),
    modelSnapshotId: uuid('model_snapshot_id').references(() => models.id),
    evaluatorType: evaluatorTypeEnum('evaluator_type').notNull(),
    evaluatorVersion: text('evaluator_version').notNull(),
    operationKey: text('operation_key'),
    evidenceSnapshot: jsonb('evidence_snapshot').notNull(),
    findingsJson: jsonb('findings_json').notNull(),
    confidence: numeric('confidence', { mode: 'string', precision: 5, scale: 4 }),
    status: evaluationStatusEnum('status').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index('artifact_evaluations_artifact_created_idx').on(table.artifactId, table.createdAt),
    uniqueIndex('artifact_evaluations_operation_key_unique')
      .on(table.operationKey)
      .where(sql`${table.operationKey} is not null`),
    uniqueIndex('artifact_evaluations_attempt_unique')
      .on(table.taskAttemptId)
      .where(sql`${table.taskAttemptId} is not null`),
    uniqueIndex('artifact_evaluations_artifact_type_version_unique').on(
      table.artifactId,
      table.evaluatorType,
      table.evaluatorVersion,
    ),
    check(
      'artifact_evaluations_confidence_range',
      sql`${table.confidence} is null or (${table.confidence} >= 0 and ${table.confidence} <= 1)`,
    ),
    check(
      'artifact_evaluations_content_safety_shape',
      sql`${table.evaluatorType} <> 'content_safety' or (${table.taskId} is not null and ${table.taskAttemptId} is not null and ${table.modelSnapshotId} is not null and ${table.operationKey} is not null and ((${table.status} = 'unknown' and ${table.confidence} is null) or (${table.status} in ('pass','warning','blocked') and ${table.confidence} is not null)))`,
    ),
  ],
);

export const contentReviewCases = pgTable(
  'content_review_cases',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    artifactId: uuid('artifact_id')
      .notNull()
      .references(() => artifacts.id),
    evaluationId: uuid('evaluation_id')
      .notNull()
      .references(() => artifactEvaluations.id),
    status: contentReviewStatusEnum('status').default('pending').notNull(),
    deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),
    revision: integer('revision').default(1).notNull(),
    decision: contentReviewDecisionEnum('decision'),
    decisionSummaryJson: jsonb('decision_summary_json'),
    decidedByAdminId: uuid('decided_by_admin_id').references(() => adminPrincipals.id),
    decisionReason: text('decision_reason'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('content_review_cases_evaluation_unique').on(table.evaluationId),
    index('content_review_cases_status_deadline_idx').on(table.status, table.deadlineAt, table.id),
    check('content_review_cases_revision_positive', sql`${table.revision} > 0`),
    check(
      'content_review_cases_decision_shape',
      sql`(${table.status} = 'pending' and ${table.decision} is null and ${table.decidedAt} is null and ${table.decidedByAdminId} is null) or (${table.status} = 'expired' and ${table.decision} is null and ${table.decidedAt} is not null and ${table.decidedByAdminId} is null) or (${table.status} = 'released' and ${table.decision} = 'release' and ${table.decidedAt} is not null and ${table.decidedByAdminId} is not null and ${table.decisionReason} is not null) or (${table.status} = 'rejected' and ${table.decision} = 'reject' and ${table.decidedAt} is not null and ${table.decidedByAdminId} is not null and ${table.decisionReason} is not null)`,
    ),
  ],
);

export const riskConfirmations = pgTable('risk_confirmations', {
  id: uuid('id').defaultRandom().primaryKey(),
  artifactId: uuid('artifact_id')
    .notNull()
    .references(() => artifacts.id),
  evaluationId: uuid('evaluation_id')
    .notNull()
    .references(() => artifactEvaluations.id),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  decision: riskDecisionEnum('decision').notNull(),
  evidenceSnapshot: jsonb('evidence_snapshot').notNull(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }).notNull(),
});

export const shares = pgTable(
  'shares',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    artifactId: uuid('artifact_id')
      .notNull()
      .references(() => artifacts.id),
    slug: text('slug').notNull(),
    allowRemix: boolean('allow_remix').default(false).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    viewCount: integer('view_count').default(0).notNull(),
    convertCount: integer('convert_count').default(0).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('shares_slug_unique').on(table.slug),
    check('shares_counts_nonnegative', sql`${table.viewCount} >= 0 and ${table.convertCount} >= 0`),
  ],
);

export const shareReports = pgTable(
  'share_reports',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    shareId: uuid('share_id')
      .notNull()
      .references(() => shares.id),
    reporterUserId: uuid('reporter_user_id').references(() => users.id),
    reason: shareReportReasonEnum('reason').notNull(),
    description: text('description'),
    status: shareReportStatusEnum('status').default('open').notNull(),
    ipHash: text('ip_hash').notNull(),
    decidedBy: uuid('decided_by').references(() => users.id),
    decisionNote: text('decision_note'),
    createdAt: createdAt(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (table) => [
    index('share_reports_status_created_idx').on(table.status, table.createdAt),
    index('share_reports_share_created_idx').on(table.shareId, table.createdAt),
  ],
);

export const agentTurns = pgTable(
  'agent_turns',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => chatSessions.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    status: agentTurnStatusEnum('status').default('received_user_input').notNull(),
    // NOT NULL placeholder only. Every new turn writes 'transcript_v1' explicitly (S08 §17) and
    // the worker fail-closes on legacy formats; 'legacy_v1' exists solely on pre-S08 rows.
    // Never change this default without a forward migration.
    executionFormat: text('execution_format').default('legacy_v1').notNull(),
    transcriptCaptureVersion: integer('transcript_capture_version'),
    revision: integer('revision').default(1).notNull(),
    continuationNo: integer('continuation_no').default(1).notNull(),
    primarySkillId: text('primary_skill_id'),
    skillSelectionSnapshotJson: jsonb('skill_selection_snapshot_json'),
    skillSelectionSnapshotHash: text('skill_selection_snapshot_hash'),
    modelSelectionSnapshotJson: jsonb('model_selection_snapshot_json'),
    modelSelectionSnapshotHash: text('model_selection_snapshot_hash'),
    generationPreferencesJson: jsonb('generation_preferences_json'),
    generationPreferencesHash: text('generation_preferences_hash'),
    executionAuthorizationJson: jsonb('execution_authorization_json'),
    executionAuthorizationHash: text('execution_authorization_hash'),
    createIdempotencyKey: text('create_idempotency_key'),
    createRequestHash: text('create_request_hash'),
    createResponseJson: jsonb('create_response_json'),
    interruptIdempotencyKey: text('interrupt_idempotency_key'),
    interruptRequestHash: text('interrupt_request_hash'),
    interruptResponseJson: jsonb('interrupt_response_json'),
    contextSnapshotJson: jsonb('context_snapshot_json'),
    contextSnapshotHash: text('context_snapshot_hash'),
    processingOwner: text('processing_owner'),
    processingLeaseExpiresAt: timestamp('processing_lease_expires_at', { withTimezone: true }),
    runQuoteId: uuid('run_quote_id').references(() => runQuotes.id),
    workflowRunId: uuid('workflow_run_id').references(() => workflowRuns.id),
    supersededByTurnId: uuid('superseded_by_turn_id').references((): AnyPgColumn => agentTurns.id),
    interruptedAt: timestamp('interrupted_at', { withTimezone: true }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    createdAt: createdAt(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (table) => [
    index('agent_turns_session_created_idx').on(table.sessionId, table.createdAt),
    uniqueIndex('agent_turns_id_user_session_unique').on(table.id, table.userId, table.sessionId),
    index('agent_turns_user_status_created_idx').on(table.userId, table.status, table.createdAt),
    uniqueIndex('agent_turns_run_quote_unique').on(table.runQuoteId),
    uniqueIndex('agent_turns_workflow_run_unique').on(table.workflowRunId),
    uniqueIndex('agent_turns_user_create_key_unique')
      .on(table.userId, table.createIdempotencyKey)
      .where(sql`${table.createIdempotencyKey} is not null`),
    uniqueIndex('agent_turns_user_interrupt_key_unique')
      .on(table.userId, table.interruptIdempotencyKey)
      .where(sql`${table.interruptIdempotencyKey} is not null`),
    uniqueIndex('agent_turns_session_active_unique')
      .on(table.sessionId)
      .where(
        sql`${table.workflowRunId} is null and ${table.status} not in ('done','blocked','failed','cancelled','superseded')`,
      ),
    check('agent_turns_revision_positive', sql`${table.revision} > 0`),
    check(
      'agent_turns_execution_format_valid',
      sql`${table.executionFormat} in ('legacy_v1','transcript_v1')
        and (${table.transcriptCaptureVersion} is null or ${table.transcriptCaptureVersion} = 1)
        and (${table.executionFormat} = 'legacy_v1' or ${table.transcriptCaptureVersion} is not distinct from 1)`,
    ),
    check('agent_turns_continuation_positive', sql`${table.continuationNo} > 0`),
    check(
      'agent_turns_processing_lease_pair',
      sql`(${table.processingOwner} is null) = (${table.processingLeaseExpiresAt} is null)`,
    ),
    check(
      'agent_turns_skill_selection_triplet',
      sql`(${table.primarySkillId} is null) = (${table.skillSelectionSnapshotJson} is null) and (${table.primarySkillId} is null) = (${table.skillSelectionSnapshotHash} is null)`,
    ),
    check(
      'agent_turns_model_selection_pair',
      sql`(${table.modelSelectionSnapshotJson} is null) = (${table.modelSelectionSnapshotHash} is null)`,
    ),
    check(
      'agent_turns_generation_preferences_pair',
      sql`(${table.generationPreferencesJson} is null) = (${table.generationPreferencesHash} is null)`,
    ),
    check(
      'agent_turns_execution_authorization_pair',
      sql`(${table.executionAuthorizationJson} is null) = (${table.executionAuthorizationHash} is null)`,
    ),
    check(
      'agent_turns_create_idempotency_triplet',
      sql`(${table.createIdempotencyKey} is null) = (${table.createRequestHash} is null) and (${table.createIdempotencyKey} is null) = (${table.createResponseJson} is null)`,
    ),
    check(
      'agent_turns_interrupt_idempotency_triplet',
      sql`(${table.interruptIdempotencyKey} is null) = (${table.interruptRequestHash} is null) and (${table.interruptIdempotencyKey} is null) = (${table.interruptResponseJson} is null)`,
    ),
    check(
      'agent_turns_context_pair',
      sql`(${table.contextSnapshotJson} is null) = (${table.contextSnapshotHash} is null)`,
    ),
  ],
);

export const contentSafetyPreflights = pgTable(
  'content_safety_preflights',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    turnId: uuid('turn_id')
      .notNull()
      .references(() => agentTurns.id),
    continuationNo: integer('continuation_no').notNull(),
    capability: moderationCapabilityEnum('capability').notNull(),
    checkNo: integer('check_no').notNull(),
    inputDigest: text('input_digest').notNull(),
    modelSnapshotId: uuid('model_snapshot_id')
      .notNull()
      .references(() => models.id),
    credentialVersionId: uuid('credential_version_id')
      .notNull()
      .references(() => providerCredentialVersions.id),
    runtimeRevision: integer('runtime_revision').notNull(),
    policyVersion: text('policy_version').notNull(),
    operationKey: text('operation_key').notNull(),
    status: contentSafetyPreflightStatusEnum('status').default('queued').notNull(),
    dispatchState: dispatchStateEnum('dispatch_state').default('not_dispatched').notNull(),
    reservedCostCny: money('reserved_cost_cny'),
    actualCostCny: money('actual_cost_cny'),
    evidenceSummaryJson: jsonb('evidence_summary_json'),
    revision: integer('revision').default(1).notNull(),
    processingOwner: text('processing_owner'),
    processingLeaseExpiresAt: timestamp('processing_lease_expires_at', { withTimezone: true }),
    createdAt: createdAt(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('content_safety_preflights_operation_unique').on(table.operationKey),
    uniqueIndex('content_safety_preflights_check_unique').on(
      table.turnId,
      table.continuationNo,
      table.capability,
      table.checkNo,
    ),
    index('content_safety_preflights_status_lease_idx').on(
      table.status,
      table.processingLeaseExpiresAt,
    ),
    check('content_safety_preflights_continuation_positive', sql`${table.continuationNo} > 0`),
    check('content_safety_preflights_check_nonnegative', sql`${table.checkNo} >= 0`),
    check('content_safety_preflights_runtime_revision_positive', sql`${table.runtimeRevision} > 0`),
    check('content_safety_preflights_revision_positive', sql`${table.revision} > 0`),
    check(
      'content_safety_preflights_reserved_cost_nonnegative',
      sql`${table.reservedCostCny} is null or ${table.reservedCostCny} >= 0`,
    ),
    check(
      'content_safety_preflights_actual_cost_nonnegative',
      sql`${table.actualCostCny} is null or ${table.actualCostCny} >= 0`,
    ),
    check(
      'content_safety_preflights_owner_lease_pair',
      sql`(${table.processingOwner} is null) = (${table.processingLeaseExpiresAt} is null)`,
    ),
    check(
      'content_safety_preflights_running_owner',
      sql`(${table.status} = 'running' and ${table.processingOwner} is not null) or (${table.status} <> 'running' and ${table.processingOwner} is null)`,
    ),
  ],
);

export const agentTurnConfirmations = pgTable(
  'agent_turn_confirmations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    turnId: uuid('turn_id')
      .notNull()
      .references(() => agentTurns.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    confirmationNo: integer('confirmation_no').notNull(),
    type: agentConfirmationTypeEnum('type').notNull(),
    status: agentConfirmationStatusEnum('status').default('pending').notNull(),
    answerSchemaVersion: integer('answer_schema_version').notNull(),
    publicPayloadJson: jsonb('public_payload_json').notNull(),
    payloadDigest: text('payload_digest').notNull(),
    answerJson: jsonb('answer_json'),
    idempotencyKey: text('idempotency_key'),
    requestHash: text('request_hash'),
    responseJson: jsonb('response_json'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('agent_turn_confirmations_turn_no_unique').on(table.turnId, table.confirmationNo),
    uniqueIndex('agent_turn_confirmations_user_key_unique')
      .on(table.userId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    index('agent_turn_confirmations_status_expires_idx').on(table.status, table.expiresAt),
    index('agent_turn_confirmations_turn_created_idx').on(table.turnId, table.createdAt),
    check('agent_turn_confirmations_no_positive', sql`${table.confirmationNo} > 0`),
    check('agent_turn_confirmations_schema_positive', sql`${table.answerSchemaVersion} > 0`),
    check(
      'agent_turn_confirmations_answered_fields',
      sql`(${table.status} = 'answered' and ${table.answerJson} is not null and ${table.idempotencyKey} is not null and ${table.requestHash} is not null and ${table.responseJson} is not null and ${table.answeredAt} is not null) or (${table.status} <> 'answered' and ${table.answerJson} is null and ${table.idempotencyKey} is null and ${table.requestHash} is null and ${table.responseJson} is null and ${table.answeredAt} is null)`,
    ),
  ],
);

export const chatMessages = pgTable(
  'chat_messages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => chatSessions.id),
    role: chatMessageRoleEnum('role').notNull(),
    content: text('content').notNull(),
    turnId: uuid('turn_id').references(() => agentTurns.id),
    attachments: jsonb('attachments').default([]).notNull(),
    toolCalls: jsonb('tool_calls').default([]).notNull(),
    skillSnapshots: jsonb('skill_snapshots').default([]).notNull(),
    pendingApproval: jsonb('pending_approval').default({}).notNull(),
    createdAt: createdAt(),
  },
  (table) => [index('chat_messages_session_created_idx').on(table.sessionId, table.createdAt)],
);

export const agentTraces = pgTable(
  'agent_traces',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    turnId: uuid('turn_id')
      .notNull()
      .references(() => agentTurns.id),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => chatSessions.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    brainModelId: text('brain_model_id').notNull(),
    brainModelSnapshotId: uuid('brain_model_snapshot_id').references(() => models.id),
    brainModelSnapshotJson: jsonb('brain_model_snapshot_json'),
    skillIds: jsonb('skill_ids').default([]).notNull(),
    status: agentTraceStatusEnum('status').default('running').notNull(),
    inputTokenTotal: integer('input_token_total').default(0).notNull(),
    outputTokenTotal: integer('output_token_total').default(0).notNull(),
    estimatedCost: money('estimated_cost').default('0.00').notNull(),
    reservedCost: money('reserved_cost').default('0.00').notNull(),
    loopGuardrailHit: text('loop_guardrail_hit'),
    createdAt: createdAt(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('agent_traces_turn_unique').on(table.turnId),
    index('agent_traces_user_created_idx').on(table.userId, table.createdAt),
    check(
      'agent_traces_usage_nonnegative',
      sql`${table.inputTokenTotal} >= 0 and ${table.outputTokenTotal} >= 0 and ${table.estimatedCost} >= 0 and ${table.reservedCost} >= 0`,
    ),
  ],
);

export const agentTraceSteps = pgTable(
  'agent_trace_steps',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    traceId: uuid('trace_id')
      .notNull()
      .references(() => agentTraces.id),
    stepNo: integer('step_no').notNull(),
    stepType: agentTraceStepTypeEnum('step_type').notNull(),
    actor: agentTraceActorEnum('actor').notNull(),
    skillId: text('skill_id'),
    toolName: text('tool_name'),
    callPositionKey: text('call_position_key'),
    toolFingerprint: text('tool_fingerprint'),
    operationKey: text('operation_key'),
    argsHash: text('args_hash'),
    inputSummary: jsonb('input_summary').notNull(),
    outputSummary: jsonb('output_summary').notNull(),
    status: agentTraceStepStatusEnum('status').notNull(),
    errorCode: text('error_code'),
    latencyMs: integer('latency_ms'),
    tokenUsageJson: jsonb('token_usage_json'),
    estimatedCost: money('estimated_cost'),
    modelSnapshotId: uuid('model_snapshot_id').references(() => models.id),
    modelSnapshotJson: jsonb('model_snapshot_json'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('agent_trace_steps_trace_step_unique').on(table.traceId, table.stepNo),
    uniqueIndex('agent_trace_steps_trace_position_unique')
      .on(table.traceId, table.callPositionKey)
      .where(sql`${table.callPositionKey} is not null`),
    index('agent_trace_steps_operation_key_idx').on(table.operationKey),
    index('agent_trace_steps_tool_args_created_idx').on(
      table.toolName,
      table.toolFingerprint,
      table.createdAt,
    ),
    index('agent_trace_steps_model_created_idx').on(table.modelSnapshotId, table.createdAt),
    check('agent_trace_steps_step_positive', sql`${table.stepNo} > 0`),
    check(
      'agent_trace_steps_latency_nonnegative',
      sql`${table.latencyMs} is null or ${table.latencyMs} >= 0`,
    ),
    check(
      'agent_trace_steps_cost_nonnegative',
      sql`${table.estimatedCost} is null or ${table.estimatedCost} >= 0`,
    ),
  ],
);

export const skillResourceSnapshots = pgTable(
  'skill_resource_snapshots',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    skillId: text('skill_id')
      .notNull()
      .references(() => skills.id),
    resourcePath: text('resource_path').notNull(),
    resourceType: skillResourceTypeEnum('resource_type').notNull(),
    contentHash: text('content_hash').notNull(),
    packageResourceId: uuid('package_resource_id').references(
      (): AnyPgColumn => skillPackageResources.id,
    ),
    contentText: text('content_text'),
    kvKey: text('kv_key').notNull(),
    summaryJson: jsonb('summary_json').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('skill_resource_snapshots_skill_path_unique').on(table.skillId, table.resourcePath),
  ],
);

export const creditAccounts = pgTable(
  'credit_accounts',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id),
    balance: money('balance').default('0.00').notNull(),
    frozen: money('frozen').default('0.00').notNull(),
    version: integer('version').default(0).notNull(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check('credit_accounts_nonnegative', sql`${table.balance} >= 0 and ${table.frozen} >= 0`),
    check('credit_accounts_version_nonnegative', sql`${table.version} >= 0`),
  ],
);

export const creditLedger = pgTable(
  'credit_ledger',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    type: ledgerTypeEnum('type').notNull(),
    amount: money('amount').notNull(),
    reservationId: uuid('reservation_id').references(() => creditReservations.id),
    workflowRunId: uuid('workflow_run_id').references(() => workflowRuns.id),
    taskId: uuid('task_id').references(() => tasks.id),
    appealId: uuid('appeal_id').references((): AnyPgColumn => appeals.id),
    idempotencyKey: text('idempotency_key').notNull(),
    accountVersion: integer('account_version'),
    balanceAfter: money('balance_after').notNull(),
    frozenAfter: money('frozen_after').notNull(),
    metadata: jsonb('metadata').default({}).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('credit_ledger_idempotency_key_unique').on(table.idempotencyKey),
    uniqueIndex('credit_ledger_user_account_version_unique')
      .on(table.userId, table.accountVersion)
      .where(sql`${table.accountVersion} is not null`),
    index('credit_ledger_user_created_idx').on(table.userId, table.createdAt),
    index('credit_ledger_workflow_run_idx').on(table.workflowRunId),
    check(
      'credit_ledger_snapshots_nonnegative',
      sql`${table.balanceAfter} >= 0 and ${table.frozenAfter} >= 0`,
    ),
    check(
      'credit_ledger_amount_direction',
      sql`(
        ${table.type} not in ('reservation_freeze', 'consume', 'expiry') or ${table.amount} < 0
      ) and (
        ${table.type} not in ('grant', 'release', 'appeal_refund') or ${table.amount} > 0
      ) and (
        ${table.type} <> 'manual_correction' or ${table.amount} <> 0
      )`,
    ),
  ],
);

export const appeals = pgTable(
  'appeals',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    ledgerId: uuid('ledger_id')
      .notNull()
      .references(() => creditLedger.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    reason: text('reason').notNull(),
    screenshots: jsonb('screenshots').default([]).notNull(),
    status: appealStatusEnum('status').default('pending').notNull(),
    refundAmount: money('refund_amount').default('0.00').notNull(),
    reviewerId: uuid('reviewer_id').references(() => users.id),
    reviewerAdminId: uuid('reviewer_admin_id').references(() => adminPrincipals.id),
    decisionReason: text('decision_reason'),
    decisionLedgerId: uuid('decision_ledger_id').references(() => creditLedger.id),
    revision: integer('revision').default(1).notNull(),
    decisionIdempotencyKeyHash: text('decision_idempotency_key_hash'),
    createdAt: createdAt(),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  },
  (table) => [
    index('appeals_user_created_idx').on(table.userId, table.createdAt),
    uniqueIndex('appeals_active_ledger_unique')
      .on(table.ledgerId)
      .where(sql`${table.status} = 'pending'`),
    uniqueIndex('appeals_decision_idempotency_unique')
      .on(table.decisionIdempotencyKeyHash)
      .where(sql`${table.decisionIdempotencyKeyHash} is not null`),
    check('appeals_refund_nonnegative', sql`${table.refundAmount} >= 0`),
    check('appeals_revision_positive', sql`${table.revision} > 0`),
  ],
);

export const inviteCampaigns = pgTable(
  'invite_campaigns',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    campaignKey: text('campaign_key').notNull(),
    name: text('name').notNull(),
    status: inviteCampaignStatusEnum('status').default('draft').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    issuanceLimit: integer('issuance_limit').notNull(),
    issuedCount: integer('issued_count').default(0).notNull(),
    defaultMaxUses: integer('default_max_uses').notNull(),
    defaultValiditySeconds: integer('default_validity_seconds'),
    emailConstraintJson: jsonb('email_constraint_json').default({}).notNull(),
    rewardCampaignId: uuid('reward_campaign_id').references(() => rewardCampaigns.id),
    internalNote: text('internal_note'),
    revision: integer('revision').default(1).notNull(),
    createdByAdminId: uuid('created_by_admin_id').references(() => adminPrincipals.id),
    createdAt: createdAt(),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('invite_campaigns_key_unique').on(table.campaignKey),
    index('invite_campaigns_status_window_idx').on(table.status, table.startsAt, table.expiresAt),
    check('invite_campaigns_issuance_limit_positive', sql`${table.issuanceLimit} > 0`),
    check(
      'invite_campaigns_issued_count_bounds',
      sql`${table.issuedCount} >= 0 and ${table.issuedCount} <= ${table.issuanceLimit}`,
    ),
    check('invite_campaigns_default_max_uses_positive', sql`${table.defaultMaxUses} > 0`),
    check('invite_campaigns_revision_positive', sql`${table.revision} > 0`),
  ],
);

export const inviteCodeBatches = pgTable(
  'invite_code_batches',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => inviteCampaigns.id),
    count: integer('count').notNull(),
    settingsSnapshotJson: jsonb('settings_snapshot_json').notNull(),
    settingsDigest: text('settings_digest').notNull(),
    createdByAdminId: uuid('created_by_admin_id').references(() => adminPrincipals.id),
    createdAt: createdAt(),
  },
  (table) => [
    index('invite_code_batches_campaign_created_idx').on(table.campaignId, table.createdAt),
    check('invite_code_batches_count_positive', sql`${table.count} > 0`),
  ],
);

export const inviteCodes = pgTable(
  'invite_codes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    campaignId: uuid('campaign_id').references(() => inviteCampaigns.id),
    batchId: uuid('batch_id').references(() => inviteCodeBatches.id),
    legacyCode: text('code'),
    codeDigest: text('code_digest'),
    keyId: text('key_id'),
    codePrefix: text('code_prefix'),
    codeCiphertext: text('code_ciphertext'),
    codeNonce: text('code_nonce'),
    codeAuthTag: text('code_auth_tag'),
    codeEncryptionKeyId: text('code_encryption_key_id'),
    emailAllowlist: jsonb('email_allowlist').default([]).notNull(),
    maxUses: integer('max_uses').notNull(),
    usedCount: integer('used_count').default(0).notNull(),
    issuedBy: uuid('issued_by').references(() => users.id),
    issuedByAdminId: uuid('issued_by_admin_id').references(() => adminPrincipals.id),
    revision: integer('revision').default(1).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('invite_codes_code_unique').on(table.legacyCode),
    uniqueIndex('invite_codes_key_digest_unique')
      .on(table.keyId, table.codeDigest)
      .where(sql`${table.keyId} is not null and ${table.codeDigest} is not null`),
    check(
      'invite_codes_digest_key_together',
      sql`(${table.codeDigest} is null) = (${table.keyId} is null)`,
    ),
    check(
      'invite_codes_legacy_or_digest_required',
      sql`${table.legacyCode} is not null or ${table.codeDigest} is not null`,
    ),
    check(
      'invite_codes_encryption_fields_together',
      sql`num_nonnulls(${table.codeCiphertext}, ${table.codeNonce}, ${table.codeAuthTag}, ${table.codeEncryptionKeyId}) in (0, 4)`,
    ),
    check(
      'invite_codes_usage_bounds',
      sql`${table.maxUses} > 0 and ${table.usedCount} >= 0 and ${table.usedCount} <= ${table.maxUses}`,
    ),
    check('invite_codes_revision_positive', sql`${table.revision} > 0`),
    index('invite_codes_campaign_created_idx').on(table.campaignId, table.createdAt),
  ],
);

export const inviteCodeRedemptions = pgTable(
  'invite_code_redemptions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    inviteCodeId: uuid('invite_code_id')
      .notNull()
      .references(() => inviteCodes.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }).notNull(),
    ledgerId: uuid('ledger_id').references(() => creditLedger.id),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('invite_code_redemptions_code_user_unique').on(table.inviteCodeId, table.userId),
  ],
);

export const referrals = pgTable(
  'referrals',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    inviterId: uuid('inviter_id')
      .notNull()
      .references(() => users.id),
    inviteeId: uuid('invitee_id')
      .notNull()
      .references(() => users.id),
    inviteCodeId: uuid('invite_code_id').references(() => inviteCodes.id),
    rewardStatus: referralRewardStatusEnum('reward_status').default('pending').notNull(),
    fraudFlag: boolean('fraud_flag').default(false).notNull(),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex('referrals_invitee_unique').on(table.inviteeId)],
);

export const skillPackages = pgTable(
  'skill_packages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    packageId: text('package_id'),
    packageVersion: text('package_version'),
    packageDigest: text('package_digest'),
    archiveSha256: text('archive_sha256'),
    manifestJson: jsonb('manifest_json'),
    status: skillPackageStatusEnum('status').default('quarantined').notNull(),
    riskStatus: skillPackageRiskStatusEnum('risk_status').default('clear').notNull(),
    revision: integer('revision').default(1).notNull(),
    sourceType: text('source_type').notNull(),
    sourceLocatorDigest: text('source_locator_digest'),
    sourceCommit: text('source_commit'),
    licenseSummaryJson: jsonb('license_summary_json'),
    quarantineStorageKey: text('quarantine_storage_key').notNull(),
    uploadExpiresAt: timestamp('upload_expires_at', { withTimezone: true }).notNull(),
    uploadedBy: text('uploaded_by'),
    latestValidationReportId: uuid('latest_validation_report_id').references(
      (): AnyPgColumn => skillPackageValidationReports.id,
    ),
    approvedValidationReportId: uuid('approved_validation_report_id').references(
      (): AnyPgColumn => skillPackageValidationReports.id,
    ),
    approvedBy: text('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    riskReviewDueAt: timestamp('risk_review_due_at', { withTimezone: true }),
    riskBlockedAt: timestamp('risk_blocked_at', { withTimezone: true }),
    disabledBy: text('disabled_by'),
    disabledReason: text('disabled_reason'),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('skill_packages_identity_unique')
      .on(table.packageId, table.packageVersion)
      .where(sql`${table.packageId} is not null and ${table.packageVersion} is not null`),
    index('skill_packages_status_created_idx').on(table.status, table.createdAt),
    index('skill_packages_risk_due_idx').on(table.riskStatus, table.riskReviewDueAt),
    check('skill_packages_revision_positive', sql`${table.revision} > 0`),
    check(
      'skill_packages_identity_pair',
      sql`(${table.packageId} is null) = (${table.packageVersion} is null)`,
    ),
  ],
);

export const skillPackageResources = pgTable(
  'skill_package_resources',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    packageRecordId: uuid('package_record_id')
      .notNull()
      .references(() => skillPackages.id),
    resourcePath: text('resource_path').notNull(),
    resourceType: text('resource_type').notNull(),
    mediaType: text('media_type').notNull(),
    byteSize: integer('byte_size').notNull(),
    contentHash: text('content_hash').notNull(),
    storageKey: text('storage_key').notNull(),
    skillId: text('skill_id'),
    rightsMetadataJson: jsonb('rights_metadata_json').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('skill_package_resources_path_unique').on(
      table.packageRecordId,
      table.resourcePath,
    ),
    index('skill_package_resources_hash_idx').on(table.contentHash),
    check('skill_package_resources_size_positive', sql`${table.byteSize} > 0`),
  ],
);

export const skillPackageValidationReports = pgTable(
  'skill_package_validation_reports',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    packageRecordId: uuid('package_record_id')
      .notNull()
      .references(() => skillPackages.id),
    packageRevision: integer('package_revision').notNull(),
    packageDigest: text('package_digest').notNull(),
    attemptNo: integer('attempt_no').notNull(),
    status: skillPackageValidationStatusEnum('status').default('queued').notNull(),
    revision: integer('revision').default(1).notNull(),
    validatorContractVersion: text('validator_contract_version').notNull(),
    platformEvalSuiteDigest: text('platform_eval_suite_digest').notNull(),
    reportJson: jsonb('report_json'),
    reportDigest: text('report_digest'),
    queueIntentId: uuid('queue_intent_id').references((): AnyPgColumn => queueDispatchIntents.id),
    processingOwner: text('processing_owner'),
    processingLeaseExpiresAt: timestamp('processing_lease_expires_at', { withTimezone: true }),
    lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('skill_package_validation_attempt_unique').on(
      table.packageRecordId,
      table.attemptNo,
    ),
    uniqueIndex('skill_package_validation_digest_unique')
      .on(table.packageRecordId, table.reportDigest)
      .where(sql`${table.reportDigest} is not null`),
    uniqueIndex('skill_package_validation_intent_unique').on(table.queueIntentId),
    index('skill_package_validation_status_lease_idx').on(
      table.status,
      table.processingLeaseExpiresAt,
    ),
    index('skill_package_validation_package_created_idx').on(
      table.packageRecordId,
      table.createdAt,
    ),
    check('skill_package_validation_attempt_positive', sql`${table.attemptNo} > 0`),
    check('skill_package_validation_revision_positive', sql`${table.revision} > 0`),
    check('skill_package_validation_package_revision_positive', sql`${table.packageRevision} > 0`),
    check(
      'skill_package_validation_owner_lease_pair',
      sql`(${table.processingOwner} is null) = (${table.processingLeaseExpiresAt} is null)`,
    ),
    check(
      'skill_package_validation_running_owner',
      sql`(${table.status} = 'running' and ${table.processingOwner} is not null) or (${table.status} <> 'running' and ${table.processingOwner} is null)`,
    ),
    check(
      'skill_package_validation_terminal_report',
      sql`(${table.status} in ('passed','failed','cancelled') and ${table.reportJson} is not null and ${table.reportDigest} is not null and ${table.completedAt} is not null) or (${table.status} in ('queued','running') and ${table.reportJson} is null and ${table.reportDigest} is null and ${table.completedAt} is null)`,
    ),
  ],
);

export const skillCatalogReleases = pgTable(
  'skill_catalog_releases',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    releaseNo: integer('release_no').notNull(),
    status: skillCatalogReleaseStatusEnum('status').default('draft').notNull(),
    revision: integer('revision').default(1).notNull(),
    baseReleaseId: uuid('base_release_id').references((): AnyPgColumn => skillCatalogReleases.id),
    rollbackOfReleaseId: uuid('rollback_of_release_id').references(
      (): AnyPgColumn => skillCatalogReleases.id,
    ),
    releaseDigest: text('release_digest').notNull(),
    manifestJson: jsonb('manifest_json').notNull(),
    reason: text('reason').notNull(),
    createdBy: text('created_by'),
    approvedBy: text('approved_by'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('skill_catalog_releases_no_unique').on(table.releaseNo),
    uniqueIndex('skill_catalog_releases_digest_unique').on(table.releaseDigest),
    index('skill_catalog_releases_status_created_idx').on(table.status, table.createdAt),
    check('skill_catalog_releases_no_positive', sql`${table.releaseNo} > 0`),
    check('skill_catalog_releases_revision_positive', sql`${table.revision} > 0`),
  ],
);

export const skillCatalogState = pgTable('skill_catalog_state', {
  id: text('id').primaryKey(),
  activeReleaseId: uuid('active_release_id').references(() => skillCatalogReleases.id),
  revision: integer('revision').default(1).notNull(),
  updatedAt: updatedAt(),
});

export const adminAuditLogs = pgTable(
  'admin_audit_logs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    actorUserId: uuid('actor_user_id').references(() => users.id),
    actorAdminId: uuid('actor_admin_id').references(() => adminPrincipals.id),
    actorType: adminActorTypeEnum('actor_type'),
    adminSessionId: uuid('admin_session_id').references(() => adminSessions.id),
    permissionSnapshot: jsonb('permission_snapshot'),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: uuid('target_id'),
    beforeJson: jsonb('before_json'),
    afterJson: jsonb('after_json'),
    reason: text('reason'),
    requestId: text('request_id'),
    traceId: text('trace_id'),
    idempotencyKeyHash: text('idempotency_key_hash'),
    sourceIpHash: text('source_ip_hash'),
    userAgentHash: text('user_agent_hash'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    mfaLevel: text('mfa_level'),
    stepUpAt: timestamp('step_up_at', { withTimezone: true }),
    result: adminAuditResultEnum('result'),
    errorCode: text('error_code'),
    createdAt: createdAt(),
  },
  (table) => [
    index('admin_audit_logs_actor_created_idx').on(table.actorUserId, table.createdAt),
    index('admin_audit_logs_admin_actor_created_idx').on(table.actorAdminId, table.createdAt),
  ],
);

export const userActivityLogs = pgTable(
  'user_activity_logs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').references(() => users.id),
    activityType: userActivityTypeEnum('activity_type').notNull(),
    targetType: text('target_type'),
    targetId: uuid('target_id'),
    metadata: jsonb('metadata').default({}).notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (table) => [
    index('user_activity_logs_user_type_created_idx').on(
      table.userId,
      table.activityType,
      table.createdAt,
    ),
  ],
);

export const eventOutbox = pgTable(
  'event_outbox',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    scopeType: text('scope_type').notNull(),
    scopeId: uuid('scope_id').notNull(),
    eventSeq: integer('event_seq').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    retentionTier: retentionTierEnum('retention_tier').default('normal').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('event_outbox_scope_sequence_unique').on(
      table.scopeType,
      table.scopeId,
      table.eventSeq,
    ),
    check('event_outbox_sequence_nonnegative', sql`${table.eventSeq} >= 0`),
  ],
);

export const queueDispatchIntents = pgTable(
  'queue_dispatch_intents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    queueName: text('queue_name').notNull(),
    jobId: text('job_id').notNull(),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    payloadVersion: integer('payload_version').notNull(),
    payload: jsonb('payload').notNull(),
    status: queueDispatchStatusEnum('status').default('pending').notNull(),
    revision: integer('revision').default(1).notNull(),
    attemptCount: integer('attempt_count').default(0).notNull(),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull(),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    lastErrorCode: text('last_error_code'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('queue_dispatch_intents_queue_job_unique').on(table.queueName, table.jobId),
    index('queue_dispatch_intents_status_next_attempt_idx').on(table.status, table.nextAttemptAt),
    index('queue_dispatch_intents_aggregate_idx').on(table.aggregateType, table.aggregateId),
    check('queue_dispatch_intents_payload_version_positive', sql`${table.payloadVersion} > 0`),
    check('queue_dispatch_intents_revision_positive', sql`${table.revision} > 0`),
    check('queue_dispatch_intents_attempt_nonnegative', sql`${table.attemptCount} >= 0`),
    check(
      'queue_dispatch_intents_lease_pair',
      sql`(${table.leaseOwner} is null) = (${table.leaseExpiresAt} is null)`,
    ),
  ],
);

export const mailDeliveries = pgTable(
  'mail_deliveries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').references(() => users.id),
    recipientHash: text('recipient_hash').notNull(),
    recipientHashKeyId: text('recipient_hash_key_id').notNull(),
    purpose: mailPurposeEnum('purpose').notNull(),
    provider: text('provider').notNull(),
    providerMessageId: text('provider_message_id'),
    status: mailDeliveryStatusEnum('status').default('queued').notNull(),
    attemptCount: integer('attempt_count').default(0).notNull(),
    lastErrorCode: text('last_error_code'),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('mail_deliveries_idempotency_key_unique').on(table.idempotencyKey),
    index('mail_deliveries_status_updated_idx').on(table.status, table.updatedAt),
    index('mail_deliveries_provider_status_created_idx').on(
      table.provider,
      table.status,
      table.createdAt,
    ),
    check(
      'mail_deliveries_provider_allowed',
      sql`${table.provider} in ('fake', 'console', 'smtp', 'tencent_ses')`,
    ),
    check('mail_deliveries_attempt_nonnegative', sql`${table.attemptCount} >= 0`),
  ],
);

export const workerHeartbeats = pgTable(
  'worker_heartbeats',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workerType: text('worker_type').notNull(),
    status: workerStatusEnum('status').default('healthy').notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
    metadata: jsonb('metadata').default({}).notNull(),
  },
  (table) => [index('worker_heartbeats_type_seen_idx').on(table.workerType, table.lastSeenAt)],
);

export const memberships = pgTable('memberships', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id),
  tier: membershipTierEnum('tier').default('free').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  monthlyCreditPolicy: jsonb('monthly_credit_policy').default({}).notNull(),
  source: membershipSourceEnum('source').default('system_grant').notNull(),
  grantedBy: uuid('granted_by').references(() => users.id),
  updatedAt: updatedAt(),
});

export const canvases = pgTable(
  'canvases',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    title: text('title').notNull(),
    graphJson: jsonb('graph_json').notNull(),
    thumbnailKey: text('thumbnail_key'),
    updatedAt: updatedAt(),
  },
  (table) => [index('canvases_user_updated_idx').on(table.userId, table.updatedAt)],
);

export const nodeVersions = pgTable(
  'node_versions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    canvasId: uuid('canvas_id')
      .notNull()
      .references(() => canvases.id),
    nodeId: uuid('node_id').notNull(),
    versionNo: integer('version_no').notNull(),
    artifactId: uuid('artifact_id').references(() => artifacts.id),
    paramsSnapshot: jsonb('params_snapshot').notNull(),
    sourceAction: sourceActionEnum('source_action').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('node_versions_canvas_node_version_unique').on(
      table.canvasId,
      table.nodeId,
      table.versionNo,
    ),
    check('node_versions_version_positive', sql`${table.versionNo} > 0`),
  ],
);

export const templates = pgTable(
  'templates',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    type: templateTypeEnum('type').notNull(),
    version: text('version').notNull(),
    definitionSnapshot: jsonb('definition_snapshot').notNull(),
    cover: text('cover'),
    category: text('category').notNull(),
    unlockType: templateUnlockTypeEnum('unlock_type').default('free').notNull(),
    price: money('price').default('0.00').notNull(),
    stats: jsonb('stats').default({}).notNull(),
    createdAt: createdAt(),
  },
  (table) => [check('templates_price_nonnegative', sql`${table.price} >= 0`)],
);

export const templateUnlocks = pgTable(
  'template_unlocks',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    templateId: uuid('template_id')
      .notNull()
      .references(() => templates.id),
    unlockedAt: timestamp('unlocked_at', { withTimezone: true }).notNull(),
    ledgerId: uuid('ledger_id').references(() => creditLedger.id),
  },
  (table) => [primaryKey({ columns: [table.userId, table.templateId] })],
);

export const platformSpecRules = pgTable(
  'platform_spec_rules',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    platform: text('platform').notNull(),
    country: text('country').notNull(),
    imageType: text('image_type').notNull(),
    rulesJson: jsonb('rules_json').notNull(),
    source: text('source').notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    version: text('version').notNull(),
    status: platformRuleStatusEnum('status').default('draft').notNull(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('platform_spec_rules_version_unique').on(
      table.platform,
      table.country,
      table.imageType,
      table.version,
    ),
  ],
);

export const assetEmbeddings = pgTable(
  'asset_embeddings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id),
    embeddingModel: text('embedding_model').notNull(),
    vector: jsonb('vector').notNull(),
    status: assetEmbeddingStatusEnum('status').default('draft').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('asset_embeddings_asset_model_unique').on(table.assetId, table.embeddingModel),
  ],
);

export const userPreferences = pgTable(
  'user_preferences',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    preferenceKey: text('preference_key').notNull(),
    preferenceValue: jsonb('preference_value').notNull(),
    source: text('source').notNull(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('user_preferences_user_key_unique').on(table.userId, table.preferenceKey),
  ],
);

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull(),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [index('notifications_user_created_idx').on(table.userId, table.createdAt)],
);
