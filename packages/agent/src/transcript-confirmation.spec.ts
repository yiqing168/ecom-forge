import { canonicalSha256 } from '@ecom-forge/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  agentClarificationAnswerSchema,
  agentClarificationPayloadSchema,
  agentProductFactsSchema,
  agentCreateProductFactsAnswerSchema,
  agentLinkProductFactsAnswerSchema,
  agentProductFactsConfirmationPayloadSchema,
  normalizeAgentProductFacts,
  normalizeProductFactList,
} from './confirmation-contract.js';
import {
  agentConfirmationContextSchema,
  agentConfirmationDependencies,
  agentConfirmedFactDependencySchema,
  prepareAgentConfirmationContext,
} from './transcript-confirmation.js';
import { prepareAgentTranscriptItem } from './transcript-item.js';

const uuid = (id: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${id.toString(16).padStart(12, '0')}`;
const facts = {
  product_name: 'Product',
  primary_colors: ['red', 'red'],
  logos: [],
  visible_text: [],
  materials: [],
  must_preserve: [],
  unknown_fields: [],
};
const clarificationQuestion = {
  schema_version: 1,
  question: 'Choose a direction',
  options: [{ id: 'a', label: 'Soft light' }],
  allow_free_text: true,
  max_response_chars: 2000,
};
const productQuestion = {
  schema_version: 1,
  mode: 'create_product',
  source_asset_id: uuid(2),
  source_version: 'a'.repeat(64),
  candidate_facts: facts,
  required_fields: ['product_name'],
};
const productAnswer = {
  facts,
  sku_code: '  SKU  ',
  product_id: uuid(3),
  fact_set_id: uuid(4),
  fact_set_version: 1,
};

const factDependency = {
  kind: 'product_fact_set',
  object_id: uuid(4),
  object_version: '1',
  content_hash: canonicalSha256(normalizeAgentProductFacts(facts)),
  owner_user_id: uuid(8),
  product_id: uuid(3),
  source_asset_id: uuid(2),
  source_version: 'a'.repeat(64),
};

describe('fact dependency version validation', () => {
  it.each(['1', '2147483647'])('accepts an exact PostgreSQL positive integer: %s', (version) => {
    expect(
      agentConfirmedFactDependencySchema.parse({ ...factDependency, object_version: version })
        .object_version,
    ).toBe(version);
  });

  it.each([
    '',
    '0',
    '-1',
    '01',
    '1.5',
    '1e3',
    ' 1',
    '1 ',
    'invalid',
    'c'.repeat(64),
    '9'.repeat(100),
    '2147483648',
    '9999999999',
  ])('rejects invalid versions without throwing from safeParse: %s', (version) => {
    expect(
      agentConfirmedFactDependencySchema.safeParse({ ...factDependency, object_version: version })
        .success,
    ).toBe(false);
  });

  it('allows a union to validate a hash-versioned resource after the fact branch fails', () => {
    const resource = { kind: 'asset', object_version: 'c'.repeat(64) };
    const schema = z.union([
      agentConfirmedFactDependencySchema,
      z.strictObject({
        kind: z.literal('asset'),
        object_version: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    ]);
    expect(schema.parse(resource)).toEqual(resource);
  });
});

function source(
  type = 'clarification',
  publicPayloadJson: unknown = clarificationQuestion,
  answerJson: unknown = { selected_option_id: 'a', selected_option_label: 'Soft light' },
) {
  return {
    id: uuid(1),
    type,
    answerSchemaVersion: 1,
    publicPayloadJson,
    payloadDigest: canonicalSha256(publicPayloadJson),
    answerJson,
  };
}

describe('shared confirmation schemas preserve existing API semantics', () => {
  it('retains strict facts, required lists, trimming and limits without new defaults', () => {
    expect(agentProductFactsSchema.parse({ ...facts, product_name: ' Product ' })).toEqual(facts);
    expect(agentProductFactsSchema.safeParse({ product_name: 'Product' }).success).toBe(false);
    expect(agentProductFactsSchema.safeParse({ ...facts, price: '10' }).success).toBe(false);
    expect(
      agentProductFactsSchema.safeParse({ ...facts, logos: Array.from({ length: 25 }, () => 'x') })
        .success,
    ).toBe(false);
    expect(agentProductFactsSchema.safeParse({ ...facts, logos: ['x'.repeat(121)] }).success).toBe(
      false,
    );
  });

  it('preserves answer normalization and create/link sku distinction', () => {
    expect(agentClarificationAnswerSchema.parse({ response_text: ' hello ' })).toEqual({
      response_text: 'hello',
    });
    expect(agentClarificationAnswerSchema.safeParse({}).success).toBe(false);
    expect(
      agentClarificationAnswerSchema.safeParse({ response_text: 'x'.repeat(2001) }).success,
    ).toBe(false);
    expect(agentClarificationPayloadSchema.safeParse(clarificationQuestion).success).toBe(true);
    expect(agentCreateProductFactsAnswerSchema.parse({ facts, sku_code: '  SKU  ' }).sku_code).toBe(
      '  SKU  ',
    );
    expect(agentLinkProductFactsAnswerSchema.safeParse({ facts, sku_code: 'SKU' }).success).toBe(
      false,
    );
    expect(agentProductFactsConfirmationPayloadSchema.safeParse(productQuestion).success).toBe(
      true,
    );
  });

  it('reuses stable fact de-duplication without mutating input or sorting', () => {
    expect(normalizeProductFactList([' blue ', 'red', 'blue', '', '  '])).toEqual(['blue', 'red']);
    expect(normalizeAgentProductFacts(facts).primary_colors).toEqual(['red']);
    expect(facts.primary_colors).toEqual(['red', 'red']);
  });
});

describe('confirmed host context capture', () => {
  it('keeps the exact selected label and free text and produces no fabricated resource dependency', () => {
    const answer = {
      selected_option_id: 'a',
      selected_option_label: 'Soft light',
      response_text: 'Keep the shadows.\nDo not retouch.',
    };
    const context = prepareAgentConfirmationContext(
      source('clarification', clarificationQuestion, answer),
    );
    expect(context).toMatchObject({ confirmation_type: 'clarification', answer });
    expect(agentConfirmationDependencies(uuid(8), context!)).toEqual([]);
    expect(Object.isFrozen(context)).toBe(true);
  });

  it.each([
    {},
    { selected_option_id: 'a' },
    { selected_option_label: 'Soft light' },
    { selected_option_id: 'missing', selected_option_label: 'Soft light' },
    { selected_option_id: 'a', selected_option_label: 'Changed label' },
    { response_text: '  silently trimmed  ' },
    { response_text: 'x', unknown: true },
  ])('rejects unbound or lossy stored clarification answers: %j', (answer) => {
    expect(
      prepareAgentConfirmationContext(source('clarification', clarificationQuestion, answer)),
    ).toBeNull();
  });

  it.each([{ allow_free_text: false }, { max_response_chars: 1 }])(
    'rejects a response outside the actual question policy: %j',
    (change) => {
      expect(
        prepareAgentConfirmationContext(
          source(
            'clarification',
            { ...clarificationQuestion, ...change },
            { response_text: 'long' },
          ),
        ),
      ).toBeNull();
    },
  );

  it('rejects digest/version drift and unsupported risk confirmations', () => {
    expect(
      prepareAgentConfirmationContext({ ...source(), payloadDigest: '0'.repeat(64) }),
    ).toBeNull();
    expect(prepareAgentConfirmationContext({ ...source(), answerSchemaVersion: 2 })).toBeNull();
    expect(prepareAgentConfirmationContext({ ...source(), type: 'risk' })).toBeNull();
  });

  it('preserves duplicate facts in the answer while indexing the normalized domain fact content', () => {
    const context = prepareAgentConfirmationContext(
      source('product_facts', productQuestion, productAnswer),
    );
    expect(context).toMatchObject({ answer: productAnswer });
    expect(agentConfirmationDependencies(uuid(8), context!)).toEqual([
      {
        kind: 'product_fact_set',
        object_id: uuid(4),
        object_version: '1',
        content_hash: canonicalSha256(normalizeAgentProductFacts(facts)),
        owner_user_id: uuid(8),
        product_id: uuid(3),
        source_asset_id: uuid(2),
        source_version: 'a'.repeat(64),
      },
    ]);
  });

  it('rejects a link answer claiming another product or adding create-only sku fields', () => {
    const question = {
      ...productQuestion,
      mode: 'link_product',
      product_id: uuid(3),
      expected_latest_fact_set_id: null,
    };
    const answer = { facts, product_id: uuid(3), fact_set_id: uuid(4), fact_set_version: 1 };
    expect(
      prepareAgentConfirmationContext(source('product_facts', question, answer)),
    ).not.toBeNull();
    expect(
      prepareAgentConfirmationContext(
        source('product_facts', question, { ...answer, product_id: uuid(9) }),
      ),
    ).toBeNull();
    expect(
      prepareAgentConfirmationContext(source('product_facts', question, productAnswer)),
    ).toBeNull();
  });

  it('does not silently populate missing fact arrays or trim a persisted answer', () => {
    expect(
      prepareAgentConfirmationContext(
        source('product_facts', productQuestion, {
          ...productAnswer,
          facts: { product_name: 'Product' },
        }),
      ),
    ).toBeNull();
    expect(
      prepareAgentConfirmationContext(
        source('product_facts', productQuestion, {
          ...productAnswer,
          facts: { ...facts, product_name: ' Product ' },
        }),
      ),
    ).toBeNull();
  });

  it('captures the maximum existing fact-list shape without dropping Unicode content', () => {
    const list = Array.from(
      { length: 24 },
      (_, i) => `${i.toString().padStart(2, '0')}${'\u8bb0'.repeat(118)}`,
    );
    const maximumFacts = {
      product_name: '\u5fc6'.repeat(120),
      primary_colors: list,
      logos: list,
      visible_text: list,
      materials: list,
      must_preserve: list,
      unknown_fields: list,
    };
    const context = prepareAgentConfirmationContext(
      source(
        'product_facts',
        { ...productQuestion, candidate_facts: maximumFacts },
        { ...productAnswer, facts: maximumFacts },
      ),
    );
    expect(context).not.toBeNull();
    const item = prepareAgentTranscriptItem(
      {
        id: uuid(10),
        user_id: uuid(8),
        session_id: uuid(11),
        turn_id: uuid(12),
        continuation_no: 2,
        sequence_no: '3',
        schema_version: 1,
        item_type: 'host_context',
        source_key: `confirmation:${uuid(1)}:answered`,
        source_message_id: null,
        source_trace_step_id: null,
        import_attempt_id: null,
        reply_to_item_id: null,
        call_ordinal: null,
        payload_json: {
          schema_version: 1,
          type: 'host_context',
          name: 'confirmation_answer@1',
          content: { type: 'inline', value: context },
        },
        resource_dependencies_json: agentConfirmationDependencies(uuid(8), context!),
        created_at: '2026-09-08T00:00:00.000Z',
      },
      {
        userMessage: { schema: z.never() },
        legacyMessage: { schema: z.never() },
        calls: [],
        hostContexts: [
          { name: 'confirmation_answer@1', content: { schema: agentConfirmationContextSchema } },
        ],
        resourceDependencySchema: agentConfirmedFactDependencySchema,
      },
    ).item;
    expect(item.payload_json).toMatchObject({
      content: { value: { answer: { facts: maximumFacts } } },
    });
  });
});
