import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/layout/product-shell', () => ({
  ProductShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/lib/resource-api', () => {
  // Mirrors the real ResourceApiError, which media-card matches on via
  // `instanceof`. Defining it inside the factory keeps the mock hoist-safe and
  // gives the specs and the component the *same* class object.
  class ResourceApiError extends Error {
    constructor(
      readonly code: string,
      readonly status: number,
      message: string,
    ) {
      super(message);
      this.name = 'ResourceApiError';
    }
  }
  return {
    ResourceApiError,
    artifactAccessUrl: vi.fn(),
    artifactContentUrl: (id: string, variant = 'thumbnail') =>
      `/api/v1/artifacts/${encodeURIComponent(id)}/content?variant=${variant}&purpose=preview`,
    assetAccessUrl: vi.fn(),
    assetContentUrl: (id: string, variant = 'thumbnail') =>
      `/api/v1/assets/${encodeURIComponent(id)}/content?variant=${variant}&purpose=preview`,
    listArtifacts: vi.fn(),
    listAssets: vi.fn(),
    listProducts: vi.fn(),
    retryAsset: vi.fn(),
    saveArtifactToAssets: vi.fn(),
    uploadAsset: vi.fn(),
  };
});

import { ArtifactsPage, AssetsPage } from './media-library-pages';
import {
  artifactAccessUrl,
  assetAccessUrl,
  listArtifacts,
  listAssets,
  listProducts,
  retryAsset,
  saveArtifactToAssets,
  type Artifact,
  type Asset,
} from '@/lib/resource-api';

const failedAsset: Asset = {
  id: '11111111-1111-4111-8111-111111111111',
  display_name: '失败素材.png',
  product_id: null,
  folder_id: null,
  kind: 'upload',
  origin: 'upload',
  status: 'processing_failed',
  processing_error_code: 'THUMBNAIL_FAILED',
  width: 20,
  height: 20,
  content_version: 'hash',
  preview: null,
  created_at: '2026-08-13T00:00:00.000Z',
};

const quarantined: Artifact = {
  id: '22222222-2222-4222-8222-222222222222',
  product_id: null,
  type: 'image',
  origin_domain: 'creative',
  producer_mode: 'chat',
  source_action: 'generate',
  visibility: 'quarantined',
  created_at: '2026-08-13T00:00:00.000Z',
};

beforeEach(() => {
  vi.mocked(listProducts).mockReset().mockResolvedValue({ items: [], next_cursor: null });
  vi.mocked(listAssets).mockReset().mockResolvedValue({ items: [], next_cursor: null });
  vi.mocked(listArtifacts).mockReset().mockResolvedValue({ items: [], next_cursor: null });
  vi.mocked(retryAsset)
    .mockReset()
    .mockResolvedValue({ ...failedAsset, status: 'processing' });
  vi.mocked(saveArtifactToAssets).mockReset().mockResolvedValue(failedAsset);
  vi.mocked(artifactAccessUrl).mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('S10 media pages', () => {
  it('offers explicit retry only for a failed asset', async () => {
    vi.mocked(listAssets).mockResolvedValue({ items: [failedAsset], next_cursor: null });
    render(<AssetsPage />);

    fireEvent.click(await screen.findByRole('button', { name: '重试处理' }));
    await waitFor(() => expect(retryAsset).toHaveBeenCalledWith(failedAsset.id));
  });

  it('does not request a preview capability for a quarantined artifact', async () => {
    vi.mocked(listArtifacts).mockResolvedValue({ items: [quarantined], next_cursor: null });
    render(<ArtifactsPage />);

    expect((await screen.findAllByText('隔离中')).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: '选择图片作品' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(artifactAccessUrl).not.toHaveBeenCalled();
  });

  it('saves a selected visible artifact through the server API', async () => {
    const visible = { ...quarantined, visibility: 'private' as const };
    vi.mocked(listArtifacts).mockResolvedValue({ items: [visible], next_cursor: null });
    vi.mocked(artifactAccessUrl).mockResolvedValue({
      url: '/api/v1/artifacts/preview',
      expires_at: '2026-08-13T00:05:00.000Z',
    });
    render(<ArtifactsPage />);

    fireEvent.click(await screen.findByRole('button', { name: '选择图片作品' }));
    fireEvent.click(screen.getByRole('button', { name: '存入资产库' }));

    await waitFor(() => expect(saveArtifactToAssets).toHaveBeenCalledWith(visible.id, {}));
    expect(await screen.findByText('已将 1 个作品存入资产库')).toBeTruthy();
  });

  it('renders artifacts as an image-only waterfall without card details', async () => {
    const visible = { ...quarantined, visibility: 'private' as const };
    vi.mocked(listArtifacts).mockResolvedValue({ items: [visible], next_cursor: null });
    vi.mocked(artifactAccessUrl).mockResolvedValue({
      url: '/api/v1/artifacts/preview',
      expires_at: '2026-08-13T00:05:00.000Z',
    });
    const { container } = render(<ArtifactsPage />);

    const image = await screen.findByRole('img');
    expect(container.querySelector('.columns-2')).toBeTruthy();
    expect(image.closest('button')?.querySelectorAll('p')).toHaveLength(0);
  });

  it('loads the next artifact page at the sentinel and shows the end state', async () => {
    let triggerIntersection: ((isIntersecting: boolean) => void) | undefined;
    class MockIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) {
        triggerIntersection = (isIntersecting) =>
          callback(
            [{ isIntersecting } as IntersectionObserverEntry] as IntersectionObserverEntry[],
            this as unknown as IntersectionObserver,
          );
      }

      disconnect() {}
      observe() {}
      unobserve() {}
    }
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);

    const first = { ...quarantined, visibility: 'private' as const };
    const second = { ...first, id: '33333333-3333-4333-8333-333333333333' };
    vi.mocked(listArtifacts)
      .mockResolvedValueOnce({ items: [first], next_cursor: 'cursor-1' })
      .mockResolvedValueOnce({ items: [second], next_cursor: null });
    vi.mocked(artifactAccessUrl).mockResolvedValue({
      url: '/api/v1/artifacts/preview',
      expires_at: '2026-08-13T00:05:00.000Z',
    });
    render(<ArtifactsPage />);

    await screen.findByRole('img');
    await waitFor(() => expect(listArtifacts).toHaveBeenCalledTimes(1));
    triggerIntersection?.(true);

    await waitFor(() => {
      expect(listArtifacts).toHaveBeenCalledTimes(2);
      expect(listArtifacts).toHaveBeenLastCalledWith({ cursor: 'cursor-1' });
    });
    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(2));
    expect(await screen.findByText('已到底')).toBeTruthy();
  });

  it('keeps the pagination cursor while polling processing assets', async () => {
    vi.useFakeTimers();
    let triggerIntersection: (() => void) | undefined;
    class MockIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) {
        triggerIntersection = () =>
          callback(
            [{ isIntersecting: true } as IntersectionObserverEntry] as IntersectionObserverEntry[],
            this as unknown as IntersectionObserver,
          );
      }

      disconnect() {}
      observe() {}
      unobserve() {}
    }
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);

    const processing = { ...failedAsset, status: 'processing' as const };
    const ready = { ...processing, status: 'ready' as const };
    const next = { ...ready, id: '44444444-4444-4444-8444-444444444444' };
    vi.mocked(listAssets)
      .mockResolvedValueOnce({ items: [processing], next_cursor: 'asset-cursor-1' })
      .mockResolvedValueOnce({ items: [ready], next_cursor: 'asset-cursor-from-poll' })
      .mockResolvedValueOnce({ items: [next], next_cursor: null });
    vi.mocked(assetAccessUrl).mockResolvedValue({
      url: '/api/v1/assets/preview',
      expires_at: '2026-08-13T00:05:00.000Z',
    });
    render(<AssetsPage />);

    await act(async () => {
      vi.advanceTimersByTime(180);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(vi.mocked(listAssets)).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1500);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(vi.mocked(listAssets)).toHaveBeenCalledTimes(2);

    triggerIntersection?.();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(vi.mocked(listAssets)).toHaveBeenLastCalledWith({ cursor: 'asset-cursor-1' });
  });

  it('shows a failure state (not the status text) when the preview image fails to load', async () => {
    const visible = { ...quarantined, visibility: 'private' as const };
    vi.mocked(listArtifacts).mockResolvedValue({ items: [visible], next_cursor: null });
    render(<ArtifactsPage />);

    const image = await screen.findByRole('img');
    fireEvent.error(image);

    expect(await screen.findByText('图片加载失败')).toBeTruthy();
    expect(screen.queryByText('已完成')).toBeNull();
    expect(screen.getByRole('button', { name: '重试加载图片' })).toBeTruthy();
  });

  it('falls back to the failure state when the rendered image fails to load', async () => {
    const visible = { ...quarantined, visibility: 'private' as const };
    vi.mocked(listArtifacts).mockResolvedValue({ items: [visible], next_cursor: null });
    render(<ArtifactsPage />);

    const image = await screen.findByRole('img', undefined, { timeout: 2000 });
    fireEvent.error(image);

    expect(await screen.findByText('图片加载失败')).toBeTruthy();
    expect(screen.queryByText('已完成')).toBeNull();
  });

  it('renders a neutral empty state for a text artifact instead of the status text', async () => {
    const textArtifact: Artifact = {
      ...quarantined,
      visibility: 'private',
      type: 'text',
    };
    vi.mocked(listArtifacts).mockResolvedValue({ items: [textArtifact], next_cursor: null });
    render(<ArtifactsPage />);

    expect(await screen.findByText('无预览图')).toBeTruthy();
    expect(screen.queryByText('已完成')).toBeNull();
    expect(artifactAccessUrl).not.toHaveBeenCalled();
  });

  it('shows the loading skeleton before the preview resolves', async () => {
    const visible = { ...quarantined, visibility: 'private' as const };
    vi.mocked(listArtifacts).mockResolvedValue({ items: [visible], next_cursor: null });
    const { container } = render(<ArtifactsPage />);

    // The card only mounts once the artifact list resolves, and the skeleton
    // appears while the image is still loading.
    await screen.findByRole('button', { name: '选择图片作品' });
    await waitFor(() => expect(container.querySelector('.animate-pulse')).toBeTruthy());

    expect(screen.queryByText('已完成')).toBeNull();
  });

  it('recovers into the image after pressing the preview retry button', async () => {
    const visible = { ...quarantined, visibility: 'private' as const };
    vi.mocked(listArtifacts).mockResolvedValue({ items: [visible], next_cursor: null });
    render(<ArtifactsPage />);

    const image = await screen.findByRole('img');
    fireEvent.error(image);
    expect(await screen.findByText('图片加载失败')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '重试加载图片' }));
    const retried = await screen.findByRole('img');
    fireEvent.load(retried);

    expect(screen.queryByText('图片加载失败')).toBeNull();
    expect(screen.getByRole('img')).toBeTruthy();
  });

  it('renders a session-authenticated content URL for an artifact preview', async () => {
    const visible = { ...quarantined, visibility: 'private' as const };
    vi.mocked(listArtifacts).mockResolvedValue({ items: [visible], next_cursor: null });
    render(<ArtifactsPage />);

    const image = await screen.findByRole('img');
    expect(image.getAttribute('src')).toBe(
      `/api/v1/artifacts/${visible.id}/content?variant=thumbnail&purpose=preview`,
    );
    expect(artifactAccessUrl).not.toHaveBeenCalled();
  });

  it('renders a session-authenticated content URL for an asset preview', async () => {
    const ready = { ...failedAsset, status: 'ready' as const };
    vi.mocked(listAssets).mockResolvedValue({ items: [ready], next_cursor: null });
    render(<AssetsPage />);

    const image = await screen.findByRole('img');
    expect(image.getAttribute('src')).toBe(
      `/api/v1/assets/${ready.id}/content?variant=thumbnail&purpose=preview`,
    );
    expect(assetAccessUrl).not.toHaveBeenCalled();
  });
});
