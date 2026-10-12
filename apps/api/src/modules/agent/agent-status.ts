import type { AgentTurnStatus } from '@ecom-forge/types';

export type AgentUserStatus = 'thinking' | 'waiting_for_you' | 'stopped' | 'completed' | 'failed';

export function agentUserStatus(status: AgentTurnStatus): AgentUserStatus {
  if (status === 'waiting_user_confirmation') return 'waiting_for_you';
  if (status === 'cancelled' || status === 'superseded') return 'stopped';
  if (status === 'done') return 'completed';
  if (status === 'blocked' || status === 'failed') return 'failed';
  return 'thinking';
}

export const TERMINAL_TURN_STATUSES: readonly AgentTurnStatus[] = [
  'done',
  'blocked',
  'failed',
  'cancelled',
  'superseded',
];
