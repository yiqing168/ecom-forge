export interface LoopBudget {
  maxRounds: number;
  maxToolCalls: number;
  maxSameFingerprintExecutions: number;
  maxNoProgress: number;
  maxSameError: number;
}

export interface LoopState {
  rounds: number;
  toolCalls: number;
  fingerprintExecutions: ReadonlyMap<string, number>;
  consecutiveNoProgress: number;
  consecutiveErrorKey?: string;
  consecutiveErrorCount: number;
  progressHash?: string;
}

export interface CompletedObservation {
  fingerprint: string;
  progressHash: string;
  errorKey?: string;
}

export interface PolicyObservation {
  progressHash: string;
  errorKey: string;
}

export type LoopGuardReason =
  'round_budget' | 'tool_budget' | 'repeated_tool_call' | 'no_progress' | 'repeated_error';

export function checkLoopGuard(
  state: LoopState,
  budget: LoopBudget,
  next?: { fingerprint?: string; errorKey?: string },
): LoopGuardReason | undefined {
  if (state.rounds >= budget.maxRounds) return 'round_budget';
  if (state.toolCalls >= budget.maxToolCalls) return 'tool_budget';
  if (
    next?.fingerprint &&
    (state.fingerprintExecutions.get(next.fingerprint) ?? 0) >= budget.maxSameFingerprintExecutions
  ) {
    return 'repeated_tool_call';
  }
  if (
    next?.errorKey &&
    state.consecutiveErrorKey === next.errorKey &&
    state.consecutiveErrorCount >= budget.maxSameError
  ) {
    return 'repeated_error';
  }
  if (state.consecutiveNoProgress >= budget.maxNoProgress) return 'no_progress';
  return undefined;
}

export function recordCompletedObservation(
  state: LoopState,
  observation: CompletedObservation,
): LoopState {
  const executions = new Map(state.fingerprintExecutions);
  executions.set(observation.fingerprint, (executions.get(observation.fingerprint) ?? 0) + 1);
  const nextState: LoopState = {
    ...state,
    toolCalls: state.toolCalls + 1,
    fingerprintExecutions: executions,
    consecutiveNoProgress:
      state.progressHash === observation.progressHash ? state.consecutiveNoProgress + 1 : 0,
    consecutiveErrorCount: observation.errorKey
      ? state.consecutiveErrorKey === observation.errorKey
        ? state.consecutiveErrorCount + 1
        : 1
      : 0,
    progressHash: observation.progressHash,
  };
  if (observation.errorKey) nextState.consecutiveErrorKey = observation.errorKey;
  else delete nextState.consecutiveErrorKey;
  return nextState;
}

export function recordPolicyObservation(
  state: LoopState,
  observation: PolicyObservation,
): LoopState {
  return {
    ...state,
    consecutiveNoProgress:
      state.progressHash === observation.progressHash ? state.consecutiveNoProgress + 1 : 0,
    consecutiveErrorKey: observation.errorKey,
    consecutiveErrorCount:
      state.consecutiveErrorKey === observation.errorKey ? state.consecutiveErrorCount + 1 : 1,
    progressHash: observation.progressHash,
  };
}
