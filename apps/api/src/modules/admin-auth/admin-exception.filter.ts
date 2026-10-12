import { Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { ZodError } from 'zod';

import { AdminAuthError } from './admin-errors.js';
import { randomUUID } from 'node:crypto';
import { requestFailureDiagnostic } from '../../shared/http/request-failure-diagnostic.js';

const messages: Record<string, string> = {
  ADMIN_REGISTRATION_REWARD_INVALID: '注册赠送积分必须是大于 0 的整数',
  INVITE_DISABLE_INVALID: '只能禁用未使用、未过期且没有注册占用的邀请码',
  ADMIN_AUTH_INVALID: '管理员账号或密码错误，请检查后重试',
  ADMIN_SESSION_REQUIRED: '管理会话已失效，请重新登录',
  ADMIN_CSRF_INVALID: '请求校验已失效，请刷新页面后重试',
  ADMIN_PERMISSION_DENIED: '当前管理员没有执行此操作的权限',
  ADMIN_STEP_UP_REQUIRED: '此操作需要重新验证管理员身份',
  ADMIN_AUTH_UNAVAILABLE: '管理认证服务暂时不可用，请稍后重试',
  ADMIN_AUTH_RATE_LIMITED: '操作过于频繁，请稍后再试',
  ADMIN_ENROLLMENT_INVALID: '开通凭据无效或已失效，请联系管理员重新签发',
  ADMIN_TOTP_INVALID: '动态验证码错误或已过期，请检查后重试',
  ADMIN_BOOTSTRAP_ALREADY_COMPLETE: '首个管理员已经创建，不能重复初始化',
  ADMIN_IDENTIFIER_CONFLICT: '管理员标识已存在，请使用其他标识',
  ADMIN_REVISION_CONFLICT: '管理员安全状态已变化，请刷新后重试',
  ADMIN_IDEMPOTENCY_KEY_INVALID: '请提供有效的幂等键后重试',
  ADMIN_IDEMPOTENCY_CONFLICT: '相同幂等键对应了不同请求，请更换幂等键',
  ADMIN_CURSOR_INVALID: '分页位置已失效，请刷新列表后重试',
  ADMIN_RESOURCE_NOT_FOUND: '管理对象不存在或已不可用',
  ADMIN_ROLE_INVALID: '管理员角色或范围配置无效',
  ADMIN_SCOPE_INVALID: '管理员资源范围配置无效',
  ADMIN_SELF_MODIFICATION: '不能修改当前管理员正在使用的安全身份',
  ADMIN_LAST_SUPER_ADMIN: '操作后必须保留至少一名可用的 super_admin',
  ADMIN_ENROLLMENT_STATE_INVALID: '当前管理员仍未处于可重新开通状态',
  INVITE_CAMPAIGN_INVALID: '邀请活动配置无效，请检查时间窗口和发行上限',
  INVITE_CAMPAIGN_KEY_CONFLICT: '邀请活动标识已存在，请使用其他标识',
  INVITE_CAMPAIGN_WINDOW_CLOSED: '邀请活动当前不在可发行时间窗口内',
  INVITE_CAMPAIGN_CAPACITY_EXCEEDED: '本次生成将超过邀请活动发行上限',
  INVITE_BATCH_LIMIT_EXCEEDED: '本次批量生成数量超过系统上限',
  INVITE_CONSTRAINT_INVALID: '邮箱或域名约束格式不正确',
  INVITE_REWARD_CLOSURE_INVALID: '关联奖励活动尚未满足激活条件',
  INVITE_EXPIRY_INVALID: '邀请码有效期必须晚于当前时间且不超过活动窗口',
  INVITE_EXPIRY_PERMANENT: '该邀请码永久有效，不能再延长有效期',
  INVITE_ADJUSTMENT_INVALID: '邀请码只允许提高容量或延长已有有效期',
  INVITE_PLAINTEXT_UNAVAILABLE: '该邀请码当前不可复制；如仍需发放，请生成新的邀请码',
};

@Catch()
export class AdminExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(AdminExceptionFilter.name);

  catch(error: unknown, host: ArgumentsHost): void {
    const response = host
      .switchToHttp()
      .getResponse<{ status(code: number): void; json(body: unknown): void }>();
    if (error instanceof AdminAuthError) {
      if (error.status >= 500)
        this.logger.error({
          event: 'admin_request_failed',
          error_code: error.code,
          status: error.status,
          ...requestFailureDiagnostic(host, error),
        });
      response.status(error.status);
      response.json({
        error: {
          code: error.code,
          message: messages[error.code] ?? '管理操作暂时无法完成，请稍后重试',
        },
      });
      return;
    }
    if (error instanceof ZodError) {
      const request = host.switchToHttp().getRequest<{
        headers?: Record<string, string | string[] | undefined>;
        method?: string;
        route?: { path?: string };
      }>();
      const rawId = request.headers?.['x-request-id'];
      const suppliedId = Array.isArray(rawId) ? rawId[0] : rawId;
      this.logger.warn(
        JSON.stringify({
          event: 'admin_request_invalid',
          request_id:
            suppliedId && /^[A-Za-z0-9._:-]{1,128}$/.test(suppliedId) ? suppliedId : randomUUID(),
          method: request.method,
          route: request.route?.path,
          issues: error.issues.slice(0, 8).map((issue) => ({
            code: issue.code,
            path: issue.path.map((part) =>
              typeof part === 'number'
                ? part
                : /^[a-z][a-z0-9_]{0,63}$/.test(String(part))
                  ? String(part)
                  : '<field>',
            ),
          })),
        }),
      );
      response.status(HttpStatus.BAD_REQUEST);
      response.json({
        error: { code: 'ADMIN_REQUEST_INVALID', message: '提交的信息格式不正确，请检查后重试' },
      });
      return;
    }
    if (error instanceof HttpException) {
      if (error.getStatus() >= 500)
        this.logger.error({
          event: 'admin_request_failed',
          error_code: 'ADMIN_REQUEST_REJECTED',
          status: error.getStatus(),
          ...requestFailureDiagnostic(host, error),
        });
      response.status(error.getStatus());
      response.json({
        error: { code: 'ADMIN_REQUEST_REJECTED', message: '管理请求未被接受' },
      });
      return;
    }
    this.logger.error({
      event: 'admin_request_failed',
      error_code: 'ADMIN_AUTH_UNAVAILABLE',
      ...requestFailureDiagnostic(host, error),
    });
    response.status(HttpStatus.SERVICE_UNAVAILABLE);
    response.json({
      error: { code: 'ADMIN_AUTH_UNAVAILABLE', message: messages.ADMIN_AUTH_UNAVAILABLE },
    });
  }
}
