export class AdminAuthError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message = code,
  ) {
    super(message);
    this.name = 'AdminAuthError';
  }
}

export function adminAuthError(code: string, status = 401): never {
  throw new AdminAuthError(code, status);
}
