import { raw } from 'express';
import type { ErrorRequestHandler } from 'express';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SKILL_PACKAGE_ARCHIVE_LIMITS } from '@ecom-forge/skills';

const rejectOversizedWebhookBody: ErrorRequestHandler = (error, _request, response, next) => {
  const payloadError = error as { status?: unknown; type?: unknown };
  if (payloadError.status !== 413 && payloadError.type !== 'entity.too.large') {
    next(error);
    return;
  }
  response
    .status(413)
    .set('Cache-Control', 'no-store')
    .json({
      error: { code: 'PROVIDER_WEBHOOK_INVALID', message: 'Webhook request rejected' },
    });
};

const rejectOversizedAssetBody: ErrorRequestHandler = (error, _request, response, next) => {
  const payloadError = error as { status?: unknown; type?: unknown };
  if (payloadError.status !== 413 && payloadError.type !== 'entity.too.large') {
    next(error);
    return;
  }
  response
    .status(413)
    .set('Cache-Control', 'no-store')
    .json({
      ok: false,
      data: null,
      error: { code: 'ASSET_UPLOAD_INVALID', message: '图片文件超过上传大小限制' },
    });
};

const rejectOversizedSkillPackageBody: ErrorRequestHandler = (error, _request, response, next) => {
  const payloadError = error as { status?: unknown; type?: unknown };
  if (payloadError.status !== 413 && payloadError.type !== 'entity.too.large') {
    next(error);
    return;
  }
  response
    .status(413)
    .set('Cache-Control', 'no-store')
    .json({
      error: {
        code: 'ADMIN_SKILL_PACKAGE_UPLOAD_INVALID',
        message: 'Skill package exceeds the upload size limit',
      },
    });
};

export function configureBodyParsers(
  app: NestExpressApplication,
  providerWebhookMaxBodyBytes: number,
  storageMaxImageBytes: number,
): void {
  app.use(
    '/api/v1/webhooks/providers',
    raw({ type: 'application/json', limit: providerWebhookMaxBodyBytes }),
    rejectOversizedWebhookBody,
  );
  app.use(
    '/api/v1/assets/uploads',
    raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: storageMaxImageBytes }),
    rejectOversizedAssetBody,
  );
  app.use(
    '/api/v1/admin/skill-packages/uploads',
    raw({
      type: 'application/octet-stream',
      limit: SKILL_PACKAGE_ARCHIVE_LIMITS.compressedBytes,
    }),
    rejectOversizedSkillPackageBody,
  );
  app.useBodyParser('json', { limit: '100kb' });
  app.useBodyParser('urlencoded', { extended: true, limit: '100kb' });
}
