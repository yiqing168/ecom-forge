export const AGENT_PACKAGE_NAME = '@ecom-forge/agent' as const;

export * from './brain-contract.js';
export {
  agentProductFactsSchema,
  agentClarificationPayloadSchema,
  agentClarificationAnswerSchema,
  agentProductFactsConfirmationPayloadSchema,
  agentCreateProductFactsAnswerSchema,
  agentLinkProductFactsAnswerSchema,
  normalizeProductFactList,
  normalizeAgentProductFacts,
} from './confirmation-contract.js';
export {
  agentConfirmationContextSchema,
  agentConfirmedFactDependencySchema,
  prepareAgentConfirmationContext,
  agentConfirmationDependencies,
} from './transcript-confirmation.js';
export type { AgentConfirmationContext } from './transcript-confirmation.js';
export * from './prompt-authoring.js';
export * from './task-budget.js';
export * from './loop-guard.js';
export * from './public-text-policy.js';
export * from './tool-contract.js';
export {
  loadSkillArgumentsSchema,
  inspectImageArgumentsSchema,
  refineLoadSkillViewPaths,
  type LoadSkillViewPathsValue,
} from './knowledge-tool-contract.js';
export {
  AgentTranscriptItemError,
  prepareAgentTranscriptDependencies,
  prepareAgentTranscriptItem,
  verifyAgentTranscriptItem,
} from './transcript-item.js';
export type {
  AgentTranscriptCall,
  AgentTranscriptCallContract,
  AgentTranscriptEnvelope,
  AgentTranscriptItem,
  AgentTranscriptItemContracts,
  AgentTranscriptItemFailure,
  AgentTranscriptResultStatus,
  AgentTranscriptValueContract,
  PreparedAgentTranscriptItem,
} from './transcript-item.js';
export { transcriptSequenceSchema } from './transcript-item.js';
export {
  AGENT_TRANSCRIPT_SUMMARY_PROJECTION_VERSION,
  agentTranscriptCompactionItemSchema,
  agentTranscriptSummarySourceItemSchema,
  assertTranscriptSummarySourceDigest,
  buildTranscriptSummarySourceDigest,
  persistedAgentTranscriptSummarySchema,
} from './transcript-summary.js';
export type {
  AgentTranscriptCompactionItem,
  AgentTranscriptSummarySourceItem,
  PersistedAgentTranscriptSummary,
  TranscriptSummaryCoverage,
} from './transcript-summary.js';
export {
  agentTranscriptWireCallId,
  validateAgentTranscriptProtocol,
} from './transcript-protocol.js';
export {
  AgentTranscriptPayloadError,
  parseAgentTranscriptPayloadReference,
  prepareAgentTranscriptPayload,
  verifyAgentTranscriptPayload,
} from './transcript-payload.js';
export type {
  AgentTranscriptPayloadContract,
  AgentTranscriptPayloadFailure,
  AgentTranscriptPayloadKind,
  AgentTranscriptPayloadRecord,
  AgentTranscriptPayloadReference,
  AgentTranscriptPayloadScope,
} from './transcript-payload.js';
export {
  crossUploadGroupScope,
  generationScopeDecisionSchema,
  imageSourceGroupSchema,
  validateGenerationScope,
} from './generation-scope.js';
export { agentProviderMetadataSchema, type AgentProviderMetadata } from './provider-metadata.js';
export * from './creative-direction.js';
