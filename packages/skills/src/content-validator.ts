import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';

import { canonicalSha256 } from '@ecom-forge/shared';
import { ORIGIN_DOMAINS, SKILL_KINDS, SKILL_VISIBILITIES } from '@ecom-forge/types';
import { parseDocument } from 'yaml';
import { z } from 'zod';

import type { SkillPackageManifest } from './package.js';
import { parseSkillPlatformProfile } from './platform-profile.js';
import {
  skillExecutionPolicySchema,
  skillAttachmentRolesSchema,
  validateSkillExecutionMetadata,
} from './execution-policy.js';

const semver = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const skillId = z.string().regex(/^[a-z0-9][a-z0-9-]*@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
const relativeResourcePath = z.string().regex(/^(presets|references)\/[a-z0-9][a-z0-9-]*\.md$/);
const evaluationCheck = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);

const authorPresetOptionSchema = z.strictObject({
  preset_id: skillId,
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(240),
  resource_path: relativeResourcePath.refine((value) => value.startsWith('presets/')),
  preview_asset_path: z.string().min(1).max(240).optional(),
});

export const skillAuthorFrontmatterSchema = z
  .strictObject({
    schema_version: z.literal(1),
    slug,
    version: semver,
    display_name: z.string().min(1).max(120),
    description: z.string().min(1).max(500),
    kind: z.enum(SKILL_KINDS),
    category: slug,
    domain: z.enum(ORIGIN_DOMAINS),
    stage: z.string().min(1).max(64),
    sort_order: z.int().min(0).max(1_000_000).default(0),
    required_inputs: z.array(z.string().min(1).max(64)).max(16).default([]),
    required_facts: z.array(z.string().min(1).max(64)).max(32).default([]),
    required_capabilities: z.array(z.string().min(1).max(128)).max(32).default([]),
    default_output_count: z.int().min(1).max(16).default(1),
    execution_policy: skillExecutionPolicySchema.optional(),
    attachment_roles: skillAttachmentRolesSchema.optional(),
    catalog_enabled: z.boolean().optional(),
    catalog: z
      .strictObject({
        visibility: z.enum(SKILL_VISIBILITIES),
        cover_asset_path: z.string().min(1).max(240).optional(),
      })
      .optional(),
    preset_slots: z
      .array(
        z.strictObject({
          slot: slug,
          label: z.string().min(1).max(80),
          required: z.boolean(),
          max_selections: z.int().min(1).max(4),
          options: z.array(authorPresetOptionSchema).min(1).max(24),
        }),
      )
      .max(8)
      .default([]),
    dependencies: z
      .array(
        z.strictObject({
          skill_id: skillId,
          mode: z.enum(['required', 'optional']),
          reason: z.string().min(1).max(240),
        }),
      )
      .max(12)
      .default([]),
    references: z
      .array(
        z.strictObject({
          path: relativeResourcePath.refine((value) => value.startsWith('references/')),
          purpose: z.string().min(1).max(240),
        }),
      )
      .max(12)
      .default([]),
  })
  .superRefine((value, context) => {
    validateSkillExecutionMetadata(value, context);
    if (
      value.kind === 'auxiliary' &&
      ((value.catalog?.visibility ?? 'internal') !== 'internal' ||
        value.preset_slots.length > 0 ||
        value.dependencies.length > 0)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'auxiliary skills must be internal and cannot declare presets or dependencies',
      });
    }
    if (value.kind === 'primary' && (value.catalog?.visibility ?? 'public') !== 'public') {
      context.addIssue({ code: 'custom', message: 'primary skills must be public' });
    }
    const slots = value.preset_slots.map((item) => item.slot);
    const presets = value.preset_slots.flatMap((item) =>
      item.options.map((option) => option.preset_id),
    );
    const dependencies = value.dependencies.map((item) => item.skill_id);
    const references = value.references.map((item) => item.path);
    if (
      new Set(slots).size !== slots.length ||
      new Set(presets).size !== presets.length ||
      new Set(dependencies).size !== dependencies.length ||
      new Set(references).size !== references.length
    ) {
      context.addIssue({ code: 'custom', message: 'Skill declarations must be unique' });
    }
  })
  .transform((value) => ({
    ...value,
    catalog: value.catalog ?? {
      visibility: value.kind === 'primary' ? ('public' as const) : ('internal' as const),
    },
  }));

export type SkillAuthorFrontmatter = z.infer<typeof skillAuthorFrontmatterSchema>;

const portableSkillFrontmatterSchema = z.strictObject({
  name: slug,
  description: z.string().min(1).max(500),
  metadata: z
    .strictObject({
      'short-description': z.string().min(1).max(240).optional(),
    })
    .optional(),
});

export interface SkillPackageContentResource {
  path: string;
  mediaType: SkillPackageManifest['resources'][number]['media_type'];
  content: Uint8Array;
}

export interface ValidatedSkillSource {
  skillId: string;
  definitionPath: string;
  definitionHash: string;
  frontmatter: SkillAuthorFrontmatter;
  body: string;
}

export interface SkillPackageContentValidation {
  skills: ValidatedSkillSource[];
  textResourceCount: number;
  binaryResourceCount: number;
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
const dynamicUrlPattern = /(?:https?:\/\/|data:|file:|ftp:\/\/|www\.)/i;
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /\b(?:api[_-]?key|secret|access[_-]?token|private[_-]?key)\s*[:=]\s*['"]?[A-Za-z0-9._~+/=-]{12,}/i,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
] as const;
const privilegeEscalationPatterns = [
  /ignore\s+(?:all\s+)?(?:previous|prior)(?:\s+(?:system|developer))?\s+instructions?/i,
  /(?:treat|regard)\s+(?:this|these)\s+(?:text|instructions?)\s+as\s+(?:system|developer|admin)/i,
  /(?:reveal|print|return|expose)\s+(?:the\s+)?(?:system prompt|hidden context|secret|api key)/i,
  /(?:call|invoke|enable|register)\s+(?:an?\s+)?(?:unregistered|hidden|unauthorized)\s+tool/i,
  /(?:\u5ffd\u7565|\u65e0\u89c6).{0,16}(?:\u4e4b\u524d|\u6b64\u524d|\u7cfb\u7edf|\u5f00\u53d1\u8005).{0,12}(?:\u6307\u4ee4|\u89c4\u5219)/,
  /(?:\u89c6\u4e3a|\u5f53\u4f5c).{0,12}(?:\u7cfb\u7edf|\u5f00\u53d1\u8005|\u7ba1\u7406\u5458).{0,8}(?:\u6307\u4ee4|\u6743\u9650)/,
  /(?:\u6cc4\u9732|\u8f93\u51fa|\u8fd4\u56de).{0,12}(?:\u7cfb\u7edf\u63d0\u793a|\u9690\u85cf\u4e0a\u4e0b\u6587|\u5bc6\u94a5|Key)/i,
] as const;

const goldenCaseSchema = z.strictObject({
  case_id: slug,
  category: z.enum([
    'success',
    'missing_fact',
    'skill_mismatch',
    'material_role_drift',
    'prompt_injection',
    'identity_drift',
    'relationship_drift',
    'cross_image_duplicate',
    'lineage_violation',
    'rights_unknown',
  ]),
  request: z.string().min(1).max(2000),
  context: z.record(z.string(), z.unknown()),
  expected: z.strictObject({
    decision: z.enum(['plan', 'clarify', 'suggest_switch', 'block']),
    required_checks: z.array(evaluationCheck).min(1).max(32),
    forbidden: z.array(evaluationCheck).max(32),
  }),
});

const requiredGoldenCategories = new Set([
  'success',
  'missing_fact',
  'skill_mismatch',
  'material_role_drift',
  'prompt_injection',
]);

function validationError(code: string): never {
  throw new Error(code);
}

function contentSha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

export function decodeStrictText(content: Uint8Array): string {
  if (content.byteLength === 0 || content.byteLength > 1_048_576) {
    return validationError('SKILL_PACKAGE_TEXT_SIZE_INVALID');
  }
  let text: string;
  try {
    text = utf8Decoder.decode(content);
  } catch {
    return validationError('SKILL_PACKAGE_TEXT_ENCODING_INVALID');
  }
  const hasForbiddenControl = [...text].some((character) => {
    const code = character.charCodeAt(0);
    return (
      (code >= 0 && code <= 8) ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      code === 127
    );
  });
  if (text.charCodeAt(0) === 0xfeff || text.includes('\r') || hasForbiddenControl) {
    return validationError('SKILL_PACKAGE_TEXT_ENCODING_INVALID');
  }
  return text;
}

export function assertSafeSkillText(text: string): void {
  if (dynamicUrlPattern.test(text)) validationError('SKILL_PACKAGE_DYNAMIC_URL_FORBIDDEN');
  if (secretPatterns.some((pattern) => pattern.test(text))) {
    validationError('SKILL_PACKAGE_SECRET_DETECTED');
  }
  if (privilegeEscalationPatterns.some((pattern) => pattern.test(text))) {
    validationError('SKILL_PACKAGE_PRIVILEGE_ESCALATION');
  }
}

export function parseSkillAuthorMarkdown(
  content: string,
  platformProfile?: unknown,
): {
  frontmatter: SkillAuthorFrontmatter;
  body: string;
  frontmatterFormat: 'legacy' | 'portable';
} {
  if (!content.startsWith('---\n')) validationError('SKILL_FRONTMATTER_INVALID');
  const closingIndex = content.indexOf('\n---\n', 4);
  if (closingIndex < 0) validationError('SKILL_FRONTMATTER_INVALID');
  const yamlText = content.slice(4, closingIndex);
  const body = content.slice(closingIndex + 5).trim();
  if (!body) validationError('SKILL_BODY_REQUIRED');
  const document = parseDocument(yamlText, { uniqueKeys: true, strict: true });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    validationError('SKILL_FRONTMATTER_INVALID');
  }
  const yamlValue = document.toJS() as unknown;
  const legacyResult = skillAuthorFrontmatterSchema.safeParse(yamlValue);
  if (legacyResult.success) {
    return { frontmatter: legacyResult.data, body, frontmatterFormat: 'legacy' };
  }

  const portableResult = portableSkillFrontmatterSchema.safeParse(yamlValue);
  if (!portableResult.success) {
    validationError('SKILL_FRONTMATTER_INVALID');
  }
  const profile = parseSkillPlatformProfile(
    platformProfile ?? {
      slug: portableResult.data.name,
      version: '0.1.0',
      display_name: portableResult.data.name,
      kind: 'primary',
      category: 'creative',
      domain: 'creative',
      stage: '1A',
      sort_order: 0,
      required_inputs: [],
      required_facts: [],
      required_capabilities: [],
      default_output_count: 1,
      catalog: { visibility: 'public' },
      preset_slots: [],
      dependencies: [],
      references: [],
    },
  );
  if (profile.slug !== portableResult.data.name) {
    validationError('SKILL_PLATFORM_PROFILE_IDENTITY_MISMATCH');
  }
  return {
    frontmatter: skillAuthorFrontmatterSchema.parse({
      schema_version: 1,
      ...profile,
      description: portableResult.data.description,
    }),
    body,
    frontmatterFormat: 'portable',
  };
}

function assertImageMagic(mediaType: string, content: Uint8Array): void {
  const bytes = Buffer.from(content);
  const valid =
    (mediaType === 'image/png' &&
      bytes.length >= 8 &&
      bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ||
    (mediaType === 'image/jpeg' &&
      bytes.length >= 4 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes.at(-2) === 0xff &&
      bytes.at(-1) === 0xd9) ||
    (mediaType === 'image/webp' &&
      bytes.length >= 12 &&
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP');
  if (!valid) validationError('SKILL_PACKAGE_MEDIA_MISMATCH');
}

function assertMediaTypeMatchesPath(path: string, mediaType: string): void {
  const valid =
    (mediaType === 'text/markdown' && path.endsWith('.md')) ||
    (mediaType === 'application/json' && path.endsWith('.json')) ||
    (mediaType === 'application/jsonl' && path.endsWith('.jsonl')) ||
    (mediaType === 'image/png' && path.endsWith('.png')) ||
    (mediaType === 'image/jpeg' && /\.jpe?g$/.test(path)) ||
    (mediaType === 'image/webp' && path.endsWith('.webp'));
  if (!valid) validationError('SKILL_PACKAGE_MEDIA_MISMATCH');
}

function relativeToSkill(definitionPath: string, relativePath: string): string {
  return `${definitionPath.slice(0, -'SKILL.md'.length)}${relativePath}`;
}

export function validateSkillPackageContents(input: {
  manifest: SkillPackageManifest;
  resources: SkillPackageContentResource[];
}): SkillPackageContentValidation {
  const contentByPath = new Map(input.resources.map((resource) => [resource.path, resource]));
  if (
    contentByPath.size !== input.resources.length ||
    input.resources.length !== input.manifest.resources.length
  ) {
    validationError('SKILL_PACKAGE_RESOURCE_INVENTORY_INVALID');
  }
  let textResourceCount = 0;
  let binaryResourceCount = 0;
  for (const expected of input.manifest.resources) {
    const resource = contentByPath.get(expected.path);
    assertMediaTypeMatchesPath(expected.path, expected.media_type);
    if (
      !resource ||
      resource.mediaType !== expected.media_type ||
      resource.content.byteLength !== expected.byte_size ||
      contentSha256(resource.content) !== expected.content_hash
    ) {
      validationError('SKILL_PACKAGE_RESOURCE_DIGEST_MISMATCH');
    }
    if (expected.media_type.startsWith('text/') || expected.media_type.includes('json')) {
      const text = decodeStrictText(resource.content);
      assertSafeSkillText(text);
      if (expected.media_type === 'application/json') {
        try {
          JSON.parse(text);
        } catch {
          validationError('SKILL_PACKAGE_JSON_INVALID');
        }
      } else if (expected.media_type === 'application/jsonl') {
        for (const line of text.split('\n').filter(Boolean)) {
          try {
            JSON.parse(line);
          } catch {
            validationError('SKILL_PACKAGE_JSON_INVALID');
          }
        }
      }
      textResourceCount += 1;
    } else {
      assertImageMagic(expected.media_type, resource.content);
      binaryResourceCount += 1;
    }
  }

  const skills = input.manifest.skills.map((inventory) => {
    const resource = contentByPath.get(inventory.definition_path);
    if (!resource || resource.mediaType !== 'text/markdown') {
      return validationError('SKILL_DEFINITION_RESOURCE_INVALID');
    }
    const source = decodeStrictText(resource.content);
    const manifestProfile = input.manifest.skill_profiles[inventory.skill_id];
    if (!manifestProfile) {
      return validationError('SKILL_DEFINITION_IDENTITY_MISMATCH');
    }
    const profile = parseSkillPlatformProfile(manifestProfile);
    const parsed = parseSkillAuthorMarkdown(source, profile);
    const { schema_version, description, ...frontmatterProfile } = parsed.frontmatter;
    void schema_version;
    void description;
    if (
      `${parsed.frontmatter.slug}@${parsed.frontmatter.version}` !== inventory.skill_id ||
      canonicalSha256(parseSkillPlatformProfile(frontmatterProfile)) !== canonicalSha256(profile) ||
      contentSha256(resource.content) !== inventory.definition_hash
    ) {
      return validationError('SKILL_DEFINITION_IDENTITY_MISMATCH');
    }
    const ownedPaths = new Set([
      ...parsed.frontmatter.preset_slots.flatMap((slot) =>
        slot.options.map((option) => option.resource_path),
      ),
      ...parsed.frontmatter.references.map((reference) => reference.path),
    ]);
    for (const path of ownedPaths) {
      const absolutePath = relativeToSkill(inventory.definition_path, path);
      const owned = contentByPath.get(absolutePath);
      if (!owned || owned.mediaType !== 'text/markdown') {
        return validationError('SKILL_DECLARED_RESOURCE_MISSING');
      }
    }
    return {
      skillId: inventory.skill_id,
      definitionPath: inventory.definition_path,
      definitionHash: inventory.definition_hash,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
    };
  });

  const primarySkills = skills.filter((skill) => skill.frontmatter.kind === 'primary');
  for (const skill of primarySkills) {
    const evalPath = `skill-package/evals/${skill.frontmatter.slug}.jsonl`;
    if (!input.manifest.eval_datasets.includes(evalPath)) {
      validationError('SKILL_GOLDEN_DATASET_MISSING');
    }
    const evaluation = contentByPath.get(evalPath);
    if (!evaluation || evaluation.mediaType !== 'application/jsonl') {
      validationError('SKILL_GOLDEN_DATASET_MISSING');
    }
    const lines = decodeStrictText(evaluation.content).split('\n').filter(Boolean);
    const cases = lines.map((line) => {
      try {
        return goldenCaseSchema.parse(JSON.parse(line) as unknown);
      } catch {
        return validationError('SKILL_GOLDEN_DATASET_INVALID');
      }
    });
    if (new Set(cases.map((item) => item.case_id)).size !== cases.length) {
      validationError('SKILL_GOLDEN_DATASET_INVALID');
    }
    const categories = new Set(cases.map((item) => item.category));
    if ([...requiredGoldenCategories].some((category) => !categories.has(category as never))) {
      validationError('SKILL_GOLDEN_DATASET_INCOMPLETE');
    }
  }

  const definitionPaths = new Set(input.manifest.skills.map((skill) => skill.definition_path));
  for (const resource of input.manifest.resources) {
    const isSkillOwnedMarkdown = /\/skills\/[^/]+\/(?:presets|references)\/[^/]+\.md$/.test(
      `/${resource.path}`,
    );
    if (
      resource.media_type === 'text/markdown' &&
      !definitionPaths.has(resource.path) &&
      isSkillOwnedMarkdown
    ) {
      const owner = skills.find((skill) =>
        resource.path.startsWith(skill.definitionPath.slice(0, -'SKILL.md'.length)),
      );
      if (!owner) validationError('SKILL_RESOURCE_OWNER_INVALID');
      const relative = resource.path.slice(owner.definitionPath.length - 'SKILL.md'.length);
      const declared = [
        ...owner.frontmatter.preset_slots.flatMap((slot) =>
          slot.options.map((option) => option.resource_path),
        ),
        ...owner.frontmatter.references.map((reference) => reference.path),
      ];
      if (!declared.includes(relative)) validationError('SKILL_RESOURCE_UNDECLARED');
    }
  }
  return { skills, textResourceCount, binaryResourceCount };
}
