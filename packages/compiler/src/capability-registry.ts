import type { ProviderCapability } from '@ecom-forge/provider';

import type { CapabilityAdapter } from './types.js';

export class CapabilityRegistry {
  private readonly adapters = new Map<string, CapabilityAdapter>();

  constructor(
    readonly version: string,
    adapters: readonly CapabilityAdapter[],
  ) {
    if (!version.trim()) throw new Error('Capability registry version is required');
    for (const adapter of adapters) {
      const key = this.key(adapter.capability, adapter.version);
      if (this.adapters.has(key)) throw new Error(`Duplicate capability adapter: ${key}`);
      this.adapters.set(key, adapter);
    }
  }

  resolve(capability: ProviderCapability, version: number): CapabilityAdapter | undefined {
    return this.adapters.get(this.key(capability, version));
  }

  private key(capability: ProviderCapability, version: number): string {
    return `${capability}@${version}`;
  }
}
