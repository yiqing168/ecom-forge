'use client';

import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { MoreHorizontal, Plus, WandSparkles } from 'lucide-react';

import { ProductShell } from '@/components/layout/product-shell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { FilterBar, FilterButton, PageHeader } from '@/features/product-pages/ui';

const canvases = [
  {
    id: 'fashion-campaign',
    image: '/demo/result-1.jpg',
    name: '夏季时装 campaign',
    nodes: 12,
    updated: '刚刚',
  },
  {
    id: 'shoe-launch',
    image: '/demo/result-2.jpg',
    name: '运动鞋上市视觉',
    nodes: 8,
    updated: '今天 13:42',
  },
  {
    id: 'home-story',
    image: '/demo/sofa.jpg',
    name: '家居空间叙事',
    nodes: 16,
    updated: '昨天 19:08',
  },
  {
    id: 'beauty-video',
    image: '/demo/cosmetics.jpg',
    name: '彩妆短片分镜',
    nodes: 10,
    updated: '8 月 6 日',
  },
];

export function CanvasesPage() {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [search, setSearch] = useState('');

  return (
    <ProductShell activeItem="画布" title="画布">
      <PageHeader
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus aria-hidden="true" size={17} />
            新建画布
          </Button>
        }
        description="手工组织文本、图片和视频节点，构建可复用的专业创作流程"
        title="画布"
      />
      <FilterBar onSearch={setSearch} search={search} searchPlaceholder="搜索画布">
        <FilterButton>最近编辑</FilterButton>
      </FilterBar>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {canvases
          .filter((canvas) => canvas.name.includes(search))
          .map((canvas) => (
            <button
              className="group overflow-hidden rounded-lg text-left outline-none transition-[transform,box-shadow] hover:-translate-y-0.5 hover:shadow-[var(--shadow-sm)] focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
              key={canvas.id}
              onClick={() => router.push(`/canvases/${canvas.id}`)}
              type="button"
            >
              <div className="relative aspect-[16/10] overflow-hidden bg-[var(--media-placeholder)]">
                <Image
                  alt={canvas.name}
                  className="object-cover opacity-90 transition-transform duration-300 group-hover:scale-[1.02]"
                  fill
                  sizes="360px"
                  src={canvas.image}
                />
                <div className="absolute inset-0 bg-white/18" />
                <span className="absolute bottom-3 left-3 rounded bg-[var(--inverse)] px-2.5 py-1 text-xs font-medium text-white">
                  {canvas.nodes} 个节点
                </span>
              </div>
              <div className="flex items-start justify-between gap-3 px-1 py-3">
                <div>
                  <h2 className="font-semibold">{canvas.name}</h2>
                  <p className="mt-1 text-sm text-[var(--muted-foreground)]">
                    已保存 · {canvas.updated}
                  </p>
                </div>
                <MoreHorizontal
                  aria-hidden="true"
                  className="text-[var(--subtle-foreground)]"
                  size={18}
                />
              </div>
            </button>
          ))}
      </div>

      <Dialog onOpenChange={setCreateOpen} open={createOpen}>
        <DialogContent>
          <DialogTitle className="text-xl font-bold">新建画布</DialogTitle>
          <DialogDescription className="mt-2 text-sm text-[var(--muted-foreground)]">
            空白画布不会自动生成节点或 Agent 计划。
          </DialogDescription>
          <div className="mt-6 grid grid-cols-2 gap-3">
            <button
              className="rounded-lg border border-[var(--primary)] bg-[var(--primary-soft)] p-4 text-left"
              type="button"
            >
              <span className="grid size-10 place-items-center rounded-md bg-white text-[var(--primary)]">
                <Plus size={18} />
              </span>
              <b className="mt-3 block">空白画布</b>
              <span className="mt-1 block text-sm text-[var(--muted-foreground)]">
                从零开始手工编排
              </span>
            </button>
            <button
              className="rounded-lg border border-[var(--border)] p-4 text-left"
              type="button"
            >
              <span className="grid size-10 place-items-center rounded-md bg-[var(--soft)]">
                <WandSparkles size={18} />
              </span>
              <b className="mt-3 block">从模板创建</b>
              <span className="mt-1 block text-sm text-[var(--muted-foreground)]">
                复制已有节点和边
              </span>
            </button>
          </div>
          <label className="mt-5 block">
            <span className="mb-1.5 block text-sm font-semibold">画布名称</span>
            <Input defaultValue="未命名画布" />
          </label>
          <div className="mt-6 flex justify-end gap-2">
            <Button onClick={() => setCreateOpen(false)} variant="ghost">
              取消
            </Button>
            <Button onClick={() => router.push('/canvases/new-canvas')}>创建并打开</Button>
          </div>
        </DialogContent>
      </Dialog>
    </ProductShell>
  );
}

export { CanvasEditorPage } from './canvas-editor';
