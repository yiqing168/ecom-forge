'use client';

import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ArrowLeft, Heart, Share2, WandSparkles } from 'lucide-react';
import { BrandMark } from '@/components/ui/brand-mark';
import { ProductShell } from '@/components/layout/product-shell';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { FilterBar, FilterButton, PageHeader } from '@/features/product-pages/ui';

const discovery = [
  {
    category: '时装',
    id: 'editorial',
    image: '/demo/result-1.jpg',
    name: '电影感时装光影',
    type: '参考图',
  },
  {
    category: '运动',
    id: 'sport',
    image: '/demo/result-2.jpg',
    name: '速度与高对比色',
    type: '模板',
  },
  {
    category: '家居',
    id: 'home',
    image: '/demo/result-3.jpg',
    name: '柔和自然采光',
    type: '参考图',
  },
  {
    category: '美妆',
    id: 'beauty',
    image: '/demo/result-4.jpg',
    name: '高饱和棚拍构图',
    type: '模板',
  },
  {
    category: '香氛',
    id: 'fragrance',
    image: '/demo/perfume.jpg',
    name: '玻璃折射与水光',
    type: '参考图',
  },
  {
    category: '彩妆',
    id: 'cosmetics',
    image: '/demo/cosmetics.jpg',
    name: '色块平铺构图',
    type: '参考图',
  },
];

export function DiscoverPage() {
  const router = useRouter();
  const [tab, setTab] = useState('模板');
  const [search, setSearch] = useState('');
  return (
    <ProductShell activeItem="发现" title="发现">
      <PageHeader description="查找可复用的创作模板和授权清晰的视觉参考" title="发现" />
      <Tabs className="mb-4" onValueChange={setTab} value={tab}>
        <TabsList aria-label="发现内容">
          {['模板', '参考图', '收藏'].map((item) => (
            <TabsTrigger key={item} value={item}>
              {item}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <FilterBar onSearch={setSearch} search={search} searchPlaceholder="搜索风格、用途或行业">
        <FilterButton>全部行业</FilterButton>
      </FilterBar>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
        {discovery
          .filter((item) => item.name.includes(search))
          .map((item) => (
            <article className="group" key={item.id}>
              <button
                className="relative block aspect-[4/3] w-full overflow-hidden rounded-lg border border-[var(--border)] bg-white outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
                onClick={() => router.push(`/discover/${item.id}`)}
                type="button"
              >
                <Image
                  alt={item.name}
                  className="object-cover transition-transform duration-300 group-hover:scale-[1.025]"
                  fill
                  sizes="320px"
                  src={item.image}
                />
                <span className="absolute left-2 top-2 rounded bg-white/94 px-2 py-1 text-xs font-semibold">
                  {item.type}
                </span>
              </button>
              <div className="flex items-start justify-between gap-2 pt-2.5">
                <div>
                  <h2 className="text-sm font-semibold">{item.name}</h2>
                  <p className="mt-0.5 text-xs text-[var(--muted-foreground)]">
                    {item.category} · 可商用
                  </p>
                </div>
                <button
                  aria-label={`收藏${item.name}`}
                  className="grid size-11 shrink-0 place-items-center rounded-md hover:bg-white"
                  type="button"
                >
                  <Heart aria-hidden="true" size={17} />
                </button>
              </div>
            </article>
          ))}
      </div>
    </ProductShell>
  );
}

export function DiscoverDetailPage({ itemId }: { itemId: string }) {
  const router = useRouter();
  const item = discovery.find((entry) => entry.id === itemId) ?? discovery[0]!;
  return (
    <ProductShell activeItem="发现" title={item.name}>
      <button
        className="mb-5 inline-flex min-h-11 items-center gap-2 text-sm text-[var(--muted-foreground)]"
        onClick={() => router.push('/discover')}
        type="button"
      >
        <ArrowLeft aria-hidden="true" size={17} />
        返回发现
      </button>
      <div className="grid gap-7 lg:grid-cols-[minmax(0,1.2fr)_420px]">
        <div className="relative min-h-[520px] overflow-hidden rounded-lg border border-[var(--border)] bg-white">
          <Image alt={item.name} className="object-cover" fill sizes="800px" src={item.image} />
        </div>
        <aside>
          <p className="text-sm font-semibold text-[var(--foreground)]">{item.type}</p>
          <h1 className="mt-2 text-3xl font-bold">{item.name}</h1>
          <p className="mt-4 text-sm leading-7 text-[var(--muted-foreground)]">
            适合广告视觉、社交媒体内容和品牌氛围图。授权版本固定，使用时会绑定当前模板版本。
          </p>
          <dl className="mt-6 space-y-3 border-y border-[var(--border)] py-5 text-sm">
            <div className="flex justify-between">
              <dt>适用行业</dt>
              <dd className="font-semibold">{item.category}</dd>
            </div>
            <div className="flex justify-between">
              <dt>授权</dt>
              <dd className="font-semibold">可商用</dd>
            </div>
            <div className="flex justify-between">
              <dt>版本</dt>
              <dd className="font-semibold">v2.1</dd>
            </div>
          </dl>
          <div className="mt-6 space-y-2">
            <Button className="w-full" onClick={() => router.push('/workspace/session/new')}>
              <WandSparkles aria-hidden="true" size={17} />
              用作参考创作
            </Button>
            <Button className="w-full" onClick={() => router.push('/suites/new')} variant="outline">
              用于套图
            </Button>
          </div>
        </aside>
      </div>
    </ProductShell>
  );
}

export function PublicSharePage() {
  const router = useRouter();
  return (
    <main className="min-h-dvh bg-[var(--background)] px-4 py-5 sm:px-7">
      <header className="mx-auto flex max-w-[1280px] items-center justify-between">
        <div className="flex items-center gap-3">
          <BrandMark className="size-9" />
          <b>象塑</b>
        </div>
        <Button onClick={() => router.push('/workspace/session/new')}>我也要创作</Button>
      </header>
      <section className="mx-auto mt-8 grid max-w-[1180px] gap-7 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="relative min-h-[70dvh] overflow-hidden rounded-lg bg-[var(--foreground)]">
          <Image
            alt="公开作品"
            className="object-contain"
            fill
            priority
            sizes="900px"
            src="/demo/result-1.jpg"
          />
        </div>
        <aside className="self-center">
          <p className="text-sm font-semibold text-[var(--foreground)]">公开作品</p>
          <h1 className="mt-2 text-3xl font-bold">城市里的夏日时装</h1>
          <p className="mt-4 text-sm leading-7 text-[var(--muted-foreground)]">
            由创作者 林夏 分享。参考这张作品创作时会建立新的任务，不继承原作品修改权。
          </p>
          <div className="mt-6 flex items-center gap-3 border-y border-[var(--border)] py-4 text-sm">
            <span className="grid size-9 place-items-center rounded-full bg-[var(--inverse)] font-bold text-white">
              林
            </span>
            <div>
              <b>林夏</b>
              <p className="text-xs text-[var(--muted-foreground)]">2026-08-08 发布</p>
            </div>
          </div>
          <Button className="mt-6 w-full" onClick={() => router.push('/workspace/session/new')}>
            <WandSparkles aria-hidden="true" size={17} />
            以此为参考创作
          </Button>
          <button
            className="mt-3 flex min-h-11 w-full items-center justify-center gap-2 text-sm text-[var(--muted-foreground)]"
            type="button"
          >
            <Share2 aria-hidden="true" size={16} />
            分享链接
          </button>
        </aside>
      </section>
    </main>
  );
}
