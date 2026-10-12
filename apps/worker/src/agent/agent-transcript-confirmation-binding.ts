import {
  agentConfirmationContextSchema,
  agentConfirmationDependencies,
  normalizeAgentProductFacts,
  prepareAgentConfirmationContext,
  type AgentTranscriptItem,
} from '@ecom-forge/agent';
import {
  agentTurnConfirmations,
  and,
  assets,
  eq,
  productFactSets,
  products,
  users,
  type Database,
} from '@ecom-forge/db';
import { canonicalJson } from '@ecom-forge/shared';
import { z } from 'zod';

const confirmationResponseSchema = z.strictObject({
  turn_id: z.uuid(),
  user_status: z.literal('thinking'),
  revision: z.int().positive(),
  continuation_no: z.int().positive(),
  event_scope: z.string(),
  last_event_seq: z.int().positive(),
});

/** Called only inside the repository's owned session/turn fence. No confirmation is consumed. */
export class AgentTranscriptConfirmationBinding {
  constructor(private readonly database: Pick<Database, 'query'>) {}

  async verifySource(item: AgentTranscriptItem): Promise<boolean> {
    return (await this.readSource(item)) !== null;
  }

  async authorizeDependencies(item: AgentTranscriptItem): Promise<boolean> {
    try {
      const content = await this.readSource(item);
      if (
        !content ||
        canonicalJson(item.resource_dependencies_json) !==
          canonicalJson(agentConfirmationDependencies(item.user_id, content))
      )
        return false;
      const user = await this.database.query.users.findFirst({
        where: eq(users.id, item.user_id),
        columns: { id: true, riskStatus: true },
      });
      if (!user || user.id !== item.user_id || user.riskStatus !== 'normal') return false;
      if (content.confirmation_type === 'clarification') return true;

      const source = await this.database.query.assets.findFirst({
        where: and(eq(assets.id, content.source_asset_id), eq(assets.userId, item.user_id)),
        columns: {
          id: true,
          userId: true,
          status: true,
          deletedAt: true,
          contentHash: true,
          productId: true,
        },
      });
      if (
        !source ||
        source.id !== content.source_asset_id ||
        source.userId !== item.user_id ||
        source.status !== 'ready' ||
        source.deletedAt !== null ||
        source.contentHash !== content.source_version ||
        source.productId !== content.answer.product_id
      )
        return false;
      const product = await this.database.query.products.findFirst({
        where: and(eq(products.id, content.answer.product_id), eq(products.userId, item.user_id)),
        columns: { id: true, userId: true, status: true },
      });
      if (
        !product ||
        product.id !== content.answer.product_id ||
        product.userId !== item.user_id ||
        product.status !== 'active'
      )
        return false;
      const factSet = await this.database.query.productFactSets.findFirst({
        where: and(
          eq(productFactSets.id, content.answer.fact_set_id),
          eq(productFactSets.userId, item.user_id),
          eq(productFactSets.productId, content.answer.product_id),
          eq(productFactSets.versionNo, content.answer.fact_set_version),
        ),
        columns: {
          id: true,
          userId: true,
          productId: true,
          versionNo: true,
          sourceAssetId: true,
          sourceVersion: true,
          confirmedAt: true,
          confirmedBy: true,
          factsJson: true,
        },
      });
      return (
        !!factSet &&
        factSet.id === content.answer.fact_set_id &&
        factSet.userId === item.user_id &&
        factSet.productId === content.answer.product_id &&
        factSet.versionNo === content.answer.fact_set_version &&
        factSet.sourceAssetId === content.source_asset_id &&
        factSet.sourceVersion === content.source_version &&
        factSet.confirmedBy === item.user_id &&
        factSet.confirmedAt instanceof Date &&
        Number.isFinite(factSet.confirmedAt.getTime()) &&
        canonicalJson(factSet.factsJson) ===
          canonicalJson(normalizeAgentProductFacts(content.answer.facts))
      );
    } catch {
      return false;
    }
  }

  private async readSource(item: AgentTranscriptItem) {
    try {
      const payload = item.payload_json;
      if (
        item.item_type !== 'host_context' ||
        payload.type !== 'host_context' ||
        payload.name !== 'confirmation_answer@1' ||
        payload.content.type !== 'inline' ||
        item.import_attempt_id !== null ||
        !item.turn_id ||
        !item.continuation_no ||
        item.source_message_id !== null ||
        item.source_trace_step_id !== null
      )
        return null;
      const parsed = agentConfirmationContextSchema.safeParse(payload.content.value);
      if (!parsed.success || canonicalJson(parsed.data) !== canonicalJson(payload.content.value))
        return null;
      const content = parsed.data;
      if (item.source_key !== `confirmation:${content.confirmation_id}:answered`) return null;
      const row = await this.database.query.agentTurnConfirmations.findFirst({
        where: and(
          eq(agentTurnConfirmations.id, content.confirmation_id),
          eq(agentTurnConfirmations.userId, item.user_id),
          eq(agentTurnConfirmations.turnId, item.turn_id),
        ),
        columns: {
          id: true,
          userId: true,
          turnId: true,
          type: true,
          status: true,
          answerSchemaVersion: true,
          publicPayloadJson: true,
          payloadDigest: true,
          answerJson: true,
          responseJson: true,
          answeredAt: true,
        },
      });
      if (
        !row ||
        row.id !== content.confirmation_id ||
        row.userId !== item.user_id ||
        row.turnId !== item.turn_id ||
        row.status !== 'answered' ||
        !(row.answeredAt instanceof Date) ||
        !Number.isFinite(row.answeredAt.getTime())
      )
        return null;
      const response = confirmationResponseSchema.safeParse(row.responseJson);
      if (
        !response.success ||
        response.data.turn_id !== item.turn_id ||
        response.data.continuation_no !== item.continuation_no ||
        response.data.event_scope !== `turn:${item.turn_id}`
      )
        return null;
      const original = prepareAgentConfirmationContext(row);
      return original && canonicalJson(original) === canonicalJson(content) ? original : null;
    } catch {
      return null;
    }
  }
}
