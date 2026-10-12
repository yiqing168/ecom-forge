type EnumValue<T extends readonly string[]> = T[number];

export const TRIGGER_MODES = ['chat', 'canvas', 'suite'] as const;
export type TriggerMode = EnumValue<typeof TRIGGER_MODES>;

export const PRODUCER_MODES = ['chat', 'canvas', 'suite'] as const;
export type ProducerMode = EnumValue<typeof PRODUCER_MODES>;

export const MUTATION_OWNERS = ['chat_session', 'canvas', 'suite'] as const;
export type MutationOwner = EnumValue<typeof MUTATION_OWNERS>;

export const ORIGIN_DOMAINS = ['creative', 'commerce'] as const;
export type OriginDomain = EnumValue<typeof ORIGIN_DOMAINS>;

export const WORKFLOW_RUN_STATUSES = [
  'reserved',
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelling',
  'cancelled',
  'refunding',
  'refunded',
  'disputed',
] as const;
export type WorkflowRunStatus = EnumValue<typeof WORKFLOW_RUN_STATUSES>;

export const TASK_STATUSES = [
  'pending',
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'blocked',
  'waiting_manual_review',
] as const;
export type TaskStatus = EnumValue<typeof TASK_STATUSES>;

export const TASK_ATTEMPT_STATUSES = [
  'created',
  'dispatching',
  'accepted',
  'polling',
  'succeeded',
  'failed',
  'timeout',
  'outcome_unknown',
] as const;
export type TaskAttemptStatus = EnumValue<typeof TASK_ATTEMPT_STATUSES>;

export const DISPATCH_STATES = ['not_dispatched', 'accepted', 'outcome_unknown'] as const;
export type DispatchState = EnumValue<typeof DISPATCH_STATES>;

export const RESERVATION_STATUSES = [
  'created',
  'frozen',
  'partially_settled',
  'settled',
  'releasing',
  'released',
  'correction_required',
] as const;
export type ReservationStatus = EnumValue<typeof RESERVATION_STATUSES>;

export const LEDGER_TYPES = [
  'grant',
  'reservation_freeze',
  'consume',
  'release',
  'appeal_refund',
  'manual_correction',
  'expiry',
] as const;
export type LedgerType = EnumValue<typeof LEDGER_TYPES>;

export const ARTIFACT_VISIBILITIES = [
  'private',
  'shared',
  'public',
  'quarantined',
  'deleted',
] as const;
export type ArtifactVisibility = EnumValue<typeof ARTIFACT_VISIBILITIES>;

export const EVALUATION_STATUSES = ['pass', 'warning', 'unknown', 'blocked'] as const;
export type EvaluationStatus = EnumValue<typeof EVALUATION_STATUSES>;

export const MODERATION_CAPABILITIES = ['moderation.text', 'moderation.image'] as const;
export type ModerationCapability = EnumValue<typeof MODERATION_CAPABILITIES>;

export const CONTENT_SAFETY_PREFLIGHT_STATUSES = [
  'queued',
  'running',
  'passed',
  'blocked',
  'failed',
  'outcome_unknown',
  'cancelled',
] as const;
export type ContentSafetyPreflightStatus = EnumValue<typeof CONTENT_SAFETY_PREFLIGHT_STATUSES>;

export const CONTENT_REVIEW_STATUSES = ['pending', 'released', 'rejected', 'expired'] as const;
export type ContentReviewStatus = EnumValue<typeof CONTENT_REVIEW_STATUSES>;

export const CONTENT_REVIEW_DECISIONS = ['release', 'reject'] as const;
export type ContentReviewDecision = EnumValue<typeof CONTENT_REVIEW_DECISIONS>;

export const RISK_DECISIONS = ['confirmed', 'cancelled'] as const;
export type RiskDecision = EnumValue<typeof RISK_DECISIONS>;

export const SHARE_REPORT_STATUSES = ['open', 'reviewing', 'dismissed', 'actioned'] as const;
export type ShareReportStatus = EnumValue<typeof SHARE_REPORT_STATUSES>;

export const MEMBERSHIP_TIERS = ['free', 'pro', 'team'] as const;
export type MembershipTier = EnumValue<typeof MEMBERSHIP_TIERS>;

export const MEMBERSHIP_SOURCES = ['system_grant', 'admin_grant', 'purchase'] as const;
export type MembershipSource = EnumValue<typeof MEMBERSHIP_SOURCES>;

export const TEMPLATE_TYPES = ['recipe', 'canvas'] as const;
export type TemplateType = EnumValue<typeof TEMPLATE_TYPES>;

export const USER_ROLES = ['user', 'admin', 'operator'] as const;
export type UserRole = EnumValue<typeof USER_ROLES>;

export const USER_RISK_STATUSES = ['normal', 'frozen', 'limited'] as const;
export type UserRiskStatus = EnumValue<typeof USER_RISK_STATUSES>;

export const RUN_QUOTE_STATUSES = [
  'quoted',
  'submitted',
  'superseded',
  'cancelled',
  'expired',
] as const;
export type RunQuoteStatus = EnumValue<typeof RUN_QUOTE_STATUSES>;

export const RUN_QUOTE_SUBMISSION_MODES = ['auto_submit', 'confirmation_required'] as const;
export type RunQuoteSubmissionMode = EnumValue<typeof RUN_QUOTE_SUBMISSION_MODES>;

export const AGENT_TURN_STATUSES = [
  'received_user_input',
  'loading_context',
  'detecting_intent',
  'validating_context',
  'clarifying',
  'planning',
  'plan_ready',
  'waiting_user_confirmation',
  'run_quote_created',
  'waiting_provider_confirmation',
  'done',
  'blocked',
  'failed',
  'cancelled',
  'superseded',
] as const;
export type AgentTurnStatus = EnumValue<typeof AGENT_TURN_STATUSES>;

export const ARTIFACT_TYPES = ['image', 'video', 'text', 'package'] as const;
export type ArtifactType = EnumValue<typeof ARTIFACT_TYPES>;

export const SOURCE_ACTIONS = ['generate', 'edit', 'replace'] as const;
export type SourceAction = EnumValue<typeof SOURCE_ACTIONS>;

export const ASSET_KINDS = ['upload', 'generated', 'imported'] as const;
export type AssetKind = EnumValue<typeof ASSET_KINDS>;

export const ASSET_ORIGINS = ['upload', 'creative_artifact', 'commerce_artifact'] as const;
export type AssetOrigin = EnumValue<typeof ASSET_ORIGINS>;

export const ASSET_STATUSES = [
  'uploading',
  'processing',
  'ready',
  'processing_failed',
  'rejected',
  'deleted',
] as const;
export type AssetStatus = EnumValue<typeof ASSET_STATUSES>;

export const ASSET_UPLOAD_STATUSES = ['pending', 'completed', 'expired', 'rejected'] as const;
export type AssetUploadStatus = EnumValue<typeof ASSET_UPLOAD_STATUSES>;

export const PRODUCT_STATUSES = ['active', 'archived'] as const;
export type ProductStatus = EnumValue<typeof PRODUCT_STATUSES>;

export const EVALUATOR_TYPES = ['platform_spec', 'commerce_evidence', 'content_safety'] as const;
export type EvaluatorType = EnumValue<typeof EVALUATOR_TYPES>;

export const SHARE_REPORT_REASONS = [
  'infringement',
  'illegal',
  'sexual',
  'fraud',
  'privacy',
  'other',
] as const;
export type ShareReportReason = EnumValue<typeof SHARE_REPORT_REASONS>;

export const CHAT_MESSAGE_ROLES = ['user', 'assistant', 'system', 'tool'] as const;
export type ChatMessageRole = EnumValue<typeof CHAT_MESSAGE_ROLES>;

export const SKILL_STATUSES = ['draft', 'published', 'disabled', 'archived'] as const;
export type SkillStatus = EnumValue<typeof SKILL_STATUSES>;

export const MODEL_STATUSES = ['poc_passed', 'poc_failed', 'disabled', 'free_test_only'] as const;
export type ModelStatus = EnumValue<typeof MODEL_STATUSES>;

export const AGENT_TRACE_STATUSES = [
  'running',
  'succeeded',
  'failed',
  'blocked',
  'cancelled',
  'superseded',
] as const;
export type AgentTraceStatus = EnumValue<typeof AGENT_TRACE_STATUSES>;

export const AGENT_TRACE_STEP_TYPES = [
  'llm_call',
  'tool_call',
  'compiler_check',
  'guardrail',
  'observation',
  'interrupt',
] as const;
export type AgentTraceStepType = EnumValue<typeof AGENT_TRACE_STEP_TYPES>;

export const AGENT_TRACE_ACTORS = ['agent', 'compiler', 'tool', 'system', 'user'] as const;
export type AgentTraceActor = EnumValue<typeof AGENT_TRACE_ACTORS>;

export const AGENT_TRACE_STEP_STATUSES = ['started', 'succeeded', 'failed', 'blocked'] as const;
export type AgentTraceStepStatus = EnumValue<typeof AGENT_TRACE_STEP_STATUSES>;

export const SKILL_RESOURCE_TYPES = [
  'catalog',
  'planning_view',
  'preset',
  'reference',
  'eval_dataset',
] as const;
export type SkillResourceType = EnumValue<typeof SKILL_RESOURCE_TYPES>;

export const RETENTION_TIERS = ['critical', 'normal', 'debug'] as const;
export type RetentionTier = EnumValue<typeof RETENTION_TIERS>;

export const WORKER_STATUSES = ['healthy', 'draining', 'stopped'] as const;
export type WorkerStatus = EnumValue<typeof WORKER_STATUSES>;

export const APPEAL_STATUSES = ['pending', 'refunded', 'rejected'] as const;
export type AppealStatus = EnumValue<typeof APPEAL_STATUSES>;

export const USER_ACTIVITY_TYPES = [
  'login',
  'logout',
  'register',
  'email_verify',
  'password_reset',
  'registration_reward',
  'risk_block',
  'download',
  'share_view',
  'fact_confirm',
  'asset_upload',
  'asset_delete',
  'export',
] as const;
export type UserActivityType = EnumValue<typeof USER_ACTIVITY_TYPES>;

export const ASSET_EMBEDDING_STATUSES = ['draft', 'ready', 'disabled'] as const;
export type AssetEmbeddingStatus = EnumValue<typeof ASSET_EMBEDDING_STATUSES>;

export const REFERRAL_REWARD_STATUSES = ['pending', 'granted', 'rejected'] as const;
export type ReferralRewardStatus = EnumValue<typeof REFERRAL_REWARD_STATUSES>;

export const PLATFORM_RULE_STATUSES = ['draft', 'active', 'retired'] as const;
export type PlatformRuleStatus = EnumValue<typeof PLATFORM_RULE_STATUSES>;

export const TEMPLATE_UNLOCK_TYPES = ['free', 'credits', 'membership'] as const;
export type TemplateUnlockType = EnumValue<typeof TEMPLATE_UNLOCK_TYPES>;

export const REGISTRATION_CLAIM_STATUSES = [
  'pending',
  'verified',
  'redeemed',
  'released',
  'expired',
] as const;
export type RegistrationClaimStatus = EnumValue<typeof REGISTRATION_CLAIM_STATUSES>;

export const REGISTRATION_REWARD_DECISIONS = ['pending', 'granted', 'rejected'] as const;
export type RegistrationRewardDecision = EnumValue<typeof REGISTRATION_REWARD_DECISIONS>;

export const MAIL_DELIVERY_STATUSES = [
  'queued',
  'sent',
  'delivered',
  'bounced',
  'complained',
  'failed',
  'outcome_unknown',
] as const;
export type MailDeliveryStatus = EnumValue<typeof MAIL_DELIVERY_STATUSES>;

export const MAIL_PURPOSES = ['email_verification', 'password_reset'] as const;
export type MailPurpose = EnumValue<typeof MAIL_PURPOSES>;

export const MAIL_PROVIDERS = ['fake', 'console', 'smtp', 'tencent_ses'] as const;
export type MailProvider = EnumValue<typeof MAIL_PROVIDERS>;

export const QUEUE_DISPATCH_STATUSES = [
  'pending',
  'dispatching',
  'dispatched',
  'cancelled',
] as const;
export type QueueDispatchStatus = EnumValue<typeof QUEUE_DISPATCH_STATUSES>;

export const PROVIDER_CALLBACK_STATUSES = [
  'queued',
  'processing',
  'processed',
  'dead_letter',
] as const;
export type ProviderCallbackStatus = EnumValue<typeof PROVIDER_CALLBACK_STATUSES>;

export const PROVIDER_CIRCUIT_SCOPES = ['provider', 'model'] as const;
export type ProviderCircuitScope = EnumValue<typeof PROVIDER_CIRCUIT_SCOPES>;

export const PROVIDER_CIRCUIT_STATUSES = ['closed', 'open', 'half_open'] as const;
export type ProviderCircuitStatus = EnumValue<typeof PROVIDER_CIRCUIT_STATUSES>;

export const AGENT_CONFIRMATION_TYPES = ['clarification', 'product_facts', 'cost', 'risk'] as const;
export type AgentConfirmationType = EnumValue<typeof AGENT_CONFIRMATION_TYPES>;

export const AGENT_CONFIRMATION_STATUSES = [
  'pending',
  'answered',
  'expired',
  'superseded',
  'cancelled',
] as const;
export type AgentConfirmationStatus = EnumValue<typeof AGENT_CONFIRMATION_STATUSES>;

export const SKILL_KINDS = ['primary', 'auxiliary'] as const;
export type SkillKind = EnumValue<typeof SKILL_KINDS>;

export const SKILL_VISIBILITIES = ['public', 'internal'] as const;
export type SkillVisibility = EnumValue<typeof SKILL_VISIBILITIES>;

export const SKILL_PACKAGE_STATUSES = [
  'quarantined',
  'uploaded',
  'validating',
  'validation_failed',
  'ready_for_review',
  'approved',
  'disabled',
  'rejected',
] as const;
export type SkillPackageStatus = EnumValue<typeof SKILL_PACKAGE_STATUSES>;

export const SKILL_PACKAGE_VALIDATION_STATUSES = [
  'queued',
  'running',
  'passed',
  'failed',
  'cancelled',
] as const;
export type SkillPackageValidationStatus = EnumValue<typeof SKILL_PACKAGE_VALIDATION_STATUSES>;

export const SKILL_PACKAGE_RISK_STATUSES = ['clear', 'needs_review', 'critical'] as const;
export type SkillPackageRiskStatus = EnumValue<typeof SKILL_PACKAGE_RISK_STATUSES>;

export const SKILL_CATALOG_RELEASE_STATUSES = ['draft', 'published', 'retired'] as const;
export type SkillCatalogReleaseStatus = EnumValue<typeof SKILL_CATALOG_RELEASE_STATUSES>;

export const ADMIN_ACTOR_TYPES = ['admin_session', 'bootstrap_cli', 'system'] as const;
export type AdminActorType = EnumValue<typeof ADMIN_ACTOR_TYPES>;

export const ADMIN_AUDIT_RESULTS = ['succeeded', 'failed', 'blocked'] as const;
export type AdminAuditResult = EnumValue<typeof ADMIN_AUDIT_RESULTS>;

export const ADMIN_PRINCIPAL_STATUSES = ['pending_enrollment', 'active', 'disabled'] as const;
export type AdminPrincipalStatus = EnumValue<typeof ADMIN_PRINCIPAL_STATUSES>;

export const ADMIN_CREDENTIAL_TYPES = ['password', 'totp'] as const;
export type AdminCredentialType = EnumValue<typeof ADMIN_CREDENTIAL_TYPES>;

export const ADMIN_CREDENTIAL_STATUSES = ['pending', 'active', 'revoked'] as const;
export type AdminCredentialStatus = EnumValue<typeof ADMIN_CREDENTIAL_STATUSES>;

export const ADMIN_ENROLLMENT_TOKEN_STATUSES = [
  'issued',
  'claimed',
  'used',
  'revoked',
  'expired',
] as const;
export type AdminEnrollmentTokenStatus = EnumValue<typeof ADMIN_ENROLLMENT_TOKEN_STATUSES>;

export const ADMIN_AUTH_CHALLENGE_PURPOSES = [
  'enrollment_mfa',
  'login_mfa',
  'recovery_mfa',
  'step_up',
  'mfa_rotation',
] as const;
export type AdminAuthChallengePurpose = EnumValue<typeof ADMIN_AUTH_CHALLENGE_PURPOSES>;

export const ADMIN_AUTH_CHALLENGE_STATUSES = ['pending', 'consumed', 'expired', 'failed'] as const;
export type AdminAuthChallengeStatus = EnumValue<typeof ADMIN_AUTH_CHALLENGE_STATUSES>;

export const ADMIN_SESSION_STATUSES = ['active', 'revoked', 'expired'] as const;
export type AdminSessionStatus = EnumValue<typeof ADMIN_SESSION_STATUSES>;

export const MODEL_CATALOG_CATEGORIES = ['brain', 'image', 'video'] as const;
export type ModelCatalogCategory = EnumValue<typeof MODEL_CATALOG_CATEGORIES>;

export const MODEL_CATALOG_ENTRY_STATUSES = ['draft', 'approved', 'disabled'] as const;
export type ModelCatalogEntryStatus = EnumValue<typeof MODEL_CATALOG_ENTRY_STATUSES>;

export const BILLABLE_SKU_STATUSES = ['draft', 'approved', 'disabled'] as const;
export type BillableSkuStatus = EnumValue<typeof BILLABLE_SKU_STATUSES>;

export const PRICING_CATALOG_RELEASE_STATUSES = ['draft', 'published', 'retired'] as const;
export type PricingCatalogReleaseStatus = EnumValue<typeof PRICING_CATALOG_RELEASE_STATUSES>;

export const INVITE_CAMPAIGN_STATUSES = ['draft', 'active', 'closed'] as const;
export type InviteCampaignStatus = EnumValue<typeof INVITE_CAMPAIGN_STATUSES>;

export const REWARD_CAMPAIGN_STATUSES = ['draft', 'active', 'disabled'] as const;
export type RewardCampaignStatus = EnumValue<typeof REWARD_CAMPAIGN_STATUSES>;

export const REWARD_CAMPAIGN_KINDS = ['registration', 'invitation'] as const;
export type RewardCampaignKind = EnumValue<typeof REWARD_CAMPAIGN_KINDS>;
