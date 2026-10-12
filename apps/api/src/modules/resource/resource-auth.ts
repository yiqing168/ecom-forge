import { ForbiddenException, UnauthorizedException } from '@nestjs/common';

import type { AuthenticationService } from '../auth/authentication.service.js';
import { AccountFrozenError } from '../auth/abuse-protection.service.js';
import {
  copyAuthCookies,
  requestHeaders,
  type ApiRequest,
  type ApiResponse,
} from '../auth/auth-http.js';

export async function requireResourceUser(
  authentication: AuthenticationService,
  request: ApiRequest,
  response: ApiResponse,
  requireUpload = false,
): Promise<string> {
  const session = await authentication.currentSession(requestHeaders(request));
  if (!session) {
    throw new ForbiddenException({
      ok: false,
      data: null,
      error: { code: 'AUTH_SESSION_REQUIRED', message: '请先登录' },
    });
  }
  copyAuthCookies(session.headers, response);
  if (session.access?.restrictionReason === 'account_restricted') {
    throw new AccountFrozenError();
  }
  if (requireUpload && !session.access.canUpload) {
    throw new UnauthorizedException({
      ok: false,
      data: null,
      error: {
        code:
          session.access.restrictionReason === 'email_verification_required'
            ? 'AUTH_VERIFICATION_REQUIRED'
            : 'FORBIDDEN',
        message:
          session.access.restrictionReason === 'email_verification_required'
            ? '邮箱尚未验证，请先完成验证'
            : '当前账号暂时不能上传或修改资源',
      },
    });
  }
  return session.user.id;
}
