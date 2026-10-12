import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { listModels, listSkills } from '@/lib/agent-api';

import { useAgentCatalogs } from './use-agent-catalogs';

vi.mock('@/lib/agent-api', () => ({
  listModels: vi.fn(),
  listSkills: vi.fn(),
}));

describe('useAgentCatalogs', () => {
  beforeEach(() => {
    vi.mocked(listModels).mockReset();
    vi.mocked(listSkills).mockReset().mockResolvedValue(skillCatalog());
  });

  it('fails closed on mixed revisions and recovers only after an explicit reload', async () => {
    let consistent = false;
    vi.mocked(listModels).mockImplementation((category) =>
      Promise.resolve(modelCatalog(category === 'image' && !consistent ? 8 : 7)),
    );
    const { result } = renderHook(() => useAgentCatalogs(true));

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.brainModels).toBeNull();
    expect(result.current.error).toContain('更新');

    consistent = true;
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.imageModels?.catalog_revision).toBe(7);
    expect(listModels).toHaveBeenCalledTimes(6);
  });

  it('ignores an obsolete load after the hook is disabled', async () => {
    let resolveModels: ((value: ReturnType<typeof modelCatalog>) => void) | undefined;
    vi.mocked(listModels).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveModels = resolve;
        }),
    );
    const { result, rerender } = renderHook(({ enabled }) => useAgentCatalogs(enabled), {
      initialProps: { enabled: true },
    });
    await waitFor(() => expect(result.current.status).toBe('loading'));

    rerender({ enabled: false });
    act(() => resolveModels?.(modelCatalog(7)));
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.skills).toBeNull();
  });
});

function modelCatalog(catalogRevision: number) {
  return { catalog_revision: catalogRevision, items: [] };
}

function skillCatalog() {
  return {
    catalog_version: 'catalog-v1',
    response_version: 'response-v1',
    generation_policy: {
      schema_version: 2 as const,
      policy_version: 'policy-v1',
    },
    items: [],
  };
}
