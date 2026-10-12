import { describe, expect, it } from 'vitest';

import { getBuiltinSkillCatalog } from './builtin.js';
import { parseSkillPlatformProfile } from './platform-profile.js';

const profile = {
  slug: 'unfamiliar-print',
  version: '1.0.0',
  display_name: 'Print',
  kind: 'primary',
  category: 'poster',
  domain: 'creative',
  stage: '1A',
  execution_policy: { version: 1, family: 'independent_sources', max_sources: 9 },
  attachment_roles: [{ role: 'semantic_reference', label: 'Source photo' }],
};

describe('Skill execution metadata', () => {
  it('accepts an unfamiliar Skill using existing execution semantics', () => {
    expect(parseSkillPlatformProfile(profile).execution_policy).toEqual(profile.execution_policy);
  });

  it.each([
    { ...profile, execution_policy: { ...profile.execution_policy, family: 'unregistered' } },
    { ...profile, execution_policy: { ...profile.execution_policy, max_sources: 10 } },
    { ...profile, execution_policy: { ...profile.execution_policy, billing_authorized: true } },
    { ...profile, attachment_roles: [{ role: 'identity_anchor', label: 'Identity' }] },
    { ...profile, attachment_roles: [...profile.attachment_roles, ...profile.attachment_roles] },
    { ...profile, kind: 'auxiliary' },
  ])('rejects incompatible roles and execution fields', (value) => {
    expect(() => parseSkillPlatformProfile(value)).toThrow('SKILL_PLATFORM_PROFILE_INVALID');
  });

  it('loads every built-in primary policy and attachment label from content metadata', async () => {
    const catalog = await getBuiltinSkillCatalog();
    for (const skill of catalog.skills.filter((item) => item.definition.kind === 'primary')) {
      expect(skill.definition.execution_policy).toBeDefined();
      expect(skill.definition.attachment_roles?.length).toBeGreaterThan(0);
    }
  });
});
