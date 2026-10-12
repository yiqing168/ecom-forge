'use client';

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Download, Save, Upload } from 'lucide-react';

import { ProductShell } from '@/components/layout/product-shell';
import { Button } from '@/components/ui/button';
import { MediaCard, isAsset, type MediaItem } from '@/features/product-pages/media-card';
import { FilterBar, PageHeader } from '@/features/product-pages/ui';
import {
  artifactAccessUrl,
  assetAccessUrl,
  listArtifacts,
  listAssets,
  listProducts,
  retryAsset,
  saveArtifactToAssets,
  uploadAsset,
  type Product,
} from '@/lib/resource-api';

function triggerDownload(url: string, filename: string) {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

function MediaLibrary({
  activeItem,
  description,
  title,
}: {
  activeItem: '作品' | '资产';
  description: string;
  title: string;
}) {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [productId, setProductId] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState('');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [uploading, setUploading] = useState(false);
  const [acting, setActing] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const isAssets = activeItem === '资产';

  const loadMoreRef = useRef<HTMLDivElement>(null);
  const nextCursorRef = useRef<string | null>(null);
  const loadingMoreRef = useRef(false);
  const requestVersionRef = useRef(0);
  const assetPollTimerRef = useRef<number | null>(null);
  const assetPollAttemptRef = useRef(0);
  const hasPendingAssets =
    isAssets &&
    items.some((item) => isAsset(item) && ['processing', 'uploading'].includes(item.status));

  async function load(
    options: { append?: boolean; preserveLoadedPages?: boolean; quiet?: boolean } = {},
  ) {
    const append = options.append ?? false;
    if (append) {
      if (loadingMoreRef.current || !nextCursorRef.current) return;
      loadingMoreRef.current = true;
      setLoadingMore(true);
    }
    if (!options.quiet) setLoading(true);
    const requestVersion = ++requestVersionRef.current;
    if (append) setLoadMoreError('');
    else setError('');
    try {
      const cursor = append ? nextCursorRef.current : null;
      const result = isAssets
        ? await listAssets({
            ...(productId ? { productId } : {}),
            ...(search ? { query: search } : {}),
            ...(cursor ? { cursor } : {}),
          })
        : await listArtifacts({
            ...(productId ? { productId } : {}),
            ...(cursor ? { cursor } : {}),
          });
      if (requestVersion !== requestVersionRef.current) return;
      setItems((current) => {
        if (!append && options.preserveLoadedPages) {
          const pageIds = new Set(result.items.map((item) => item.id));
          return [...result.items, ...current.filter((item) => !pageIds.has(item.id))];
        }
        if (!append) return result.items;
        const existing = new Set(current.map((item) => item.id));
        return [...current, ...result.items.filter((item) => !existing.has(item.id))];
      });
      if (!options.preserveLoadedPages) {
        nextCursorRef.current = result.next_cursor;
        setNextCursor(result.next_cursor);
      }
      if (!append && !options.preserveLoadedPages) {
        setSelected((current) =>
          current.filter((id) => result.items.some((item) => item.id === id)),
        );
      }
    } catch (cause) {
      if (append) {
        setLoadMoreError(cause instanceof Error ? cause.message : '加载更多失败');
      } else {
        setError(cause instanceof Error ? cause.message : `${title}加载失败，请重试`);
      }
    } finally {
      if (requestVersion === requestVersionRef.current && !options.quiet && !append) {
        setLoading(false);
      }
      if (append && requestVersion === requestVersionRef.current) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }

  useEffect(() => {
    void listProducts()
      .then((result) => setProducts(result.items))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    requestVersionRef.current += 1;
    nextCursorRef.current = null;
    loadingMoreRef.current = false;
    setLoadingMore(false);
    setNextCursor(null);
    setLoadMoreError('');
    const timer = window.setTimeout(() => void load(), 180);
    return () => window.clearTimeout(timer);
  }, [search, isAssets, productId]);

  useEffect(() => {
    const sentinel = loadMoreRef.current;
    if (!sentinel || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) void load({ append: true, quiet: true });
      },
      { rootMargin: '720px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [items.length, nextCursor]);

  useEffect(() => {
    if (!hasPendingAssets) {
      if (assetPollTimerRef.current) window.clearTimeout(assetPollTimerRef.current);
      assetPollTimerRef.current = null;
      assetPollAttemptRef.current = 0;
      return undefined;
    }

    let disposed = false;
    const pollDelays = [1500, 3000, 5000, 10000, 15000] as const;
    const schedule = (delay: number): void => {
      if (disposed) return;
      assetPollTimerRef.current = window.setTimeout(() => {
        assetPollTimerRef.current = null;
        if (disposed) return;
        if (document.hidden) {
          schedule(30_000);
          return;
        }
        void (async () => {
          await load({ preserveLoadedPages: true, quiet: true });
          if (disposed) return;
          assetPollAttemptRef.current += 1;
          schedule(
            pollDelays[Math.min(assetPollAttemptRef.current, pollDelays.length - 1)] ?? 15_000,
          );
        })();
      }, delay);
    };
    const handleVisibilityChange = (): void => {
      if (document.hidden || disposed) return;
      if (assetPollTimerRef.current) window.clearTimeout(assetPollTimerRef.current);
      assetPollTimerRef.current = null;
      schedule(0);
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    schedule(pollDelays[0]);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (assetPollTimerRef.current) window.clearTimeout(assetPollTimerRef.current);
      assetPollTimerRef.current = null;
    };
  }, [hasPendingAssets, productId, search]);

  async function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setUploading(true);
    setError('');
    setNotice('图片已上传，正在进行安全检查和缩略图处理…');
    try {
      const asset = await uploadAsset(file, { ...(productId ? { productId } : {}) });
      setNotice(
        asset.status === 'ready'
          ? '素材处理完成'
          : asset.status === 'rejected'
            ? '图片未通过格式或尺寸检查'
            : asset.status === 'processing_failed'
              ? '缩略图处理失败，可以在素材卡片上重试'
              : '素材仍在处理中，页面会自动更新',
      );
      await load({ quiet: true });
    } catch (cause) {
      setNotice('');
      setError(cause instanceof Error ? cause.message : '上传失败，请重试');
    } finally {
      setUploading(false);
    }
  }

  async function handleRetry(id: string) {
    setRetryingId(id);
    setError('');
    setNotice('');
    try {
      await retryAsset(id);
      setNotice('已重新提交处理，页面会自动更新');
      await load({ quiet: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '重试失败，请稍后再试');
    } finally {
      setRetryingId(null);
    }
  }

  async function downloadSelected() {
    setActing(true);
    setError('');
    try {
      for (const id of selected) {
        const item = items.find((candidate) => candidate.id === id);
        if (!item) continue;
        const access = isAsset(item)
          ? await assetAccessUrl(item.id, 'original', 'download')
          : await artifactAccessUrl(item.id, 'original', 'download');
        triggerDownload(access.url, isAsset(item) ? item.display_name : `artifact-${item.id}`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '下载失败，请重试');
    } finally {
      setActing(false);
    }
  }

  async function saveSelected() {
    setActing(true);
    setError('');
    try {
      await Promise.all(
        selected.map((id) => saveArtifactToAssets(id, { ...(productId ? { productId } : {}) })),
      );
      setNotice(`已将 ${selected.length} 个作品存入资产库`);
      setSelected([]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '存入资产库失败，请重试');
    } finally {
      setActing(false);
    }
  }

  const visible = useMemo(
    () =>
      items.filter((item) =>
        (isAsset(item) ? item.display_name : item.id).toLowerCase().includes(search.toLowerCase()),
      ),
    [items, search],
  );

  return (
    <ProductShell activeItem={activeItem} title={title}>
      <PageHeader
        actions={
          isAssets ? (
            <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-md bg-[var(--primary)] px-4 text-sm font-semibold text-white">
              <Upload aria-hidden="true" size={17} />
              {uploading ? '上传中…' : '上传素材'}
              <input
                accept="image/jpeg,image/png,image/webp"
                className="sr-only"
                disabled={uploading}
                onChange={(event) => void handleUpload(event)}
                type="file"
              />
            </label>
          ) : (
            <Button
              disabled={acting || selected.length === 0}
              onClick={() => void downloadSelected()}
              variant="outline"
            >
              <Download aria-hidden="true" size={17} />
              下载已选
            </Button>
          )
        }
        description={description}
        title={title}
      />
      <FilterBar onSearch={setSearch} search={search} searchPlaceholder={`搜索${title}`}>
        <label className="sr-only" htmlFor={`${activeItem}-product-filter`}>
          按商品筛选
        </label>
        <select
          className="h-11 min-w-40 rounded-[7px] border border-[var(--border-strong)] bg-white px-3 text-sm"
          id={`${activeItem}-product-filter`}
          onChange={(event) => setProductId(event.target.value)}
          value={productId}
        >
          <option value="">全部商品</option>
          {products.map((product) => (
            <option key={product.id} value={product.id}>
              {product.name}
            </option>
          ))}
        </select>
      </FilterBar>
      {selected.length ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--border-strong)] bg-[var(--primary-soft)] px-4 py-3 text-sm">
          <span>已选择 {selected.length} 项</span>
          <div className="flex gap-2">
            {!isAssets ? (
              <Button
                disabled={acting}
                onClick={() => void saveSelected()}
                size="sm"
                variant="outline"
              >
                <Save aria-hidden="true" size={14} />
                存入资产库
              </Button>
            ) : null}
            <Button disabled={acting} onClick={() => void downloadSelected()} size="sm">
              <Download aria-hidden="true" size={14} />
              下载
            </Button>
          </div>
        </div>
      ) : null}
      {notice ? <p className="mb-4 text-sm text-[var(--primary)]">{notice}</p> : null}
      {loading ? (
        <p className="py-16 text-center text-sm text-[var(--muted-foreground)]">加载中…</p>
      ) : null}
      {error ? (
        <div className="py-16 text-center text-sm text-[var(--danger)]">
          <p>{error}</p>
          <Button className="mt-3" onClick={() => void load()} variant="outline">
            重试
          </Button>
        </div>
      ) : null}
      {!loading && !error && visible.length === 0 ? (
        <p className="py-16 text-center text-sm text-[var(--muted-foreground)]">暂无{title}</p>
      ) : null}
      {!loading && !error && visible.length > 0 ? (
        <>
          <div
            className={
              isAssets
                ? 'grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5'
                : 'columns-2 gap-3 md:columns-3 xl:columns-4 2xl:columns-5'
            }
          >
            {visible.map((item) => {
              const active = selected.includes(item.id);
              const selectable = isAsset(item)
                ? item.status === 'ready'
                : !['quarantined', 'deleted'].includes(item.visibility);
              return (
                <MediaCard
                  active={active}
                  item={item}
                  key={item.id}
                  onClick={() =>
                    setSelected((current) =>
                      active ? current.filter((value) => value !== item.id) : [...current, item.id],
                    )
                  }
                  retrying={retryingId === item.id}
                  selectable={selectable}
                  showDetails={isAssets}
                  waterfall={!isAssets}
                  {...(isAsset(item) ? { onRetry: () => void handleRetry(item.id) } : {})}
                />
              );
            })}
          </div>
          <div
            aria-live="polite"
            className="flex min-h-12 items-center justify-center gap-3 py-4 text-xs text-[var(--muted-foreground)]"
            ref={loadMoreRef}
          >
            {loadingMore ? (
              <span className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
            ) : null}
            {loadingMore
              ? '加载更多...'
              : loadMoreError
                ? loadMoreError
                : nextCursor
                  ? '继续下滑加载更多'
                  : '已到底'}
            {loadMoreError ? (
              <Button
                onClick={() => void load({ append: true, quiet: true })}
                size="sm"
                variant="outline"
              >
                重试
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
    </ProductShell>
  );
}

export function AssetsPage() {
  return (
    <MediaLibrary
      activeItem="资产"
      description="管理上传素材、参考图和生成结果，可在任意创作中复用"
      title="资产库"
    />
  );
}

export function ArtifactsPage() {
  return (
    <MediaLibrary
      activeItem="作品"
      description="查看每次生成的最终结果、版本与内容检查状态"
      title="我的作品"
    />
  );
}
