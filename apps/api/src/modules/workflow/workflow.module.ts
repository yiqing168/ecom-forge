import { Module } from '@nestjs/common';

import type { Database } from '@ecom-forge/db';

import type { AppConfig } from '../../config/app-config.js';
import { APP_CONFIG } from '../../config/config.module.js';
import { DATABASE } from '../../shared/database/database.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { EventsModule } from '../events/events.module.js';
import { EventWakeHub } from '../events/event-wake.hub.js';
import { WorkflowController } from './workflow.controller.js';
import { WorkflowQueryService } from './workflow-query.service.js';
import { WorkflowRetryService } from './workflow-retry.service.js';

@Module({
  imports: [AuthModule, EventsModule],
  controllers: [WorkflowController],
  providers: [
    {
      provide: WorkflowQueryService,
      inject: [DATABASE, APP_CONFIG],
      useFactory: (database: Database, config: AppConfig): WorkflowQueryService =>
        new WorkflowQueryService(database, config.auth.secret),
    },
    {
      provide: WorkflowRetryService,
      inject: [DATABASE, EventWakeHub],
      useFactory: (database: Database, eventWakeHub: EventWakeHub): WorkflowRetryService =>
        new WorkflowRetryService(database, eventWakeHub),
    },
  ],
})
export class WorkflowModule {}
