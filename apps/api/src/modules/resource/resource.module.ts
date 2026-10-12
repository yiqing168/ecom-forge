import { Module } from '@nestjs/common';

import type { Database } from '@ecom-forge/db';

import type { AppConfig } from '../../config/app-config.js';
import { APP_CONFIG } from '../../config/config.module.js';
import { DATABASE } from '../../shared/database/database.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AbuseProtectionService } from '../auth/abuse-protection.service.js';
import { ArtifactController } from './artifact.controller.js';
import { ArtifactService } from './artifact.service.js';
import { AssetController } from './asset.controller.js';
import { AssetService } from './asset.service.js';
import { AssetWriteGuard } from './asset-write.guard.js';
import { ProductController } from './product.controller.js';
import { ProductService } from './product.service.js';

@Module({
  imports: [AuthModule],
  controllers: [ProductController, AssetController, ArtifactController],
  providers: [
    AssetWriteGuard,
    {
      provide: ProductService,
      inject: [DATABASE, APP_CONFIG],
      useFactory: (database: Database, config: AppConfig) =>
        new ProductService(database, config.resourceCursorSecret, config.resourceIdempotencySecret),
    },
    {
      provide: AssetService,
      inject: [DATABASE, APP_CONFIG, AbuseProtectionService],
      useFactory: (
        database: Database,
        config: AppConfig,
        abuseProtection: AbuseProtectionService,
      ) => new AssetService(database, config, abuseProtection),
    },
    {
      provide: ArtifactService,
      inject: [DATABASE, APP_CONFIG, AbuseProtectionService],
      useFactory: (
        database: Database,
        config: AppConfig,
        abuseProtection: AbuseProtectionService,
      ) => new ArtifactService(database, config, abuseProtection),
    },
  ],
  exports: [ProductService, AssetService, ArtifactService],
})
export class ResourceModule {}
