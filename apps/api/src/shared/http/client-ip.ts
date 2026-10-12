import ipaddr from 'ipaddr.js';

export class InvalidProxyAddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidProxyAddressError';
  }
}

type Address = ipaddr.IPv4 | ipaddr.IPv6;
type Cidr = [Address, number];

function parseAddress(value: string): Address {
  const address = ipaddr.parse(value.trim().replace(/^\[|\]$/g, ''));
  if (address.kind() === 'ipv6') {
    const ipv6 = address as ipaddr.IPv6;
    return ipv6.isIPv4MappedAddress() ? ipv6.toIPv4Address() : ipv6;
  }
  return address;
}

function matches(address: Address, range: Cidr): boolean {
  const [network, prefix] = range;
  if (address.kind() !== network.kind()) {
    return false;
  }
  if (address.kind() === 'ipv4') {
    return (address as ipaddr.IPv4).match(network as ipaddr.IPv4, prefix);
  }
  return (address as ipaddr.IPv6).match(network as ipaddr.IPv6, prefix);
}

function normalize(address: Address): string {
  return address.kind() === 'ipv6' ? address.toNormalizedString() : address.toString();
}

export class TrustedProxyResolver {
  private readonly trustedRanges: Cidr[];

  constructor(cidrs: readonly string[]) {
    try {
      this.trustedRanges = cidrs.map((cidr) => ipaddr.parseCIDR(cidr) as Cidr);
    } catch {
      throw new InvalidProxyAddressError('TRUSTED_PROXY_CIDRS contains an invalid range');
    }
    if (this.trustedRanges.length === 0) {
      throw new InvalidProxyAddressError('At least one trusted proxy CIDR is required');
    }
  }

  resolve(remoteAddress: string, headers: Record<string, string | string[] | undefined>): string {
    let remote: Address;
    try {
      remote = parseAddress(remoteAddress);
    } catch {
      throw new InvalidProxyAddressError('Request remote address is invalid');
    }

    if (!this.trustedRanges.some((range) => matches(remote, range))) {
      return normalize(remote);
    }

    const realIp = headers['x-real-ip'];
    if (typeof realIp === 'string' && realIp.trim()) {
      try {
        return normalize(parseAddress(realIp));
      } catch {
        throw new InvalidProxyAddressError('Trusted proxy supplied an invalid X-Real-IP');
      }
    }

    const forwardedFor = headers['x-forwarded-for'];
    if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
      const chain = forwardedFor
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
      try {
        const addresses = chain.map(parseAddress);
        for (let index = addresses.length - 1; index >= 0; index -= 1) {
          const address = addresses[index]!;
          if (!this.trustedRanges.some((range) => matches(address, range))) {
            return normalize(address);
          }
        }
      } catch {
        throw new InvalidProxyAddressError('Trusted proxy supplied an invalid X-Forwarded-For');
      }
    }

    return normalize(remote);
  }

  isTrustedAddress(addressValue: string): boolean {
    try {
      const address = parseAddress(addressValue);
      return this.trustedRanges.some((range) => matches(address, range));
    } catch {
      return false;
    }
  }
}

export function rateLimitIpBucket(addressValue: string): string {
  const address = parseAddress(addressValue);
  if (address.kind() === 'ipv4') {
    return address.toString();
  }
  const bytes = address.toByteArray();
  for (let index = 8; index < bytes.length; index += 1) {
    bytes[index] = 0;
  }
  return `${ipaddr.fromByteArray(bytes).toNormalizedString()}/64`;
}
