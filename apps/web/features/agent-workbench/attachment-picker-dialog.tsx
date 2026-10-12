'use client';

import Image from 'next/image';
import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { Check, ImagePlus, Upload } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import type { ExampleAsset } from '@/features/agent-workbench/data';
import { cn } from '@/lib/cn';
import {
  assetAccessUrl,
  listAssets,
  MAX_ASSET_UPLOAD_BYTES,
  uploadAsset,
} from '@/lib/resource-api';

const MAX_ATTACHMENTS = 9;

type AttachmentPickerDialogProps = {
  currentAttachments: ExampleAsset[];
  onConfirm: (attachments: ExampleAsset[]) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
};

async function assetToExample(
  asset: Awaited<ReturnType<typeof listAssets>>['items'][number],
): Promise<ExampleAsset | null> {
  if (asset.status !== 'ready' || !asset.content_version) return null;
  try {
    const access = await assetAccessUrl(asset.id);
    return {
      category: asset.origin,
      id: asset.id,
      imageUrl: access.url,
      label: asset.display_name,
      prompt: '',
      tags: asset.kind,
      resourceType: 'asset',
      resourceVersion: asset.content_version,
    };
  } catch {
    return null;
  }
}

export function AttachmentPickerDialog({
  currentAttachments,
  onConfirm,
  onOpenChange,
  open,
}: AttachmentPickerDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const requestEpoch = useRef(0);
  const [candidates, setCandidates] = useState<ExampleAsset[]>([]);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    const epoch = ++requestEpoch.current;
    setCandidates(currentAttachments);
    setSelectedIds(currentAttachments.map((item) => item.id));
    setLoading(true);
    setLoadingMore(false);
    setNextCursor(null);
    setError('');
    void listAssets()
      .then(async (result) => {
        const serverAssets = (await Promise.all(result.items.map(assetToExample))).filter(
          (item): item is ExampleAsset => item !== null,
        );
        if (!active || requestEpoch.current !== epoch) return;
        const merged = new Map(currentAttachments.map((item) => [item.id, item]));
        serverAssets.forEach((item) => merged.set(item.id, item));
        setCandidates([...merged.values()]);
        setSelectedIds(currentAttachments.map((item) => item.id));
        setNextCursor(result.next_cursor);
      })
      .catch((cause) => {
        if (!active || requestEpoch.current !== epoch) return;
        setError(cause instanceof Error ? cause.message : '资产加载失败，请重试');
        setCandidates(currentAttachments);
        setSelectedIds(currentAttachments.map((item) => item.id));
      })
      .finally(() => {
        if (active && requestEpoch.current === epoch) setLoading(false);
      });
    return () => {
      active = false;
      requestEpoch.current += 1;
    };
  }, [currentAttachments, open]);

  async function loadMoreAssets() {
    if (!nextCursor || loadingMore) return;
    const epoch = requestEpoch.current;
    setLoadingMore(true);
    setError('');
    try {
      const result = await listAssets({ cursor: nextCursor });
      const next = (await Promise.all(result.items.map(assetToExample))).filter(
        (item): item is ExampleAsset => item !== null,
      );
      if (requestEpoch.current !== epoch) return;
      setCandidates((current) => {
        const merged = new Map(current.map((item) => [item.id, item]));
        next.forEach((item) => merged.set(item.id, item));
        return [...merged.values()];
      });
      setNextCursor(result.next_cursor);
    } catch (cause) {
      if (requestEpoch.current !== epoch) return;
      setError(cause instanceof Error ? cause.message : '资产加载失败，请重试');
    } finally {
      if (requestEpoch.current === epoch) setLoadingMore(false);
    }
  }

  async function addFiles(files: File[]) {
    const images = files.filter((file) =>
      ['image/jpeg', 'image/png', 'image/webp'].includes(file.type),
    );
    if (images.length !== files.length) setError('仅支持 JPG、PNG、WebP 图片');
    const validImages = images.filter(
      (file) => file.size > 0 && file.size <= MAX_ASSET_UPLOAD_BYTES,
    );
    if (validImages.length !== images.length) setError('单张图片不能超过 20 MB');
    const available = MAX_ATTACHMENTS - selectedIds.length;
    if (available <= 0) {
      setError(`最多添加 ${MAX_ATTACHMENTS} 个附件`);
      return;
    }
    setLoading(true);
    try {
      const uploaded = await Promise.all(
        validImages.slice(0, available).map((file) => uploadAsset(file)),
      );
      const next = (await Promise.all(uploaded.map(assetToExample))).filter(
        (item): item is ExampleAsset => item !== null,
      );
      setCandidates((current) => [...next, ...current]);
      setSelectedIds((current) => [...current, ...next.map((item) => item.id)]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '上传失败，请重试');
    } finally {
      setLoading(false);
    }
  }

  function toggle(id: string) {
    setError('');
    setSelectedIds((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      if (current.length >= MAX_ATTACHMENTS) {
        setError(`最多添加 ${MAX_ATTACHMENTS} 个附件`);
        return current;
      }
      return [...current, id];
    });
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="w-[min(calc(100vw-32px),720px)]">
        <DialogTitle className="text-xl font-bold">添加附件</DialogTitle>
        <DialogDescription className="mt-2 text-sm text-[var(--muted-foreground)]">
          上传图片或从资产中选择，最多 {MAX_ATTACHMENTS} 个。附件会显示在输入框上方。
        </DialogDescription>
        <div
          className={cn(
            'mt-5 flex min-h-28 cursor-pointer items-center justify-center rounded-lg border border-dashed border-[var(--border-strong)] bg-[var(--surface-raised)] px-4 text-center outline-none transition-colors',
            dragging && 'border-[var(--primary)] bg-[var(--primary-soft)]',
          )}
          onClick={() => inputRef.current?.click()}
          onDragEnter={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event: DragEvent<HTMLDivElement>) => {
            event.preventDefault();
            setDragging(false);
            void addFiles([...event.dataTransfer.files]);
          }}
          role="button"
          tabIndex={0}
        >
          <div>
            <Upload
              aria-hidden="true"
              className="mx-auto text-[var(--muted-foreground)]"
              size={22}
            />
            <p className="mt-2 text-sm font-semibold">拖入图片，或点击上传</p>
            <p className="mt-1 text-sm text-[var(--muted-foreground)]">JPG、PNG、WebP</p>
          </div>
        </div>
        <input
          accept="image/jpeg,image/png,image/webp"
          className="sr-only"
          multiple
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            void addFiles([...(event.target.files ?? [])]);
            event.target.value = '';
          }}
          ref={inputRef}
          type="file"
        />
        <div className="mt-5 flex items-center justify-between">
          <h3 className="text-sm font-semibold">资产库</h3>
          <span className="text-sm text-[var(--muted-foreground)]">
            已选 {selectedIds.length}/{MAX_ATTACHMENTS}
          </span>
        </div>
        <div className="mt-3 grid max-h-[320px] grid-cols-3 gap-3 overflow-y-auto pr-1 sm:grid-cols-5">
          {loading && candidates.length === 0 ? (
            <p className="col-span-full py-10 text-center text-sm text-[var(--muted-foreground)]">
              加载资产中…
            </p>
          ) : null}
          {!loading && candidates.length === 0 ? (
            <p className="col-span-full py-10 text-center text-sm text-[var(--muted-foreground)]">
              资产库暂无可用图片
            </p>
          ) : null}
          {candidates.map((asset) => {
            const selected = selectedIds.includes(asset.id);
            return (
              <button
                aria-pressed={selected}
                className={cn(
                  'group relative aspect-square overflow-hidden rounded-lg border-2 bg-[var(--soft)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]',
                  selected ? 'border-[var(--primary)]' : 'border-transparent',
                )}
                key={asset.id}
                onClick={() => toggle(asset.id)}
                type="button"
              >
                <Image
                  alt={asset.label}
                  className="object-cover"
                  fill
                  sizes="140px"
                  src={asset.imageUrl}
                  unoptimized={
                    asset.imageUrl.startsWith('data:') || asset.imageUrl.startsWith('/api/v1/')
                  }
                />
                <span className="absolute inset-x-0 bottom-0 truncate bg-black/62 px-2 py-1.5 text-left text-xs text-white">
                  {asset.label}
                </span>
                {selected ? (
                  <span className="absolute right-2 top-2 grid size-6 place-items-center rounded-full bg-[var(--primary)] text-white">
                    <Check size={14} />
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
        {nextCursor ? (
          <div className="mt-2 flex justify-center">
            <Button
              disabled={loadingMore}
              onClick={() => void loadMoreAssets()}
              size="sm"
              variant="ghost"
            >
              {loadingMore ? '加载中…' : '加载更多'}
            </Button>
          </div>
        ) : null}
        {error ? <p className="mt-3 text-sm font-medium text-[var(--danger)]">{error}</p> : null}
        <div className="mt-6 flex items-center justify-between gap-3">
          <span className="hidden items-center gap-2 text-sm text-[var(--muted-foreground)] sm:flex">
            <ImagePlus size={16} />
            选择后可在输入中使用 @ 精确引用
          </span>
          <div className="ml-auto flex gap-2">
            <Button onClick={() => onOpenChange(false)} variant="ghost">
              取消
            </Button>
            <Button
              onClick={() => {
                onConfirm(candidates.filter((item) => selectedIds.includes(item.id)));
                onOpenChange(false);
              }}
            >
              加入本次输入
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
