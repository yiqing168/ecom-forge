import { Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { ZodError } from 'zod';

import { AgentApiError, type AgentErrorCode } from './agent.errors.js';
import { requestFailureDiagnostic } from '../../shared/http/request-failure-diagnostic.js';

interface HttpResponse {
  status(code: number): void;
  json(body: unknown): void;
}

const MESSAGES: Record<AgentErrorCode, string> = {
  CREDIT_BALANCE_EMPTY: '当前积分余额为 0，未开始调用创作助手，请充值后再试',
  AGENT_CONFIRMATION_EXPIRED: '本次确认已过期，请重新发起当前请求',
  AGENT_CONFIRMATION_NOT_AVAILABLE: '当前确认暂时无法处理，请稍后继续',
  AGENT_CONTEXT_UNAVAILABLE: '当前引用内容暂时无法安全读取，请移除后重试',
  AGENT_MODEL_UNAVAILABLE: '创作助手暂时不可用，请稍后重试',
  FORBIDDEN: '当前账号暂时无法使用创作助手',
  IDEMPOTENCY_CONFLICT: '提交内容已发生变化，请刷新后重试',
  GENERATION_PREFERENCES_INVALID: '所选图片模型不支持当前尺寸或数量，请调整后重试',
  MODEL_CATALOG_STALE: '模型目录已更新，请刷新后重新选择',
  MODEL_SELECTION_INVALID: '所选模型已失效或不支持当前创作请求，请重新选择',
  MODEL_SELECTION_REQUIRED: '请选择推理模型和图片模型后再发送',
  RESOURCE_NOT_FOUND: '未找到该对话请求',
  REFERENCE_NOT_AVAILABLE: '所选素材已变化或不可用，请重新选择',
  SESSION_ACTIVE: '该会话仍有进行中的请求，请先停止或取消后再删除',
  SESSION_CURSOR_INVALID: '会话列表位置已失效，请刷新后重试',
  SESSION_SKILL_MISMATCH: '当前会话已固定创作方向，请新建会话后切换 Skill',
  SESSION_CREATIVE_DIRECTION_MISMATCH: '本会话设计师已固定，请新建会话更换',
  SESSION_REVISION_CONFLICT: '会话已被其他操作更新，请刷新后重试',
  SKILL_SELECTION_INVALID: '所选 Skill 或风格已失效，请重新选择',
  SKILL_SELECTION_REQUIRED: '请选择一个 Skill 后再发送',
  SKILL_VERSION_DRIFT: '所选 Skill 已更新，请刷新后重新选择',
  TURN_ALREADY_SUBMITTED: '该请求已进入生成任务，请在任务中停止',
  TURN_STATE_INVALID: '当前请求状态已变化，请刷新后重试',
};

function statusFor(code: AgentErrorCode): number {
  if (code === 'RESOURCE_NOT_FOUND') return HttpStatus.NOT_FOUND;
  if (code === 'SESSION_CURSOR_INVALID') return HttpStatus.BAD_REQUEST;
  if (code === 'REFERENCE_NOT_AVAILABLE') return HttpStatus.CONFLICT;
  if (code === 'AGENT_CONFIRMATION_EXPIRED') return HttpStatus.GONE;
  if (code === 'FORBIDDEN' || code === 'SKILL_SELECTION_REQUIRED') return HttpStatus.FORBIDDEN;
  if (
    code === 'AGENT_CONTEXT_UNAVAILABLE' ||
    code === 'AGENT_MODEL_UNAVAILABLE' ||
    code === 'SKILL_VERSION_DRIFT' ||
    code === 'MODEL_CATALOG_STALE'
  ) {
    return HttpStatus.SERVICE_UNAVAILABLE;
  }
  return HttpStatus.CONFLICT;
}

@Catch()
export class AgentExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(AgentExceptionFilter.name);

  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponse>();
    if (error instanceof HttpException) {
      if (error.getStatus() >= 500)
        this.logger.error({
          event: 'agent_request_failed',
          error_code: 'AGENT_INTERNAL_ERROR',
          status: error.getStatus(),
          ...requestFailureDiagnostic(host, error),
        });
      response.status(error.getStatus());
      response.json(error.getResponse());
      return;
    }
    if (error instanceof ZodError) {
      response.status(HttpStatus.BAD_REQUEST);
      response.json({
        ok: false,
        data: null,
        error: { code: 'REQUEST_INVALID', message: '请求参数不正确' },
      });
      return;
    }
    if (error instanceof AgentApiError) {
      response.status(statusFor(error.code));
      response.json({
        ok: false,
        data: null,
        error: { code: error.code, message: MESSAGES[error.code] },
      });
      return;
    }
    this.logger.error({
      event: 'agent_request_failed',
      error_code: 'AGENT_INTERNAL_ERROR',
      ...requestFailureDiagnostic(host, error),
    });
    response.status(HttpStatus.INTERNAL_SERVER_ERROR);
    response.json({
      ok: false,
      data: null,
      error: { code: 'AGENT_INTERNAL_ERROR', message: '创作助手暂时不可用，请稍后重试' },
    });
  }
}
