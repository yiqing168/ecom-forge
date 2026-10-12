import { describe, expect, it } from 'vitest';

import { AdminApiError, adminErrorMessage } from './admin-api';

describe('adminErrorMessage', () => {
  it('uses curated local messages for known security errors', () => {
    expect(adminErrorMessage(new AdminApiError('ADMIN_AUTH_INVALID', 401, 'ignored'))).toBe(
      '管理员账号或密码错误',
    );
  });

  it('explains model moderation failures without exposing internal configuration concepts', () => {
    expect(
      adminErrorMessage(
        new AdminApiError('MODEL_MODERATION_PROBE_DECISION_MISMATCH', 422, 'ignored'),
      ),
    ).toBe('该模型未通过内容安全能力校验，请更换支持多模态审核的模型');
    expect(adminErrorMessage(new AdminApiError('CONTENT_SAFETY_UNAVAILABLE', 409, 'ignored'))).toBe(
      '内容安全能力尚未就绪，请先配置可用的 OpenAI 多模态对话模型',
    );
  });

  it('keeps a sanitized server message for a new stable domain error', () => {
    expect(
      adminErrorMessage(
        new AdminApiError('INVITE_EXPIRY_PERMANENT', 422, '该邀请码永久有效，不能再延长有效期'),
      ),
    ).toBe('该邀请码永久有效，不能再延长有效期');
  });

  it('does not expose an unbounded or code-only fallback', () => {
    expect(adminErrorMessage(new AdminApiError('NEW_CODE', 409, 'NEW_CODE'))).toBe(
      '操作暂时无法完成，请稍后重试',
    );
    expect(adminErrorMessage(new AdminApiError('NEW_CODE', 409, 'x'.repeat(201)))).toBe(
      '操作暂时无法完成，请稍后重试',
    );
  });
});
