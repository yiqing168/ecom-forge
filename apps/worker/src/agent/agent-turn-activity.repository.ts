import { type Database } from '@ecom-forge/db';

import { appendOutboxEventInTransaction } from '../database/outbox.repository.js';
import { lockOwnedTurn } from './agent-turn.repository-helpers.js';
import type { ClaimedAgentTurn } from './agent-turn.types.js';

export type AgentActivityType =
  'context_reading' | 'knowledge_loading' | 'plan_preparing' | 'safety_checking';

export type AgentContextActivitySummary = '正在理解你的需求' | '正在分析参考图片' | '正在继续思考';

export function contextActivitySummary(input: {
  completedBrainRounds: number;
  followsImageInspection: boolean;
}): AgentContextActivitySummary {
  if (input.followsImageInspection) return '正在分析参考图片';
  return input.completedBrainRounds === 0 ? '正在理解你的需求' : '正在继续思考';
}

type ActivityDescriptor =
  | {
      activityType: 'context_reading';
      displaySummary: AgentContextActivitySummary;
    }
  | {
      activityType: Exclude<AgentActivityType, 'context_reading'>;
      displaySummary?: never;
    };

const ACTIVITY_SUMMARIES: Record<Exclude<AgentActivityType, 'context_reading'>, string> = {
  knowledge_loading: '正在加载专业知识',
  plan_preparing: '正在准备方案',
  safety_checking: '正在检查安全与权限',
};

function displaySummaryFor(input: ActivityDescriptor): string {
  return input.activityType === 'context_reading'
    ? input.displaySummary
    : ACTIVITY_SUMMARIES[input.activityType];
}

export class AgentTurnActivityRepository {
  constructor(private readonly database: Database) {}

  async start(
    input: {
      claimed: ClaimedAgentTurn;
      revision: number;
      activityId: string;
    } & ActivityDescriptor,
  ): Promise<{ eventSeq: number } | null> {
    return this.database.transaction(async (transaction) => {
      const [turn] = await lockOwnedTurn(transaction, input.claimed, input.revision);
      if (!turn) return null;
      const event = await appendOutboxEventInTransaction(transaction, {
        scopeType: 'turn',
        scopeId: turn.id,
        eventType: 'turn.activity_started',
        payload: {
          turn_id: turn.id,
          agent_trace_id: input.claimed.traceId,
          activity_id: input.activityId,
          activity_type: input.activityType,
          display_summary: displaySummaryFor(input),
          status: 'started',
        },
      });
      return { eventSeq: event.eventSeq };
    });
  }

  async finish(
    input: {
      claimed: ClaimedAgentTurn;
      revision: number;
      activityId: string;
      status: 'succeeded' | 'failed' | 'blocked' | 'cancelled';
    } & ActivityDescriptor,
  ): Promise<{ eventSeq: number } | null> {
    return this.database.transaction(async (transaction) => {
      const [turn] = await lockOwnedTurn(transaction, input.claimed, input.revision);
      if (!turn) return null;
      const event = await appendOutboxEventInTransaction(transaction, {
        scopeType: 'turn',
        scopeId: turn.id,
        eventType: 'turn.activity_finished',
        payload: {
          turn_id: turn.id,
          agent_trace_id: input.claimed.traceId,
          activity_id: input.activityId,
          activity_type: input.activityType,
          display_summary: displaySummaryFor(input),
          status: input.status,
        },
      });
      return { eventSeq: event.eventSeq };
    });
  }
}
