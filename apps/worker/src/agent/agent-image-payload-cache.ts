import type { AgentBrainImageDetail, AgentBrainImagePayload } from '@ecom-forge/agent';

type ImagePayloadLoader = () => Promise<AgentBrainImagePayload>;

type CacheEntry = {
  detail: AgentBrainImageDetail;
  payload: AgentBrainImagePayload;
};

/** Keeps only one materialized representation per authorized image in a turn. */
export class AgentImagePayloadCache {
  private readonly entries = new Map<string, CacheEntry>();
  private totalBytes = 0;

  constructor(private readonly maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error('AGENT_IMAGE_MATERIALIZATION_LIMIT_INVALID');
    }
  }

  async getOrResolve(
    key: string,
    detail: AgentBrainImageDetail,
    load: ImagePayloadLoader,
  ): Promise<AgentBrainImagePayload> {
    const cached = this.entries.get(key);
    if (cached && (cached.detail === 'detail' || cached.detail === detail)) {
      return cached.payload;
    }

    const payload = await load();
    const nextBytes = payload.bytes.byteLength;
    const previousBytes = cached?.payload.bytes.byteLength ?? 0;
    const totalAfterReplacement = this.totalBytes - previousBytes + nextBytes;
    if (nextBytes <= 0 || totalAfterReplacement > this.maxBytes) {
      throw new Error('AGENT_IMAGE_MATERIALIZATION_LIMIT_EXCEEDED');
    }

    this.entries.set(key, { detail, payload });
    this.totalBytes = totalAfterReplacement;
    return payload;
  }

  get bytesUsed(): number {
    return this.totalBytes;
  }

  get size(): number {
    return this.entries.size;
  }
}
