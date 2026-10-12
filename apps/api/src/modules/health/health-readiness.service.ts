import { Inject, Injectable } from '@nestjs/common';

import { sql, type Database } from '@ecom-forge/db';
import { builtinSkillCatalogKey, queueRecoverySentinelKey } from '@ecom-forge/queue';
import { getBuiltinSkillCatalog } from '@ecom-forge/skills';

import type { AppConfig } from '../../config/app-config.js';
import { APP_CONFIG } from '../../config/config.module.js';
import { DATABASE } from '../../shared/database/database.module.js';
import { REDIS_CONTROL_CLIENT, type RedisControlClient } from '../../shared/redis/redis.module.js';

@Injectable()
export class HealthReadinessService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(REDIS_CONTROL_CLIENT) private readonly redis: RedisControlClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async isReady(): Promise<boolean> {
    try {
      await this.database.execute(sql`select 1`);
      await this.redis.ping();
      const sentinel = await this.redis.get(queueRecoverySentinelKey(this.config.redisPrefix));
      const workerSkillCatalog = await this.redis.get(
        builtinSkillCatalogKey(this.config.redisPrefix),
      );
      const apiSkillCatalog = (await getBuiltinSkillCatalog()).catalogVersion;
      return sentinel === 'ready' && workerSkillCatalog === apiSkillCatalog;
    } catch {
      return false;
    }
  }
}
