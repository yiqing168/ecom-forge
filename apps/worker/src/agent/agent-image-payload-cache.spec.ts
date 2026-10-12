import { describe, expect, it, vi } from 'vitest';

import { AgentImagePayloadCache } from './agent-image-payload-cache.js';

const payload = (bytes: number) => ({
  media_type: 'image/webp' as const,
  bytes: new Uint8Array(bytes),
  width: 32,
  height: 32,
});

describe('AgentImagePayloadCache', () => {
  it('reuses overview and replaces it with detail without retaining both payloads', async () => {
    const cache = new AgentImagePayloadCache(10);
    const load = vi.fn().mockResolvedValueOnce(payload(6)).mockResolvedValueOnce(payload(8));

    const overview = await cache.getOrResolve('input-1:hash', 'overview', load);
    expect(await cache.getOrResolve('input-1:hash', 'overview', load)).toBe(overview);
    const detail = await cache.getOrResolve('input-1:hash', 'detail', load);

    expect(load).toHaveBeenCalledTimes(2);
    expect(detail.bytes.byteLength).toBe(8);
    expect(cache.size).toBe(1);
    expect(cache.bytesUsed).toBe(8);
  });

  it('fails closed when one payload or the total cache exceeds the turn budget', async () => {
    const cache = new AgentImagePayloadCache(10);

    await expect(
      cache.getOrResolve('input-1:hash', 'overview', () => Promise.resolve(payload(11))),
    ).rejects.toThrow('AGENT_IMAGE_MATERIALIZATION_LIMIT_EXCEEDED');
    expect(cache.size).toBe(0);
    expect(cache.bytesUsed).toBe(0);

    await cache.getOrResolve('input-1:hash', 'overview', () => Promise.resolve(payload(6)));
    await expect(
      cache.getOrResolve('input-2:hash', 'overview', () => Promise.resolve(payload(5))),
    ).rejects.toThrow('AGENT_IMAGE_MATERIALIZATION_LIMIT_EXCEEDED');
    expect(cache.size).toBe(1);
    expect(cache.bytesUsed).toBe(6);
  });

  it('retains the existing payload when a larger replacement cannot fit', async () => {
    const cache = new AgentImagePayloadCache(10);
    const overview = await cache.getOrResolve('input-1:hash', 'overview', () =>
      Promise.resolve(payload(6)),
    );

    await expect(
      cache.getOrResolve('input-1:hash', 'detail', () => Promise.resolve(payload(11))),
    ).rejects.toThrow('AGENT_IMAGE_MATERIALIZATION_LIMIT_EXCEEDED');
    expect(cache.bytesUsed).toBe(6);
    expect(
      await cache.getOrResolve('input-1:hash', 'overview', () => Promise.resolve(payload(11))),
    ).toBe(overview);
  });
});
