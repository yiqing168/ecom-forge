import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from './app.module.js';
import { APP_CONFIG } from './config/config.module.js';
import type { AppConfig } from './config/app-config.js';
import { configureBodyParsers } from './configure-body-parsers.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    rawBody: true,
  });
  const config = app.get<AppConfig>(APP_CONFIG);

  configureBodyParsers(app, config.provider.webhookMaxBodyBytes, config.storage.maxImageBytes);

  app.enableCors({
    credentials: true,
    origin: [...config.auth.trustedOrigins, config.admin.origin],
  });

  await app.listen(config.apiPort);
}

void bootstrap();
