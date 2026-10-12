'use client';

import Image from 'next/image';
import { Plus, X } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';

import {
  ResourceImageViewerProvider,
  useResourceImageViewer,
  type ViewableImage,
} from '@/components/media/resource-image-viewer';
import type { ExampleAsset } from '@/features/agent-workbench/data';
import { cn } from '@/lib/cn';

type AttachmentStackProps = {
  attachments: ExampleAsset[];
  onAdd: () => void;
  onRemove: (id: string) => void;
};

export function AttachmentStack(props: AttachmentStackProps) {
  return (
    <ResourceImageViewerProvider>
      <AttachmentStackContent {...props} />
    </ResourceImageViewerProvider>
  );
}

function AttachmentStackContent({ attachments, onAdd, onRemove }: AttachmentStackProps) {
  const { open } = useResourceImageViewer();
  const [expanded, setExpanded] = useState(false);
  const [hoveredAttachmentId, setHoveredAttachmentId] = useState<string | null>(null);
  const collapseTimerRef = useRef<number | null>(null);
  const suppressNextTouchPreviewRef = useRef<string | null>(null);
  const visibleAttachments = attachments.slice(0, 6);
  const hiddenCount = attachments.length - visibleAttachments.length;
  const addCollapsedX = visibleAttachments.length ? (hiddenCount > 0 ? 88 : 54) : 0;
  const expandedItemStep = 56;
  const addExpandedX = visibleAttachments.length * expandedItemStep;
  const addButtonSize = 40;
  const expandedAddButtonWidth = 48;
  const collapsedRotations = [-7, 5, -4, 7, -3, 4] as const;
  const viewerItems: ViewableImage[] = attachments.map((attachment) => ({
    alt: attachment.label,
    id: attachment.id,
    previewUrl: attachment.imageUrl,
    // Demo examples are preview-only; server-backed attachments carry resourceType.
    ...(attachment.resourceType ? { resourceType: attachment.resourceType } : {}),
  }));

  useEffect(
    () => () => {
      if (collapseTimerRef.current !== null) window.clearTimeout(collapseTimerRef.current);
    },
    [],
  );

  function keepExpanded() {
    if (collapseTimerRef.current !== null) window.clearTimeout(collapseTimerRef.current);
    collapseTimerRef.current = null;
    setExpanded(true);
  }

  function scheduleCollapse() {
    if (collapseTimerRef.current !== null) window.clearTimeout(collapseTimerRef.current);
    collapseTimerRef.current = window.setTimeout(() => {
      setExpanded(false);
      setHoveredAttachmentId(null);
      collapseTimerRef.current = null;
    }, 140);
  }

  return (
    <div
      aria-label={attachments.length ? `${attachments.length} 个附件` : '暂无附件'}
      className={cn(
        'attachment-stack relative z-10 h-12 w-12 shrink-0',
        expanded && 'is-expanded',
        visibleAttachments.length === 0 && 'is-empty',
      )}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setExpanded(false);
      }}
      onMouseLeave={scheduleCollapse}
      style={
        {
          '--stack-collapsed-width': `${visibleAttachments.length ? addCollapsedX + addButtonSize : expandedAddButtonWidth}px`,
          '--stack-expanded-width': `${addExpandedX + expandedAddButtonWidth}px`,
        } as CSSProperties
      }
    >
      {visibleAttachments.map((attachment, index) => (
        <div
          className={cn(
            'attachment-stack-item group/attachment absolute left-0 top-0 size-12 origin-bottom-left overflow-hidden rounded-md bg-[var(--soft)] shadow-sm ring-2 ring-white',
            hoveredAttachmentId === attachment.id && 'is-hovered',
          )}
          key={attachment.id}
          onFocus={() => {
            keepExpanded();
            setHoveredAttachmentId(attachment.id);
          }}
          onMouseEnter={() => {
            keepExpanded();
            setHoveredAttachmentId(attachment.id);
          }}
          onPointerDown={(event) => {
            if (event.pointerType !== 'mouse') {
              // The first touch reveals the remove action instead of opening a preview beneath it.
              if (!expanded || hoveredAttachmentId !== attachment.id) {
                suppressNextTouchPreviewRef.current = attachment.id;
              }
              keepExpanded();
              setHoveredAttachmentId(attachment.id);
            }
          }}
          style={
            {
              '--fan-x': `${index * expandedItemStep}px`,
              '--fan-delay': `${index * 16}ms`,
              '--stack-rotate': `${collapsedRotations[index] ?? 0}deg`,
              '--stack-x': `${index * 5}px`,
              '--stack-y': `${index % 2 === 0 ? 1 : -1}px`,
              zIndex: index + 1,
            } as CSSProperties
          }
          title={attachment.label}
        >
          <button
            aria-label={`查看${attachment.label}`}
            className="absolute inset-0 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white"
            onClick={(event) => {
              if (suppressNextTouchPreviewRef.current === attachment.id) {
                suppressNextTouchPreviewRef.current = null;
                event.preventDefault();
                return;
              }
              open(viewerItems, index);
            }}
            type="button"
          >
            <Image
              alt={attachment.label}
              className="attachment-stack-image object-cover"
              fill
              sizes="48px"
              src={attachment.imageUrl}
              unoptimized={
                attachment.imageUrl.startsWith('data:') ||
                attachment.imageUrl.startsWith('/api/v1/')
              }
            />
          </button>
          <button
            aria-label={`移除${attachment.label}`}
            className="attachment-remove absolute right-1 top-1 z-20 grid size-6 cursor-pointer place-items-center rounded-full bg-black/85 text-white opacity-0 shadow-sm outline-none hover:bg-black focus:opacity-100 focus-visible:ring-2 focus-visible:ring-white"
            onClick={() => {
              suppressNextTouchPreviewRef.current = null;
              onRemove(attachment.id);
            }}
            onMouseEnter={keepExpanded}
            onMouseDown={keepExpanded}
            type="button"
          >
            <X aria-hidden="true" className="text-white" size={14} strokeWidth={2.5} />
          </button>
          {hiddenCount > 0 && index === visibleAttachments.length - 1 ? (
            <button
              aria-label={`管理另外 ${hiddenCount} 个附件`}
              className="absolute inset-0 z-10 grid cursor-pointer place-items-center bg-black/58 text-xs font-bold text-white outline-none hover:bg-black/68 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white"
              onClick={onAdd}
              onMouseEnter={keepExpanded}
              type="button"
            >
              +{hiddenCount}
            </button>
          ) : null}
        </div>
      ))}

      <button
        aria-label="添加附件"
        className="attachment-stack-add absolute left-0 top-1 grid size-10 cursor-pointer place-items-center rounded-full border border-transparent bg-[var(--soft)] text-[var(--muted-foreground)] outline-none hover:bg-[var(--soft-strong)] hover:text-[var(--foreground)] focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
        onClick={onAdd}
        onMouseEnter={() => {
          if (expanded && collapseTimerRef.current !== null) {
            window.clearTimeout(collapseTimerRef.current);
            collapseTimerRef.current = null;
          }
        }}
        style={
          {
            '--add-collapsed-x': `${addCollapsedX}px`,
            '--add-delay': `${visibleAttachments.length * 16}ms`,
            '--add-expanded-x': `${addExpandedX}px`,
            zIndex: visibleAttachments.length + 2,
          } as CSSProperties
        }
        type="button"
      >
        <Plus aria-hidden="true" size={19} strokeWidth={2} />
      </button>
    </div>
  );
}
