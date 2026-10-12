export class ProviderWebhookNotFoundError extends Error {
  constructor() {
    super('Provider webhook was not found');
    this.name = 'ProviderWebhookNotFoundError';
  }
}

export class ProviderWebhookRequestError extends Error {
  constructor(readonly kind: 'invalid' | 'unauthorized') {
    super('Provider webhook request was rejected');
    this.name = 'ProviderWebhookRequestError';
  }
}
