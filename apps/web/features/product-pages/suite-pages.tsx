'use client';

import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Check, ChevronRight, Plus } from 'lucide-react';
import { ProductShell } from '@/components/layout/product-shell';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { FilterBar, FilterButton, PageHeader, StatusBadge } from '@/features/product-pages/ui';
import { cn } from '@/lib/cn';

const suites = [
  {
    count: 8,
    id: 'suite-dress',
    image: '/demo/dress.jpg',
    name: '夏季轻盈连衣裙',
    status: '处理中',
    updated: '3 分钟前',
  },
  {
    count: 12,
    id: 'suite-shoe',
    image: '/demo/shoe.jpg',
    name: '缓震跑步鞋',
    status: '已完成',
    updated: '今天 10:25',
  },
  {
    count: 6,
    id: 'suite-perfume',
    image: '/demo/perfume.jpg',
    name: '木质调淡香水',
    status: '部分完成',
    updated: '昨天 16:08',
  },
];

export function SuitesPage() {
  const router = useRouter();
  const [search, setSearch] = useState('');
  return (
    <ProductShell activeItem="套图" title="套图">
      <PageHeader
        actions={
          <Button onClick={() => router.push('/suites/new')}>
            <Plus aria-hidden="true" size={17} />
            新建套图
          </Button>
        }
        description="围绕一个商品生成结构完整、风格统一的一组图片"
        title="商品套图"
      />
      <FilterBar onSearch={setSearch} search={search} searchPlaceholder="搜索商品或 SKU">
        <FilterButton>全部状态</FilterButton>
      </FilterBar>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {suites
          .filter((item) => item.name.includes(search))
          .map((suite) => (
            <button
              className="flex overflow-hidden rounded-lg text-left outline-none transition-[box-shadow,transform] hover:-translate-y-0.5 hover:shadow-[var(--shadow-sm)] focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
              key={suite.id}
              onClick={() => router.push(`/suites/${suite.id}`)}
              type="button"
            >
              <span className="relative aspect-square w-36 shrink-0">
                <Image
                  alt={suite.name}
                  className="object-cover"
                  fill
                  sizes="144px"
                  src={suite.image}
                />
              </span>
              <span className="min-w-0 flex-1 p-4">
                <span className="flex items-start justify-between gap-2">
                  <b className="truncate">{suite.name}</b>
                  <ChevronRight aria-hidden="true" size={16} />
                </span>
                <span className="mt-2 block">
                  <StatusBadge status={suite.status} />
                </span>
                <span className="mt-4 block text-xs text-[var(--muted-foreground)]">
                  {suite.count} 张 · {suite.updated}
                </span>
              </span>
            </button>
          ))}
      </div>
    </ProductShell>
  );
}

export function SuiteWorkbenchPage({ existing = false }: { existing?: boolean }) {
  const [step, setStep] = useState(existing ? 5 : 1);
  const [confirmed, setConfirmed] = useState(false);
  const steps = ['选择商品', '确认事实', '平台与语言', '设置卖点', '图片组合', '确认生成'];
  return (
    <ProductShell activeItem="套图" title={existing ? '套图详情' : '新建套图'}>
      <div className="grid gap-5 xl:grid-cols-[220px_1fr_300px]">
        <aside className="space-y-1">
          {steps.map((item, index) => (
            <button
              className={cn(
                'flex min-h-11 w-full items-center gap-3 rounded-md px-3 text-left text-sm',
                step === index + 1
                  ? 'bg-[var(--primary-soft)] font-semibold text-[var(--foreground)]'
                  : 'text-[var(--muted-foreground)]',
              )}
              key={item}
              onClick={() => setStep(index + 1)}
              type="button"
            >
              <span className="grid size-6 place-items-center rounded-full border border-[var(--border-strong)] text-xs">
                {index + 1}
              </span>
              {item}
            </button>
          ))}
        </aside>
        <section className="min-h-[620px] rounded-lg border border-[var(--border)] bg-white p-6">
          <p className="text-xs font-semibold text-[var(--foreground)]">步骤 {step} / 6</p>
          <h1 className="mt-2 text-2xl font-bold">{steps[step - 1]}</h1>
          {step <= 2 ? (
            <div className="mt-6 flex items-center gap-4 rounded-lg border border-[var(--border)] p-4">
              <span className="relative size-20 overflow-hidden rounded-md">
                <Image
                  alt="连衣裙"
                  className="object-cover"
                  fill
                  sizes="80px"
                  src="/demo/dress.jpg"
                />
              </span>
              <div>
                <b>夏季轻盈连衣裙</b>
                <p className="mt-1 text-sm text-[var(--muted-foreground)]">
                  DR-2408-01 · 米白色 · 无 Logo
                </p>
              </div>
            </div>
          ) : null}
          {step === 3 ? (
            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              {['淘宝 / 中国 / 简体中文', '抖音电商 / 中国 / 简体中文'].map((item, index) => (
                <button
                  className={cn(
                    'rounded-lg border p-4 text-left text-sm',
                    index === 0
                      ? 'border-[var(--primary)] bg-[var(--primary-soft)]'
                      : 'border-[var(--border)]',
                  )}
                  key={item}
                  type="button"
                >
                  {item}
                </button>
              ))}
            </div>
          ) : null}
          {step === 4 ? (
            <textarea
              className="mt-6 min-h-48 w-full rounded-lg border border-[var(--border-strong)] p-4 outline-none focus:border-[var(--primary)]"
              defaultValue="轻盈透气、自然收腰、适合通勤与度假"
            />
          ) : null}
          {step >= 5 ? (
            <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {['白底主图 × 2', '场景主图 × 2', '卖点图 × 3', '细节图 × 2', '尺寸图 × 1'].map(
                (item) => (
                  <label
                    className="flex min-h-20 cursor-pointer items-center gap-3 rounded-lg border border-[var(--border)] p-3 text-sm font-medium"
                    key={item}
                  >
                    <Checkbox defaultChecked />
                    {item}
                  </label>
                ),
              )}
            </div>
          ) : null}
          {step === 6 ? (
            <div className="mt-6 rounded-lg border border-[var(--border-strong)] bg-[var(--primary-soft)] p-5">
              <div className="flex items-end justify-between">
                <div>
                  <p className="text-sm font-semibold">一次确认全部图片</p>
                  <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                    10 张图片，失败项自动释放积分
                  </p>
                </div>
                <div className="text-right">
                  <b className="text-2xl">48.00</b>
                  <p className="text-xs">预计积分</p>
                </div>
              </div>
              <Button className="mt-5 w-full" onClick={() => setConfirmed(true)}>
                {confirmed ? (
                  <>
                    <Check aria-hidden="true" size={16} />
                    已开始生成
                  </>
                ) : (
                  '确认并生成套图'
                )}
              </Button>
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
            <Button
              disabled={step === 6}
              onClick={() => setStep((value) => Math.min(6, value + 1))}
            >
              下一步
            </Button>
          </div>
        </section>
        <aside className="h-fit rounded-lg border border-[var(--border)] bg-white p-5">
          <h2 className="font-bold">套图摘要</h2>
          <dl className="mt-4 space-y-3 text-sm">
            <div className="flex justify-between">
              <dt>商品</dt>
              <dd className="font-semibold">连衣裙</dd>
            </div>
            <div className="flex justify-between">
              <dt>平台</dt>
              <dd className="font-semibold">淘宝</dd>
            </div>
            <div className="flex justify-between">
              <dt>图片数</dt>
              <dd className="font-semibold">10</dd>
            </div>
            <div className="flex justify-between">
              <dt>比例</dt>
              <dd className="font-semibold">1:1</dd>
            </div>
          </dl>
          <div className="mt-5 border-t border-[var(--border)] pt-4">
            <StatusBadge status={confirmed ? '处理中' : '草稿'} />
          </div>
        </aside>
      </div>
    </ProductShell>
  );
}
