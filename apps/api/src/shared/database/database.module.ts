import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';

import { createDatabaseClient, type Database } from '@ecom-forge/db';

import { APP_CONFIG } from '../../config/config.module.js';
import type { AppConfig } from '../../config/app-config.js';

export const DATABASE = Symbol('DATABASE');

@Injectable()
class DatabaseResource implements OnApplicationShutdown {
  readonly database: Database;
  private readonly client: ReturnType<typeof createDatabaseClient>['client'];

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    const resource = createDatabaseClient({
      ...(config.databaseUrl ? { databaseUrl: config.databaseUrl } : {}),
      maxConnections: config.database.poolMax,
      statementTimeoutMs: config.database.statementTimeoutMs,
      transactionTimeoutMs: config.database.transactionTimeoutMs,
      applicationName: 'ecom-forge-api',
    });
    this.database = resource.db;
    this.client = resource.client;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.client.end();
  }
}

@Global()
@Module({
  providers: [
    DatabaseResource,
    {
      provide: DATABASE,
      inject: [DatabaseResource],
      useFactory: (resource: DatabaseResource): Database => resource.database,
    },
  ],
  exports: [DATABASE],
})
export class DatabaseModule {}
