import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/resource-api', () => ({
  MAX_ASSET_UPLOAD_BYTES: 20 * 1024 * 1024,
  assetAccessUrl: vi.fn((id: string) =>
    Promise.resolve({
      url: `/api/v1/assets/${id}/thumbnail`,
      expires_at: '2026-09-30T00:00:00.000Z',
    }),
  ),
  listAssets: vi.fn(),
  uploadAsset: vi.fn(),
}));

import { listAssets } from '@/lib/resource-api';

import { AttachmentPickerDialog } from './attachment-picker-dialog';

const emptyAttachments: [] = [];

function asset(id: string) {
  return {
    id,
    status: 'ready',
    content_version: `version-${id}`,
    origin: 'upload',
    product_id: null,
    folder_id: null,
    processing_error_code: null,
    width: 100,
    height: 100,
    preview: { variant: 'thumbnail' },
    created_at: '2026-09-29T00:00:00.000Z',
    display_name: id,
    kind: 'upload',
  } satisfies Awaited<ReturnType<typeof listAssets>>['items'][number];
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('AttachmentPickerDialog', () => {
  it('loads and selects an older asset from a later page', async () => {
    vi.mocked(listAssets)
      .mockResolvedValueOnce({ items: [asset('recent')], next_cursor: 'page-2' })
      .mockResolvedValueOnce({ items: [asset('older')], next_cursor: null });
    const onConfirm = vi.fn();
    render(
      <AttachmentPickerDialog
        currentAttachments={emptyAttachments}
        onConfirm={onConfirm}
        onOpenChange={vi.fn()}
        open
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: '加载更多' }));
    await screen.findByText('older');
    expect(listAssets).toHaveBeenNthCalledWith(2, { cursor: 'page-2' });
    fireEvent.click(screen.getByText('older').closest('button')!);
    fireEvent.click(screen.getByRole('button', { name: '加入本次输入' }));
    expect(onConfirm).toHaveBeenCalledWith([expect.objectContaining({ id: 'older' })]);
  });

  it('keeps the cursor available after a failed page load so it can be retried', async () => {
    vi.mocked(listAssets)
      .mockResolvedValueOnce({ items: [asset('recent')], next_cursor: 'page-2' })
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({ items: [asset('older')], next_cursor: null });
    render(
      <AttachmentPickerDialog
        currentAttachments={emptyAttachments}
        onConfirm={vi.fn()}
        onOpenChange={vi.fn()}
        open
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: '加载更多' }));
    await screen.findByText('temporary failure');
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
    await waitFor(() => expect(screen.getByText('older')).toBeTruthy());
    expect(listAssets).toHaveBeenCalledTimes(3);
  });
});
