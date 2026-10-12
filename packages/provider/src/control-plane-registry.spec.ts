import { describe, expect, it } from 'vitest';

import { ProviderControlPlaneRegistry } from './control-plane-registry.js';

const registry = new ProviderControlPlaneRegistry([
  {
    provider: 'fixture',
    adapterKey: 'fixture-v1',
    displayName: 'Fixture',
    credentialKind: 'api_key',
    probeContractVersion: 'fixture@1',
    endpointProfiles: [
      {
        key: 'mainland',
        regions: ['cn-mainland'],
        supportsModelDiscovery: true,
        capabilities: ['image.generate'],
        modelSpecKeys: ['media@v2'],
      },
    ],
  },
]);

describe('Provider control-plane registry', () => {
  it('resolves only registered adapter, endpoint, and region combinations', () => {
    expect(
      registry.resolve({
        provider: 'fixture',
        adapter_key: 'fixture-v1',
        endpoint_profile_key: 'mainland',
        region: 'cn-mainland',
      }),
    ).toMatchObject({ adapter: { adapterKey: 'fixture-v1' }, endpoint: { key: 'mainland' } });
    expect(() =>
      registry.resolve({
        provider: 'fixture',
        adapter_key: 'unknown',
        endpoint_profile_key: 'mainland',
        region: 'cn-mainland',
      }),
    ).toThrow('PROVIDER_ADAPTER_NOT_REGISTERED');
    expect(() =>
      registry.resolve({
        provider: 'fixture',
        adapter_key: 'fixture-v1',
        endpoint_profile_key: 'mainland',
        region: 'untrusted-region',
      }),
    ).toThrow('PROVIDER_REGION_NOT_ALLOWED');
  });

  it('rejects duplicate adapter identities at construction time', () => {
    expect(
      () => new ProviderControlPlaneRegistry([...registry.list(), ...registry.list()]),
    ).toThrow(/Duplicate Provider adapter/);
  });
});
