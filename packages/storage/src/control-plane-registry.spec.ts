import { describe, expect, it } from 'vitest';

import { StorageControlPlaneRegistry } from './control-plane-registry.js';

const registry = new StorageControlPlaneRegistry([
  {
    adapterKey: 'fixture-storage-v1',
    displayName: 'Fixture storage',
    probeContractVersion: 'fixture-storage@1',
    endpointProfiles: [
      {
        key: 'private',
        regions: ['cn-mainland'],
        capabilities: ['put', 'head', 'range_read', 'delete', 'sign_private'],
      },
    ],
  },
]);

describe('Storage control-plane registry', () => {
  it('resolves a private channel only through a registered profile', () => {
    expect(
      registry.resolve({
        purpose: 'private_assets',
        adapter_key: 'fixture-storage-v1',
        endpoint_profile_key: 'private',
        region: 'cn-mainland',
        bucket: 'assets.example.com',
        root_prefix: 'private/assets',
      }),
    ).toMatchObject({ endpoint: { key: 'private' } });
  });

  it('rejects public or traversal-prone storage configuration', () => {
    expect(() =>
      registry.resolve({
        purpose: 'private_assets',
        adapter_key: 'fixture-storage-v1',
        endpoint_profile_key: 'private',
        region: 'cn-mainland',
        bucket: 'assets.example.com',
        root_prefix: '../public',
      }),
    ).toThrow();
    expect(() =>
      registry.resolve({
        purpose: 'private_assets',
        adapter_key: 'unknown',
        endpoint_profile_key: 'private',
        region: 'cn-mainland',
        bucket: 'assets.example.com',
        root_prefix: 'private/assets',
      }),
    ).toThrow('STORAGE_ADAPTER_NOT_REGISTERED');
  });
});
