import { Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { ZodError } from 'zod';

import { SignedCursorError } from '../../shared/http/signed-cursor.js';
import { ResourceApiError, type ResourceErrorCode } from './resource.errors.js';
import { requestFailureDiagnostic } from '../../shared/http/request-failure-diagnostic.js';

interface HttpResponse {
  status(code: number): void;
  json(body: unknown): void;
}

const RESPONSES: Record<ResourceErrorCode, { status: number; message: string }> = {
  ARTIFACT_QUARANTINED: { status: 423, message: '该作品正在进行内容检查，暂不可使用' },
  ASSET_IN_USE: { status: 409, message: '该素材正在被运行中的任务使用，暂时不能删除' },
  ASSET_NOT_READY: { status: 409, message: '素材仍在处理中，暂时不可使用' },
  ASSET_PROCESSING_FAILED: { status: 422, message: '素材处理失败，请重试处理' },
  ASSET_REVISION_CONFLICT: { status: 409, message: '素材已发生变化，请刷新后重试' },
  ASSET_UPLOAD_EXPIRED: { status: 410, message: '上传窗口已过期，请重新选择文件' },
  ASSET_UPLOAD_INVALID: { status: 422, message: '图片文件不符合上传要求' },
  IDEMPOTENCY_CONFLICT: { status: 409, message: '本次提交内容已变化，请重新操作' },
  PRODUCT_FACT_VERSION_CONFLICT: { status: 409, message: '商品事实已更新，请刷新后再确认' },
  PRODUCT_REVISION_CONFLICT: { status: 409, message: '商品信息已更新，请刷新后重试' },
  PRODUCT_SKU_CONFLICT: { status: 409, message: '当前账户已存在相同 SKU 或货号' },
  RESOURCE_NOT_FOUND: { status: 404, message: '未找到该资源' },
  STORAGE_UNAVAILABLE: { status: 503, message: '文件服务暂时不可用，请稍后重试' },
};

@Catch()
export class ResourceExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ResourceExceptionFilter.name);

  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponse>();
    if (error instanceof HttpException) {
      if (error.getStatus() >= 500)
        this.logger.error({
          event: 'resource_request_failed',
          error_code: 'RESOURCE_INTERNAL_ERROR',
          status: error.getStatus(),
          ...requestFailureDiagnostic(host, error),
        });
      response.status(error.getStatus());
      response.json(error.getResponse());
      return;
    }
    if (error instanceof ZodError || error instanceof SignedCursorError) {
      response.status(HttpStatus.BAD_REQUEST);
      response.json({
        ok: false,
        data: null,
        error: { code: 'REQUEST_INVALID', message: '请求参数不正确' },
      });
      return;
    }
    if (error instanceof ResourceApiError) {
      const result = RESPONSES[error.code];
      response.status(result.status);
      response.json({
        ok: false,
        data: null,
        error: { code: error.code, message: result.message },
      });
      return;
    }
    this.logger.error({
      event: 'resource_request_failed',
      error_code: 'RESOURCE_INTERNAL_ERROR',
      ...requestFailureDiagnostic(host, error),
    });
    response.status(HttpStatus.INTERNAL_SERVER_ERROR);
    response.json({
      ok: false,
      data: null,
      error: { code: 'RESOURCE_INTERNAL_ERROR', message: '资源服务暂时不可用，请稍后重试' },
    });
  }
}
