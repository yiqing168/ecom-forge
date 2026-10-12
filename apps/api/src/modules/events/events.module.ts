import { Module } from '@nestjs/common';

import type { Database } from '@ecom-forge/db';

import type { AppConfig } from '../../config/app-config.js';
import { APP_CONFIG } from '../../config/config.module.js';
import { DATABASE } from '../../shared/database/database.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { EventOutboxRepository } from './event-outbox.repository.js';
import { EventsController } from './events.controller.js';
import { EventWakeHub } from './event-wake.hub.js';
import { SseStreamService } from './sse-stream.service.js';

@Module({
  imports: [AuthModule],
  controllers: [EventsController],
  providers: [
    EventWakeHub,
    {
      provide: EventOutboxRepository,
      inject: [DATABASE],
      useFactory: (database: Database): EventOutboxRepository =>
        new EventOutboxRepository(database),
    },
    {
      provide: SseStreamService,
      inject: [EventOutboxRepository, EventWakeHub, APP_CONFIG],
      useFactory: (
        outbox: EventOutboxRepository,
        wakeHub: EventWakeHub,
        config: AppConfig,
      ): SseStreamService => new SseStreamService(outbox, wakeHub, config.sse),
    },
  ],
  exports: [EventWakeHub],
})
export class EventsModule {}
