'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ChevronRight, PackagePlus, Sparkles } from 'lucide-react';

import { ProductShell } from '@/components/layout/product-shell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { ProductDetailControls } from '@/features/product-pages/product-detail-controls';
import { FilterBar, FilterButton, PageHeader } from '@/features/product-pages/ui';
import {
  assetAccessUrl,
  createProduct,
  getProduct,
  listProducts,
  type Product,
  type ProductDetail,
} from '@/lib/resource-api';

function ProductImage({ product }: { product: Product | ProductDetail }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    if (!product.primary_asset_id) return;
    void assetAccessUrl(product.primary_asset_id)
      .then((result) => setUrl(result.url))
      .catch(() => undefined);
  }, [product.primary_asset_id]);
  return url ? (
    <img alt={product.name} className="size-full object-cover" src={url} />
  ) : (
    <div className="grid size-full place-items-center text-xs text-[var(--muted-foreground)]">
      {product.primary_asset_id ? '主图加载中' : '暂无主图'}
    </div>
  );
}

function NewProductDialog({
  onCreated,
  onOpenChange,
  open,
}: {
  onCreated: (product: Product) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const [name, setName] = useState('');
  const [sku, setSku] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError('');
    try {
      const product = await createProduct({ name, ...(sku.trim() ? { sku_code: sku } : {}) });
      onCreated(product);
      setName('');
      setSku('');
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '商品创建失败，请稍后重试');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogTitle className="text-xl font-bold">新建商品</DialogTitle>
        <DialogDescription className="mt-2 text-sm text-[var(--muted-foreground)]">
          先建立商品身份，主图可以稍后在资产库上传并关联。
        </DialogDescription>
        <form className="mt-6 space-y-4" onSubmit={(event) => void submit(event)}>
          <label className="block">
            <span className="mb-1.5 block text-sm font-semibold">商品名称</span>
            <Input
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：夏季轻盈连衣裙"
              value={name}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-semibold">SKU 编号</span>
            <Input
              onChange={(event) => setSku(event.target.value)}
              placeholder="选填"
              value={sku}
            />
          </label>
          {error ? <p className="text-sm text-[var(--danger)]">{error}</p> : null}
          <div className="mt-6 flex justify-end gap-2">
            <Button onClick={() => onOpenChange(false)} type="button" variant="ghost">
              取消
            </Button>
            <Button disabled={saving || !name.trim()} type="submit">
              {saving ? '创建中…' : '创建商品'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ProductsPage() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [items, setItems] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try {
      setItems((await listProducts(search)).items);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '商品加载失败，请重试');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 180);
    return () => window.clearTimeout(timer);
  }, [search]);

  return (
    <ProductShell activeItem="商品" title="商品">
      <PageHeader
        actions={
          <Button onClick={() => setOpen(true)}>
            <PackagePlus aria-hidden="true" size={17} />
            新建商品
          </Button>
        }
        description="以商品和 SKU 组织素材、事实与全部生成记录"
        title="商品"
      />
      <FilterBar onSearch={setSearch} search={search} searchPlaceholder="搜索商品名或 SKU">
        <FilterButton>全部分类</FilterButton>
      </FilterBar>
      {loading ? (
        <p className="py-16 text-center text-sm text-[var(--muted-foreground)]">加载商品中…</p>
      ) : null}
      {error ? (
        <div className="py-16 text-center text-sm text-[var(--danger)]">
          <p>{error}</p>
          <Button className="mt-3" onClick={() => void load()} variant="outline">
            重试
          </Button>
        </div>
      ) : null}
      {!loading && !error && items.length === 0 ? (
        <p className="py-16 text-center text-sm text-[var(--muted-foreground)]">还没有商品</p>
      ) : null}
      {!loading && !error && items.length > 0 ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
          {items.map((product) => (
            <button
              className="group overflow-hidden rounded-lg text-left outline-none transition-[box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:shadow-[var(--shadow-sm)] focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
              key={product.id}
              onClick={() => router.push(`/products/${product.id}`)}
              type="button"
            >
              <div className="relative aspect-square overflow-hidden bg-[var(--soft)]">
                <ProductImage product={product} />
              </div>
              <div className="p-3.5">
                <div className="flex items-start justify-between gap-2">
                  <h2 className="truncate text-sm font-semibold">{product.name}</h2>
                  <ChevronRight
                    aria-hidden="true"
                    className="mt-0.5 shrink-0 text-[var(--subtle-foreground)]"
                    size={15}
                  />
                </div>
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                  {product.sku_code ?? '未设置 SKU'}
                </p>
                <p className="mt-3 text-xs font-medium text-[var(--foreground)]">
                  {product.artifact_count} 个创作结果
                </p>
              </div>
            </button>
          ))}
        </div>
      ) : null}
      <NewProductDialog
        onCreated={(product) => setItems((current) => [product, ...current])}
        onOpenChange={setOpen}
        open={open}
      />
    </ProductShell>
  );
}

export function ProductDetailPage({ productId }: { productId: string }) {
  const router = useRouter();
  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [error, setError] = useState('');
  async function loadProduct() {
    setError('');
    try {
      setProduct(await getProduct(productId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '商品加载失败，请重试');
    }
  }
  useEffect(() => {
    void loadProduct();
  }, [productId]);
  if (error)
    return (
      <ProductShell activeItem="商品" title="商品">
        <p className="py-16 text-center text-sm text-[var(--danger)]">{error}</p>
      </ProductShell>
    );
  if (!product)
    return (
      <ProductShell activeItem="商品" title="商品">
        <p className="py-16 text-center text-sm text-[var(--muted-foreground)]">加载商品中…</p>
      </ProductShell>
    );
  const facts = product.latest_fact_set?.facts ?? {};
  return (
    <ProductShell activeItem="商品" title={product.name}>
      <button
        className="mb-5 inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
        onClick={() => router.push('/products')}
        type="button"
      >
        <ArrowLeft aria-hidden="true" size={17} />
        返回商品
      </button>
      <div className="grid gap-7 lg:grid-cols-[320px_1fr]">
        <section>
          <div className="relative aspect-square overflow-hidden rounded-lg border border-[var(--border)] bg-white">
            <ProductImage product={product} />
          </div>
          <Button className="mt-3 w-full" onClick={() => router.push('/workspace/session/new')}>
            <Sparkles aria-hidden="true" size={17} />
            用这个商品创作
          </Button>
        </section>
        <div>
          <PageHeader
            actions={<ProductDetailControls onChanged={loadProduct} product={product} />}
            description={product.sku_code ?? '未设置 SKU'}
            title={product.name}
          />
          <section className="border-y border-[var(--border)] bg-white">
            <div className="grid sm:grid-cols-2">
              <div className="p-5 sm:border-r sm:border-[var(--border)]">
                <p className="text-xs text-[var(--muted-foreground)]">已确认事实</p>
                <dl className="mt-4 space-y-3 text-sm">
                  <div className="flex justify-between">
                    <dt>主体颜色</dt>
                    <dd className="font-medium">
                      {Array.isArray(facts.primary_colors)
                        ? String(facts.primary_colors[0] ?? '暂无')
                        : '暂无'}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt>Logo</dt>
                    <dd className="font-medium">
                      {Array.isArray(facts.logos) && facts.logos.length ? '有' : '无'}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt>材质</dt>
                    <dd className="font-medium">
                      {Array.isArray(facts.materials)
                        ? String(facts.materials[0] ?? '暂无')
                        : '暂无'}
                    </dd>
                  </div>
                </dl>
              </div>
              <div className="p-5">
                <p className="text-xs text-[var(--muted-foreground)]">创作概览</p>
                <dl className="mt-4 space-y-3 text-sm">
                  <div className="flex justify-between">
                    <dt>作品</dt>
                    <dd className="font-medium">{product.artifact_count}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt>资产</dt>
                    <dd className="font-medium">{product.asset_count}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt>事实版本</dt>
                    <dd className="font-medium">v{product.latest_fact_set?.version_no ?? 0}</dd>
                  </div>
                </dl>
              </div>
            </div>
          </section>
          <h2 className="mb-3 mt-7 text-lg font-bold">这个商品的作品</h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            {Array.from({ length: Math.min(product.artifact_count, 6) }, (_, index) => (
              <div
                className="grid aspect-square place-items-center rounded-lg border border-[var(--border)] bg-[var(--soft)] text-xs text-[var(--muted-foreground)]"
                key={`${product.id}-${index}`}
              >
                创作结果 {index + 1}
              </div>
            ))}
          </div>
        </div>
      </div>
    </ProductShell>
  );
}
