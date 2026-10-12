export { authorizeBindings } from './authorization.js';
export {
  creativeConstraintsSnapshotSchema,
  creativeExecutionProfileSchema,
  creativeProfileRequiresDistinctPrompts,
  isCreativeProfilePrimarySkill,
  resolveCreativeExecutionProfile,
  S13A_CREATIVE_PROFILE_VERSION,
  validateCreativeExecutionProfile,
  validateSessionSourceDecision,
} from './creative-profiles.js';
export { CapabilityRegistry } from './capability-registry.js';
export {
  createImageCapabilityRegistry,
  imageEditCapabilityAdapter,
  imageGenerateCapabilityAdapter,
  S12_IMAGE_CAPABILITY_REGISTRY_VERSION,
} from './image-capabilities.js';
export { compilePlan } from './compile-plan.js';
export { buildApprovedImagePrompt, IMAGE_PROVIDER_WRAPPER } from './approved-image-prompt.js';
export type { ApprovedImagePromptInput } from './approved-image-prompt.js';
export { stableTopologicalSort } from './dag.js';
export {
  candidatePlanSchema,
  agentModelSelectionSnapshotSchema,
  attachmentSnapshotSchema,
  compilerContextSchema,
  executionAuthorizationSchema,
  generationPreferencesSchema,
  bindingRoleSchema,
  productFactsSnapshotSchema,
} from './schemas.js';
export type {
  BindingSnapshot,
  AttachmentSnapshot,
  AgentModelSelectionSnapshot,
  CandidatePlan,
  CapabilityAdapter,
  CapabilityRequirements,
  CompilePlanResult,
  CompiledPlan,
  CompilerContext,
  CompilerRejection,
  ExecutionAuthorization,
} from './types.js';
export type { CreativeExecutionProfile } from './creative-profiles.js';

export const COMPILER_PACKAGE_NAME = '@ecom-forge/compiler' as const;
export const COMPILER_VERSION = 's09-v1' as const;
