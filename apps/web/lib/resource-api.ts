type ApiErrorPayload = { error?: { code?: string; message?: string } };

export class ResourceApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ResourceApiError';
  }
}

const apiOrigin = (process.env.NEXT_PUBLIC_API_ORIGIN ?? '').replace(/\/$/, '');
export const MAX_ASSET_UPLOAD_BYTES = 20 * 1024 * 1024;

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !(init.body instanceof Blob) && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const response = await fetch(`${apiOrigin}${path}`, {
    ...init,
    credentials: 'include',
    headers,
    cache: 'no-store',
  });
  const payload = (await response.json().catch(() => null)) as
    ({ data?: T } & ApiErrorPayload) | null;
  if (!response.ok) {
    throw new ResourceApiError(
      payload?.error?.code ?? 'RESOURCE_REQUEST_FAILED',
      response.status,
      payload?.error?.message ?? '资源服务暂时不可用，请稍后重试',
    );
  }
  return payload?.data as T;
}

function key(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export type Product = {
  id: string;
  name: string;
  sku_code: string | null;
  status: 'active' | 'archived';
  revision: number;
  primary_asset_id: string | null;
  primary_asset_preview: { variant: 'thumbnail' } | null;
  artifact_count: number;
  updated_at: string;
};

export type ProductDetail = Product & {
  latest_fact_set: {
    id: string;
    version_no: number;
    source_asset_id: string;
    facts: Record<string, unknown>;
    confirmed_at: string | null;
  } | null;
  asset_count: number;
  workflow_count: number;
  credit_summary: null;
};

export type ProductFacts = {
  product_name: string;
  primary_colors: string[];
  logos: string[];
  visible_text: string[];
  materials: string[];
  must_preserve: string[];
  unknown_fields: string[];
};

export type Asset = {
  id: string;
  display_name: string;
  product_id: string | null;
  folder_id: string | null;
  kind: 'upload' | 'generated' | 'imported';
  origin: string;
  status: 'uploading' | 'processing' | 'ready' | 'processing_failed' | 'rejected' | 'deleted';
  processing_error_code: string | null;
  width: number | null;
  height: number | null;
  content_version: string | null;
  preview: { variant: 'thumbnail' } | null;
  created_at: string;
  image_url?: string;
};

export type Artifact = {
  id: string;
  product_id: string | null;
  type: 'image' | 'video' | 'text';
  origin_domain: 'creative' | 'commerce';
  producer_mode: 'chat' | 'canvas' | 'suite';
  source_action: string;
  source_artifact_id?: string | null;
  producer_session_id?: string | null;
  visibility: 'private' | 'shared' | 'public' | 'quarantined' | 'deleted';
  content_version?: string | null;
  publication_revision?: number | null;
  width?: number | null;
  height?: number | null;
  created_at: string;
  preview?: { variant: 'thumbnail' };
  image_url?: string;
};

export async function listProducts(
  query = '',
): Promise<{ items: Product[]; next_cursor: string | null }> {
  const suffix = query ? `?query=${encodeURIComponent(query)}` : '';
  return request(`/api/v1/products${suffix}`);
}

export function getProduct(id: string): Promise<ProductDetail> {
  return request(`/api/v1/products/${encodeURIComponent(id)}`);
}

export function createProduct(input: {
  name: string;
  sku_code?: string;
  primary_asset_id?: string;
}): Promise<Product> {
  return request('/api/v1/products', {
    method: 'POST',
    headers: { 'Idempotency-Key': key('product-create') },
    body: JSON.stringify(input),
  });
}

export function updateProduct(
  id: string,
  input: {
    revision: number;
    name?: string;
    sku_code?: string | null;
    primary_asset_id?: string | null;
    status?: 'active' | 'archived';
  },
): Promise<Product> {
  return request(`/api/v1/products/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Idempotency-Key': key('product-update') },
    body: JSON.stringify(input),
  });
}

export function createProductFactSet(
  id: string,
  input: {
    expected_latest_fact_set_id: string | null;
    source_asset_id: string;
    facts: ProductFacts;
  },
): Promise<ProductDetail['latest_fact_set']> {
  return request(`/api/v1/products/${encodeURIComponent(id)}/fact-sets`, {
    method: 'POST',
    headers: { 'Idempotency-Key': key('product-facts') },
    body: JSON.stringify(input),
  });
}

export async function listAssets(
  options:
    | {
        productId?: string;
        query?: string;
        status?: Asset['status'];
        cursor?: string;
      }
    | string = {},
): Promise<{ items: Asset[]; next_cursor: string | null }> {
  const normalized = typeof options === 'string' ? { query: options } : options;
  const query = new URLSearchParams();
  if (normalized.query) query.set('query', normalized.query);
  if (normalized.productId) query.set('product_id', normalized.productId);
  if (normalized.status) query.set('status', normalized.status);
  if (normalized.cursor) query.set('cursor', normalized.cursor);
  const suffix = query.size ? `?${query.toString()}` : '';
  return request(`/api/v1/assets${suffix}`);
}

export async function listArtifacts(
  options: {
    originDomain?: Artifact['origin_domain'];
    producerMode?: Artifact['producer_mode'];
    productId?: string;
    skuCode?: string;
    type?: Artifact['type'];
    cursor?: string;
  } = {},
): Promise<{ items: Artifact[]; next_cursor: string | null }> {
  const query = new URLSearchParams();
  if (options.productId) query.set('product_id', options.productId);
  if (options.skuCode) query.set('sku_code', options.skuCode);
  if (options.type) query.set('type', options.type);
  if (options.originDomain) query.set('origin_domain', options.originDomain);
  if (options.producerMode) query.set('producer_mode', options.producerMode);
  if (options.cursor) query.set('cursor', options.cursor);
  const suffix = query.size ? `?${query.toString()}` : '';
  return request(`/api/v1/artifacts${suffix}`);
}

export function assetAccessUrl(
  id: string,
  variant: 'original' | 'thumbnail' = 'thumbnail',
  purpose: 'download' | 'preview' = 'preview',
  options: { signal?: AbortSignal } = {},
): Promise<{ url: string; expires_at: string }> {
  return request(`/api/v1/assets/${encodeURIComponent(id)}/access-url`, {
    method: 'POST',
    headers: { 'Idempotency-Key': key('asset-access') },
    body: JSON.stringify({ variant, purpose }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

export function artifactAccessUrl(
  id: string,
  variant: 'original' | 'thumbnail' = 'thumbnail',
  purpose: 'download' | 'preview' = 'preview',
  options: { signal?: AbortSignal } = {},
): Promise<{ url: string; expires_at: string }> {
  return request(`/api/v1/artifacts/${encodeURIComponent(id)}/access-url`, {
    method: 'POST',
    headers: { 'Idempotency-Key': key('artifact-access') },
    body: JSON.stringify({ variant, purpose }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/**
 * In-app preview URL for an artifact. Session-authenticated and fixed, so a
 * same-origin `<img>` can load it directly via the session cookie — no per-image
 * signed-URL round trip. The backend serves `Cache-Control: private,
 * no-cache` plus ETag/304, so cached bytes are revalidated before reuse.
 */
export function artifactContentUrl(
  id: string,
  variant: 'original' | 'thumbnail' = 'thumbnail',
): string {
  return `/api/v1/artifacts/${encodeURIComponent(id)}/content?variant=${variant}&purpose=preview`;
}

/**
 * In-app preview URL for an asset. See {@link artifactContentUrl} — same contract,
 * different resource kind.
 */
export function assetContentUrl(
  id: string,
  variant: 'original' | 'thumbnail' = 'thumbnail',
): string {
  return `/api/v1/assets/${encodeURIComponent(id)}/content?variant=${variant}&purpose=preview`;
}

export function retryAsset(id: string): Promise<Asset> {
  return request(`/api/v1/assets/${encodeURIComponent(id)}/retry-processing`, {
    method: 'POST',
    headers: { 'Idempotency-Key': key('asset-retry') },
    body: JSON.stringify({ reason: 'user_requested' }),
  });
}

export function saveArtifactToAssets(
  id: string,
  options: { folderId?: string; productId?: string } = {},
): Promise<Asset> {
  return request(`/api/v1/artifacts/${encodeURIComponent(id)}/save-to-assets`, {
    method: 'POST',
    headers: { 'Idempotency-Key': key('artifact-save') },
    body: JSON.stringify({
      ...(options.folderId ? { folder_id: options.folderId } : {}),
      ...(options.productId ? { product_id: options.productId } : {}),
    }),
  });
}

/** Status-aware fallback for upload failures whose response body is not the API's JSON shape. */
function uploadFailureMessage(status: number): string {
  if (status === 413) return '图片文件超过上传大小限制，请压缩后重试';
  if (status === 410) return '上传窗口已过期，请重新选择文件';
  if (status === 404) return '上传已失效，请重新选择文件';
  if (status === 403) return '该图片无法上传（格式或来源不受支持），请换一张图片';
  if (status === 429) return '操作过于频繁，请稍后再试';
  if (status >= 500) return '上传服务暂时不可用，请稍后重试';
  return '图片上传失败，请重试';
}

export async function uploadAsset(
  file: File,
  options: { productId?: string } = {},
): Promise<Asset> {
  if (file.size <= 0 || file.size > MAX_ASSET_UPLOAD_BYTES) {
    throw new ResourceApiError('ASSET_UPLOAD_INVALID', 413, '图片不能超过20 MB');
  }
  const intent = await request<{
    upload_id: string;
    asset_id: string;
    upload: { url: string; headers: Record<string, string> };
  }>('/api/v1/assets/upload-url', {
    method: 'POST',
    headers: { 'Idempotency-Key': key('asset-upload') },
    body: JSON.stringify({
      display_name: file.name,
      declared_mime_type: file.type,
      file_size_bytes: file.size,
      ...(options.productId ? { product_id: options.productId } : {}),
    }),
  });
  const uploadResponse = await fetch(intent.upload.url, {
    method: 'PUT',
    credentials: 'include',
    headers: intent.upload.headers,
    body: file,
  });
  if (!uploadResponse.ok) {
    // The API answers with a structured error, but the Next.js rewrite proxy replies
    // with plain text when it rejects a request itself (e.g. its body size cap), so
    // the body is not always JSON. Prefer the server's code/message and fall back to
    // a status-aware hint, instead of collapsing every failure into one opaque text.
    const payload = (await uploadResponse.json().catch(() => null)) as ApiErrorPayload | null;
    throw new ResourceApiError(
      payload?.error?.code ?? 'ASSET_UPLOAD_INVALID',
      uploadResponse.status,
      payload?.error?.message ?? uploadFailureMessage(uploadResponse.status),
    );
  }
  await request(`/api/v1/assets/complete`, {
    method: 'POST',
    headers: { 'Idempotency-Key': key('asset-complete') },
    body: JSON.stringify({ upload_id: intent.upload_id, asset_id: intent.asset_id }),
  });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const listed = await listAssets();
    const asset = listed.items.find((item) => item.id === intent.asset_id);
    if (
      asset?.status === 'ready' ||
      asset?.status === 'rejected' ||
      asset?.status === 'processing_failed'
    ) {
      return asset;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 500));
  }
  const listed = await listAssets();
  return (
    listed.items.find((item) => item.id === intent.asset_id) ?? {
      id: intent.asset_id,
      display_name: file.name,
      product_id: options.productId ?? null,
      folder_id: null,
      kind: 'upload',
      origin: 'upload',
      status: 'processing',
      processing_error_code: null,
      width: null,
      height: null,
      content_version: null,
      preview: null,
      created_at: new Date().toISOString(),
    }
  );
}
