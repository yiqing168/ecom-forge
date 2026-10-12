import { Module } from '@nestjs/common';

import type { Database } from '@ecom-forge/db';

import type { AppConfig } from '../../config/app-config.js';
import { APP_CONFIG } from '../../config/config.module.js';
import { DATABASE } from '../../shared/database/database.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { EventsModule } from '../events/events.module.js';
import { EventWakeHub } from '../events/event-wake.hub.js';
import { ProductService } from '../resource/product.service.js';
import { ResourceModule } from '../resource/resource.module.js';
import { AbuseProtectionService } from '../auth/abuse-protection.service.js';
import { AgentConfirmationService } from './agent-confirmation.service.js';
import { AgentController } from './agent.controller.js';
import { AgentTurnService } from './agent-turn.service.js';
import { AgentSessionService } from './agent-session.service.js';
import { SkillCatalogService } from './skill-catalog.service.js';

@Module({
  imports: [AuthModule, EventsModule, ResourceModule],
  controllers: [AgentController],
  providers: [
    {
      provide: SkillCatalogService,
      inject: [DATABASE, APP_CONFIG],
      useFactory: (database: Database, config: AppConfig): SkillCatalogService =>
        new SkillCatalogService(database, config),
    },
    {
      provide: AgentSessionService,
      inject: [DATABASE, APP_CONFIG],
      useFactory: (database: Database, config: AppConfig): AgentSessionService =>
        new AgentSessionService(
          database,
          config.resourceIdempotencySecret,
          config.resourceCursorSecret,
        ),
    },
    {
      provide: AgentTurnService,
      inject: [DATABASE, EventWakeHub, APP_CONFIG, AbuseProtectionService],
      useFactory: (
        database: Database,
        wakeHub: EventWakeHub,
        config: AppConfig,
        abuseProtection: AbuseProtectionService,
      ): AgentTurnService => new AgentTurnService(database, wakeHub, config, abuseProtection),
    },
    {
      provide: AgentConfirmationService,
      inject: [DATABASE, EventWakeHub, ProductService, AbuseProtectionService],
      useFactory: (
        database: Database,
        wakeHub: EventWakeHub,
        products: ProductService,
        abuseProtection: AbuseProtectionService,
      ): AgentConfirmationService =>
        new AgentConfirmationService(database, wakeHub, products, abuseProtection),
    },
  ],
  exports: [AgentTurnService, AgentConfirmationService, AgentSessionService, SkillCatalogService],
})
export class AgentModule {}
