import { z } from 'zod';

import type { ProviderCapability } from './contracts.js';
import {
  VERCEL_AI_AGENT_ADAPTER_KEY,
  VERCEL_AI_AGENT_ENDPOINT_PROFILE_KEY,
  VERCEL_AI_AGENT_PROBE_CONTRACT_VERSION,
} from './agent-brain/vercel-ai-agent-brain.js';

const registryKey = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);

export const providerChannelInputSchema = z.strictObject({
  provider: registryKey,
  adapter_key: registryKey,
  endpoint_profile_key: registryKey,
  region: registryKey.nullish(),
});

export type ProviderChannelInput = z.infer<typeof providerChannelInputSchema>;
export type ProviderControlCapability = ProviderCapability | 'agent.brain';

export interface ProviderEndpointProfile {
  readonly key: string;
  readonly regions: readonly string[];
  readonly supportsModelDiscovery: boolean;
  readonly capabilities: readonly ProviderControlCapability[];
  readonly modelSpecKeys: readonly string[];
}

export interface ProviderAdapterProfile {
  readonly provider: string;
  readonly adapterKey: string;
  readonly displayName: string;
  readonly endpointProfiles: readonly ProviderEndpointProfile[];
  readonly credentialKind: 'api_key' | 'secret_bundle';
  readonly probeContractVersion: string;
}

export class ProviderControlPlaneRegistry {
  private readonly profiles: ReadonlyMap<string, ProviderAdapterProfile>;

  constructor(profiles: readonly ProviderAdapterProfile[]) {
    const entries = new Map<string, ProviderAdapterProfile>();
    for (const profile of profiles) {
      const profileKey = `${profile.provider}:${profile.adapterKey}`;
      if (entries.has(profileKey)) throw new Error(`Duplicate Provider adapter ${profileKey}`);
      if (profile.endpointProfiles.length === 0) {
        throw new Error(`Provider adapter ${profileKey} has no endpoint profiles`);
      }
      const endpointKeys = new Set<string>();
      for (const endpoint of profile.endpointProfiles) {
        if (endpointKeys.has(endpoint.key)) {
          throw new Error(`Duplicate Provider endpoint profile ${profileKey}:${endpoint.key}`);
        }
        if (endpoint.regions.some((region) => !/^[a-z0-9-]{1,64}$/.test(region))) {
          throw new Error(`Invalid Provider region in ${profileKey}:${endpoint.key}`);
        }
        endpointKeys.add(endpoint.key);
      }
      entries.set(profileKey, profile);
    }
    this.profiles = entries;
  }

  list(): readonly ProviderAdapterProfile[] {
    return [...this.profiles.values()];
  }

  resolve(input: unknown): {
    readonly adapter: ProviderAdapterProfile;
    readonly endpoint: ProviderEndpointProfile;
  } {
    const channel = providerChannelInputSchema.parse(input);
    const adapter = this.profiles.get(`${channel.provider}:${channel.adapter_key}`);
    if (!adapter) throw new Error('PROVIDER_ADAPTER_NOT_REGISTERED');
    const endpoint = adapter.endpointProfiles.find(
      (candidate) => candidate.key === channel.endpoint_profile_key,
    );
    if (!endpoint) throw new Error('PROVIDER_ENDPOINT_PROFILE_NOT_REGISTERED');
    if (channel.region != null && !endpoint.regions.includes(channel.region)) {
      throw new Error('PROVIDER_REGION_NOT_ALLOWED');
    }
    return { adapter, endpoint };
  }
}

export const PROVIDER_CONTROL_PLANE_REGISTRY = new ProviderControlPlaneRegistry([
  {
    provider: 'fake',
    adapterKey: 'fake-provider-v1',
    displayName: 'Fake Provider (local/test only)',
    credentialKind: 'api_key',
    probeContractVersion: 'provider-credential@1',
    endpointProfiles: [
      {
        key: 'local',
        regions: ['local'],
        supportsModelDiscovery: false,
        capabilities: ['image.generate', 'image.edit', 'moderation.text', 'moderation.image'],
        modelSpecKeys: ['media@v1'],
      },
    ],
  },
  {
    provider: 'openai',
    adapterKey: VERCEL_AI_AGENT_ADAPTER_KEY,
    displayName: 'OpenAI 协议中转站',
    credentialKind: 'api_key',
    probeContractVersion: VERCEL_AI_AGENT_PROBE_CONTRACT_VERSION,
    endpointProfiles: [
      {
        key: VERCEL_AI_AGENT_ENDPOINT_PROFILE_KEY,
        regions: [],
        supportsModelDiscovery: false,
        capabilities: [
          'agent.brain',
          'image.generate',
          'image.edit',
          'moderation.text',
          'moderation.image',
        ],
        modelSpecKeys: ['agent-brain@1', 'media@v1', 'media@v2'],
      },
    ],
  },
  {
    provider: 'anthropic',
    adapterKey: VERCEL_AI_AGENT_ADAPTER_KEY,
    displayName: 'Anthropic 协议中转站',
    credentialKind: 'api_key',
    probeContractVersion: VERCEL_AI_AGENT_PROBE_CONTRACT_VERSION,
    endpointProfiles: [
      {
        key: VERCEL_AI_AGENT_ENDPOINT_PROFILE_KEY,
        regions: [],
        supportsModelDiscovery: false,
        capabilities: ['agent.brain'],
        modelSpecKeys: ['agent-brain@1'],
      },
    ],
  },
]);
