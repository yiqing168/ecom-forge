import { describe, expect, it } from 'vitest';

import type { SkillSelectionSnapshot } from '@ecom-forge/skills';

import {
  resolveSkillDefaultOutputCount,
  type LoadedSkillResource,
} from './skill-runtime.adapter.js';

function planningResource(content: string): LoadedSkillResource {
  return {
    skillId: 'external-skill@1.0.0',
    name: 'External Skill',
    resource: {
      resource_snapshot_id: '00000000-0000-4000-8000-000000000001',
      package_resource_id: '00000000-0000-4000-8000-000000000002',
      resource_path: 'SKILL.md',
      resource_hash: 'a'.repeat(64),
    },
    content,
    tokenCount: 1,
    alreadyLoaded: false,
  };
}

describe('resolveSkillDefaultOutputCount', () => {
  it('keeps the immutable snapshot value when it is present', () => {
    expect(
      resolveSkillDefaultOutputCount(
        {
          primary_skill_id: 'external-skill@1.0.0',
          default_output_count: 2,
        } as SkillSelectionSnapshot,
        [],
      ),
    ).toBe(2);
  });

  it('recovers a missing legacy snapshot value only from legacy frontmatter', () => {
    expect(
      resolveSkillDefaultOutputCount(
        { primary_skill_id: 'external-skill@1.0.0' } as SkillSelectionSnapshot,
        [
          planningResource(`---
schema_version: 1
slug: external-skill
version: 1.0.0
display_name: External Skill
description: Legacy Skill fixture.
kind: primary
category: creative
domain: creative
stage: 1A
default_output_count: 3
---
Create the requested image.
`),
        ],
      ),
    ).toBe(3);
  });

  it('fails closed when a portable Skill snapshot omits its platform output count', () => {
    expect(() =>
      resolveSkillDefaultOutputCount(
        { primary_skill_id: 'external-skill@1.0.0' } as SkillSelectionSnapshot,
        [
          planningResource(`---
name: external-skill
description: Portable Skill fixture.
---
Create the requested image.
`),
        ],
      ),
    ).toThrow('SKILL_DEFAULT_OUTPUT_COUNT_UNAVAILABLE');
  });
});
