import { describe, expect, it } from 'vitest';

import { assertSkillResourcePath, parseSkillDefinition, validateSkillSelection } from './index.js';

const hash = 'a'.repeat(64);

describe('skill runtime contracts', () => {
  const definition = parseSkillDefinition({
    schema_version: 1,
    slug: 'portrait-renewal',
    version: '1.0.0',
    display_name: '人像焕新',
    description: '安全的人像风格创作',
    kind: 'primary',
    visibility: 'public',
    domain: 'creative',
    category: 'portrait',
    stage: 'beta',
    planning_view: { path: 'SKILL.md', content_hash: hash },
    preset_slots: [
      {
        slot: 'style',
        label: '风格',
        required: true,
        max_selections: 1,
        options: [
          {
            preset_id: 'paper-color@1.0.0',
            name: '纸上亮色',
            description: '留白与亮色',
            resource_path: 'presets/paper-color.md',
            resource_hash: hash,
          },
        ],
      },
    ],
    dependencies: [{ skill_id: 'portrait-safety@1.0.0', mode: 'required', reason: '人物身份安全' }],
  });

  it('requires explicit primary and required preset selection', () => {
    expect(() =>
      validateSkillSelection({
        selection: { primary_skill_id: 'portrait-renewal@1.0.0', preset_selections: [] },
        definition,
        definitionHash: hash,
        packageRecordId: '11111111-1111-4111-8111-111111111111',
        planningResource: {
          resource_snapshot_id: '22222222-2222-4222-8222-222222222222',
          package_resource_id: '33333333-3333-4333-8333-333333333333',
          resource_path: 'SKILL.md',
          resource_hash: hash,
        },
        catalogReleaseId: 'release',
        catalogVersion: hash,
        dependencySnapshots: new Map(),
        resourceSnapshots: new Map(),
      }),
    ).toThrow('SKILL_SELECTION_REQUIRED');
    const selected = validateSkillSelection({
      selection: {
        primary_skill_id: 'portrait-renewal@1.0.0',
        preset_selections: [{ slot: 'style', preset_id: 'paper-color@1.0.0' }],
      },
      definition,
      definitionHash: hash,
      packageRecordId: '11111111-1111-4111-8111-111111111111',
      planningResource: {
        resource_snapshot_id: '22222222-2222-4222-8222-222222222222',
        package_resource_id: '33333333-3333-4333-8333-333333333333',
        resource_path: 'SKILL.md',
        resource_hash: hash,
      },
      catalogReleaseId: 'release',
      catalogVersion: hash,
      dependencySnapshots: new Map([
        [
          'portrait-safety@1.0.0',
          {
            skill_id: 'portrait-safety@1.0.0',
            name: '人物保真',
            definition_hash: hash,
            package_record_id: '44444444-4444-4444-8444-444444444444',
            planning_resource: {
              resource_snapshot_id: '55555555-5555-4555-8555-555555555555',
              package_resource_id: '66666666-6666-4666-8666-666666666666',
              resource_path: 'SKILL.md',
              resource_hash: hash,
            },
            reference_resources: [],
          },
        ],
      ]),
      resourceSnapshots: new Map([
        [
          'presets/paper-color.md',
          {
            resource_snapshot_id: '77777777-7777-4777-8777-777777777777',
            package_resource_id: '88888888-8888-4888-8888-888888888888',
            resource_path: 'presets/paper-color.md',
            resource_hash: hash,
          },
        ],
      ]),
    });
    expect(selected.snapshot.required_auxiliary.map((item) => item.skill_id)).toEqual([
      'portrait-safety@1.0.0',
    ]);
    expect(selected.snapshot.default_output_count).toBe(1);
  });

  it('normalizes the default output count and preserves an explicit Skill override', () => {
    expect(definition.default_output_count).toBe(1);
    expect(
      parseSkillDefinition({
        ...definition,
        slug: 'cinematic-triptych',
        default_output_count: 3,
      }).default_output_count,
    ).toBe(3);
  });

  it('rejects traversal and recursive reference paths', () => {
    expect(() => assertSkillResourcePath('../secret.md', 'reference')).toThrow(
      'SKILL_RESOURCE_PATH_INVALID',
    );
    expect(() => assertSkillResourcePath('references/nested/file.md', 'reference')).toThrow(
      'SKILL_RESOURCE_PATH_INVALID',
    );
  });
});
