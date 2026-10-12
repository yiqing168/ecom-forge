import { readFile } from 'node:fs/promises';
import type { Route } from '@playwright/test';

import type { Artifact, Asset, Product, ProductDetail } from '../lib/resource-api';

const responseHeaders = {
  'access-control-allow-credentials': 'true',
  'access-control-allow-headers': 'content-type,idempotency-key',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-origin': 'http://127.0.0.1:3100',
};

const now = '2026-08-14T00:00:00.000Z';
const uploadPreview =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const fixtureAssets: Array<Asset & { accessUrl: string }> = [
  {
    accessUrl: '/demo/dress.jpg',
    content_version: 'mock-dress-v1',
    created_at: now,
    display_name: '电影感时装大片',
    folder_id: null,
    height: 1200,
    id: '00000000-0000-4000-8000-000000000101',
    kind: 'upload',
    origin: '服装',
    preview: { variant: 'thumbnail' },
    processing_error_code: null,
    product_id: 'sku-001',
    status: 'ready',
    width: 900,
  },
  {
    accessUrl: '/demo/shoe.jpg',
    content_version: 'mock-shoe-v1',
    created_at: now,
    display_name: '潮流运动视觉',
    folder_id: null,
    height: 1200,
    id: '00000000-0000-4000-8000-000000000102',
    kind: 'upload',
    origin: '鞋包',
    preview: { variant: 'thumbnail' },
    processing_error_code: null,
    product_id: null,
    status: 'ready',
    width: 900,
  },
  {
    accessUrl: '/demo/sofa.jpg',
    content_version: 'mock-sofa-v1',
    created_at: now,
    display_name: '现代家居氛围',
    folder_id: null,
    height: 900,
    id: '00000000-0000-4000-8000-000000000103',
    kind: 'upload',
    origin: '家居',
    preview: { variant: 'thumbnail' },
    processing_error_code: null,
    product_id: null,
    status: 'ready',
    width: 1200,
  },
  {
    accessUrl: '/demo/perfume.jpg',
    content_version: 'mock-perfume-v1',
    created_at: now,
    display_name: '香氛广告视觉',
    folder_id: null,
    height: 1200,
    id: '00000000-0000-4000-8000-000000000104',
    kind: 'upload',
    origin: '美妆个护',
    preview: { variant: 'thumbnail' },
    processing_error_code: null,
    product_id: null,
    status: 'ready',
    width: 900,
  },
  {
    accessUrl: '/demo/cosmetics.jpg',
    content_version: 'mock-cosmetics-v1',
    created_at: now,
    display_name: '彩妆创意平铺',
    folder_id: null,
    height: 900,
    id: '00000000-0000-4000-8000-000000000105',
    kind: 'upload',
    origin: '日用百货',
    preview: { variant: 'thumbnail' },
    processing_error_code: null,
    product_id: null,
    status: 'ready',
    width: 1200,
  },
];

const fixtureProduct: Product = {
  artifact_count: 3,
  id: 'sku-001',
  name: '夏季轻盈连衣裙',
  primary_asset_id: fixtureAssets[0]!.id,
  primary_asset_preview: { variant: 'thumbnail' },
  revision: 1,
  sku_code: 'SKU-001',
  status: 'active',
  updated_at: now,
};

const fixtureProductDetail: ProductDetail = {
  ...fixtureProduct,
  asset_count: 1,
  credit_summary: null,
  latest_fact_set: {
    confirmed_at: now,
    facts: {
      logos: [],
      materials: ['轻盈面料'],
      primary_colors: ['浅蓝色'],
    },
    id: '00000000-0000-4000-8000-000000000301',
    source_asset_id: fixtureAssets[0]!.id,
    version_no: 1,
  },
  workflow_count: 2,
};

const fixtureArtifacts: Array<Artifact & { accessUrl: string }> = [
  {
    accessUrl: '/demo/result-1.jpg',
    created_at: now,
    id: '00000000-0000-4000-8000-000000000401',
    origin_domain: 'creative',
    preview: { variant: 'thumbnail' },
    producer_mode: 'chat',
    product_id: fixtureProduct.id,
    source_action: 'image.generate',
    type: 'image',
    visibility: 'private',
  },
];

async function fulfillData(route: Route, data: unknown, status = 200) {
  await route.fulfill({
    body: JSON.stringify({ data }),
    contentType: 'application/json',
    headers: responseHeaders,
    status,
  });
}

async function fulfillError(route: Route, status: number, code: string, message: string) {
  await route.fulfill({
    body: JSON.stringify({ error: { code, message } }),
    contentType: 'application/json',
    headers: responseHeaders,
    status,
  });
}

export function createResourceApiMock(): (route: Route) => Promise<boolean> {
  const assets = fixtureAssets.map((asset) => ({ ...asset }));
  let uploadCount = 0;

  return async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const path = url.pathname;

    const contentMatch = path.match(/^\/api\/v1\/(assets|artifacts)\/([^/]+)\/content$/);
    if (method === 'GET' && contentMatch) {
      const id = decodeURIComponent(contentMatch[2]!);
      const item = (contentMatch[1] === 'assets' ? assets : fixtureArtifacts).find(
        (candidate) => candidate.id === id,
      );
      if (!item) {
        await fulfillError(route, 404, 'MEDIA_NOT_FOUND', '图片不存在');
      } else if (item.accessUrl === uploadPreview) {
        await route.fulfill({
          body: Buffer.from(uploadPreview.split(',')[1]!, 'base64'),
          contentType: 'image/png',
          headers: responseHeaders,
          status: 200,
        });
      } else {
        await route.fulfill({
          body: await readFile(new URL(`../public${item.accessUrl}`, import.meta.url)),
          contentType: 'image/jpeg',
          headers: responseHeaders,
          status: 200,
        });
      }
      return true;
    }

    if (method === 'GET' && path === '/api/v1/products') {
      const query = url.searchParams.get('query')?.trim().toLocaleLowerCase() ?? '';
      const items = query
        ? [fixtureProduct].filter((product) =>
            `${product.name} ${product.sku_code ?? ''}`.toLocaleLowerCase().includes(query),
          )
        : [fixtureProduct];
      await fulfillData(route, { items, next_cursor: null });
      return true;
    }

    const productMatch = path.match(/^\/api\/v1\/products\/([^/]+)$/);
    if (method === 'GET' && productMatch) {
      if (decodeURIComponent(productMatch[1]!) !== fixtureProduct.id) {
        await fulfillError(route, 404, 'PRODUCT_NOT_FOUND', '商品不存在');
      } else {
        await fulfillData(route, fixtureProductDetail);
      }
      return true;
    }

    if (method === 'GET' && path === '/api/v1/assets') {
      const productId = url.searchParams.get('product_id');
      const query = url.searchParams.get('query')?.trim().toLocaleLowerCase() ?? '';
      const status = url.searchParams.get('status');
      const items = assets
        .filter((asset) => !productId || asset.product_id === productId)
        .filter((asset) => !query || asset.display_name.toLocaleLowerCase().includes(query))
        .filter((asset) => !status || asset.status === status)
        .map(({ accessUrl: _accessUrl, ...asset }) => asset);
      await fulfillData(route, { items, next_cursor: null });
      return true;
    }

    if (method === 'POST' && path === '/api/v1/assets/upload-url') {
      const body = request.postDataJSON() as { display_name?: string };
      uploadCount += 1;
      const suffix = String(200 + uploadCount).padStart(12, '0');
      const assetId = `00000000-0000-4000-8000-${suffix}`;
      assets.push({
        accessUrl: uploadPreview,
        content_version: `mock-upload-${uploadCount}-v1`,
        created_at: now,
        display_name: body.display_name ?? `测试附件 ${uploadCount}`,
        folder_id: null,
        height: 1,
        id: assetId,
        kind: 'upload',
        origin: 'user_upload',
        preview: { variant: 'thumbnail' },
        processing_error_code: null,
        product_id: null,
        status: 'ready',
        width: 1,
      });
      await fulfillData(route, {
        asset_id: assetId,
        upload: { headers: { 'content-type': 'image/png' }, url: `/api/v1/mock-upload/${assetId}` },
        upload_id: `mock-upload-${uploadCount}`,
      });
      return true;
    }

    if (method === 'PUT' && path.startsWith('/api/v1/mock-upload/')) {
      await route.fulfill({ body: '', headers: responseHeaders, status: 204 });
      return true;
    }

    if (method === 'POST' && path === '/api/v1/assets/complete') {
      await fulfillData(route, { status: 'processing' });
      return true;
    }

    const assetAccessMatch = path.match(/^\/api\/v1\/assets\/([^/]+)\/access-url$/);
    if (method === 'POST' && assetAccessMatch) {
      const id = decodeURIComponent(assetAccessMatch[1]!);
      const asset = assets.find((item) => item.id === id);
      if (!asset) {
        await fulfillError(route, 404, 'ASSET_NOT_FOUND', '资产不存在');
      } else {
        await fulfillData(route, { expires_at: '2026-08-14T00:10:00.000Z', url: asset.accessUrl });
      }
      return true;
    }

    if (method === 'GET' && path === '/api/v1/artifacts') {
      const productId = url.searchParams.get('product_id');
      const items = fixtureArtifacts
        .filter((artifact) => !productId || artifact.product_id === productId)
        .map(({ accessUrl: _accessUrl, ...artifact }) => artifact);
      await fulfillData(route, { items, next_cursor: null });
      return true;
    }

    const artifactAccessMatch = path.match(/^\/api\/v1\/artifacts\/([^/]+)\/access-url$/);
    if (method === 'POST' && artifactAccessMatch) {
      const id = decodeURIComponent(artifactAccessMatch[1]!);
      const artifact = fixtureArtifacts.find((item) => item.id === id);
      if (!artifact) {
        await fulfillError(route, 404, 'ARTIFACT_NOT_FOUND', '作品不存在');
      } else {
        await fulfillData(route, {
          expires_at: '2026-08-14T00:10:00.000Z',
          url: artifact.accessUrl,
        });
      }
      return true;
    }

    if (
      path === '/api/v1/products' ||
      path.startsWith('/api/v1/products/') ||
      path === '/api/v1/assets' ||
      path.startsWith('/api/v1/assets/') ||
      path === '/api/v1/artifacts' ||
      path.startsWith('/api/v1/artifacts/')
    ) {
      await fulfillError(
        route,
        501,
        'E2E_RESOURCE_MOCK_UNHANDLED',
        `E2E resource mock does not handle ${method} ${path}`,
      );
      return true;
    }

    return false;
  };
}
