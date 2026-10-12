import { Module } from '@nestjs/common';

import type { Database } from '@ecom-forge/db';

import type { AppConfig } from '../../config/app-config.js';
import { APP_CONFIG } from '../../config/config.module.js';
import { DATABASE } from '../../shared/database/database.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { EventsModule } from '../events/events.module.js';
import { EventWakeHub } from '../events/event-wake.hub.js';
import { CreditController } from './credit.controller.js';
import { CreditService } from './credit.service.js';
import { LocalQuoteProducer, UnavailableQuoteProducer } from './quote-producer.js';

@Module({
  imports: [AuthModule, EventsModule],
  controllers: [CreditController],
  providers: [
    {
      provide: CreditService,
      inject: [DATABASE, APP_CONFIG, EventWakeHub],
      useFactory: (
        database: Database,
        config: AppConfig,
        eventWakeHub: EventWakeHub,
      ): CreditService =>
        new CreditService(
          database,
          config.auth.secret,
          config.appEnv === 'local' || config.appEnv === 'test'
            ? new LocalQuoteProducer()
            : new UnavailableQuoteProducer(),
          eventWakeHub,
        ),
    },
  ],
  exports: [CreditService],
})
export class CreditModule {}
