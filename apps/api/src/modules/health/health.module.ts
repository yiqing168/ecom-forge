import { Module } from '@nestjs/common';

import { HealthController } from './health.controller.js';
import { HealthReadinessService } from './health-readiness.service.js';

@Module({
  controllers: [HealthController],
  providers: [HealthReadinessService],
})
export class HealthModule {}
