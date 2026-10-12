import {
  Controller,
  Get,
  Header,
  Inject,
  Param,
  Query,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import {
  ADMIN_AUDIT_RESULTS,
  TASK_STATUSES,
  USER_RISK_STATUSES,
  WORKFLOW_RUN_STATUSES,
} from '@ecom-forge/types';
import { z } from 'zod';

import { AdminExceptionFilter } from './admin-exception.filter.js';
import { adminAuthError } from './admin-errors.js';
import {
  AdminHostGuard,
  AdminOriginGuard,
  AdminPermissionGuard,
  AdminSessionGuard,
  requireAdminPermission,
} from './admin-guards.js';
import type { AdminRequest, AdminSessionContext } from './admin-http.js';
import { AdminOperationsQueryService } from './admin-operations-query.service.js';

const uuid = z.uuid();
const pageFields = {
  cursor: z.string().min(1).max(4_096).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};
const usersQuery = z.strictObject({
  ...pageFields,
  risk_status: z.enum(USER_RISK_STATUSES).optional(),
});
const workflowRunsQuery = z.strictObject({
  ...pageFields,
  status: z.enum(WORKFLOW_RUN_STATUSES).optional(),
});
const tasksQuery = z.strictObject({
  ...pageFields,
  status: z.enum(TASK_STATUSES).optional(),
});
const auditLogsQuery = z.strictObject({
  ...pageFields,
  action: z.string().min(1).max(160).optional(),
  result: z.enum(ADMIN_AUDIT_RESULTS).optional(),
});

function session(request: AdminRequest): AdminSessionContext {
  if (!request.adminSession) adminAuthError('ADMIN_SESSION_REQUIRED');
  return request.adminSession;
}

@Controller('api/v1/admin')
@UseFilters(AdminExceptionFilter)
@UseGuards(AdminHostGuard, AdminOriginGuard, AdminSessionGuard, AdminPermissionGuard)
export class AdminOperationsQueryController {
  constructor(
    @Inject(AdminOperationsQueryService) private readonly operations: AdminOperationsQueryService,
  ) {}

  @Get('dashboard')
  @requireAdminPermission('dashboard.read')
  @Header('Cache-Control', 'no-store')
  dashboard() {
    return this.operations.dashboard();
  }

  @Get('users')
  @requireAdminPermission('users.read')
  @Header('Cache-Control', 'no-store')
  users(@Query() query: unknown, @Req() request: AdminRequest) {
    const input = usersQuery.parse(query);
    return this.operations.users(session(request), {
      limit: input.limit,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.risk_status ? { riskStatus: input.risk_status } : {}),
    });
  }

  @Get('users/:id')
  @requireAdminPermission('users.read')
  @Header('Cache-Control', 'no-store')
  user(@Param('id') id: string) {
    return this.operations.user(uuid.parse(id));
  }

  @Get('workflow-runs')
  @requireAdminPermission('tasks.read')
  @Header('Cache-Control', 'no-store')
  workflowRuns(@Query() query: unknown, @Req() request: AdminRequest) {
    const input = workflowRunsQuery.parse(query);
    return this.operations.workflowRuns(session(request), {
      limit: input.limit,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.status ? { status: input.status } : {}),
    });
  }

  @Get('workflow-runs/:id')
  @requireAdminPermission('tasks.read')
  @Header('Cache-Control', 'no-store')
  workflowRun(@Param('id') id: string) {
    return this.operations.workflowRun(uuid.parse(id));
  }

  @Get('tasks')
  @requireAdminPermission('tasks.read')
  @Header('Cache-Control', 'no-store')
  tasks(@Query() query: unknown, @Req() request: AdminRequest) {
    const input = tasksQuery.parse(query);
    return this.operations.tasks(session(request), {
      limit: input.limit,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.status ? { status: input.status } : {}),
    });
  }

  @Get('tasks/:id')
  @requireAdminPermission('tasks.read')
  @Header('Cache-Control', 'no-store')
  task(@Param('id') id: string) {
    return this.operations.task(uuid.parse(id));
  }

  @Get('audit-logs')
  @requireAdminPermission('audit.read')
  @Header('Cache-Control', 'no-store')
  auditLogs(@Query() query: unknown, @Req() request: AdminRequest) {
    const input = auditLogsQuery.parse(query);
    return this.operations.auditLogs(session(request), {
      limit: input.limit,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.action ? { action: input.action } : {}),
      ...(input.result ? { result: input.result } : {}),
    });
  }

  @Get('audit-logs/:id')
  @requireAdminPermission('audit.read')
  @Header('Cache-Control', 'no-store')
  auditLog(@Param('id') id: string) {
    return this.operations.auditLog(uuid.parse(id));
  }

  @Get('health')
  @requireAdminPermission('health.read')
  @Header('Cache-Control', 'no-store')
  health() {
    return this.operations.health();
  }
}
