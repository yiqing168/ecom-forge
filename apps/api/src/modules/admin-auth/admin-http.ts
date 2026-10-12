import type { Request, Response } from 'express';

export type AdminRequest = Request & {
  adminSession?: AdminSessionContext;
};

export interface AdminSessionContext {
  id: string;
  principalId: string;
  rawToken: string;
  authzVersion: number;
  mfaLevel: string;
  recoveryRestricted: boolean;
  stepUpAt: Date | null;
  permissions: readonly string[];
  scopes: readonly { roleKey: string; scopeType: string; scopeKey: string }[];
  sessionExpiresAt: Date;
  idleExpiresAt: Date;
  sourceIpHash?: string | null;
  userAgentHash?: string | null;
}

export type AdminResponse = Response;

export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    if (part.slice(0, separator).trim() === name) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return undefined;
}

export function setAdminCookie(
  response: Response,
  name: string,
  value: string,
  secure: boolean,
  maxAge: number,
): void {
  const flags = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor(maxAge))}`,
    ...(secure ? ['Secure'] : []),
  ];
  response.append('set-cookie', flags.join('; '));
}

export function clearAdminCookie(response: Response, name: string, secure: boolean): void {
  setAdminCookie(response, name, '', secure, 0);
}
