import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/lib/resource-api', () => ({
  artifactAccessUrl: vi.fn(),
  assetAccessUrl: vi.fn(),
}));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { artifactAccessUrl, assetAccessUrl } from '@/lib/resource-api';

import {
  ResourceImageViewerProvider,
  useResourceImageViewer,
  type ViewableImage,
} from './resource-image-viewer';

const gallery: ViewableImage[] = [
  { alt: '源图', id: 'asset-1', resourceType: 'asset' },
  { alt: '生成图', id: 'artifact-1', resourceType: 'artifact' },
];

function ViewerTrigger({ index = 0 }: { index?: number }) {
  const { open } = useResourceImageViewer();
  return (
    <button onClick={() => open(gallery, index)} type="button">
      打开画廊
    </button>
  );
}

beforeEach(() => {
  vi.mocked(assetAccessUrl).mockReset();
  vi.mocked(artifactAccessUrl).mockReset();
});

afterEach(cleanup);

describe('ResourceImageViewerProvider', () => {
  it('opens the selected original and isolates a failed neighboring image', async () => {
    vi.mocked(assetAccessUrl).mockResolvedValue({
      url: 'https://signed.example/asset-original',
      expires_at: '2026-08-30T01:00:00.000Z',
    });
    vi.mocked(artifactAccessUrl).mockRejectedValue(new Error('artifact unavailable'));
    render(
      <ResourceImageViewerProvider>
        <ViewerTrigger />
      </ResourceImageViewerProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开画廊' }));

    expect(await screen.findByLabelText('图片查看器')).toBeTruthy();
    expect(screen.queryByTitle('上一张图片')).toBeNull();
    expect(screen.queryByTitle('下一张图片')).toBeNull();
    expect(assetAccessUrl).toHaveBeenCalledWith('asset-1', 'original', 'preview');
  });

  it('keeps the loading dialog open with retry when the selected image fails', async () => {
    vi.mocked(assetAccessUrl).mockResolvedValue({
      url: 'https://signed.example/asset-original',
      expires_at: '2026-08-30T01:00:00.000Z',
    });
    vi.mocked(artifactAccessUrl).mockRejectedValue(new Error('原图授权已失效'));
    render(
      <ResourceImageViewerProvider>
        <ViewerTrigger index={1} />
      </ResourceImageViewerProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开画廊' }));

    expect(await screen.findByText('原图授权已失效')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
    expect(screen.queryByLabelText('图片查看器')).toBeNull();
  });

  it('does not silently replace a server-backed original with its preview', async () => {
    vi.mocked(assetAccessUrl).mockRejectedValue(new Error('原图授权已失效'));
    render(
      <ResourceImageViewerProvider>
        <ViewerTrigger />
      </ResourceImageViewerProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开画廊' }));

    expect(await screen.findByText('原图授权已失效')).toBeTruthy();
    expect(screen.queryByLabelText('图片查看器')).toBeNull();
  });
});
