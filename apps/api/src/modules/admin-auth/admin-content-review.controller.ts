import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { CONTENT_REVIEW_STATUSES } from '@ecom-forge/types';
import { z } from 'zod';

import { AdminExceptionFilter } from './admin-exception.filter.js';
import { adminAuthError } from './admin-errors.js';
import {
  AdminHostGuard,
  AdminOriginGuard,
  AdminPermissionGuard,
  AdminSessionGuard,
  AdminStepUpGuard,
  requireAdminPermission,
} from './admin-guards.js';
import type { AdminRequest, AdminSessionContext } from './admin-http.js';
import { AdminContentReviewService } from './admin-content-review.service.js';

const pageQuery = z.strictObject({
  cursor: z.string().min(1).max(4_096).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(CONTENT_REVIEW_STATUSES).optional(),
});
const decisionBody = z
  .strictObject({
    decision: z.enum(['release', 'reject']),
    expected_revision: z.number().int().positive(),
    confirmation_summary: z.strictObject({
      artifact_reviewed: z.literal(true),
      assessment: z.enum(['safe', 'unsafe']),
      policy_version: z.string().min(1).max(128),
    }),
    reason: z.string().trim().min(8).max(1_000),
  })
  .superRefine((value, context) => {
    const expected = value.decision === 'release' ? 'safe' : 'unsafe';
    if (value.confirmation_summary.assessment !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['confirmation_summary', 'assessment'],
        message: 'assessment does not match decision',
      });
    }
  });

function session(request: AdminRequest): AdminSessionContext {
  if (!request.adminSession) adminAuthError('ADMIN_SESSION_REQUIRED');
  return request.adminSession;
}

function idempotencyKey(request: AdminRequest): string {
  const value = request.headers['idempotency-key'];
  const key = Array.isArray(value) ? value[0] : value;
  if (!key) adminAuthError('ADMIN_IDEMPOTENCY_KEY_INVALID', 400);
  return key;
}

@Controller('api/v1/admin/content-reviews')
@UseFilters(AdminExceptionFilter)
@UseGuards(AdminHostGuard, AdminOriginGuard, AdminSessionGuard, AdminPermissionGuard)
export class AdminContentReviewController {
  constructor(private readonly reviews: AdminContentReviewService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @requireAdminPermission('moderation.read')
  list(@Query() query: unknown, @Req() request: AdminRequest) {
    const input = pageQuery.parse(query);
    return this.reviews.list(session(request), {
      limit: input.limit,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.status ? { status: input.status } : {}),
    });
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  @requireAdminPermission('moderation.read')
  detail(@Param('id') id: string, @Req() request: AdminRequest) {
    return this.reviews.detail(session(request), z.uuid().parse(id));
  }

  @Post(':id/decide')
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AdminStepUpGuard)
  @requireAdminPermission('moderation.decide')
  decide(@Param('id') id: string, @Body() body: unknown, @Req() request: AdminRequest) {
    const input = decisionBody.parse(body);
    return this.reviews.decide(session(request), request, z.uuid().parse(id), {
      expectedRevision: input.expected_revision,
      decision: input.decision,
      confirmationSummary: input.confirmation_summary,
      reason: input.reason,
      idempotencyKey: idempotencyKey(request),
    });
  }
}
