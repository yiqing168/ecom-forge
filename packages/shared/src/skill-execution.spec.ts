import { describe, expect, it } from 'vitest';

import {
  parseSkillExecutionPolicy,
  skillExecutionRules,
  skillGenerationIntent,
} from './skill-execution.js';

describe('Skill execution policy', () => {
  it.each([
    'text_generation',
    'independent_sources',
    'optional_references',
    'reference_composition',
    'identity_edit',
    'product',
  ] as const)('reads the declared %s family', (family) => {
    const policy = parseSkillExecutionPolicy({ version: 1, family, max_sources: 9 });
    expect(policy).toEqual({ version: 1, family, max_sources: 9 });
  });

  it.each([
    undefined,
    null,
    [],
    { version: 2, family: 'independent_sources', max_sources: 9 },
    { version: 1, family: 'void-line-poster', max_sources: 9 },
    { version: 1, family: 'independent_sources', max_sources: 10 },
    { version: 1, family: 'independent_sources', max_sources: 0 },
    { version: 1, family: 'independent_sources', max_sources: 1.5 },
    { version: 1, family: 'independent_sources', max_sources: '9' },
    { version: 1, family: 'product', max_sources: 9, bypass_facts: true },
    Object.assign(Object.create({ family: 'product' }), {
      version: 1,
      max_sources: 9,
      bypass_facts: true,
    }),
  ])('rejects malformed or privilege-expanding metadata %j', (value) => {
    expect(parseSkillExecutionPolicy(value)).toBeNull();
  });

  it('derives source safety and routing without a Skill ID', () => {
    expect(
      skillExecutionRules({ version: 1, family: 'independent_sources', max_sources: 3 }),
    ).toMatchObject({
      roles: ['semantic_reference'],
      min_sources: 1,
      max_sources: 3,
      independent: true,
    });
    expect(
      skillExecutionRules({ version: 1, family: 'product', max_sources: 9 }).requires_product_facts,
    ).toBe(true);
    expect(
      skillExecutionRules({ version: 1, family: 'identity_edit', max_sources: 9 }).source_role,
    ).toBe('identity_anchor');
    expect(
      skillGenerationIntent({ version: 1, family: 'optional_references', max_sources: 9 }, 0),
    ).toBe('creative_generate');
    expect(
      skillGenerationIntent({ version: 1, family: 'optional_references', max_sources: 9 }, 1),
    ).toBe('raw_asset_generate');
  });
});
