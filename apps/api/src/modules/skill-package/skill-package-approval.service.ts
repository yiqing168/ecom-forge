import {
  adminAuditLogs,
  and,
  eq,
  skillPackageResources,
  skillPackages,
  skillPackageValidationReports,
  skillResourceSnapshots,
  skills,
  sql,
  type Database,
} from '@ecom-forge/db';
import { canonicalSha256, scopedAdvisoryLockKey } from '@ecom-forge/shared';
import {
  parseSkillDefinition,
  parseSkillPackageManifest,
  validateSkillPackageContents,
  type SkillDefinition,
  type SkillPackageContentResource,
} from '@ecom-forge/skills';

import type { AppEnvironment } from '../../config/app-config.js';
import {
  isAuthorizedSkillPackageActor,
  skillPackageActorRef,
  skillPackageAuditActor,
  type SkillPackageActor,
} from './skill-package-actor.js';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface SkillPackageContentReader {
  read(storageKey: string, maxBytes: number): Promise<Uint8Array>;
}

export class MemorySkillPackageContentReader implements SkillPackageContentReader {
  constructor(private readonly resources: ReadonlyMap<string, Uint8Array>) {}

  read(storageKey: string, maxBytes: number): Promise<Uint8Array> {
    const content = this.resources.get(storageKey);
    if (!content || content.byteLength === 0 || content.byteLength > maxBytes) {
      return Promise.reject(new Error('SKILL_PACKAGE_RESOURCE_UNAVAILABLE'));
    }
    return Promise.resolve(content);
  }
}

export interface ApproveSkillPackageInput {
  packageRecordId: string;
  validationReportId: string;
  expectedPackageRevision: number;
  reason: string;
  actor: SkillPackageActor;
}

export class SkillPackageApprovalError extends Error {
  constructor(
    readonly code:
      | 'SKILL_PACKAGE_APPROVAL_FORBIDDEN'
      | 'SKILL_PACKAGE_APPROVAL_INVALID'
      | 'SKILL_PACKAGE_APPROVAL_CONFLICT'
      | 'SKILL_PACKAGE_VERSION_CONFLICT',
  ) {
    super(code);
    this.name = 'SkillPackageApprovalError';
  }
}

function assertActor(actor: SkillPackageActor, appEnv: AppEnvironment): void {
  if (!isAuthorizedSkillPackageActor(actor, appEnv)) {
    throw new SkillPackageApprovalError('SKILL_PACKAGE_APPROVAL_FORBIDDEN');
  }
}

function resourceLimit(mediaType: string): number {
  return mediaType.startsWith('image/') ? 16 * 1024 * 1024 : 1024 * 1024;
}

function runtimePath(definitionPath: string, packagePath: string): string {
  const root = definitionPath.slice(0, -'SKILL.md'.length);
  if (!packagePath.startsWith(root)) {
    throw new SkillPackageApprovalError('SKILL_PACKAGE_APPROVAL_INVALID');
  }
  return packagePath.slice(root.length);
}

function resourceType(path: string): 'planning_view' | 'preset' | 'reference' {
  if (path === 'SKILL.md') return 'planning_view';
  if (path.startsWith('presets/')) return 'preset';
  if (path.startsWith('references/')) return 'reference';
  throw new SkillPackageApprovalError('SKILL_PACKAGE_APPROVAL_INVALID');
}

export class SkillPackageApprovalService {
  constructor(
    private readonly database: Database,
    private readonly appEnv: AppEnvironment,
    private readonly reader: SkillPackageContentReader,
  ) {}

  async approve(input: ApproveSkillPackageInput): Promise<{
    packageRecordId: string;
    validationReportId: string;
    skillIds: string[];
    reused: boolean;
  }> {
    const snapshot = await this.prepareApproval(input);
    return this.database.transaction((transaction) =>
      this.approvePreparedInTransaction(transaction, input, snapshot),
    );
  }

  async prepareApproval(input: ApproveSkillPackageInput) {
    assertActor(input.actor, this.appEnv);
    if (!input.reason.trim() || input.expectedPackageRevision < 1) {
      throw new SkillPackageApprovalError('SKILL_PACKAGE_APPROVAL_INVALID');
    }
    return this.readValidatedSnapshot(input);
  }

  async approvePreparedInTransaction(
    transaction: Transaction,
    input: ApproveSkillPackageInput,
    snapshot: Awaited<ReturnType<SkillPackageApprovalService['prepareApproval']>>,
  ): Promise<{
    packageRecordId: string;
    validationReportId: string;
    skillIds: string[];
    reused: boolean;
  }> {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(${scopedAdvisoryLockKey('skill-package-approval', input.packageRecordId)})`,
    );
    for (const source of [...snapshot.validation.skills].sort((left, right) =>
      left.skillId.localeCompare(right.skillId),
    )) {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(${scopedAdvisoryLockKey('skill-version', source.skillId)})`,
      );
    }
    const [packageRecord, report] = await Promise.all([
      transaction.query.skillPackages.findFirst({
        where: eq(skillPackages.id, input.packageRecordId),
      }),
      transaction.query.skillPackageValidationReports.findFirst({
        where: eq(skillPackageValidationReports.id, input.validationReportId),
      }),
    ]);
    if (
      packageRecord?.status === 'approved' &&
      report &&
      packageRecord.approvedValidationReportId === report.id &&
      packageRecord.revision === input.expectedPackageRevision + 1
    ) {
      return {
        packageRecordId: packageRecord.id,
        validationReportId: report.id,
        skillIds: snapshot.compiled.map((item) => item.definitionId),
        reused: true,
      };
    }
    if (
      !packageRecord ||
      !report ||
      packageRecord.revision !== input.expectedPackageRevision ||
      packageRecord.latestValidationReportId !== report.id ||
      report.packageRecordId !== packageRecord.id ||
      report.packageRevision !== packageRecord.revision ||
      report.packageDigest !== packageRecord.packageDigest ||
      report.status !== 'passed' ||
      !report.reportDigest
    ) {
      throw new SkillPackageApprovalError('SKILL_PACKAGE_APPROVAL_CONFLICT');
    }
    if (
      packageRecord.status !== 'ready_for_review' ||
      packageRecord.riskStatus !== 'clear' ||
      packageRecord.disabledAt
    ) {
      throw new SkillPackageApprovalError('SKILL_PACKAGE_APPROVAL_INVALID');
    }

    for (const compiled of snapshot.compiled) {
      const existing = await transaction.query.skills.findFirst({
        where: eq(skills.id, compiled.definitionId),
      });
      if (
        existing &&
        (existing.packageRecordId !== packageRecord.id ||
          existing.definitionHash !== compiled.definitionHash ||
          existing.skillDigest !== compiled.skillDigest)
      ) {
        throw new SkillPackageApprovalError('SKILL_PACKAGE_VERSION_CONFLICT');
      }
      if (!existing) {
        await transaction.insert(skills).values({
          id: compiled.definitionId,
          slug: compiled.definition.slug,
          name: compiled.definition.display_name,
          category: compiled.definition.category,
          domain: compiled.definition.domain,
          kind: compiled.definition.kind,
          visibility: compiled.definition.visibility,
          stage: compiled.definition.stage,
          version: compiled.definition.version,
          packageRecordId: packageRecord.id,
          skillDigest: compiled.skillDigest,
          definitionJson: compiled.definition,
          definitionHash: compiled.definitionHash,
          sortOrder: compiled.definition.sort_order,
          price: {},
          status: 'draft',
        });
        await transaction.insert(skillResourceSnapshots).values(
          compiled.resources.map((resource) => ({
            skillId: compiled.definitionId,
            resourcePath: resource.runtimePath,
            resourceType: resource.resourceType,
            contentHash: resource.contentHash,
            packageResourceId: resource.packageResourceId,
            contentText: resource.contentText,
            kvKey: `skill:${compiled.definition.slug}:${compiled.definition.version}:${resource.resourceType}:${canonicalSha256(resource.runtimePath)}:${resource.contentHash}`,
            summaryJson: {
              schema_version: 1,
              byte_size: Buffer.byteLength(resource.contentText, 'utf8'),
            },
          })),
        );
      }
    }

    const [updated] = await transaction
      .update(skillPackages)
      .set({
        status: 'approved',
        revision: packageRecord.revision + 1,
        approvedValidationReportId: report.id,
        approvedBy: skillPackageActorRef(input.actor),
        approvedAt: new Date(),
      })
      .where(
        and(
          eq(skillPackages.id, packageRecord.id),
          eq(skillPackages.revision, packageRecord.revision),
          eq(skillPackages.status, 'ready_for_review'),
        ),
      )
      .returning({ id: skillPackages.id });
    if (!updated) throw new SkillPackageApprovalError('SKILL_PACKAGE_APPROVAL_CONFLICT');
    await transaction.insert(adminAuditLogs).values({
      ...skillPackageAuditActor(input.actor),
      action: 'skill_package.approve',
      targetType: 'skill_package',
      targetId: packageRecord.id,
      afterJson: {
        package_digest: packageRecord.packageDigest,
        validation_report_id: report.id,
        validation_report_digest: report.reportDigest,
        validator_contract_version: report.validatorContractVersion,
        platform_eval_suite_digest: report.platformEvalSuiteDigest,
        skill_count: snapshot.compiled.length,
      },
      reason: input.reason,
      result: 'succeeded',
    });
    return {
      packageRecordId: packageRecord.id,
      validationReportId: report.id,
      skillIds: snapshot.compiled.map((item) => item.definitionId),
      reused: false,
    };
  }

  private async readValidatedSnapshot(input: ApproveSkillPackageInput) {
    const packageRecord = await this.database.query.skillPackages.findFirst({
      where: eq(skillPackages.id, input.packageRecordId),
    });
    if (
      !packageRecord?.manifestJson ||
      packageRecord.latestValidationReportId !== input.validationReportId
    ) {
      throw new SkillPackageApprovalError('SKILL_PACKAGE_APPROVAL_INVALID');
    }
    const manifest = parseSkillPackageManifest(packageRecord.manifestJson);
    // Image resources stay quarantined until a metadata-stripping re-encoder is available.
    if (manifest.resources.some((resource) => resource.media_type.startsWith('image/'))) {
      throw new SkillPackageApprovalError('SKILL_PACKAGE_APPROVAL_INVALID');
    }
    const rows = await this.database.query.skillPackageResources.findMany({
      where: eq(skillPackageResources.packageRecordId, packageRecord.id),
    });
    const byPath = new Map(rows.map((row) => [row.resourcePath, row]));
    const resources: SkillPackageContentResource[] = [];
    const textByPath = new Map<string, string>();
    for (const expected of manifest.resources) {
      const row = byPath.get(expected.path);
      if (
        !row ||
        row.contentHash !== expected.content_hash ||
        row.mediaType !== expected.media_type
      ) {
        throw new SkillPackageApprovalError('SKILL_PACKAGE_APPROVAL_INVALID');
      }
      const content = await this.reader.read(row.storageKey, resourceLimit(row.mediaType));
      resources.push({ path: row.resourcePath, mediaType: expected.media_type, content });
      if (expected.media_type === 'text/markdown') {
        textByPath.set(row.resourcePath, new TextDecoder('utf-8', { fatal: true }).decode(content));
      }
    }
    const validation = validateSkillPackageContents({ manifest, resources });
    const compiled = validation.skills.map((source) => {
      if (
        source.frontmatter.catalog.cover_asset_path ||
        source.frontmatter.preset_slots.some((slot) =>
          slot.options.some((option) => option.preview_asset_path),
        )
      ) {
        throw new SkillPackageApprovalError('SKILL_PACKAGE_APPROVAL_INVALID');
      }
      const definitionResource = byPath.get(source.definitionPath);
      if (!definitionResource) {
        throw new SkillPackageApprovalError('SKILL_PACKAGE_APPROVAL_INVALID');
      }
      const selectedPaths = [
        source.definitionPath,
        ...source.frontmatter.preset_slots.flatMap((slot) =>
          slot.options.map(
            (option) =>
              `${source.definitionPath.slice(0, -'SKILL.md'.length)}${option.resource_path}`,
          ),
        ),
        ...source.frontmatter.references.map(
          (reference) => `${source.definitionPath.slice(0, -'SKILL.md'.length)}${reference.path}`,
        ),
      ];
      const selectedResources = selectedPaths.map((path) => {
        const row = byPath.get(path);
        const contentText = textByPath.get(path);
        if (!row || contentText === undefined) {
          throw new SkillPackageApprovalError('SKILL_PACKAGE_APPROVAL_INVALID');
        }
        const pathInSkill = runtimePath(source.definitionPath, path);
        return {
          runtimePath: pathInSkill,
          resourceType: resourceType(pathInSkill),
          contentHash: row.contentHash,
          packageResourceId: row.id,
          contentText,
        };
      });
      const hashFor = (relativePath: string) => {
        const row = selectedResources.find((resource) => resource.runtimePath === relativePath);
        if (!row) throw new SkillPackageApprovalError('SKILL_PACKAGE_APPROVAL_INVALID');
        return row.contentHash;
      };
      const definition = parseSkillDefinition({
        schema_version: 1,
        slug: source.frontmatter.slug,
        version: source.frontmatter.version,
        display_name: source.frontmatter.display_name,
        description: source.frontmatter.description,
        kind: source.frontmatter.kind,
        visibility: source.frontmatter.catalog.visibility,
        domain: source.frontmatter.domain,
        category: source.frontmatter.category,
        stage: source.frontmatter.stage,
        sort_order: source.frontmatter.sort_order,
        required_inputs: source.frontmatter.required_inputs,
        required_facts: source.frontmatter.required_facts,
        required_capabilities: source.frontmatter.required_capabilities,
        default_output_count: source.frontmatter.default_output_count,
        ...(source.frontmatter.execution_policy
          ? { execution_policy: source.frontmatter.execution_policy }
          : {}),
        ...(source.frontmatter.attachment_roles
          ? { attachment_roles: source.frontmatter.attachment_roles }
          : {}),
        ...(source.frontmatter.catalog_enabled !== undefined
          ? { catalog_enabled: source.frontmatter.catalog_enabled }
          : {}),
        planning_view: { path: 'SKILL.md', content_hash: source.definitionHash },
        preset_slots: source.frontmatter.preset_slots.map((slot) => ({
          ...slot,
          options: slot.options.map(({ preview_asset_path: _previewAssetPath, ...option }) => ({
            ...option,
            resource_hash: hashFor(option.resource_path),
            disabled: false,
          })),
        })),
        dependencies: source.frontmatter.dependencies,
        references: source.frontmatter.references.map((reference) => ({
          path: reference.path,
          content_hash: hashFor(reference.path),
        })),
      } satisfies SkillDefinition);
      const definitionHash = canonicalSha256(definition);
      return {
        definition,
        definitionId: source.skillId,
        definitionHash,
        skillDigest: canonicalSha256({
          definition,
          resources: selectedResources.map(({ runtimePath: path, contentHash }) => ({
            path,
            content_hash: contentHash,
          })),
        }),
        resources: selectedResources,
      };
    });
    return { validation, compiled };
  }
}
