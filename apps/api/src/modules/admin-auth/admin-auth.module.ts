import { Module } from '@nestjs/common';

import type { Database } from '@ecom-forge/db';

import type { AppConfig } from '../../config/app-config.js';
import { APP_CONFIG } from '../../config/config.module.js';
import { DATABASE } from '../../shared/database/database.module.js';
import {
  REDIS_CONTROL_CLIENT,
  REDIS_EVAL_CLIENT,
  type RedisControlClient,
  type RedisEvalClient,
} from '../../shared/redis/redis.module.js';
import { AdminAuthController, AdminEnrollmentController } from './admin-auth.controller.js';
import { AdminAuthService } from './admin-auth.service.js';
import { AdminCredentialService } from './admin-credential.service.js';
import {
  AdminHostGuard,
  AdminOriginGuard,
  AdminPermissionGuard,
  AdminSessionGuard,
  AdminStepUpGuard,
} from './admin-guards.js';
import {
  AdminPrincipalController,
  AdminSessionManagementController,
} from './admin-principal.controller.js';
import { AdminPrincipalService } from './admin-principal.service.js';
import { AdminStorageControlController } from './admin-storage-control.controller.js';
import { AdminStorageControlService } from './admin-storage-control.service.js';
import { AdminModelConfigurationController } from './admin-model-configuration.controller.js';
import { AdminModelConfigurationService } from './admin-model-configuration.service.js';
import { AdminInviteCodeController } from './admin-invite.controller.js';
import { AdminInviteCodeService } from './admin-invite-code.service.js';
import { AdminOperationsQueryController } from './admin-operations-query.controller.js';
import { AdminOperationsQueryService } from './admin-operations-query.service.js';
import { AdminUserControlController } from './admin-user-control.controller.js';
import { AdminUserControlService } from './admin-user-control.service.js';
import { AdminTaskControlController } from './admin-task-control.controller.js';
import { AdminTaskControlService } from './admin-task-control.service.js';
import { AdminWorkflowControlController } from './admin-workflow-control.controller.js';
import { AdminWorkflowControlService } from './admin-workflow-control.service.js';
import { AdminAppealController } from './admin-appeal.controller.js';
import { AdminAppealService } from './admin-appeal.service.js';
import { AdminCreditController } from './admin-credit.controller.js';
import { AdminCreditService } from './admin-credit.service.js';
import { AdminRegistrationRewardController } from './admin-registration-reward.controller.js';
import { AdminRegistrationRewardService } from './admin-registration-reward.service.js';
import {
  AdminSkillPackageController,
  AdminSkillPackageUploadController,
} from './admin-skill-package.controller.js';
import { AdminSkillPackageService } from './admin-skill-package.service.js';
import { AdminContentReviewController } from './admin-content-review.controller.js';
import { AdminContentReviewService } from './admin-content-review.service.js';

@Module({
  controllers: [
    AdminAuthController,
    AdminEnrollmentController,
    AdminPrincipalController,
    AdminSessionManagementController,
    AdminModelConfigurationController,
    AdminStorageControlController,
    AdminInviteCodeController,
    AdminOperationsQueryController,
    AdminUserControlController,
    AdminTaskControlController,
    AdminWorkflowControlController,
    AdminAppealController,
    AdminCreditController,
    AdminRegistrationRewardController,
    AdminSkillPackageController,
    AdminSkillPackageUploadController,
    AdminContentReviewController,
  ],
  providers: [
    AdminHostGuard,
    AdminOriginGuard,
    AdminSessionGuard,
    AdminPermissionGuard,
    AdminStepUpGuard,
    {
      provide: AdminAuthService,
      inject: [DATABASE, APP_CONFIG, REDIS_EVAL_CLIENT],
      useFactory: (
        database: Database,
        config: AppConfig,
        redis: RedisEvalClient,
      ): AdminAuthService => new AdminAuthService(database, config, redis),
    },
    {
      provide: AdminCredentialService,
      inject: [DATABASE, APP_CONFIG, AdminAuthService],
      useFactory: (
        database: Database,
        config: AppConfig,
        auth: AdminAuthService,
      ): AdminCredentialService => new AdminCredentialService(database, config, auth),
    },
    {
      provide: AdminPrincipalService,
      inject: [DATABASE, APP_CONFIG],
      useFactory: (database: Database, config: AppConfig): AdminPrincipalService =>
        new AdminPrincipalService(database, config),
    },
    {
      provide: AdminModelConfigurationService,
      inject: [DATABASE, APP_CONFIG],
      useFactory: (database: Database, config: AppConfig): AdminModelConfigurationService =>
        new AdminModelConfigurationService(database, config),
    },
    {
      provide: AdminStorageControlService,
      inject: [DATABASE, APP_CONFIG],
      useFactory: (database: Database, config: AppConfig): AdminStorageControlService =>
        new AdminStorageControlService(database, config),
    },
    {
      provide: AdminInviteCodeService,
      inject: [DATABASE, APP_CONFIG],
      useFactory: (database: Database, config: AppConfig): AdminInviteCodeService =>
        new AdminInviteCodeService(database, config),
    },
    {
      provide: AdminOperationsQueryService,
      inject: [DATABASE, REDIS_CONTROL_CLIENT, APP_CONFIG],
      useFactory: (
        database: Database,
        redis: RedisControlClient,
        config: AppConfig,
      ): AdminOperationsQueryService => new AdminOperationsQueryService(database, redis, config),
    },
    {
      provide: AdminUserControlService,
      inject: [DATABASE, APP_CONFIG],
      useFactory: (database: Database, config: AppConfig): AdminUserControlService =>
        new AdminUserControlService(database, config),
    },
    {
      provide: AdminTaskControlService,
      inject: [DATABASE, REDIS_CONTROL_CLIENT, APP_CONFIG],
      useFactory: (
        database: Database,
        redis: RedisControlClient,
        config: AppConfig,
      ): AdminTaskControlService => new AdminTaskControlService(database, redis, config),
    },
    {
      provide: AdminWorkflowControlService,
      inject: [DATABASE, APP_CONFIG],
      useFactory: (database: Database, config: AppConfig): AdminWorkflowControlService =>
        new AdminWorkflowControlService(database, config),
    },
    {
      provide: AdminAppealService,
      inject: [DATABASE, APP_CONFIG],
      useFactory: (database: Database, config: AppConfig): AdminAppealService =>
        new AdminAppealService(database, config),
    },
    {
      provide: AdminCreditService,
      inject: [DATABASE, APP_CONFIG],
      useFactory: (database: Database, config: AppConfig): AdminCreditService =>
        new AdminCreditService(database, config),
    },
    {
      provide: AdminRegistrationRewardService,
      inject: [DATABASE, APP_CONFIG],
      useFactory: (database: Database, config: AppConfig): AdminRegistrationRewardService =>
        new AdminRegistrationRewardService(database, config),
    },
    {
      provide: AdminSkillPackageService,
      inject: [DATABASE, APP_CONFIG],
      useFactory: (database: Database, config: AppConfig): AdminSkillPackageService =>
        new AdminSkillPackageService(database, config),
    },
    {
      provide: AdminContentReviewService,
      inject: [DATABASE, APP_CONFIG],
      useFactory: (database: Database, config: AppConfig): AdminContentReviewService =>
        new AdminContentReviewService(database, config),
    },
  ],
  exports: [
    AdminAuthService,
    AdminCredentialService,
    AdminPrincipalService,
    AdminStorageControlService,
    AdminInviteCodeService,
    AdminOperationsQueryService,
    AdminUserControlService,
    AdminTaskControlService,
    AdminWorkflowControlService,
    AdminAppealService,
    AdminCreditService,
    AdminRegistrationRewardService,
    AdminSkillPackageService,
    AdminContentReviewService,
  ],
})
export class AdminAuthModule {}
