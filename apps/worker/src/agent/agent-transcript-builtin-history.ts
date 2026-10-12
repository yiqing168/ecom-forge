import { agentTurns, and, eq, inArray, or, sql, type Database } from '@ecom-forge/db';
import { canonicalJson, canonicalSha256 } from '@ecom-forge/shared';
import { builtinUuid } from '@ecom-forge/skills';

import {
  transcriptSelectionSkillDependencies,
  type TranscriptSkillDependency,
} from './agent-transcript-skill-context.js';
import type { AgentReadQuery } from './agent-turn.types.js';

export interface TranscriptHistoryScope {
  userId: string;
  sessionId: string;
}

/** Historical evidence only: this never authorizes execution or substitutes a resource body. */
export async function authorizeHistoricalBuiltinDependency(
  database: Pick<Database, 'query'>,
  read: AgentReadQuery,
  scope: TranscriptHistoryScope,
  dependency: TranscriptSkillDependency,
): Promise<boolean> {
  // A former external package with the same slug must not acquire builtin history privileges.
  if (dependency.catalog_release_id !== builtinUuid(`catalog:${dependency.catalog_version}`))
    return false;
  const resource = {
    resource_snapshot_id: dependency.resource_snapshot_id,
    package_resource_id: dependency.package_resource_id,
    resource_path: dependency.resource_path,
    resource_hash: dependency.resource_hash,
  };
  const catalog = {
    catalog_release_id: dependency.catalog_release_id,
    catalog_version: dependency.catalog_version,
  };
  const primary = {
    primary_skill_id: dependency.skill_id,
    primary_definition_hash: dependency.definition_hash,
    primary_package_record_id: dependency.package_record_id,
  };
  const auxiliary = {
    skill_id: dependency.skill_id,
    definition_hash: dependency.definition_hash,
    package_record_id: dependency.package_record_id,
  };
  const candidates = [
    { ...primary, primary_planning_resource: resource },
    { ...primary, primary_reference_resources: [resource] },
    { ...primary, preset_selections: [resource] },
    ...['required_auxiliary', 'optional_auxiliary'].flatMap((key) => [
      { [key]: [{ ...auxiliary, planning_resource: resource }] },
      { [key]: [{ ...auxiliary, reference_resources: [resource] }] },
    ]),
  ];
  const rows = await read(() =>
    database.query.agentTurns.findMany({
      where: and(
        eq(agentTurns.userId, scope.userId),
        eq(agentTurns.sessionId, scope.sessionId),
        eq(agentTurns.executionFormat, 'transcript_v1'),
        inArray(agentTurns.status, ['done', 'blocked', 'failed', 'cancelled', 'superseded']),
        sql`${agentTurns.endedAt} is not null`,
        or(
          ...candidates.map(
            (candidate) =>
              sql`${agentTurns.skillSelectionSnapshotJson} @> ${canonicalJson({ ...catalog, ...candidate })}::jsonb`,
          ),
        ),
      ),
      columns: {
        userId: true,
        sessionId: true,
        status: true,
        endedAt: true,
        executionFormat: true,
        skillSelectionSnapshotJson: true,
        skillSelectionSnapshotHash: true,
      },
      limit: 1,
    }),
  );
  const source = rows[0];
  if (
    !source ||
    source.userId !== scope.userId ||
    source.sessionId !== scope.sessionId ||
    source.executionFormat !== 'transcript_v1' ||
    !source.endedAt ||
    !['done', 'blocked', 'failed', 'cancelled', 'superseded'].includes(source.status) ||
    canonicalSha256(source.skillSelectionSnapshotJson) !== source.skillSelectionSnapshotHash
  )
    return false;
  return transcriptSelectionSkillDependencies(source.skillSelectionSnapshotJson).some(
    (entry) => canonicalJson(entry) === canonicalJson(dependency),
  );
}
