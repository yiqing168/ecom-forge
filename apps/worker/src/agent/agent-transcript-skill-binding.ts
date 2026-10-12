import type { AgentTranscriptItem } from '@ecom-forge/agent';
import { agentTurns, and, eq, users, type Database } from '@ecom-forge/db';
import { canonicalJson, canonicalSha256 } from '@ecom-forge/shared';

import {
  prepareTranscriptCoreSkillContext,
  transcriptCoreSkillContextSchema,
  transcriptCoreSkillDependencies,
} from './agent-transcript-skill-context.js';
import { AgentTranscriptSkillResources } from './agent-transcript-skill-resources.js';

/** Source binding only. Dynamic load_skill results must use their real call/result binding. */
export class AgentTranscriptCoreSkillBinding {
  private readonly resources: AgentTranscriptSkillResources;

  constructor(private readonly database: Pick<Database, 'query' | 'select'>) {
    this.resources = new AgentTranscriptSkillResources(database);
  }

  async verifySource(item: AgentTranscriptItem): Promise<boolean> {
    return (await this.readSource(item)) !== null;
  }

  async authorizeDependencies(
    item: AgentTranscriptItem,
    allowHistoricalBuiltin = false,
  ): Promise<boolean> {
    try {
      const context = await this.readSource(item);
      if (!context) return false;
      const dependencies = transcriptCoreSkillDependencies(context);
      if (
        canonicalJson(item.resource_dependencies_json.map(canonicalJson).sort()) !==
        canonicalJson(dependencies.map(canonicalJson).sort())
      )
        return false;
      const user = await this.database.query.users.findFirst({
        where: eq(users.id, item.user_id),
        columns: { id: true, riskStatus: true },
      });
      if (!user || user.id !== item.user_id || user.riskStatus !== 'normal') return false;
      return await this.resources.authorize(
        dependencies,
        allowHistoricalBuiltin ? { userId: item.user_id, sessionId: item.session_id } : undefined,
      );
    } catch {
      return false;
    }
  }

  private async readSource(item: AgentTranscriptItem) {
    try {
      const payload = item.payload_json;
      if (
        item.item_type !== 'host_context' ||
        payload.type !== 'host_context' ||
        payload.name !== 'core_skill_knowledge@1' ||
        payload.content.type !== 'inline' ||
        !item.turn_id ||
        !item.continuation_no ||
        item.import_attempt_id !== null ||
        item.source_message_id !== null ||
        item.source_trace_step_id !== null ||
        item.source_key !== `turn:${item.turn_id}:continuation:${item.continuation_no}:core-skill`
      )
        return null;
      const context = transcriptCoreSkillContextSchema.parse(payload.content.value);
      if (canonicalJson(context) !== canonicalJson(payload.content.value)) return null;
      const turn = await this.database.query.agentTurns.findFirst({
        where: and(
          eq(agentTurns.id, item.turn_id),
          eq(agentTurns.userId, item.user_id),
          eq(agentTurns.sessionId, item.session_id),
        ),
        columns: {
          id: true,
          userId: true,
          sessionId: true,
          continuationNo: true,
          primarySkillId: true,
          skillSelectionSnapshotJson: true,
          skillSelectionSnapshotHash: true,
        },
      });
      if (
        !turn ||
        turn.id !== item.turn_id ||
        turn.userId !== item.user_id ||
        turn.sessionId !== item.session_id ||
        turn.continuationNo < item.continuation_no ||
        turn.skillSelectionSnapshotHash !== context.selection_digest ||
        canonicalSha256(turn.skillSelectionSnapshotJson) !== context.selection_digest
      )
        return null;
      const expected = prepareTranscriptCoreSkillContext(turn.skillSelectionSnapshotJson);
      return turn.primarySkillId === expected.resources[0]!.skill_id &&
        canonicalJson(context) === canonicalJson(expected)
        ? expected
        : null;
    } catch {
      return null;
    }
  }
}
