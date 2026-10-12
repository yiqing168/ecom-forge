import type { AgentTranscriptItemContracts } from '@ecom-forge/agent';
import { inArray, skillResourceSnapshots, type Database } from '@ecom-forge/db';
import { utf8Sha256 } from '@ecom-forge/shared';
import { resolveBuiltinSkill } from '@ecom-forge/skills';
import { z } from 'zod';

import {
  AgentTranscriptReadError,
  AgentTranscriptRepository,
  type AuthorizedAgentTranscriptItem,
} from './agent-transcript.repository.js';
import { AgentTranscriptCoreSkillBinding } from './agent-transcript-skill-binding.js';
import {
  transcriptCoreSkillContextSchema,
  transcriptSkillDependencySchema,
  type TranscriptCoreSkillContext,
} from './agent-transcript-skill-context.js';

const coreContracts: AgentTranscriptItemContracts = {
  userMessage: { schema: z.never() },
  legacyMessage: { schema: z.never() },
  calls: [],
  hostContexts: [
    { name: 'core_skill_knowledge@1', content: { schema: transcriptCoreSkillContextSchema } },
  ],
  resourceDependencySchema: transcriptSkillDependencySchema,
};

export interface TranscriptCoreSkillKnowledge {
  readonly item_id: string;
  readonly sequence_no: string;
  readonly history_generation: string;
  readonly resources: readonly Readonly<
    TranscriptCoreSkillContext['resources'][number] & { content: string }
  >[];
}

/** No slug-based content substitution, Redis body cache or transcript copy of Skill text. */
export class AgentTranscriptCoreSkillReader {
  private readonly repository: AgentTranscriptRepository;

  constructor(private readonly database: Pick<Database, 'query' | 'select'>) {
    const binding = new AgentTranscriptCoreSkillBinding(database);
    this.repository = new AgentTranscriptRepository(database, {
      itemContracts: coreContracts,
      verifyHostContextSource: (item) => binding.verifySource(item),
      authorizeDependencies: ({ item }) => binding.authorizeDependencies(item),
    });
  }

  read(input: {
    userId: string;
    sessionId: string;
    itemId: string;
  }): Promise<TranscriptCoreSkillKnowledge> {
    return this.repository.readMaterializedItem(input, (item) => this.materialize(item));
  }

  private async materialize(
    initial: AuthorizedAgentTranscriptItem,
  ): Promise<TranscriptCoreSkillKnowledge> {
    const payload = initial.item.payload_json;
    if (payload.type !== 'host_context' || payload.content.type !== 'inline') fail();
    const context = transcriptCoreSkillContextSchema.parse(payload.content.value);
    return Object.freeze({
      item_id: initial.item.id,
      sequence_no: initial.item.sequence_no,
      history_generation: initial.history_generation,
      resources: await this.materializeResources(context.resources),
    });
  }

  /** Called inside the transcript repository's before/after authorization fence. */
  async materializeResources<
    T extends Omit<TranscriptCoreSkillContext['resources'][number], 'name'>,
  >(
    resources: readonly T[],
    omitSupersededBuiltin = false,
  ): Promise<readonly Readonly<T & { content: string }>[]> {
    const contents = new Map<string, string>();
    const externalIds = new Set<string>();
    for (const selected of resources) {
      const builtin = await resolveBuiltinSkill(selected.skill_id);
      if (!builtin) {
        externalIds.add(selected.resource_snapshot_id);
        continue;
      }
      const resource = builtin.resources.get(selected.resource_path);
      const content = builtin.resourceContent.get(selected.resource_path);
      if (
        builtin.skillId !== selected.skill_id ||
        builtin.definitionHash !== selected.definition_hash ||
        builtin.packageRecordId !== selected.package_record_id ||
        resource?.resource_snapshot_id !== selected.resource_snapshot_id ||
        resource?.package_resource_id !== selected.package_resource_id ||
        resource?.resource_hash !== selected.resource_hash
      ) {
        // The native reader already verified the old selection as historical evidence.
        if (omitSupersededBuiltin) continue;
        fail();
      }
      if (typeof content !== 'string' || utf8Sha256(content) !== selected.resource_hash) fail();
      contents.set(selected.resource_snapshot_id, content);
    }
    if (externalIds.size) {
      const rows = await this.database.query.skillResourceSnapshots.findMany({
        where: inArray(skillResourceSnapshots.id, [...externalIds]),
        columns: {
          id: true,
          skillId: true,
          packageResourceId: true,
          resourcePath: true,
          contentHash: true,
          contentText: true,
        },
      });
      const byId = new Map(rows.map((row) => [row.id, row]));
      for (const selected of resources) {
        if (!externalIds.has(selected.resource_snapshot_id)) continue;
        const row = byId.get(selected.resource_snapshot_id);
        if (
          !row ||
          row.skillId !== selected.skill_id ||
          row.packageResourceId !== selected.package_resource_id ||
          row.resourcePath !== selected.resource_path ||
          row.contentHash !== selected.resource_hash ||
          typeof row.contentText !== 'string' ||
          utf8Sha256(row.contentText) !== selected.resource_hash
        )
          fail();
        contents.set(selected.resource_snapshot_id, row.contentText);
      }
    }
    return Object.freeze(
      resources.flatMap((selected) => {
        const content = contents.get(selected.resource_snapshot_id);
        if (content === undefined && omitSupersededBuiltin) return [];
        if (content === undefined) fail();
        return [Object.freeze({ ...selected, content })];
      }),
    );
  }
}

function fail(): never {
  throw new AgentTranscriptReadError('payload_invalid');
}
