import type { Redis } from 'ioredis';

import { eq, skillResourceSnapshots, type Database } from '@ecom-forge/db';
import { canonicalSha256, utf8Sha256 } from '@ecom-forge/shared';
import type {
  AuxiliarySkillSelectionSnapshot,
  SkillResourceSelectionSnapshot,
  SkillSelectionSnapshot,
} from '@ecom-forge/skills';
import {
  assertSkillResourcePath,
  loadBuiltinResource,
  parseSkillAuthorMarkdown,
} from '@ecom-forge/skills';

export interface LoadedSkillResource {
  skillId: string;
  name: string;
  resource: SkillResourceSelectionSnapshot;
  content: string;
  tokenCount: number;
  alreadyLoaded: boolean;
}

export function resolveSkillDefaultOutputCount(
  snapshot: SkillSelectionSnapshot,
  loaded: readonly LoadedSkillResource[],
): number {
  const snapshotted = (snapshot as { default_output_count?: unknown }).default_output_count;
  if (isValidDefaultOutputCount(snapshotted)) return snapshotted;

  const planning = loaded.find(
    (item) =>
      item.skillId === snapshot.primary_skill_id && item.resource.resource_path === 'SKILL.md',
  );
  if (!planning) throw new Error('SKILL_DEFAULT_OUTPUT_COUNT_UNAVAILABLE');
  const parsed = parseSkillAuthorMarkdown(planning.content);
  if (parsed.frontmatterFormat !== 'legacy') {
    throw new Error('SKILL_DEFAULT_OUTPUT_COUNT_UNAVAILABLE');
  }
  const recovered = parsed.frontmatter.default_output_count;
  if (!isValidDefaultOutputCount(recovered)) {
    throw new Error('SKILL_DEFAULT_OUTPUT_COUNT_UNAVAILABLE');
  }
  return recovered;
}

function isValidDefaultOutputCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 16;
}

export class SkillRuntimeAdapter {
  private readonly loaded = new Map<string, LoadedSkillResource>();

  constructor(
    private readonly database: Database,
    private readonly redis: Redis,
    private readonly redisPrefix: string,
  ) {}

  async loadCore(snapshot: SkillSelectionSnapshot): Promise<LoadedSkillResource[]> {
    return Promise.all([
      this.loadResource(
        snapshot.primary_skill_id,
        snapshot.primary_name,
        snapshot.primary_planning_resource,
      ),
      ...snapshot.preset_selections.map((preset) =>
        this.loadResource(snapshot.primary_skill_id, preset.name, {
          resource_snapshot_id: preset.resource_snapshot_id,
          package_resource_id: preset.package_resource_id,
          resource_path: preset.resource_path,
          resource_hash: preset.resource_hash,
        }),
      ),
      ...snapshot.required_auxiliary.map((skill) => this.loadAuxiliarySnapshot(skill)),
    ]);
  }

  async restore(
    snapshot: SkillSelectionSnapshot,
    resourceSnapshotIds: readonly string[],
  ): Promise<LoadedSkillResource[]> {
    const allowed = this.allowedResources(snapshot);
    const uniqueIds = [...new Set(resourceSnapshotIds)];
    return Promise.all(
      uniqueIds.map((resourceId) => {
        const selected = allowed.get(resourceId);
        if (!selected) throw new Error('SKILL_VERSION_DRIFT');
        return this.loadResource(selected.skillId, selected.name, selected.resource);
      }),
    );
  }

  async loadPlanning(
    snapshot: SkillSelectionSnapshot,
    skillId: string,
  ): Promise<LoadedSkillResource[]> {
    if (skillId === snapshot.primary_skill_id) {
      throw new Error('AGENT_TOOL_NOT_ALLOWED');
    }
    if (!this.isPlanningLoaded(snapshot.primary_skill_id)) {
      throw new Error('AGENT_PRIMARY_SKILL_REQUIRED');
    }
    const allowed = snapshot.optional_auxiliary.find((skill) => skill.skill_id === skillId);
    if (!allowed) throw new Error('AGENT_TOOL_NOT_ALLOWED');
    return [await this.loadAuxiliarySnapshot(allowed)];
  }

  async loadReferences(
    snapshot: SkillSelectionSnapshot,
    skillId: string,
    referencePaths: string[],
  ): Promise<LoadedSkillResource[]> {
    if (referencePaths.length < 1 || referencePaths.length > 4) {
      throw new Error('SKILL_RESOURCE_LIMIT_EXCEEDED');
    }
    const uniquePaths = [...new Set(referencePaths)];
    if (uniquePaths.length !== referencePaths.length) throw new Error('AGENT_TOOL_NOT_ALLOWED');
    for (const path of uniquePaths) assertSkillResourcePath(path, 'reference');
    const selected = this.selectedSkill(snapshot, skillId);
    if (!selected || !this.isPlanningLoaded(skillId)) throw new Error('AGENT_TOOL_NOT_ALLOWED');
    return Promise.all(
      uniquePaths.map((path) => {
        const resource = selected.references.find((candidate) => candidate.resource_path === path);
        if (!resource) throw new Error('AGENT_TOOL_NOT_ALLOWED');
        return this.loadResource(skillId, selected.name, resource);
      }),
    );
  }

  private loadAuxiliarySnapshot(
    skill: AuxiliarySkillSelectionSnapshot,
  ): Promise<LoadedSkillResource> {
    return this.loadResource(skill.skill_id, skill.name, skill.planning_resource);
  }

  private allowedResources(
    snapshot: SkillSelectionSnapshot,
  ): Map<string, { skillId: string; name: string; resource: SkillResourceSelectionSnapshot }> {
    const entries: Array<{
      skillId: string;
      name: string;
      resource: SkillResourceSelectionSnapshot;
    }> = [
      {
        skillId: snapshot.primary_skill_id,
        name: snapshot.primary_name,
        resource: snapshot.primary_planning_resource,
      },
      ...snapshot.preset_selections.map((preset) => ({
        skillId: snapshot.primary_skill_id,
        name: preset.name,
        resource: {
          resource_snapshot_id: preset.resource_snapshot_id,
          package_resource_id: preset.package_resource_id,
          resource_path: preset.resource_path,
          resource_hash: preset.resource_hash,
        },
      })),
      ...(snapshot.primary_reference_resources ?? []).map((resource) => ({
        skillId: snapshot.primary_skill_id,
        name: snapshot.primary_name,
        resource,
      })),
      ...[...snapshot.required_auxiliary, ...snapshot.optional_auxiliary].flatMap((skill) => [
        { skillId: skill.skill_id, name: skill.name, resource: skill.planning_resource },
        ...(skill.reference_resources ?? []).map((resource) => ({
          skillId: skill.skill_id,
          name: skill.name,
          resource,
        })),
      ]),
    ];
    return new Map(entries.map((entry) => [entry.resource.resource_snapshot_id, entry]));
  }

  private selectedSkill(
    snapshot: SkillSelectionSnapshot,
    skillId: string,
  ): { name: string; references: SkillResourceSelectionSnapshot[] } | null {
    if (skillId === snapshot.primary_skill_id) {
      return {
        name: snapshot.primary_name,
        references: snapshot.primary_reference_resources ?? [],
      };
    }
    const auxiliary = [...snapshot.required_auxiliary, ...snapshot.optional_auxiliary].find(
      (skill) => skill.skill_id === skillId,
    );
    return auxiliary
      ? { name: auxiliary.name, references: auxiliary.reference_resources ?? [] }
      : null;
  }

  private isPlanningLoaded(skillId: string): boolean {
    return [...this.loaded.values()].some(
      (resource) => resource.skillId === skillId && resource.resource.resource_path === 'SKILL.md',
    );
  }

  private async loadResource(
    skillId: string,
    name: string,
    resource: SkillResourceSelectionSnapshot,
  ): Promise<LoadedSkillResource> {
    const builtin = await loadBuiltinResource(skillId, resource.resource_path);
    const effectiveResource = builtin?.resource ?? resource;
    const cacheKey = `${skillId}:${effectiveResource.resource_snapshot_id}:${effectiveResource.resource_hash}`;
    const existing = this.loaded.get(cacheKey);
    if (existing) return { ...existing, alreadyLoaded: true };
    let content: string | null = builtin?.content ?? null;
    const redisKey = `${this.redisPrefix}:skill:v1:${canonicalSha256(cacheKey)}`;
    if (!builtin) {
      try {
        content = await this.redis.get(redisKey);
        if (content && utf8Sha256(content) !== resource.resource_hash) content = null;
      } catch {
        content = null;
      }
    }
    if (!content) {
      const row = await this.database.query.skillResourceSnapshots.findFirst({
        where: eq(skillResourceSnapshots.id, resource.resource_snapshot_id),
      });
      if (
        !row ||
        row.skillId !== skillId ||
        row.packageResourceId !== resource.package_resource_id ||
        row.resourcePath !== resource.resource_path ||
        row.contentHash !== resource.resource_hash ||
        !row.contentText ||
        utf8Sha256(row.contentText) !== resource.resource_hash
      ) {
        throw new Error('SKILL_VERSION_DRIFT');
      }
      content = row.contentText;
      await this.redis.set(redisKey, content).catch(() => undefined);
    }
    const loaded: LoadedSkillResource = {
      skillId,
      name,
      resource: effectiveResource,
      content,
      tokenCount: Math.max(1, Math.ceil(content.length / 4)),
      alreadyLoaded: false,
    };
    this.loaded.set(cacheKey, loaded);
    return loaded;
  }
}
