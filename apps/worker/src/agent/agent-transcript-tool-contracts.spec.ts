import {
  validateAgentTranscriptProtocol,
  agentTranscriptWireCallId,
  type AgentTranscriptItemContracts,
} from '@ecom-forge/agent';
import { attachmentSnapshotSchema } from '@ecom-forge/compiler';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { transcriptSkillDependencySchema } from './agent-transcript-skill-context.js';
import {
  prepareTranscriptKnowledgeBatch,
  prepareTranscriptKnowledgeResult,
  transcriptKnowledgeToolContracts,
  verifyTranscriptKnowledgeResultSource,
} from './agent-transcript-tool-contracts.js';

const uuid = (id: number) => `cccccccc-cccc-4ccc-8ccc-${id.toString(16).padStart(12, '0')}`;
const userId = uuid(1),
  sessionId = uuid(2),
  turnId = uuid(3);
const binding = attachmentSnapshotSchema.parse({
  binding_key: 'source-1',
  kind: 'asset',
  object_id: uuid(4),
  object_version: 'a'.repeat(64),
  content_hash: 'a'.repeat(64),
  owner_user_id: userId,
  readable: true,
  mutable: false,
  producer_mode: null,
  producer_session_id: null,
  mutation_owner: null,
  source_action: null,
  media_type: 'image',
  lifecycle: 'active',
  visibility: 'private',
  role: 'semantic_reference',
  position: 7,
  publication_revision: null,
});
const skill = transcriptSkillDependencySchema.parse({
  kind: 'skill_resource',
  skill_id: 'lighting@1.0.0',
  definition_hash: 'b'.repeat(64),
  package_record_id: uuid(5),
  catalog_release_id: uuid(6),
  catalog_version: 'c'.repeat(64),
  resource_snapshot_id: uuid(7),
  package_resource_id: uuid(8),
  resource_path: 'SKILL.md',
  resource_hash: 'd'.repeat(64),
});
const contracts: AgentTranscriptItemContracts = {
  userMessage: { schema: z.never() },
  legacyMessage: { schema: z.never() },
  hostContexts: [],
  calls: transcriptKnowledgeToolContracts,
  resourceDependencySchema: z.union([attachmentSnapshotSchema, transcriptSkillDependencySchema]),
};
const metadata = (id = 10, sequence = '1') => ({
  id: uuid(id),
  user_id: userId,
  session_id: sessionId,
  turn_id: turnId,
  continuation_no: 1,
  sequence_no: sequence,
  schema_version: 1 as const,
  source_key: `model:${uuid(id)}:output`,
  source_message_id: null,
  source_trace_step_id: uuid(9),
  import_attempt_id: null,
  reply_to_item_id: null,
  call_ordinal: null,
  resource_dependencies_json: [binding, skill],
  created_at: '2026-09-08T00:00:00.000Z',
});
const imageCall = () => ({
  name: 'inspect_image@1',
  call_id: 'call-1',
  arguments: { binding_key: binding.binding_key, detail: 'detail' },
});
const skillCall = () => ({
  name: 'load_skill@1',
  call_id: 'call-2',
  arguments: { skill_id: skill.skill_id, view: 'planning' },
});
function result(
  parent = prepareTranscriptKnowledgeBatch(metadata(), [imageCall()], contracts),
  raw: unknown = { binding, detail: 'detail', materialized: true },
) {
  return prepareTranscriptKnowledgeResult(
    {
      metadata: metadata(11, '2'),
      parent,
      ordinal: 0,
      status: 'succeeded',
      result: raw,
    },
    contracts,
  );
}

describe('runtime knowledge tool transcript contracts', () => {
  it('captures signed knowledge calls and includes signatures in the envelope digest', () => {
    const original = prepareTranscriptKnowledgeBatch(metadata(), [imageCall()], contracts);
    const signed = prepareTranscriptKnowledgeBatch(
      metadata(),
      [
        {
          ...imageCall(),
          provider_metadata: { google: { thoughtSignature: 'opaque-test-signature' } },
        },
      ],
      contracts,
    );
    expect(signed.payload_json).toMatchObject({
      calls: [{ provider_metadata: { google: { thoughtSignature: 'opaque-test-signature' } } }],
    });
    expect(signed.payload_digest).not.toBe(original.payload_digest);
  });
  it('retains the entire ordered response as one immutable assistant item', () => {
    const calls = [imageCall(), skillCall()];
    const parent = prepareTranscriptKnowledgeBatch(metadata(), calls, contracts);
    expect(parent.payload_json).toMatchObject({
      type: 'assistant_output',
      mode: 'tools',
      calls: [
        { name: 'inspect_image@1', arguments: { value: calls[0]!.arguments } },
        { name: 'load_skill@1', arguments: { value: calls[1]!.arguments } },
      ],
    });
    calls[0]!.name = 'changed';
    expect(parent.payload_json).toMatchObject({
      calls: [{ name: 'inspect_image@1' }, { name: 'load_skill@1' }],
    });
    expect(Object.isFrozen(parent.payload_json)).toBe(true);
  });

  it.each([
    { name: 'image.generate@1', call_id: 'call-2', arguments: {} },
    { name: 'load_skill@2', call_id: 'call-2', arguments: skillCall().arguments },
    {
      ...imageCall(),
      arguments: { ...imageCall().arguments, signed_url: 'https://example.test/private' },
    },
    { ...imageCall(), arguments: { ...imageCall().arguments, detail: 'auto' } },
    { ...skillCall(), arguments: { skill_id: 'lighting@latest', view: 'planning' } },
    {
      ...skillCall(),
      arguments: {
        skill_id: skill.skill_id,
        view: 'references',
        reference_paths: ['../secret.md'],
      },
    },
    {
      ...skillCall(),
      arguments: { skill_id: skill.skill_id, view: 'references', reference_paths: [] },
    },
  ])('refuses the entire batch when a later call is invalid: %j', (invalid) => {
    expect(() =>
      prepareTranscriptKnowledgeBatch(metadata(), [imageCall(), invalid], contracts),
    ).toThrow();
  });

  it('requires one to four calls and a real model-step source identity', () => {
    for (const count of [0, 5]) {
      expect(() =>
        prepareTranscriptKnowledgeBatch(
          metadata(),
          Array.from({ length: count }, imageCall),
          contracts,
        ),
      ).toThrow();
    }
    expect(() =>
      prepareTranscriptKnowledgeBatch(
        { ...metadata(), source_trace_step_id: null },
        [imageCall()],
        contracts,
      ),
    ).toThrow();
  });

  it('uses host protocol identities and omits unsafe diagnostic provider IDs', () => {
    const parent = prepareTranscriptKnowledgeBatch(
      metadata(),
      [{ ...imageCall(), call_id: 'not/a/safe/id' }],
      contracts,
    );
    expect(parent.payload_json).toMatchObject({ calls: [{ provider_call_id: null }] });
    expect(agentTranscriptWireCallId({ assistant_item_id: parent.id, call_ordinal: 0 })).toBe(
      `call_${parent.id.replaceAll('-', '')}_0`,
    );
  });

  it('keeps Unicode binding keys and whitespace without canonicalizing the semantic text', () => {
    const parent = prepareTranscriptKnowledgeBatch(
      metadata(),
      [
        {
          ...imageCall(),
          arguments: { binding_key: ' 原图\n', detail: 'detail' },
        },
      ],
      contracts,
    );
    expect(parent.payload_json).toMatchObject({
      calls: [{ arguments: { value: { binding_key: ' 原图\n' } } }],
    });
  });

  it('records an image result with complete binding, detail and inherited Skill dependencies', () => {
    const item = result();
    expect(item.resource_dependencies_json).toEqual([binding, skill]);
    expect(item.payload_json).toMatchObject({
      status: 'succeeded',
      result: { value: { binding, detail: 'detail', materialized: true } },
    });
  });

  it('verifies a result against the exact original call, including its complete dependencies', () => {
    const parent = prepareTranscriptKnowledgeBatch(metadata(), [imageCall()], contracts);
    const item = result(parent);
    expect(verifyTranscriptKnowledgeResultSource({ item, parent }, contracts)).toBe(true);
    expect(
      verifyTranscriptKnowledgeResultSource(
        { item: { ...item, source_key: 'invented' }, parent },
        contracts,
      ),
    ).toBe(false);
    expect(
      verifyTranscriptKnowledgeResultSource(
        { item: { ...item, resource_dependencies_json: [binding] }, parent },
        contracts,
      ),
    ).toBe(false);
    expect(
      verifyTranscriptKnowledgeResultSource(
        { item: { ...item, call_ordinal: 1 }, parent },
        contracts,
      ),
    ).toBe(false);
  });

  it.each([
    { binding: { ...binding, binding_key: 'other' }, detail: 'detail', materialized: true },
    { binding: { ...binding, content_hash: 'f'.repeat(64) }, detail: 'detail', materialized: true },
    { binding: { ...binding, position: 8 }, detail: 'detail', materialized: true },
    { binding, detail: 'overview', materialized: true },
    { binding, detail: 'detail', materialized: false },
    { binding, detail: 'detail', materialized: true, bytes: 'binary' },
  ])('rejects results that do not match the inspected input: %j', (value) => {
    expect(() => result(undefined, value)).toThrow();
  });

  it('inherits the original dependencies once when a planning resource is already loaded', () => {
    const parent = prepareTranscriptKnowledgeBatch(metadata(), [skillCall()], contracts);
    const item = result(parent, {
      skill_id: skill.skill_id,
      view: 'planning',
      already_loaded: true,
      resources: [skill],
    });
    expect(item.resource_dependencies_json).toEqual([binding, skill]);
  });

  it('retains actual ordered reference resources and adds them to inherited dependencies', () => {
    const resources = [
      { ...skill, resource_snapshot_id: uuid(30), resource_path: 'references/light.md' },
      { ...skill, resource_snapshot_id: uuid(31), resource_path: 'references/texture.md' },
    ];
    const parent = prepareTranscriptKnowledgeBatch(
      metadata(),
      [
        {
          ...skillCall(),
          arguments: {
            skill_id: skill.skill_id,
            view: 'references',
            reference_paths: resources.map((entry) => entry.resource_path),
          },
        },
      ],
      contracts,
    );
    const value = {
      skill_id: skill.skill_id,
      view: 'references',
      already_loaded: false,
      resources,
    };
    expect(result(parent, value).resource_dependencies_json).toEqual([
      binding,
      skill,
      ...resources,
    ]);
    expect(() => result(parent, { ...value, resources: [...resources].reverse() })).toThrow();
  });

  it.each([
    { skill_id: 'other@1.0.0', view: 'planning', already_loaded: false, resources: [skill] },
    { skill_id: skill.skill_id, view: 'references', already_loaded: false, resources: [skill] },
    {
      skill_id: skill.skill_id,
      view: 'planning',
      already_loaded: false,
      resources: [{ ...skill, resource_path: 'references/light.md' }],
    },
    {
      skill_id: skill.skill_id,
      view: 'planning',
      already_loaded: false,
      resources: [skill, skill],
    },
    {
      skill_id: skill.skill_id,
      view: 'planning',
      already_loaded: false,
      resources: [skill],
      content: 'private knowledge',
    },
  ])('rejects a fabricated knowledge result: %j', (value) => {
    const parent = prepareTranscriptKnowledgeBatch(metadata(), [skillCall()], contracts);
    expect(() => result(parent, value)).toThrow();
  });

  it.each(['user_id', 'session_id', 'turn_id'] as const)('rejects cross-scope %s', (key) => {
    const parent = prepareTranscriptKnowledgeBatch(metadata(), [imageCall()], contracts);
    expect(() =>
      prepareTranscriptKnowledgeResult(
        {
          metadata: { ...metadata(11, '2'), [key]: uuid(99) },
          parent,
          ordinal: 0,
          status: 'succeeded',
          result: { binding, detail: 'detail', materialized: true },
        },
        contracts,
      ),
    ).toThrow();
  });

  it('keeps a failed call and the unexecuted remainder protocol-closed', () => {
    const parent = prepareTranscriptKnowledgeBatch(
      metadata(),
      [imageCall(), skillCall()],
      contracts,
    );
    const first = prepareTranscriptKnowledgeResult(
      {
        metadata: metadata(11, '2'),
        parent,
        ordinal: 0,
        status: 'rejected',
        result: { public_error_code: 'AGENT_IMAGE_BINDING_INVALID' },
      },
      contracts,
    );
    const second = prepareTranscriptKnowledgeResult(
      {
        metadata: metadata(12, '3'),
        parent,
        ordinal: 1,
        status: 'not_executed',
        result: { reason: 'earlier_call_failed' },
      },
      contracts,
    );
    expect(
      validateAgentTranscriptProtocol(
        {
          scope: { user_id: userId, session_id: sessionId },
          first_sequence_no: '1',
          require_closed: true,
          items: [parent, first, second],
        },
        contracts,
      ).protocol_closed,
    ).toBe(true);
    const forbidden = prepareTranscriptKnowledgeResult(
      {
        metadata: metadata(12, '3'),
        parent,
        ordinal: 1,
        status: 'succeeded',
        result: {
          skill_id: skill.skill_id,
          view: 'planning',
          already_loaded: false,
          resources: [skill],
        },
      },
      contracts,
    );
    expect(() =>
      validateAgentTranscriptProtocol(
        {
          scope: { user_id: userId, session_id: sessionId },
          first_sequence_no: '1',
          require_closed: true,
          items: [parent, first, forbidden],
        },
        contracts,
      ),
    ).toThrow();
  });

  it.each(['rejected', 'unknown', 'not_executed'] as const)(
    'never disguises %s as a successful result',
    (status) => {
      const parent = prepareTranscriptKnowledgeBatch(metadata(), [imageCall()], contracts);
      expect(() =>
        prepareTranscriptKnowledgeResult(
          {
            metadata: metadata(11, '2'),
            parent,
            ordinal: 0,
            status,
            result: { binding, detail: 'detail', materialized: true },
          },
          contracts,
        ),
      ).toThrow();
    },
  );
});
