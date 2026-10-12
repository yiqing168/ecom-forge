import { agentConfirmedFactDependencySchema, type AgentTranscriptItem } from '@ecom-forge/agent';
import { attachmentSnapshotSchema } from '@ecom-forge/compiler';
import { and, assets, eq, productFactSets, products, type Database } from '@ecom-forge/db';
import { canonicalSha256 } from '@ecom-forge/shared';

import { AgentTranscriptConfirmationBinding } from './agent-transcript-confirmation-binding.js';
import {
  AgentTranscriptPreviousAttemptFailureBinding,
  PREVIOUS_ATTEMPT_FAILURE_CONTEXT_NAME,
} from './agent-transcript-failure-context.js';
import { AgentTranscriptKnowledgeBinding } from './agent-transcript-knowledge-binding.js';
import {
  AgentTranscriptUserMessageAuthorizer,
  verifyTranscriptUserMessageSource,
} from './agent-transcript-message-binding.js';
import { nativeTranscriptContracts } from './agent-transcript-native.js';
import { AgentTranscriptCoreSkillBinding } from './agent-transcript-skill-binding.js';
import { transcriptSkillDependencySchema } from './agent-transcript-skill-context.js';
import { AgentTranscriptSkillResources } from './agent-transcript-skill-resources.js';
import { AgentTranscriptTerminalBinding } from './agent-transcript-terminal-binding.js';
import { AgentTranscriptRepository } from './agent-transcript.repository.js';
import { AgentTranscriptCoreSkillReader } from './agent-transcript-skill-reader.js';
import { AgentTranscriptRuntimePolicyBinding } from './agent-transcript-policy-context.js';
import { transcriptLoadedSkillSchema } from './agent-transcript-tool-contracts.js';
import type { AgentReadQuery } from './agent-turn.types.js';

export class NativeTranscriptDependencies {
  private readonly images: AgentTranscriptUserMessageAuthorizer;
  private readonly skills: AgentTranscriptSkillResources;

  constructor(
    private readonly database: Pick<Database, 'query' | 'select'>,
    private readonly read: AgentReadQuery = async (build) => build(),
  ) {
    this.images = new AgentTranscriptUserMessageAuthorizer(database, read);
    this.skills = new AgentTranscriptSkillResources(database, read);
  }

  async authorize(
    userId: string,
    dependencies: readonly unknown[],
    sessionId?: string,
  ): Promise<boolean> {
    try {
      const images: unknown[] = [];
      const skills: unknown[] = [];
      const facts: Array<ReturnType<typeof agentConfirmedFactDependencySchema.parse>> = [];
      for (const raw of dependencies) {
        const value = nativeTranscriptContracts.resourceDependencySchema.parse(raw);
        if (canonicalSha256(value) !== canonicalSha256(raw)) return false;
        if (attachmentSnapshotSchema.safeParse(value).success) images.push(value);
        else if (transcriptSkillDependencySchema.safeParse(value).success) skills.push(value);
        else facts.push(agentConfirmedFactDependencySchema.parse(value));
      }
      // Empty dependency sets still require a live, eligible owner.
      if (
        !(await this.images.authorizeBindings(userId, images)) ||
        !(await this.skills.authorize(skills, sessionId ? { userId, sessionId } : undefined))
      )
        return false;
      for (const dependency of facts) {
        if (dependency.owner_user_id !== userId) return false;
        const source = await this.read(() =>
          this.database.query.assets.findFirst({
            where: and(eq(assets.id, dependency.source_asset_id), eq(assets.userId, userId)),
          }),
        );
        const product = await this.read(() =>
          this.database.query.products.findFirst({
            where: and(eq(products.id, dependency.product_id), eq(products.userId, userId)),
          }),
        );
        const facts = await this.read(() =>
          this.database.query.productFactSets.findFirst({
            where: and(
              eq(productFactSets.id, dependency.object_id),
              eq(productFactSets.userId, userId),
              eq(productFactSets.productId, dependency.product_id),
            ),
          }),
        );
        if (
          !source ||
          source.status !== 'ready' ||
          source.deletedAt !== null ||
          source.contentHash !== dependency.source_version ||
          source.productId !== dependency.product_id ||
          !product ||
          product.status !== 'active' ||
          !facts ||
          String(facts.versionNo) !== dependency.object_version ||
          facts.sourceAssetId !== source.id ||
          facts.sourceVersion !== source.contentHash ||
          facts.confirmedBy !== userId ||
          !facts.confirmedAt ||
          canonicalSha256(facts.factsJson) !== dependency.content_hash
        )
          return false;
      }
      return true;
    } catch {
      return false;
    }
  }
}

export function createNativeTranscriptReader(database: Pick<Database, 'query' | 'select'>) {
  const images = new AgentTranscriptUserMessageAuthorizer(database);
  const skills = new AgentTranscriptCoreSkillBinding(database);
  const confirmations = new AgentTranscriptConfirmationBinding(database);
  const terminal = new AgentTranscriptTerminalBinding(database, nativeTranscriptContracts);
  const knowledge = new AgentTranscriptKnowledgeBinding(database, nativeTranscriptContracts);
  const dependencies = new NativeTranscriptDependencies(database);
  const resourceReader = new AgentTranscriptCoreSkillReader(database);
  const policy = new AgentTranscriptRuntimePolicyBinding(database);
  const previousAttemptFailure = new AgentTranscriptPreviousAttemptFailureBinding(database);
  const hostName = (item: AgentTranscriptItem) =>
    item.payload_json.type === 'host_context' ? item.payload_json.name : null;
  requireHostContextVerifiers();
  const hostContextVerifiers: Record<string, (item: AgentTranscriptItem) => Promise<boolean>> = {
    'core_skill_knowledge@1': (item) => skills.verifySource(item),
    'confirmation_answer@1': (item) => confirmations.verifySource(item),
    'runtime_policy@1': (item) => policy.verifySource(item),
    [PREVIOUS_ATTEMPT_FAILURE_CONTEXT_NAME]: (item) => previousAttemptFailure.verifySource(item),
  };
  // Unhandled names fail closed. They must NOT fall through to another verifier: that would reject
  // the item and fail the entire read instead of skipping it, which is how a newly registered host
  // context could brick every session that contains it.
  const verifyHostSource = (item: AgentTranscriptItem) => {
    const name = hostName(item);
    const handler = name === null ? undefined : hostContextVerifiers[name];
    return handler ? handler(item) : Promise.resolve(false);
  };
  const authorizeHostDependencies = (item: AgentTranscriptItem) => {
    const name = hostName(item);
    if (name === 'core_skill_knowledge@1') return skills.authorizeDependencies(item, true);
    if (name === 'confirmation_answer@1') return confirmations.authorizeDependencies(item);
    return dependencies.authorize(item.user_id, item.resource_dependencies_json, item.session_id);
  };
  return new AgentTranscriptRepository(database, {
    itemContracts: nativeTranscriptContracts,
    materializeResources: async (item) => {
      const payload = item.payload_json;
      if (
        payload.type !== 'tool_result' ||
        payload.name !== 'load_skill@1' ||
        payload.status !== 'succeeded'
      )
        return [];
      if (payload.result.type !== 'inline')
        throw new Error('AGENT_TRANSCRIPT_ITEM_NOT_MODEL_VISIBLE');
      return resourceReader.materializeResources(
        transcriptLoadedSkillSchema.parse(payload.result.value).resources,
        true,
      );
    },
    verifyMessageSource: verifyTranscriptUserMessageSource,
    verifyHostContextSource: verifyHostSource,
    verifyToolResultSource: (input) =>
      input.parent.payload_json.type === 'assistant_output' &&
      input.parent.payload_json.mode === 'terminal'
        ? terminal.verifySource(input)
        : knowledge.verifySource(input),
    authorizeDependencies: ({ item }) =>
      item.item_type === 'user_message'
        ? images.authorize(item)
        : item.item_type === 'host_context'
          ? authorizeHostDependencies(item)
          : dependencies.authorize(item.user_id, item.resource_dependencies_json, item.session_id),
  });
}

/**
 * Every host-context name the reader knows how to verify.
 *
 * Kept as an explicit list (rather than derived from the handler table) so
 * `requireHostContextVerifiers` can compare it against the registered contracts: registering a new
 * host context without wiring a verifier then fails loudly at startup instead of failing every read
 * that contains the item.
 */
export const NATIVE_HOST_CONTEXT_VERIFIER_NAMES = [
  'core_skill_knowledge@1',
  'confirmation_answer@1',
  'runtime_policy@1',
  PREVIOUS_ATTEMPT_FAILURE_CONTEXT_NAME,
] as const;

export function requireHostContextVerifiers(): void {
  const handled = new Set<string>(NATIVE_HOST_CONTEXT_VERIFIER_NAMES);
  for (const contract of nativeTranscriptContracts.hostContexts) {
    if (!handled.has(contract.name))
      throw new Error('AGENT_TRANSCRIPT_HOST_CONTEXT_VERIFIER_MISSING');
  }
}
