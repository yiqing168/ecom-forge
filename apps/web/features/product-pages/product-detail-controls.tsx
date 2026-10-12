'use client';

import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { FileCheck2, ImagePlus, Pencil } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  createProductFactSet,
  listAssets,
  updateProduct,
  uploadAsset,
  type Asset,
  type ProductDetail,
  type ProductFacts,
} from '@/lib/resource-api';

type DialogName = 'edit' | 'facts' | 'image' | null;

function list(value: string): string[] {
  return value
    .split(/[\n,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function ProductDetailControls({
  onChanged,
  product,
}: {
  onChanged: () => Promise<void>;
  product: ProductDetail;
}) {
  const [dialog, setDialog] = useState<DialogName>(null);
  const [name, setName] = useState(product.name);
  const [sku, setSku] = useState(product.sku_code ?? '');
  const [assets, setAssets] = useState<Asset[]>([]);
  const [selectedAssetId, setSelectedAssetId] = useState(product.primary_asset_id ?? '');
  const [colors, setColors] = useState('');
  const [logos, setLogos] = useState('');
  const [materials, setMaterials] = useState('');
  const [mustPreserve, setMustPreserve] = useState('');
  const [visibleText, setVisibleText] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setName(product.name);
    setSku(product.sku_code ?? '');
    setSelectedAssetId(product.primary_asset_id ?? '');
  }, [product]);

  async function loadReadyAssets() {
    const result = await listAssets({ productId: product.id, status: 'ready' });
    setAssets(result.items);
    if (!selectedAssetId && result.items[0]) setSelectedAssetId(result.items[0].id);
  }

  function open(next: Exclude<DialogName, null>) {
    setError('');
    setNotice('');
    setDialog(next);
    if (next === 'image') void loadReadyAssets().catch(showError);
  }

  function showError(cause: unknown) {
    setError(cause instanceof Error ? cause.message : '操作失败，请稍后重试');
  }

  async function saveProduct(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError('');
    try {
      await updateProduct(product.id, {
        revision: product.revision,
        name,
        sku_code: sku.trim() || null,
      });
      await onChanged();
      setDialog(null);
    } catch (cause) {
      showError(cause);
    } finally {
      setSaving(false);
    }
  }

  async function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setSaving(true);
    setError('');
    setNotice('图片已上传，正在检查格式并生成缩略图…');
    try {
      const asset = await uploadAsset(file, { productId: product.id });
      if (asset.status !== 'ready') {
        throw new Error(
          asset.status === 'processing_failed'
            ? '图片处理失败，请前往资产库重试'
            : asset.status === 'rejected'
              ? '图片未通过格式或尺寸检查'
              : '图片仍在处理中，请稍后再试',
        );
      }
      setAssets((current) => [asset, ...current.filter((item) => item.id !== asset.id)]);
      setSelectedAssetId(asset.id);
      setNotice('图片处理完成，可以设为主图');
    } catch (cause) {
      setNotice('');
      showError(cause);
    } finally {
      setSaving(false);
    }
  }

  async function savePrimaryImage() {
    if (!selectedAssetId) return;
    setSaving(true);
    setError('');
    try {
      await updateProduct(product.id, {
        revision: product.revision,
        primary_asset_id: selectedAssetId,
      });
      await onChanged();
      setDialog(null);
    } catch (cause) {
      showError(cause);
    } finally {
      setSaving(false);
    }
  }

  async function saveFacts(event: FormEvent) {
    event.preventDefault();
    if (!product.primary_asset_id) return;
    setSaving(true);
    setError('');
    const facts: ProductFacts = {
      product_name: product.name,
      primary_colors: list(colors),
      logos: list(logos),
      visible_text: list(visibleText),
      materials: list(materials),
      must_preserve: list(mustPreserve),
      unknown_fields: [],
    };
    try {
      await createProductFactSet(product.id, {
        expected_latest_fact_set_id: product.latest_fact_set?.id ?? null,
        source_asset_id: product.primary_asset_id,
        facts,
      });
      await onChanged();
      setDialog(null);
    } catch (cause) {
      showError(cause);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => open('edit')} variant="outline">
          <Pencil aria-hidden="true" size={16} />
          编辑商品
        </Button>
        <Button onClick={() => open('image')} variant="outline">
          <ImagePlus aria-hidden="true" size={16} />
          设置主图
        </Button>
        <Button
          disabled={!product.primary_asset_id}
          onClick={() => open('facts')}
          variant="outline"
        >
          <FileCheck2 aria-hidden="true" size={16} />
          确认事实
        </Button>
      </div>

      <Dialog onOpenChange={(value) => !value && setDialog(null)} open={dialog === 'edit'}>
        <DialogContent>
          <DialogTitle className="text-xl font-bold">编辑商品</DialogTitle>
          <DialogDescription className="mt-2 text-sm text-[var(--muted-foreground)]">
            更新商品名称和当前账号内唯一的 SKU 编号。
          </DialogDescription>
          <form className="mt-6 space-y-4" onSubmit={(event) => void saveProduct(event)}>
            <label className="block">
              <span className="mb-1.5 block text-sm font-semibold">商品名称</span>
              <Input onChange={(event) => setName(event.target.value)} value={name} />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-sm font-semibold">SKU 编号</span>
              <Input onChange={(event) => setSku(event.target.value)} value={sku} />
            </label>
            <DialogActions error={error} saving={saving} />
          </form>
        </DialogContent>
      </Dialog>

      <Dialog onOpenChange={(value) => !value && setDialog(null)} open={dialog === 'image'}>
        <DialogContent>
          <DialogTitle className="text-xl font-bold">设置商品主图</DialogTitle>
          <DialogDescription className="mt-2 text-sm text-[var(--muted-foreground)]">
            上传新素材，或从已关联且处理完成的商品素材中选择。
          </DialogDescription>
          <div className="mt-6 space-y-4">
            <label className="flex min-h-20 cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-[var(--border-strong)] bg-[var(--surface-raised)] text-sm font-semibold">
              <ImagePlus aria-hidden="true" size={18} />
              {saving ? '处理中…' : '上传商品图片'}
              <input
                accept="image/jpeg,image/png,image/webp"
                className="sr-only"
                disabled={saving}
                onChange={(event) => void handleUpload(event)}
                type="file"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-sm font-semibold">已处理素材</span>
              <select
                className="h-11 w-full rounded-[7px] border border-[var(--border-strong)] bg-white px-3 text-sm"
                onChange={(event) => setSelectedAssetId(event.target.value)}
                value={selectedAssetId}
              >
                <option value="">请选择素材</option>
                {assets.map((asset) => (
                  <option key={asset.id} value={asset.id}>
                    {asset.display_name}
                  </option>
                ))}
              </select>
            </label>
            {notice ? <p className="text-sm text-[var(--primary)]">{notice}</p> : null}
            {error ? <p className="text-sm text-[var(--danger)]">{error}</p> : null}
            <div className="flex justify-end gap-2">
              <Button onClick={() => setDialog(null)} type="button" variant="ghost">
                取消
              </Button>
              <Button disabled={saving || !selectedAssetId} onClick={() => void savePrimaryImage()}>
                设为主图
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog onOpenChange={(value) => !value && setDialog(null)} open={dialog === 'facts'}>
        <DialogContent className="max-h-[calc(100dvh-32px)] overflow-y-auto">
          <DialogTitle className="text-xl font-bold">确认商品事实</DialogTitle>
          <DialogDescription className="mt-2 text-sm text-[var(--muted-foreground)]">
            事实将基于当前主图保存为不可变新版本。多项内容可用逗号分隔。
          </DialogDescription>
          <form className="mt-6 space-y-4" onSubmit={(event) => void saveFacts(event)}>
            <FactInput label="主体颜色" onChange={setColors} value={colors} />
            <FactInput label="Logo" onChange={setLogos} value={logos} />
            <FactInput label="可见文字" onChange={setVisibleText} value={visibleText} />
            <FactInput label="材质" onChange={setMaterials} value={materials} />
            <FactInput label="必须保留" onChange={setMustPreserve} value={mustPreserve} />
            <DialogActions error={error} saving={saving} />
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function FactInput({
  label,
  onChange,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-semibold">{label}</span>
      <Input onChange={(event) => onChange(event.target.value)} value={value} />
    </label>
  );
}

function DialogActions({ error, saving }: { error: string; saving: boolean }) {
  return (
    <>
      {error ? <p className="text-sm text-[var(--danger)]">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button disabled={saving} type="submit">
          {saving ? '保存中…' : '保存'}
        </Button>
      </div>
    </>
  );
}
