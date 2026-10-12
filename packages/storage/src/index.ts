export { LocalPrivateStorage, StoragePathError } from './local-private-storage.js';
export {
  StorageCapabilityCodec,
  StorageCapabilityError,
  storageObjectKeyDigest,
  type StorageCapability,
  type StorageCapabilityPurpose,
} from './capability.js';
export {
  STORAGE_CONTROL_PLANE_REGISTRY,
  S10_PRIVATE_ASSET_SMOKE_CONTRACT_VERSION,
  StorageControlPlaneRegistry,
  storageChannelInputSchema,
  type StorageAdapterProfile,
  type StorageChannelInput,
  type StorageControlCapability,
  type StorageEndpointProfile,
} from './control-plane-registry.js';
