import { Module } from '@nestjs/common';

import { ConfigModule } from './config/config.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { AdminAuthModule } from './modules/admin-auth/admin-auth.module.js';
import { AgentModule } from './modules/agent/agent.module.js';
import { CreditModule } from './modules/credit/credit.module.js';
import { EventsModule } from './modules/events/events.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { ProviderWebhookModule } from './modules/provider-webhook/provider-webhook.module.js';
import { ResourceModule } from './modules/resource/resource.module.js';
import { WorkflowModule } from './modules/workflow/workflow.module.js';
import { ModelCatalogModule } from './modules/model-catalog/model-catalog.module.js';
import { DatabaseModule } from './shared/database/database.module.js';
import { RedisModule } from './shared/redis/redis.module.js';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    RedisModule,
    AuthModule,
    AdminAuthModule,
    AgentModule,
    EventsModule,
    CreditModule,
    WorkflowModule,
    ProviderWebhookModule,
    ResourceModule,
    ModelCatalogModule,
    HealthModule,
  ],
})
export class AppModule {}
