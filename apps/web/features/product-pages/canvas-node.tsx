'use client';

import Image from 'next/image';
import { useContext, useState } from 'react';
import {
  Handle,
  NodeToolbar,
  Position,
  useReactFlow,
  type Edge,
  type NodeProps,
} from '@xyflow/react';
import {
  ChevronDown,
  CirclePlay,
  Copy,
  Download,
  FileText,
  ImageIcon,
  ImagePlus,
  Images,
  Maximize2,
  MoreHorizontal,
  Plus,
  Trash2,
  Video,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import {
  CanvasActionsContext,
  type CanvasNode,
  type CanvasNodeData,
} from '@/features/product-pages/canvas-model';
import { cn } from '@/lib/cn';

function NodeIcon({ kind }: { kind: CanvasNodeData['kind'] }) {
  if (kind === 'image') return <ImageIcon aria-hidden="true" size={15} />;
  if (kind === 'video') return <Video aria-hidden="true" size={15} />;
  if (kind === 'asset') return <Images aria-hidden="true" size={15} />;
  return <FileText aria-hidden="true" size={15} />;
}

export function CreativeNode({ data, id, selected }: NodeProps<CanvasNode>) {
  const actions = useContext(CanvasActionsContext);
  const { deleteElements, fitView, getNode, setNodes, updateNodeData } = useReactFlow<
    CanvasNode,
    Edge
  >();
  const [referencesOpen, setReferencesOpen] = useState(false);

  const running = data.runStatus === 'queued' || data.runStatus === 'running';

  function duplicateNode() {
    const current = getNode(id);
    if (!current) return;
    setNodes((nodes) => [
      ...nodes.map((node) => ({ ...node, selected: false })),
      {
        ...current,
        data: { ...current.data, attachments: [] },
        id: crypto.randomUUID(),
        position: { x: current.position.x + 36, y: current.position.y + 36 },
        selected: true,
      },
    ]);
  }

  function downloadNode() {
    if (!data.image) return;
    const anchor = document.createElement('a');
    anchor.download = `${data.title}.jpg`;
    anchor.href = data.image;
    anchor.click();
  }

  return (
    <>
      <NodeToolbar
        className="flex items-center gap-1 rounded-lg border border-[var(--border)] bg-white p-1 shadow-[var(--shadow-md)]"
        isVisible={selected}
        position={Position.Top}
      >
        <IconButton
          aria-label="预览"
          icon={<Maximize2 aria-hidden="true" size={15} />}
          onClick={() => void fitView({ duration: 260, nodes: [{ id }], padding: 0.65 })}
        />
        <IconButton
          aria-label="复制"
          icon={<Copy aria-hidden="true" size={15} />}
          onClick={duplicateNode}
        />
        <IconButton
          aria-label="下载"
          disabled={!data.image}
          icon={<Download aria-hidden="true" size={15} />}
          onClick={downloadNode}
        />
        <span className="mx-0.5 h-5 w-px bg-[var(--border)]" />
        <IconButton
          aria-label="删除节点"
          className="text-[var(--danger)] hover:bg-[var(--danger-soft)]"
          icon={<Trash2 aria-hidden="true" size={15} />}
          onClick={() => void deleteElements({ nodes: [{ id }] })}
        />
        <IconButton aria-label="更多操作" icon={<MoreHorizontal aria-hidden="true" size={15} />} />
      </NodeToolbar>

      <article
        className={cn(
          'w-[260px] overflow-hidden rounded-lg border-2 bg-white shadow-[0_10px_30px_rgba(21,24,32,0.08)] transition-colors',
          selected && 'border-[var(--primary)]',
          !selected && data.runStatus !== 'failed' && 'border-transparent',
          data.runStatus === 'failed' && 'border-[var(--danger)]',
        )}
      >
        <Handle
          className="!size-3 !border-2 !border-white !bg-[var(--canvas-node)]"
          position={Position.Left}
          type="target"
        />
        <div className="flex h-10 items-center gap-2 border-b border-[var(--border)] px-3 text-sm font-semibold">
          <NodeIcon kind={data.kind} />
          {data.title}
          <span className="ml-auto rounded bg-[var(--soft)] px-1.5 py-0.5 text-xs text-[var(--muted-foreground)]">
            {data.runStatus === 'running'
              ? '运行中'
              : data.runStatus === 'succeeded'
                ? '完成'
                : data.runStatus === 'failed'
                  ? '失败'
                  : 'v2'}
          </span>
        </div>
        {data.image ? (
          <div className="relative aspect-[4/3] bg-[var(--soft)]">
            <Image
              alt={data.title}
              className="object-cover"
              fill
              loading={data.kind === 'asset' ? 'eager' : 'lazy'}
              sizes="260px"
              src={data.image}
              unoptimized
            />
          </div>
        ) : (
          <div className="min-h-28 p-4 text-sm leading-6 text-[var(--muted-foreground)]">
            {data.prompt ?? '输入文本或结构化内容'}
          </div>
        )}
        <div className="flex items-center justify-between border-t border-[var(--border)] px-3 py-2 text-sm text-[var(--muted-foreground)]">
          <span>{data.attachments?.length ?? 0} 个附件</span>
          <span>已保存</span>
        </div>
        <Handle
          className="!size-3 !border-2 !border-white !bg-[var(--primary)]"
          position={Position.Right}
          type="source"
        />
      </article>

      <NodeToolbar
        className="w-[420px] rounded-lg border border-[var(--border)] bg-white p-3 shadow-[var(--shadow-md)]"
        isVisible={selected}
        position={Position.Bottom}
      >
        <div className="mb-2 flex gap-2 overflow-x-auto">
          {(data.attachments ?? []).map((item) => (
            <span
              className="inline-flex h-9 shrink-0 items-center gap-2 rounded-md bg-[var(--soft)] px-2 text-sm"
              data-source-node-id={item.sourceNodeId}
              key={item.id}
            >
              <ImagePlus aria-hidden="true" size={14} />
              {item.label}
            </span>
          ))}
          <button
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-dashed border-[var(--border-strong)] px-2 text-sm text-[var(--muted-foreground)]"
            onClick={() => actions?.addAttachment(id)}
            type="button"
          >
            <Plus aria-hidden="true" size={14} />
            添加附件
          </button>
        </div>
        <textarea
          aria-label={`${data.title}提示词`}
          className="min-h-16 w-full resize-none rounded-md border border-[var(--border)] bg-[var(--surface-raised)] p-2.5 text-sm outline-none focus:border-[var(--primary)]"
          onChange={(event) => updateNodeData(id, { prompt: event.target.value })}
          value={data.prompt ?? ''}
        />
        {referencesOpen ? (
          <div className="mt-2 rounded-md border border-[var(--border)] bg-white p-2 text-sm shadow-sm">
            <p className="mb-1 font-semibold">当前节点附件</p>
            {data.attachments?.length ? (
              data.attachments.map((item) => (
                <button
                  className="block min-h-10 w-full rounded px-2 text-left hover:bg-[var(--soft)]"
                  key={item.id}
                  onClick={() => {
                    const current = data.prompt ?? '';
                    updateNodeData(id, {
                      prompt: `${current}${current.endsWith(' ') || !current ? '' : ' '}@${item.label} `,
                    });
                    setReferencesOpen(false);
                  }}
                  type="button"
                >
                  @{item.label}
                </button>
              ))
            ) : (
              <p className="px-2 py-2 text-[var(--muted-foreground)]">暂无可引用附件</p>
            )}
          </div>
        ) : null}
        <div className="mt-2 flex items-center gap-1.5">
          <button
            aria-label="引用当前附件"
            className="grid size-10 place-items-center rounded-md hover:bg-[var(--soft)]"
            onClick={() => setReferencesOpen((value) => !value)}
            type="button"
          >
            @
          </button>
          <button
            className="inline-flex h-10 items-center gap-1 rounded-md px-2 text-sm hover:bg-[var(--soft)]"
            onClick={() =>
              updateNodeData(id, {
                model: data.model === '图像模型' ? '商品精修模型' : '图像模型',
              })
            }
            type="button"
          >
            {data.model ?? '图像模型'}
            <ChevronDown aria-hidden="true" size={12} />
          </button>
          <button
            className="inline-flex h-10 items-center gap-1 rounded-md px-2 text-sm hover:bg-[var(--soft)]"
            onClick={() =>
              updateNodeData(id, {
                ratio: data.ratio === '1:1' ? '3:4' : data.ratio === '3:4' ? '16:9' : '1:1',
              })
            }
            type="button"
          >
            {data.ratio ?? '1:1'}
            <ChevronDown aria-hidden="true" size={12} />
          </button>
          <Button
            className="ml-auto"
            disabled={running}
            onClick={() => actions?.requestRun({ nodeId: id, scope: 'node' })}
            size="sm"
          >
            <CirclePlay aria-hidden="true" size={15} />
            {running ? '运行中…' : '运行节点'}
          </Button>
        </div>
      </NodeToolbar>
    </>
  );
}

export const nodeTypes = { creative: CreativeNode };
