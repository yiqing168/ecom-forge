export function normalizeRelayOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('PROVIDER_RELAY_URL_INVALID');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== '/' && parsed.pathname !== '')
  ) {
    throw new Error('PROVIDER_RELAY_URL_INVALID');
  }
  return parsed.origin;
}

export function assertRelayOriginAllowed(value: string, allowedOrigins: readonly string[]): string {
  const origin = normalizeRelayOrigin(value);
  const normalizedAllowlist = allowedOrigins.map(normalizeRelayOrigin);
  if (!normalizedAllowlist.includes(origin)) {
    throw new Error('PROVIDER_RELAY_URL_NOT_ALLOWLISTED');
  }
  return origin;
}

export function normalizeRelayApiBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('PROVIDER_RELAY_URL_INVALID');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('PROVIDER_RELAY_URL_INVALID');
  }
  const path = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${path || '/v1'}`;
}

export function assertRelayApiBaseUrlAllowed(
  value: string,
  allowedOrigins: readonly string[],
): string {
  const baseUrl = normalizeRelayApiBaseUrl(value);
  const origin = new URL(baseUrl).origin;
  const normalizedAllowlist = allowedOrigins.map(normalizeRelayOrigin);
  if (!normalizedAllowlist.includes(origin)) {
    throw new Error('PROVIDER_RELAY_URL_NOT_ALLOWLISTED');
  }
  return baseUrl;
}

export function relayApiResourceUrl(baseUrl: string, resource: string): string {
  const normalizedResource = resource.replace(/^\/+/, '');
  if (!normalizedResource || normalizedResource.includes('..')) {
    throw new Error('PROVIDER_RELAY_RESOURCE_INVALID');
  }
  return `${normalizeRelayApiBaseUrl(baseUrl)}/${normalizedResource}`;
}

/** Discovery uses the relay's OpenAI root; native Google execution has a separate root. */
export function googleRelayApiBaseUrl(baseUrl: string): string {
  const normalized = normalizeRelayApiBaseUrl(baseUrl);
  const parsed = new URL(normalized);
  if (parsed.pathname.endsWith('/v1')) {
    parsed.pathname = parsed.pathname.slice(0, -3) + '/v1beta';
  } else if (!parsed.pathname.endsWith('/v1beta')) {
    parsed.pathname += '/v1beta';
  }
  return parsed.origin + parsed.pathname;
}

const OUTPUT_ORIGIN_WILDCARD_PREFIX = 'https://*.';
const DOMAIN_LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Normalizes one image output allowlist entry: either an exact HTTPS origin or a
 * single-level wildcard family like `https://*.provider-output.example.com` that
 * trusts every subdomain of one registered domain (for example relay file pools
 * oss1..ossN under the operator's own domain).
 */
export function normalizeOutputOriginEntry(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('PROVIDER_RELAY_URL_INVALID');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== '/' && parsed.pathname !== '')
  ) {
    throw new Error('PROVIDER_RELAY_URL_INVALID');
  }
  const host = parsed.host.toLowerCase();
  if (host.startsWith('*.')) {
    const wildcardBody = host.slice(2);
    const colonIndex = wildcardBody.indexOf(':');
    const domain = colonIndex < 0 ? wildcardBody : wildcardBody.slice(0, colonIndex);
    const port = colonIndex < 0 ? undefined : wildcardBody.slice(colonIndex + 1);
    if (
      domain.length < 3 ||
      !domain.includes('.') ||
      !domain.split('.').every((label) => DOMAIN_LABEL_PATTERN.test(label)) ||
      (port !== undefined && !/^[1-9]\d{0,4}$/.test(port)) ||
      (port !== undefined && (Number(port) < 1 || Number(port) > 65_535))
    ) {
      throw new Error('PROVIDER_RELAY_URL_INVALID');
    }
    return `${OUTPUT_ORIGIN_WILDCARD_PREFIX}${domain}${port ? `:${port}` : ''}`;
  }
  if (host.includes('*')) {
    throw new Error('PROVIDER_RELAY_URL_INVALID');
  }
  return parsed.origin;
}

export function isOutputOriginAllowed(outputUrl: URL, allowlist: readonly string[]): boolean {
  // Wildcard entries carry their port: an entry without a port only matches the
  // default HTTPS port, an entry with a port only matches exactly that port.
  const host = outputUrl.host.toLowerCase();
  return allowlist.some((entry) => {
    if (entry.startsWith(OUTPUT_ORIGIN_WILDCARD_PREFIX)) {
      const suffix = entry.slice(OUTPUT_ORIGIN_WILDCARD_PREFIX.length);
      return host === suffix || host.endsWith(`.${suffix}`);
    }
    return outputUrl.origin === entry;
  });
}
