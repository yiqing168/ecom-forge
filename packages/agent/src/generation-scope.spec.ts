import { describe, expect, it } from 'vitest';

import {
  crossUploadGroupScope,
  generationScopeDecisionSchema,
  validateGenerationScope,
} from './generation-scope.js';

const sources = [false, true].map((latest, index) => ({
  binding_key: `source-${index + 1}`,
  source_group: {
    message_id: `11111111-1111-4111-8111-11111111111${index}`,
    created_at: `2026-09-2${index + 1}T00:00:00Z`,
    is_latest_upload: latest,
  },
}));
function plan(
  keys = ['source-2'],
  mode: 'latest_upload' | 'conversation_reference' = 'latest_upload',
) {
  return {
    scope_decision: {
      mode,
      input_binding_keys: keys,
      output_count: keys.length,
      reason_summary: 'Continue the subject selected in the conversation.',
    },
    nodes: keys.map((key) => ({ input_bindings: [key], params: { output_count: 1 } })),
  };
}

describe('generation scope', () => {
  it('allows the recent subject without making the earlier photo a task', () => {
    expect(validateGenerationScope(plan(), sources)).toBeNull();
  });
  it('rejects a recent-subject plan that silently regenerates an older source', () => {
    expect(validateGenerationScope(plan(['source-1', 'source-2']), sources)).toContain('earlier');
  });
  it.each([['source-1'], ['source-1', 'source-2']])(
    'allows a deliberate history selection %s',
    (...keys) => {
      expect(validateGenerationScope(plan(keys, 'conversation_reference'), sources)).toBeNull();
    },
  );
  it('requires an explicit scope with source evidence, while accepting old frozen plans', () => {
    const legacy = { nodes: plan().nodes };
    expect(validateGenerationScope(legacy, sources)).toContain('Declare');
    expect(
      validateGenerationScope(
        legacy,
        sources.map(({ binding_key }) => ({ binding_key })),
      ),
    ).toBeNull();
  });
  it('rejects a source whose provenance is missing in a sourced pool, but permits an output', () => {
    const mixed = [
      ...sources.map((source) => ({ ...source, candidate_kind: 'original_source' as const })),
      { binding_key: 'source-3', candidate_kind: 'original_source' as const },
      { binding_key: 'output-1', candidate_kind: 'latest_output' as const },
    ];
    expect(validateGenerationScope(plan(['source-3']), mixed)).toContain('provenance');
    expect(validateGenerationScope(plan(['output-1']), mixed)).toBeNull();
  });
  it('rejects count drift, hidden inputs, duplicate declarations and unavailable inputs', () => {
    const count = plan();
    count.nodes[0]!.params.output_count = 2;
    expect(validateGenerationScope(count, sources)).toContain('sum');
    const hidden = plan();
    hidden.nodes.push({ input_bindings: ['source-1'], params: { output_count: 1 } });
    expect(validateGenerationScope(hidden, sources)).toContain('exactly');
    const duplicate = plan();
    duplicate.scope_decision.input_binding_keys.push('source-2');
    expect(validateGenerationScope(duplicate, sources)).toContain('exactly');
    expect(validateGenerationScope(plan(['missing']), sources)).toContain('unavailable');
  });
  it('counts variants over the whole plan, not source count', () => {
    const variants = plan();
    variants.nodes[0]!.params.output_count = 3;
    variants.scope_decision.output_count = 3;
    expect(validateGenerationScope(variants, sources)).toBeNull();
  });
  it('confirms the exact selected bindings and total output count across upload groups', () => {
    const both = plan(['source-1', 'source-2'], 'conversation_reference');
    const scope = crossUploadGroupScope(both, sources);
    expect(scope).toMatchObject({ groupCount: 2, sourceCount: 2, outputCount: 2 });
    expect(crossUploadGroupScope(plan(['source-1'], 'conversation_reference'), sources)).toBeNull();
    const moreOutputs = structuredClone(both);
    moreOutputs.scope_decision.output_count = 3;
    expect(crossUploadGroupScope(moreOutputs, sources)?.digest).not.toBe(scope?.digest);
    const changedBinding = structuredClone(both);
    changedBinding.nodes[1]!.input_bindings = ['source-3'];
    expect(
      crossUploadGroupScope(changedBinding, [
        ...sources,
        {
          binding_key: 'source-3',
          source_group: {
            message_id: '11111111-1111-4111-8111-111111111113',
            created_at: '2026-09-23T00:00:00Z',
            is_latest_upload: false,
          },
        },
      ])?.digest,
    ).not.toBe(scope?.digest);
  });
  it('rejects malformed model decisions', () => {
    expect(
      generationScopeDecisionSchema.safeParse({ ...plan().scope_decision, output_count: 0 })
        .success,
    ).toBe(false);
  });
});
