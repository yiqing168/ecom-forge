import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/resource-api', () => ({
  createProductFactSet: vi.fn(),
  listAssets: vi.fn(),
  updateProduct: vi.fn(),
  uploadAsset: vi.fn(),
}));

import { ProductDetailControls } from './product-detail-controls';
import {
  createProductFactSet,
  listAssets,
  updateProduct,
  type ProductDetail,
} from '@/lib/resource-api';

const product: ProductDetail = {
  id: '11111111-1111-4111-8111-111111111111',
  name: '原商品',
  sku_code: 'SKU-1',
  status: 'active',
  revision: 3,
  primary_asset_id: '22222222-2222-4222-8222-222222222222',
  primary_asset_preview: { variant: 'thumbnail' },
  artifact_count: 0,
  updated_at: '2026-08-13T00:00:00.000Z',
  latest_fact_set: null,
  asset_count: 1,
  workflow_count: 0,
  credit_summary: null,
};

beforeEach(() => {
  vi.mocked(updateProduct).mockReset().mockResolvedValue(product);
  vi.mocked(createProductFactSet).mockReset().mockResolvedValue({
    id: '33333333-3333-4333-8333-333333333333',
    version_no: 1,
    source_asset_id: product.primary_asset_id!,
    facts: {},
    confirmed_at: '2026-08-13T00:00:00.000Z',
  });
  vi.mocked(listAssets).mockReset().mockResolvedValue({ items: [], next_cursor: null });
});

afterEach(cleanup);

describe('ProductDetailControls', () => {
  it('updates the product with the current server revision', async () => {
    const onChanged = vi.fn().mockResolvedValue(undefined);
    render(<ProductDetailControls onChanged={onChanged} product={product} />);

    fireEvent.click(screen.getByRole('button', { name: '编辑商品' }));
    fireEvent.change(screen.getByLabelText('商品名称'), { target: { value: '新商品' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(updateProduct).toHaveBeenCalledWith(product.id, {
        revision: 3,
        name: '新商品',
        sku_code: 'SKU-1',
      }),
    );
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it('creates a strict fact snapshot from the current primary asset', async () => {
    render(<ProductDetailControls onChanged={vi.fn()} product={product} />);

    fireEvent.click(screen.getByRole('button', { name: '确认事实' }));
    fireEvent.change(screen.getByLabelText('主体颜色'), { target: { value: '红色，白色' } });
    fireEvent.change(screen.getByLabelText('材质'), { target: { value: '棉, 亚麻' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(createProductFactSet).toHaveBeenCalledWith(product.id, {
        expected_latest_fact_set_id: null,
        source_asset_id: product.primary_asset_id,
        facts: {
          product_name: '原商品',
          primary_colors: ['红色', '白色'],
          logos: [],
          visible_text: [],
          materials: ['棉', '亚麻'],
          must_preserve: [],
          unknown_fields: [],
        },
      }),
    );
  });

  it('keeps fact confirmation disabled until a primary asset exists', () => {
    render(
      <ProductDetailControls
        onChanged={vi.fn()}
        product={{ ...product, primary_asset_id: null, primary_asset_preview: null }}
      />,
    );

    expect(screen.getByRole('button', { name: '确认事实' }).hasAttribute('disabled')).toBe(true);
  });
});
