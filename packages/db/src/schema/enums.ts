import {
  AGENT_TRACE_ACTORS,
  AGENT_TRACE_STATUSES,
  AGENT_TRACE_STEP_STATUSES,
  AGENT_TRACE_STEP_TYPES,
  AGENT_TURN_STATUSES,
  ADMIN_AUTH_CHALLENGE_PURPOSES,
  ADMIN_AUTH_CHALLENGE_STATUSES,
  ADMIN_ACTOR_TYPES,
  ADMIN_AUDIT_RESULTS,
  ADMIN_CREDENTIAL_STATUSES,
  ADMIN_CREDENTIAL_TYPES,
  ADMIN_ENROLLMENT_TOKEN_STATUSES,
  ADMIN_PRINCIPAL_STATUSES,
  ADMIN_SESSION_STATUSES,
  AGENT_CONFIRMATION_STATUSES,
  AGENT_CONFIRMATION_TYPES,
  APPEAL_STATUSES,
  ASSET_EMBEDDING_STATUSES,
  ARTIFACT_TYPES,
  ARTIFACT_VISIBILITIES,
  ASSET_KINDS,
  ASSET_ORIGINS,
  ASSET_STATUSES,
  ASSET_UPLOAD_STATUSES,
  CHAT_MESSAGE_ROLES,
  CONTENT_REVIEW_DECISIONS,
  CONTENT_REVIEW_STATUSES,
  CONTENT_SAFETY_PREFLIGHT_STATUSES,
  DISPATCH_STATES,
  EVALUATION_STATUSES,
  EVALUATOR_TYPES,
  LEDGER_TYPES,
  MAIL_DELIVERY_STATUSES,
  MAIL_PURPOSES,
  MEMBERSHIP_SOURCES,
  MEMBERSHIP_TIERS,
  MODEL_STATUSES,
  MODEL_CATALOG_CATEGORIES,
  MODEL_CATALOG_ENTRY_STATUSES,
  MODERATION_CAPABILITIES,
  MUTATION_OWNERS,
  ORIGIN_DOMAINS,
  PLATFORM_RULE_STATUSES,
  PRODUCER_MODES,
  PRODUCT_STATUSES,
  PROVIDER_CALLBACK_STATUSES,
  PROVIDER_CIRCUIT_SCOPES,
  PROVIDER_CIRCUIT_STATUSES,
  QUEUE_DISPATCH_STATUSES,
  REFERRAL_REWARD_STATUSES,
  REWARD_CAMPAIGN_KINDS,
  REWARD_CAMPAIGN_STATUSES,
  REGISTRATION_CLAIM_STATUSES,
  REGISTRATION_REWARD_DECISIONS,
  RESERVATION_STATUSES,
  RETENTION_TIERS,
  RISK_DECISIONS,
  RUN_QUOTE_STATUSES,
  RUN_QUOTE_SUBMISSION_MODES,
  SHARE_REPORT_REASONS,
  SHARE_REPORT_STATUSES,
  SKILL_RESOURCE_TYPES,
  SKILL_CATALOG_RELEASE_STATUSES,
  SKILL_KINDS,
  SKILL_PACKAGE_RISK_STATUSES,
  SKILL_PACKAGE_STATUSES,
  SKILL_PACKAGE_VALIDATION_STATUSES,
  SKILL_STATUSES,
  SKILL_VISIBILITIES,
  BILLABLE_SKU_STATUSES,
  PRICING_CATALOG_RELEASE_STATUSES,
  INVITE_CAMPAIGN_STATUSES,
  SOURCE_ACTIONS,
  TASK_ATTEMPT_STATUSES,
  TASK_STATUSES,
  TEMPLATE_TYPES,
  TEMPLATE_UNLOCK_TYPES,
  TRIGGER_MODES,
  USER_ACTIVITY_TYPES,
  USER_RISK_STATUSES,
  USER_ROLES,
  WORKER_STATUSES,
  WORKFLOW_RUN_STATUSES,
} from '@ecom-forge/types';
import { pgEnum } from 'drizzle-orm/pg-core';

export const triggerModeEnum = pgEnum('trigger_mode', TRIGGER_MODES);
export const producerModeEnum = pgEnum('producer_mode', PRODUCER_MODES);
export const mutationOwnerEnum = pgEnum('mutation_owner', MUTATION_OWNERS);
export const originDomainEnum = pgEnum('origin_domain', ORIGIN_DOMAINS);
export const workflowRunStatusEnum = pgEnum('workflow_run_status', WORKFLOW_RUN_STATUSES);
export const taskStatusEnum = pgEnum('task_status', TASK_STATUSES);
export const taskAttemptStatusEnum = pgEnum('task_attempt_status', TASK_ATTEMPT_STATUSES);
export const dispatchStateEnum = pgEnum('dispatch_state', DISPATCH_STATES);
export const reservationStatusEnum = pgEnum('reservation_status', RESERVATION_STATUSES);
export const ledgerTypeEnum = pgEnum('ledger_type', LEDGER_TYPES);
export const artifactVisibilityEnum = pgEnum('artifact_visibility', ARTIFACT_VISIBILITIES);
export const evaluationStatusEnum = pgEnum('evaluation_status', EVALUATION_STATUSES);
export const moderationCapabilityEnum = pgEnum('moderation_capability', MODERATION_CAPABILITIES);
export const contentSafetyPreflightStatusEnum = pgEnum(
  'content_safety_preflight_status',
  CONTENT_SAFETY_PREFLIGHT_STATUSES,
);
export const contentReviewStatusEnum = pgEnum('content_review_status', CONTENT_REVIEW_STATUSES);
export const contentReviewDecisionEnum = pgEnum(
  'content_review_decision',
  CONTENT_REVIEW_DECISIONS,
);
export const riskDecisionEnum = pgEnum('risk_decision', RISK_DECISIONS);
export const shareReportStatusEnum = pgEnum('share_report_status', SHARE_REPORT_STATUSES);
export const membershipTierEnum = pgEnum('membership_tier', MEMBERSHIP_TIERS);
export const membershipSourceEnum = pgEnum('membership_source', MEMBERSHIP_SOURCES);
export const templateTypeEnum = pgEnum('template_type', TEMPLATE_TYPES);
export const userRoleEnum = pgEnum('user_role', USER_ROLES);
export const userRiskStatusEnum = pgEnum('user_risk_status', USER_RISK_STATUSES);
export const runQuoteStatusEnum = pgEnum('run_quote_status', RUN_QUOTE_STATUSES);
export const runQuoteSubmissionModeEnum = pgEnum(
  'run_quote_submission_mode',
  RUN_QUOTE_SUBMISSION_MODES,
);
export const agentTurnStatusEnum = pgEnum('agent_turn_status', AGENT_TURN_STATUSES);
export const artifactTypeEnum = pgEnum('artifact_type', ARTIFACT_TYPES);
export const sourceActionEnum = pgEnum('source_action', SOURCE_ACTIONS);
export const assetKindEnum = pgEnum('asset_kind', ASSET_KINDS);
export const assetOriginEnum = pgEnum('asset_origin', ASSET_ORIGINS);
export const assetStatusEnum = pgEnum('asset_status', ASSET_STATUSES);
export const assetUploadStatusEnum = pgEnum('asset_upload_status', ASSET_UPLOAD_STATUSES);
export const productStatusEnum = pgEnum('product_status', PRODUCT_STATUSES);
export const evaluatorTypeEnum = pgEnum('evaluator_type', EVALUATOR_TYPES);
export const shareReportReasonEnum = pgEnum('share_report_reason', SHARE_REPORT_REASONS);
export const chatMessageRoleEnum = pgEnum('chat_message_role', CHAT_MESSAGE_ROLES);
export const skillStatusEnum = pgEnum('skill_status', SKILL_STATUSES);
export const modelStatusEnum = pgEnum('model_status', MODEL_STATUSES);
export const agentTraceStatusEnum = pgEnum('agent_trace_status', AGENT_TRACE_STATUSES);
export const agentTraceStepTypeEnum = pgEnum('agent_trace_step_type', AGENT_TRACE_STEP_TYPES);
export const agentTraceActorEnum = pgEnum('agent_trace_actor', AGENT_TRACE_ACTORS);
export const agentTraceStepStatusEnum = pgEnum(
  'agent_trace_step_status',
  AGENT_TRACE_STEP_STATUSES,
);
export const skillResourceTypeEnum = pgEnum('skill_resource_type', SKILL_RESOURCE_TYPES);
export const agentConfirmationTypeEnum = pgEnum(
  'agent_confirmation_type',
  AGENT_CONFIRMATION_TYPES,
);
export const agentConfirmationStatusEnum = pgEnum(
  'agent_confirmation_status',
  AGENT_CONFIRMATION_STATUSES,
);
export const skillKindEnum = pgEnum('skill_kind', SKILL_KINDS);
export const skillVisibilityEnum = pgEnum('skill_visibility', SKILL_VISIBILITIES);
export const skillPackageStatusEnum = pgEnum('skill_package_status', SKILL_PACKAGE_STATUSES);
export const skillPackageValidationStatusEnum = pgEnum(
  'skill_package_validation_status',
  SKILL_PACKAGE_VALIDATION_STATUSES,
);
export const skillPackageRiskStatusEnum = pgEnum(
  'skill_package_risk_status',
  SKILL_PACKAGE_RISK_STATUSES,
);
export const skillCatalogReleaseStatusEnum = pgEnum(
  'skill_catalog_release_status',
  SKILL_CATALOG_RELEASE_STATUSES,
);
export const adminActorTypeEnum = pgEnum('admin_actor_type', ADMIN_ACTOR_TYPES);
export const adminAuditResultEnum = pgEnum('admin_audit_result', ADMIN_AUDIT_RESULTS);
export const adminPrincipalStatusEnum = pgEnum('admin_principal_status', ADMIN_PRINCIPAL_STATUSES);
export const adminCredentialTypeEnum = pgEnum('admin_credential_type', ADMIN_CREDENTIAL_TYPES);
export const adminCredentialStatusEnum = pgEnum(
  'admin_credential_status',
  ADMIN_CREDENTIAL_STATUSES,
);
export const adminEnrollmentTokenStatusEnum = pgEnum(
  'admin_enrollment_token_status',
  ADMIN_ENROLLMENT_TOKEN_STATUSES,
);
export const adminAuthChallengePurposeEnum = pgEnum(
  'admin_auth_challenge_purpose',
  ADMIN_AUTH_CHALLENGE_PURPOSES,
);
export const adminAuthChallengeStatusEnum = pgEnum(
  'admin_auth_challenge_status',
  ADMIN_AUTH_CHALLENGE_STATUSES,
);
export const adminSessionStatusEnum = pgEnum('admin_session_status', ADMIN_SESSION_STATUSES);
export const modelCatalogCategoryEnum = pgEnum('model_catalog_category', MODEL_CATALOG_CATEGORIES);
export const modelCatalogEntryStatusEnum = pgEnum(
  'model_catalog_entry_status',
  MODEL_CATALOG_ENTRY_STATUSES,
);
export const billableSkuStatusEnum = pgEnum('billable_sku_status', BILLABLE_SKU_STATUSES);
export const pricingCatalogReleaseStatusEnum = pgEnum(
  'pricing_catalog_release_status',
  PRICING_CATALOG_RELEASE_STATUSES,
);
export const inviteCampaignStatusEnum = pgEnum('invite_campaign_status', INVITE_CAMPAIGN_STATUSES);
export const rewardCampaignStatusEnum = pgEnum('reward_campaign_status', REWARD_CAMPAIGN_STATUSES);
export const rewardCampaignKindEnum = pgEnum('reward_campaign_kind', REWARD_CAMPAIGN_KINDS);
export const retentionTierEnum = pgEnum('retention_tier', RETENTION_TIERS);
export const workerStatusEnum = pgEnum('worker_status', WORKER_STATUSES);
export const appealStatusEnum = pgEnum('appeal_status', APPEAL_STATUSES);
export const userActivityTypeEnum = pgEnum('user_activity_type', USER_ACTIVITY_TYPES);

export const assetEmbeddingStatusEnum = pgEnum('asset_embedding_status', ASSET_EMBEDDING_STATUSES);
export const referralRewardStatusEnum = pgEnum('referral_reward_status', REFERRAL_REWARD_STATUSES);
export const platformRuleStatusEnum = pgEnum('platform_rule_status', PLATFORM_RULE_STATUSES);
export const templateUnlockTypeEnum = pgEnum('template_unlock_type', TEMPLATE_UNLOCK_TYPES);
export const registrationClaimStatusEnum = pgEnum(
  'registration_claim_status',
  REGISTRATION_CLAIM_STATUSES,
);
export const registrationRewardDecisionEnum = pgEnum(
  'registration_reward_decision',
  REGISTRATION_REWARD_DECISIONS,
);
export const mailDeliveryStatusEnum = pgEnum('mail_delivery_status', MAIL_DELIVERY_STATUSES);
export const mailPurposeEnum = pgEnum('mail_purpose', MAIL_PURPOSES);
export const queueDispatchStatusEnum = pgEnum('queue_dispatch_status', QUEUE_DISPATCH_STATUSES);
export const providerCallbackStatusEnum = pgEnum(
  'provider_callback_status',
  PROVIDER_CALLBACK_STATUSES,
);
export const providerCircuitScopeEnum = pgEnum('provider_circuit_scope', PROVIDER_CIRCUIT_SCOPES);
export const providerCircuitStatusEnum = pgEnum(
  'provider_circuit_status',
  PROVIDER_CIRCUIT_STATUSES,
);
