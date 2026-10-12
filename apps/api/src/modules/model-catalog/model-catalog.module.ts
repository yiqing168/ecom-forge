import { Module } from '@nestjs/common';

import type { Database } from '@ecom-forge/db';

import type { AppConfig } from '../../config/app-config.js';
import { APP_CONFIG } from '../../config/config.module.js';
import { DATABASE } from '../../shared/database/database.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ModelCatalogController } from './model-catalog.controller.js';
import { ModelCatalogService } from './model-catalog.service.js';

@Module({
  imports: [AuthModule],
  controllers: [ModelCatalogController],
  providers: [
    {
      provide: ModelCatalogService,
      inject: [DATABASE, APP_CONFIG],
      useFactory: (database: Database, config: AppConfig): ModelCatalogService =>
        new ModelCatalogService(database, config.appEnv),
    },
  ],
})
export class ModelCatalogModule {}
