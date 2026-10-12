import type {
  AgentBrainImageDetail,
  AgentBrainModelSnapshot,
  AgentBrainStepInput,
  LoopState,
  PersistedAgentTranscriptSummary,
} from '@ecom-forge/agent';
import type { Database } from '@ecom-forge/db';
import type { SessionCreativeDirectionSnapshot } from '@ecom-forge/shared';
import type { SkillSelectionSnapshot } from '@ecom-forge/skills';
import type {
  AgentModelSelectionSnapshot,
  AttachmentSnapshot,
  CompilerContext,
  ExecutionAuthorization,
} from '@ecom-forge/compiler';

import type { AgentBrainTranscriptMessage } from '@ecom-forge/agent';
import type { SessionImageCandidate } from './agent-session-image-candidate.service.js';
import type { NativeTranscriptPendingExecution } from './agent-transcript-recovery.js';
import type { AuthorizedAgentTranscriptItem } from './agent-transcript.repository.js';

export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type AgentWriteQuery = <T>(
  build: (transaction: Transaction) => PromiseLike<T>,
) => Promise<T>;
export type AgentReadQuery = <T>(build: () => PromiseLike<T>) => Promise<T>;

export interface ClaimedAgentTurn {
  turnId: string;
  sessionId: string;
  traceId: string;
  userMessageId: string;
  userId: string;
  continuationNo: number;
  revision: number;
  owner: string;
  message: string;
  attachments: AttachmentSnapshot[];
  sessionImageCandidates?: SessionImageCandidate[];
  sessionImageCandidatesUnavailable?: boolean;
  sessionSummaryVersion: number;
  /** Native (`transcript_v1`) strict v2 checkpoint reused from `chat_sessions.summary_json`. */
  transcriptSummary?: PersistedAgentTranscriptSummary;
  /** The ordered, already-authorized native window that backs `transcriptMessages`. */
  transcriptItems?: readonly AuthorizedAgentTranscriptItem[];
  selection: SkillSelectionSnapshot;
  selectionHash: string;
  effectiveSkillDefaultOutputCount?: number;
  requiredGenerationCapabilities: AgentBrainStepInput['skill_selection']['required_capabilities'];
  executionAuthorization: ExecutionAuthorization;
  executionAuthorizationHash: string;
  modelSelection?: AgentModelSelectionSnapshot;
  modelSelectionHash?: string;
  generationPreferences?: NonNullable<CompilerContext['generation_preferences']>;
  generationPreferencesHash?: string;
  sessionCreativeDirection?: SessionCreativeDirectionSnapshot;
  loopState: LoopState;
  observations: AgentBrainStepInput['observations'];
  materializedImageBindingKeys?: string[];
  materializedImageDetails?: Record<string, AgentBrainImageDetail>;
  inputTokenTotal: number;
  outputTokenTotal: number;
  contextInitialized: boolean;
  /** Frozen turn execution format read from the authenticated database turn; never from the job. */
  executionFormat?: string;
  transcriptCaptureVersion?: number | null;
  transcriptGeneration?: string;
  transcriptMessages?: AgentBrainTranscriptMessage[];
  pendingTranscriptExecution?: NativeTranscriptPendingExecution;
  isFirstSessionTurn: boolean;
  loadedResourceSnapshotIds: string[];
  publicTextRejections: number;
  consecutiveBrainDeliveryFailures: number;
  lastBrainCallOutcomeUnknown: boolean;
  lastBrainCallBudgetExceeded: boolean;
  modelSnapshot: AgentBrainModelSnapshot;
  authoringPlan?: Record<string, unknown>;
  authoringCompletedKeys?: string[];
}

export interface TraceStepInput {
  stepType: 'llm_call' | 'tool_call' | 'compiler_check' | 'guardrail' | 'observation';
  actor: 'agent' | 'compiler' | 'tool' | 'system';
  skillId?: string;
  toolName?: string;
  callPositionKey?: string;
  toolFingerprint?: string;
  argsHash?: string;
  inputSummary: Record<string, unknown>;
  outputSummary: Record<string, unknown>;
  status: 'started' | 'succeeded' | 'failed' | 'blocked';
  errorCode?: string;
  tokenUsageJson?: Record<string, unknown>;
  modelSnapshotJson?: AgentBrainModelSnapshot;
}
