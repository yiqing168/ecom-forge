import { z } from 'zod';

export const S10_PRIVATE_ASSET_SMOKE_CONTRACT_VERSION = 's10-private-assets@1';

const registryKey = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);
const bucketName = z
  .string()
  .min(3)
  .max(63)
  .regex(/^[a-z0-9][a-z0-9.-]+[a-z0-9]$/);
const rootPrefix = z
  .string()
  .max(256)
  .refine((value) => value === '' || /^[a-zA-Z0-9][a-zA-Z0-9/_-]*$/.test(value))
  .refine((value) => !value.includes('..') && !value.startsWith('/'));

export const storageChannelInputSchema = z.strictObject({
  purpose: z.literal('private_assets'),
  adapter_key: registryKey,
  endpoint_profile_key: registryKey,
  region: registryKey.nullish(),
  bucket: bucketName,
  root_prefix: rootPrefix,
});

export type StorageChannelInput = z.infer<typeof storageChannelInputSchema>;
export type StorageControlCapability = 'put' | 'head' | 'range_read' | 'delete' | 'sign_private';

export interface StorageEndpointProfile {
  readonly key: string;
  readonly regions: readonly string[];
  readonly capabilities: readonly StorageControlCapability[];
}

export interface StorageAdapterProfile {
  readonly adapterKey: string;
  readonly displayName: string;
  readonly endpointProfiles: readonly StorageEndpointProfile[];
  readonly probeContractVersion: string;
}

export class StorageControlPlaneRegistry {
  private readonly profiles: ReadonlyMap<string, StorageAdapterProfile>;

  constructor(profiles: readonly StorageAdapterProfile[]) {
    const entries = new Map<string, StorageAdapterProfile>();
    for (const profile of profiles) {
      if (entries.has(profile.adapterKey)) {
        throw new Error(`Duplicate storage adapter ${profile.adapterKey}`);
      }
      if (profile.endpointProfiles.length === 0) {
        throw new Error(`Storage adapter ${profile.adapterKey} has no endpoint profiles`);
      }
      const endpointKeys = new Set<string>();
      for (const endpoint of profile.endpointProfiles) {
        if (endpointKeys.has(endpoint.key)) {
          throw new Error(
            `Duplicate storage endpoint profile ${profile.adapterKey}:${endpoint.key}`,
          );
        }
        if (endpoint.regions.some((region) => !/^[a-z0-9-]{1,64}$/.test(region))) {
          throw new Error(`Invalid storage region in ${profile.adapterKey}:${endpoint.key}`);
        }
        endpointKeys.add(endpoint.key);
      }
      entries.set(profile.adapterKey, profile);
    }
    this.profiles = entries;
  }

  list(): readonly StorageAdapterProfile[] {
    return [...this.profiles.values()];
  }

  resolve(input: unknown): {
    readonly channel: StorageChannelInput;
    readonly adapter: StorageAdapterProfile;
    readonly endpoint: StorageEndpointProfile;
  } {
    const channel = storageChannelInputSchema.parse(input);
    const adapter = this.profiles.get(channel.adapter_key);
    if (!adapter) throw new Error('STORAGE_ADAPTER_NOT_REGISTERED');
    const endpoint = adapter.endpointProfiles.find(
      (candidate) => candidate.key === channel.endpoint_profile_key,
    );
    if (!endpoint) throw new Error('STORAGE_ENDPOINT_PROFILE_NOT_REGISTERED');
    if (channel.region != null && !endpoint.regions.includes(channel.region)) {
      throw new Error('STORAGE_REGION_NOT_ALLOWED');
    }
    return { channel, adapter, endpoint };
  }
}

export const STORAGE_CONTROL_PLANE_REGISTRY = new StorageControlPlaneRegistry([
  {
    adapterKey: 'local-private-v1',
    displayName: 'Local private storage (local/test only)',
    probeContractVersion: 'storage-private-assets@1',
    endpointProfiles: [
      {
        key: 'local',
        regions: ['local'],
        capabilities: ['put', 'head', 'range_read', 'delete', 'sign_private'],
      },
    ],
  },
]);
