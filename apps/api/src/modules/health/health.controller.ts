import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';

import { buildServiceName } from '@ecom-forge/shared';
import type { ServiceHealth } from '@ecom-forge/types';

import { HealthReadinessService } from './health-readiness.service.js';

@Controller('api/v1/health')
export class HealthController {
  constructor(@Inject(HealthReadinessService) private readonly readiness: HealthReadinessService) {}

  @Get()
  getHealth(): ServiceHealth {
    return this.live();
  }

  @Get('live')
  live(): ServiceHealth {
    return {
      service: buildServiceName('api'),
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  async ready(): Promise<ServiceHealth> {
    if (!(await this.readiness.isReady())) {
      throw new ServiceUnavailableException({
        service: buildServiceName('api'),
        status: 'not_ready',
        timestamp: new Date().toISOString(),
      });
    }
    return this.live();
  }
}
