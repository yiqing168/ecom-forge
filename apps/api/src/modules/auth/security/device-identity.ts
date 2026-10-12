import { randomBytes } from 'node:crypto';

import type { HmacKeyring } from './hmac-keyring.js';

const DEVICE_COOKIE = 'ef_device';
const DEVICE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

interface DeviceRequest {
  headers: Record<string, string | string[] | undefined>;
}

interface DeviceResponse {
  append(name: string, value: string): void;
}

function cookieValue(request: DeviceRequest): string | undefined {
  const header = request.headers.cookie;
  const serialized = Array.isArray(header) ? header.join(';') : header;
  return serialized
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${DEVICE_COOKIE}=`))
    ?.slice(DEVICE_COOKIE.length + 1);
}

export class DeviceIdentity {
  constructor(
    private readonly keys: HmacKeyring,
    private readonly secure: boolean,
  ) {}

  resolve(request: DeviceRequest, response: DeviceResponse): string {
    const existing = cookieValue(request);
    if (existing && this.isValid(existing)) return existing;

    const nonce = randomBytes(18).toString('base64url');
    const signature = this.keys.digest(`auth-device\0${nonce}`);
    const token = `${nonce}.${signature.keyId}.${signature.digest}`;
    response.append(
      'set-cookie',
      [
        `${DEVICE_COOKIE}=${token}`,
        'Path=/',
        `Max-Age=${DEVICE_MAX_AGE_SECONDS}`,
        'HttpOnly',
        'SameSite=Lax',
        ...(this.secure ? ['Secure'] : []),
      ].join('; '),
    );
    return token;
  }

  private isValid(token: string): boolean {
    const [nonce, keyId, digest, ...rest] = token.split('.');
    return Boolean(
      rest.length === 0 &&
      nonce &&
      /^[A-Za-z0-9_-]{24}$/.test(nonce) &&
      keyId &&
      digest &&
      this.keys.verify(`auth-device\0${nonce}`, { keyId, digest }),
    );
  }
}
