import type { Server } from 'node:http';

import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';

import { AppModule } from '../src/app.module.js';

describe('GET /api/v1/health', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns the API health state', async () => {
    const server = app.getHttpServer() as Server;
    const response = await request(server).get('/api/v1/health').expect(200);

    expect(response.body).toMatchObject({
      service: 'ecom-forge-api',
      status: 'ok',
    });
  });

  it('keeps the liveness probe independent from database and Redis readiness', async () => {
    const server = app.getHttpServer() as Server;
    const response = await request(server).get('/api/v1/health/live').expect(200);

    expect(response.body).toMatchObject({
      service: 'ecom-forge-api',
      status: 'ok',
    });
  });
});
