export type ResourceErrorCode =
  | 'ARTIFACT_QUARANTINED'
  | 'ASSET_IN_USE'
  | 'ASSET_NOT_READY'
  | 'ASSET_PROCESSING_FAILED'
  | 'ASSET_REVISION_CONFLICT'
  | 'ASSET_UPLOAD_EXPIRED'
  | 'ASSET_UPLOAD_INVALID'
  | 'IDEMPOTENCY_CONFLICT'
  | 'PRODUCT_FACT_VERSION_CONFLICT'
  | 'PRODUCT_REVISION_CONFLICT'
  | 'PRODUCT_SKU_CONFLICT'
  | 'RESOURCE_NOT_FOUND'
  | 'STORAGE_UNAVAILABLE';

export class ResourceApiError extends Error {
  constructor(readonly code: ResourceErrorCode) {
    super(code);
    this.name = 'ResourceApiError';
  }
}

export function resourceError(code: ResourceErrorCode): never {
  throw new ResourceApiError(code);
}
