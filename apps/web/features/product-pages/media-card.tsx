'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, ImageOff, RefreshCw, ShieldAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/features/product-pages/ui';
import { artifactContentUrl, assetContentUrl, type Artifact, type Asset } from '@/lib/resource-api';

export type MediaItem = Asset | Artifact;

/**
 * In-app previews use a session-authenticated, fixed content URL
 * (`/api/v1/artifacts|assets/{id}/content?variant=thumbnail&purpose=preview`).
 * Same-origin `<img>` requests carry the session cookie automatically, so there
 * is no per-image signed-URL round trip. The backend applies media rate limits
 * and serves `Cache-Control: private, no-cache` plus ETag/304, so reuse of cached
 * bytes rechecks authorization and the current representation.
 * Signed URLs remain only for download/share paths (see `artifactAccessUrl`).
 */
export function isAsset(item: MediaItem): item is Asset {
  return 'display_name' in item;
}

function itemLabel(item: MediaItem): string {
  return isAsset(item)
    ? item.display_name
    : `${item.type === 'image' ? '图片' : item.type === 'video' ? '视频' : '文本'}作品`;
}

function itemStatusLabel(item: MediaItem): string {
  if (!isAsset(item)) {
    if (item.visibility === 'quarantined') return '隔离中';
    if (item.visibility === 'deleted') return '已删除';
    return '已完成';
  }
  return {
    deleted: '已删除',
    processing: '处理中',
    processing_failed: '处理失败',
    ready: '已完成',
    rejected: '已拒绝',
    uploading: '等待上传',
  }[item.status];
}

type ImageState = 'loading' | 'ready' | 'error' | 'empty';

export function MediaCard({
  active,
  item,
  onClick,
  onRetry,
  retrying,
  selectable,
  showDetails = true,
  waterfall = false,
}: {
  active: boolean;
  item: MediaItem;
  onClick: () => void;
  onRetry?: () => void;
  retrying: boolean;
  selectable: boolean;
  showDetails?: boolean;
  waterfall?: boolean;
}) {
  const safeLabel = itemLabel(item);
  const status = itemStatusLabel(item);
  const previewable = isAsset(item)
    ? item.status === 'ready'
    : !['quarantined', 'deleted'].includes(item.visibility);
  const width = item.width;
  const height = item.height;
  const aspectRatio =
    width && height && width > 0 && height > 0
      ? `${width} / ${height}`
      : showDetails
        ? '1 / 1'
        : '3 / 4';

  const isAssetItem = isAsset(item);
  const itemId = item.id;
  const itemType = isAssetItem ? undefined : item.type;
  // Fixed, session-authenticated preview URL — no request needed from the
  // client, so nothing to cache or coalesce here.
  const contentUrl = isAssetItem ? assetContentUrl(itemId) : artifactContentUrl(itemId);

  const [imageState, setImageState] = useState<ImageState>(() =>
    previewable && itemType !== 'text' ? 'loading' : 'empty',
  );
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    setImageState(previewable && itemType !== 'text' ? 'loading' : 'empty');
  }, [isAssetItem, itemId, itemType, previewable]);

  const retryPreview = useCallback(() => {
    setImageState('loading');
    // Remounts the <img> via `key` so the browser re-fetches without busting the
    // cache (the URL is unchanged, so a cached 304 still applies).
    setReloadToken((current) => current + 1);
  }, []);

  const imageFailed = imageState === 'error';
  const imageMissing = imageState === 'empty';

  return (
    <div className={waterfall ? 'mb-3 break-inside-avoid' : undefined}>
      <div className="relative">
        <button
          aria-label={`选择${safeLabel}`}
          aria-pressed={active}
          className="group block w-full text-left outline-none"
          disabled={!selectable}
          onClick={onClick}
          type="button"
        >
          <div
            className={`relative overflow-hidden rounded-lg border-2 bg-white ${active ? 'border-[var(--primary)] ring-2 ring-[var(--focus-soft)]' : 'border-transparent'}`}
            style={{ aspectRatio }}
          >
            {previewable && itemType !== 'text' && imageState !== 'error' ? (
              <>
                {imageState === 'loading' ? (
                  <div
                    aria-hidden="true"
                    className="absolute inset-0 animate-pulse bg-[var(--media-placeholder)]/60"
                  />
                ) : null}
                <img
                  // `key` forces a clean remount on retry so the browser
                  // re-fetches the (unchanged) URL without us touching the cache.
                  key={reloadToken}
                  alt={safeLabel}
                  className="absolute inset-0 size-full object-contain transition-[opacity,transform] duration-300 group-hover:scale-[1.02]"
                  loading="lazy"
                  onError={() => setImageState('error')}
                  onLoad={() => setImageState('ready')}
                  src={contentUrl}
                />
              </>
            ) : imageMissing ? (
              <div className="absolute inset-0 grid size-full place-items-center bg-[var(--soft)] px-3 text-center">
                <div className="flex flex-col items-center gap-1.5 text-[var(--muted-foreground)]">
                  <ImageOff aria-hidden="true" size={22} />
                  <span className="text-xs">无预览图</span>
                </div>
              </div>
            ) : null}
            {active ? (
              <span className="absolute right-2 top-2 grid size-7 place-items-center rounded-full bg-[var(--primary)] text-white">
                <Check aria-hidden="true" size={15} />
              </span>
            ) : null}
            {status === '隔离中' || status === '已拒绝' ? (
              <span className="absolute inset-0 grid place-items-center bg-white/82">
                <ShieldAlert aria-hidden="true" className="text-[var(--danger)]" size={24} />
                <span className="sr-only">{status}</span>
              </span>
            ) : null}
          </div>
          {showDetails ? (
            <div className="flex items-start justify-between gap-2 pt-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{safeLabel}</p>
                <p className="mt-0.5 text-xs text-[var(--muted-foreground)]">
                  {isAsset(item)
                    ? item.origin
                    : item.origin_domain === 'commerce'
                      ? '电商创作'
                      : '创意创作'}
                </p>
              </div>
              <StatusBadge status={status} />
            </div>
          ) : null}
        </button>
        {/*
        The preview failure state must stay OUTSIDE the card button: nesting an
        interactive retry control inside it produces an invalid <button> in
        <button> DOM. It is rendered as a sibling overlay covering exactly the
        preview box (same aspect ratio, anchored to the top of the card), and it
        is pointer-events-none so selecting the card still works everywhere
        except the retry control itself.
      */}
        {imageFailed ? (
          <div
            className="pointer-events-none absolute inset-x-0 top-0 grid place-items-center bg-[var(--soft)] px-3 text-center"
            style={{ aspectRatio }}
          >
            <div className="flex flex-col items-center gap-1.5 text-[var(--danger)]">
              <ImageOff aria-hidden="true" size={22} />
              <span className="text-xs font-medium">图片加载失败</span>
              <button
                aria-label="重试加载图片"
                className="pointer-events-auto mt-1 inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--foreground)] outline-none transition-colors hover:bg-[var(--soft-strong)] focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
                onClick={(event) => {
                  event.stopPropagation();
                  retryPreview();
                }}
                type="button"
              >
                <RefreshCw aria-hidden="true" size={12} />
                重试
              </button>
            </div>
          </div>
        ) : null}
      </div>
      {isAsset(item) && item.status === 'processing_failed' && onRetry ? (
        <Button
          className="mt-2 w-full"
          disabled={retrying}
          onClick={onRetry}
          size="sm"
          variant="outline"
        >
          <RefreshCw aria-hidden="true" size={14} />
          {retrying ? '已提交…' : '重试处理'}
        </Button>
      ) : null}
    </div>
  );
}
