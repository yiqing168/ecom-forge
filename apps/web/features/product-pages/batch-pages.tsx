'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  Download,
  FileDown,
  Layers3,
  PackageCheck,
  Plus,
  RefreshCw,
  Upload,
} from 'lucide-react';
import { ProductShell } from '@/components/layout/product-shell';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  FilterBar,
  FilterButton,
  MetricStrip,
  PageHeader,
  StatusBadge,
} from '@/features/product-pages/ui';
import { cn } from '@/lib/cn';

const batchRows = [
  {
    completed: 38,
    failed: 2,
    id: 'batch-summer',
    name: '夏季女装主图更新',
    status: '处理中',
    total: 50,
    updated: '2 分钟前',
  },
  {
    completed: 24,
    failed: 1,
    id: 'batch-shoes',
    name: '运动鞋秋季场景',
    status: '部分完成',
    total: 25,
    updated: '今天 11:20',
  },
  {
    completed: 12,
    failed: 0,
    id: 'batch-beauty',
    name: '彩妆新品白底图',
    status: '已完成',
    total: 12,
    updated: '昨天 18:42',
  },
];

export function BatchesPage() {
  const router = useRouter();
  const [search, setSearch] = useState('');
  return (
    <ProductShell activeItem="批量" title="批量">
      <PageHeader
        actions={
          <Button onClick={() => router.push('/batches/new')}>
            <Plus aria-hidden="true" size={17} />
            新建批量
          </Button>
        }
        description="一次处理多个 SKU，统一确认费用，失败条目可独立重试"
        title="批量创作"
      />
      <MetricStrip
        items={[
          { label: '进行中', value: '1' },
          { label: '本月 SKU', value: '214' },
          { label: '平均成功率', value: '96.8%' },
          { label: '待处理失败项', value: '3' },
        ]}
      />
      <FilterBar onSearch={setSearch} search={search} searchPlaceholder="搜索批量名称">
        <FilterButton>全部状态</FilterButton>
      </FilterBar>
      <div className="border-y border-[var(--border)]">
        {batchRows
          .filter((batch) => batch.name.includes(search))
          .map((batch) => {
            const percent = Math.round(((batch.completed + batch.failed) / batch.total) * 100);
            return (
              <button
                className="w-full border-b border-[var(--border)] px-2 py-5 text-left outline-none transition-colors last:border-b-0 hover:bg-white/70 focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
                key={batch.id}
                onClick={() => router.push(`/batches/${batch.id}`)}
                type="button"
              >
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                  <span className="grid size-12 shrink-0 place-items-center rounded-lg bg-[var(--primary-soft)] text-[var(--primary)]">
                    <Layers3 aria-hidden="true" size={22} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-bold">{batch.name}</h2>
                      <StatusBadge status={batch.status} />
                    </div>
                    <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                      {batch.total} 个 SKU · 更新于 {batch.updated}
                    </p>
                    <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-[var(--soft)]">
                      <div
                        className="h-full rounded-full bg-[var(--primary)]"
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                  </div>
                  <div className="flex min-w-[170px] items-center justify-between text-sm sm:justify-end sm:gap-7">
                    <span>
                      <b>{batch.completed}</b> 成功
                    </span>
                    <span className={batch.failed ? 'text-[var(--danger)]' : ''}>
                      <b>{batch.failed}</b> 失败
                    </span>
                    <ChevronRight aria-hidden="true" size={18} />
                  </div>
                </div>
              </button>
            );
          })}
      </div>
    </ProductShell>
  );
}

export function NewBatchPage() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const steps = ['选择商品', '设置素材', '创作要求', '检查并提交'];
  return (
    <ProductShell activeItem="批量" title="新建批量">
      <button
        className="mb-5 inline-flex min-h-11 items-center gap-2 text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
        onClick={() => router.push('/batches')}
        type="button"
      >
        <ArrowLeft aria-hidden="true" size={17} />
        返回批量任务
      </button>
      <div className="grid gap-6 lg:grid-cols-[220px_1fr_280px]">
        <aside className="space-y-1">
          {steps.map((label, index) => (
            <button
              className={cn(
                'flex min-h-11 w-full items-center gap-3 rounded-md px-3 text-left text-sm',
                step === index + 1
                  ? 'bg-[var(--primary-soft)] font-semibold text-[var(--foreground)]'
                  : 'text-[var(--muted-foreground)]',
              )}
              key={label}
              onClick={() => setStep(index + 1)}
              type="button"
            >
              <span
                className={cn(
                  'grid size-6 place-items-center rounded-full border text-xs',
                  step > index + 1 && 'border-[var(--primary)] bg-[var(--primary)] text-white',
                )}
              >
                {step > index + 1 ? <Check aria-hidden="true" size={13} /> : index + 1}
              </span>
              {label}
            </button>
          ))}
        </aside>
        <section className="min-h-[520px] rounded-lg border border-[var(--border)] bg-white p-6">
          <p className="text-xs font-semibold text-[var(--foreground)]">步骤 {step} / 4</p>
          <h1 className="mt-2 text-2xl font-bold">{steps[step - 1]}</h1>
          {step === 1 ? (
            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              {['连衣裙 SKU 01', '运动鞋 SKU 02', '香水 SKU 03', '沙发 SKU 04'].map(
                (item, index) => (
                  <label
                    className="flex cursor-pointer items-center gap-3 rounded-lg border border-[var(--border)] p-4"
                    key={item}
                  >
                    <Checkbox defaultChecked={index < 3} />
                    <span className="grid size-10 place-items-center rounded bg-[var(--soft)]">
                      <PackageCheck aria-hidden="true" size={18} />
                    </span>
                    <span className="text-sm font-semibold">{item}</span>
                  </label>
                ),
              )}
            </div>
          ) : null}
          {step === 2 ? (
            <div className="mt-6 grid gap-4">
              <label className="grid min-h-40 cursor-pointer place-items-center rounded-lg border border-dashed border-[var(--border-strong)] bg-[var(--surface-raised)] text-center">
                <span>
                  <Upload aria-hidden="true" className="mx-auto mb-3" size={24} />
                  <b>上传统一参考素材</b>
                  <span className="mt-1 block text-sm text-[var(--muted-foreground)]">
                    也可以复用每个 SKU 已有素材
                  </span>
                </span>
                <input className="sr-only" type="file" />
              </label>
            </div>
          ) : null}
          {step === 3 ? (
            <div className="mt-6">
              <textarea
                className="min-h-48 w-full resize-none rounded-lg border border-[var(--border-strong)] p-4 outline-none focus:border-[var(--primary)]"
                defaultValue="为每个商品生成一张具有统一品牌感的场景主图，主体清楚，保留商品颜色与结构。"
              />
              <div className="mt-3 flex gap-2">
                <button
                  className="rounded-md bg-[var(--primary-soft)] px-3 py-2 text-sm font-semibold text-[var(--foreground)]"
                  type="button"
                >
                  主图创意
                </button>
                <button className="rounded-md bg-[var(--soft)] px-3 py-2 text-sm" type="button">
                  1:1
                </button>
              </div>
            </div>
          ) : null}
          {step === 4 ? (
            <div className="mt-6 space-y-4">
              <div className="grid grid-cols-3 border-y border-[var(--border)] py-4 text-center">
                <div>
                  <b className="text-xl">3</b>
                  <p className="text-xs text-[var(--muted-foreground)]">SKU</p>
                </div>
                <div className="border-x border-[var(--border)]">
                  <b className="text-xl">自动</b>
                  <p className="text-xs text-[var(--muted-foreground)]">解析产物数量</p>
                </div>
                <div>
                  <b className="text-xl">提交后</b>
                  <p className="text-xs text-[var(--muted-foreground)]">核对积分</p>
                </div>
              </div>
              <p className="text-sm leading-6 text-[var(--muted-foreground)]">
                系统按创作要求解析每个 SKU 的产物数量，并在执行前核对价格、余额和并发额度。
              </p>
            </div>
          ) : null}
          <div className="mt-8 flex justify-between">
            <Button
              disabled={step === 1}
              onClick={() => setStep((value) => Math.max(1, value - 1))}
              variant="ghost"
            >
              上一步
            </Button>
            {step < 4 ? (
              <Button onClick={() => setStep((value) => Math.min(4, value + 1))}>
                下一步
                <ArrowRight aria-hidden="true" size={16} />
              </Button>
            ) : (
              <Button onClick={() => router.push('/batches/batch-summer')}>开始批量创作</Button>
            )}
          </div>
        </section>
        <aside className="h-fit rounded-lg border border-[var(--border)] bg-white p-5">
          <h2 className="font-bold">批量摘要</h2>
          <dl className="mt-4 space-y-3 text-sm">
            <div className="flex justify-between">
              <dt>已选商品</dt>
              <dd className="font-semibold">3</dd>
            </div>
            <div className="flex justify-between">
              <dt>产物数量</dt>
              <dd className="font-semibold">按创作要求</dd>
            </div>
            <div className="flex justify-between">
              <dt>图片比例</dt>
              <dd className="font-semibold">1:1</dd>
            </div>
          </dl>
        </aside>
      </div>
    </ProductShell>
  );
}

export function BatchDetailPage() {
  const [retrying, setRetrying] = useState(false);
  return (
    <ProductShell activeItem="批量" title="批量详情">
      <PageHeader
        actions={
          <>
            <Button variant="outline">
              <FileDown aria-hidden="true" size={16} />
              导出 CSV
            </Button>
            <Button>
              <Download aria-hidden="true" size={16} />
              打包下载
            </Button>
          </>
        }
        description="50 个 SKU · 创建于今天 09:42"
        title="夏季女装主图更新"
      />
      <MetricStrip
        items={[
          { label: '总体进度', value: '80%' },
          { label: '成功', value: '38' },
          { label: '失败', value: '2' },
          { label: '处理中', value: '10' },
        ]}
      />
      <div className="mb-4 flex justify-end">
        <Button onClick={() => setRetrying(true)} variant="outline">
          <RefreshCw aria-hidden="true" size={15} />
          {retrying ? '已提交失败项' : '仅重试失败项'}
        </Button>
      </div>
      <div className="border-y border-[var(--border)]">
        {['连衣裙 01', '短袖衬衫 02', '半身裙 03', '针织上衣 04', '阔腿裤 05'].map(
          (name, index) => (
            <div
              className={`grid gap-3 px-4 py-4 sm:grid-cols-[1fr_130px_120px] sm:items-center ${index ? 'border-t border-[var(--border)]' : ''}`}
              key={name}
            >
              <div className="flex items-center gap-3">
                <span className="grid size-10 place-items-center rounded bg-[var(--soft)]">
                  <PackageCheck aria-hidden="true" size={18} />
                </span>
                <div>
                  <p className="text-sm font-semibold">{name}</p>
                  <p className="text-xs text-[var(--muted-foreground)]">SKU-WM-{100 + index}</p>
                </div>
              </div>
              <StatusBadge status={index === 2 ? '失败' : index > 2 ? '处理中' : '已完成'} />
              <button
                className="inline-flex min-h-11 items-center justify-end gap-1 text-sm text-[var(--foreground)]"
                type="button"
              >
                查看结果
                <ChevronRight aria-hidden="true" size={15} />
              </button>
            </div>
          ),
        )}
      </div>
    </ProductShell>
  );
}
