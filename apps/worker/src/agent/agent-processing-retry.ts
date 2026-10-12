import { AgentBrainCallError } from '@ecom-forge/agent';

export class AgentPreflightPendingError extends Error {
  constructor(readonly retryAt?: Date) {
    super('CONTENT_SAFETY_PENDING');
  }
}

export class AgentPreflightNotDispatchedError extends Error {
  constructor() {
    super('CONTENT_SAFETY_UNAVAILABLE');
  }
}

export type AgentProcessingPhase =
  | 'claimed'
  | 'skill_core_load'
  | 'skill_context_restore'
  | 'skill_budget_check'
  | 'session_image_candidates_resolve'
  | 'image_context_resolve'
  | 'product_facts_resolve'
  | 'transcript_prelude'
  | 'session_memory_prepare'
  | 'context_snapshot_persist'
  | 'agent_loop';

const SAFE_PROCESSING_RETRY_PHASES = new Set<AgentProcessingPhase>([
  'skill_core_load',
  'skill_context_restore',
  'skill_budget_check',
  'session_image_candidates_resolve',
  'image_context_resolve',
  'product_facts_resolve',
  'transcript_prelude',
  'context_snapshot_persist',
]);

const RETRYABLE_NOT_DISPATCHED_CODES = new Set([
  'AGENT_BRAIN_CIRCUIT_OPEN',
  'AGENT_BRAIN_CIRCUIT_UNAVAILABLE',
  'AGENT_BRAIN_QUOTA_UNAVAILABLE',
  'AGENT_BRAIN_REQUEST_NOT_DISPATCHED',
  'AGENT_BRAIN_RUNTIME_BINDING_UNAVAILABLE',
]);

const TRANSIENT_ERROR_CODES = new Set([
  '40001',
  '40P01',
  '53300',
  '57P01',
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '08P01',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

export function isSafeAgentProcessingRetry(input: {
  error: unknown;
  phase: AgentProcessingPhase;
}): boolean {
  if (input.error instanceof AgentPreflightNotDispatchedError) return true;
  if (!SAFE_PROCESSING_RETRY_PHASES.has(input.phase)) return false;
  if (input.error instanceof AgentBrainCallError) return false;
  return hasTransientErrorCode(input.error);
}

export function isRetryableAgentBrainNotDispatched(errorCode: string): boolean {
  return RETRYABLE_NOT_DISPATCHED_CODES.has(errorCode);
}

export function agentRetryDelayMs(input: {
  attempt: number;
  baseMs: number;
  maxMs: number;
}): number {
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    throw new Error('AGENT_RETRY_ATTEMPT_INVALID');
  }
  if (!Number.isSafeInteger(input.baseMs) || input.baseMs < 0) {
    throw new Error('AGENT_RETRY_BASE_DELAY_INVALID');
  }
  if (!Number.isSafeInteger(input.maxMs) || input.maxMs < input.baseMs) {
    throw new Error('AGENT_RETRY_MAX_DELAY_INVALID');
  }
  return Math.min(input.maxMs, input.baseMs * 2 ** (input.attempt - 1));
}

export async function waitForAgentRetry(input: {
  delayMs: number;
  signal: AbortSignal;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}): Promise<void> {
  if (!Number.isSafeInteger(input.delayMs) || input.delayMs < 0) {
    throw new Error('AGENT_RETRY_DELAY_INVALID');
  }
  if (input.signal.aborted) return;
  const setTimeoutFn = input.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = input.clearTimeoutFn ?? clearTimeout;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeoutFn(timer);
      input.signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeoutFn(finish, input.delayMs);
    input.signal.addEventListener('abort', finish, { once: true });
  });
}

function hasTransientErrorCode(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; cause?: unknown; name?: unknown };
  const code = typeof candidate.code === 'string' ? candidate.code.toUpperCase() : undefined;
  if (code && TRANSIENT_ERROR_CODES.has(code)) return true;
  if (typeof candidate.name === 'string' && TRANSIENT_ERROR_CODES.has(candidate.name)) {
    return true;
  }
  return candidate.cause !== undefined && hasTransientErrorCode(candidate.cause);
}
