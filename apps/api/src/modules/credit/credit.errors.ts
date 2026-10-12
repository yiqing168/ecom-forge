import { HttpStatus } from '@nestjs/common';

import { CreditError, CreditProjectionDriftError } from '@ecom-forge/credit';

export function mapCreditError(error: unknown): {
  status: number;
  body: { code: string; message: string };
} {
  if (error instanceof CreditError) {
    const status =
      error.code === 'RESOURCE_NOT_FOUND'
        ? HttpStatus.NOT_FOUND
        : error.code === 'CREDIT_ACCOUNT_UNAVAILABLE' ||
            error.code === 'COST_MODEL_UNAVAILABLE' ||
            error.code === 'PROVIDER_UNAVAILABLE'
          ? HttpStatus.SERVICE_UNAVAILABLE
          : error.code === 'AUTH_VERIFICATION_REQUIRED' || error.code === 'FORBIDDEN'
            ? HttpStatus.FORBIDDEN
            : error.code === 'INSUFFICIENT_CREDITS'
              ? HttpStatus.PAYMENT_REQUIRED
              : HttpStatus.CONFLICT;
    const messages: Record<typeof error.code, string> = {
      IDEMPOTENCY_CONFLICT: '提交内容已发生变化，请刷新页面后重试',
      INSUFFICIENT_CREDITS:
        '本次生成所需积分超过当前可用余额，未开始生成；请减少生成数量或联系管理员补充积分后重试',
      COST_MODEL_UNAVAILABLE: '当前费用暂不可确认，请稍后再试',
      PROVIDER_UNAVAILABLE: '当前生成服务暂不可用，请稍后再试',
      COST_ACK_REQUIRED: '请先确认最新费用信息',
      RUN_QUOTE_EXPIRED: '费用报价已过期，请重新创建报价',
      RESOURCE_BUSY: '当前请求正在处理中，请稍后重试',
      AUTH_VERIFICATION_REQUIRED: '邮箱尚未验证，请先完成验证',
      FORBIDDEN: '当前账号暂时无法执行此操作',
      RESOURCE_NOT_FOUND: '未找到该任务',
      CREDIT_ACCOUNT_UNAVAILABLE: '积分账户暂时不可用，请稍后再试',
      RESERVATION_STATE_INVALID: '这笔任务状态已变化，请刷新后查看',
      SETTLEMENT_PROTECTED: '任务结果仍在确认中，请等待处理',
    };
    return { status, body: { code: error.code, message: messages[error.code] } };
  }
  if (error instanceof CreditProjectionDriftError) {
    return {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      body: { code: 'CREDIT_ACCOUNT_UNAVAILABLE', message: '积分账户暂时不可用，请稍后再试' },
    };
  }
  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    body: { code: 'CREDIT_INTERNAL_ERROR', message: '服务暂时不可用，请稍后再试' },
  };
}
