import { Module } from '@nestjs/common';

import type { Database } from '@ecom-forge/db';
import { FakeProviderAdapter, ProviderWebhookRegistry } from '@ecom-forge/provider';

import type { AppConfig } from '../../config/app-config.js';
import { APP_CONFIG } from '../../config/config.module.js';
import { DATABASE } from '../../shared/database/database.module.js';
import { CallbackDigestKeyring } from './callback-digest-keyring.js';
import { ProviderWebhookController } from './provider-webhook.controller.js';
import { ProviderWebhookService } from './provider-webhook.service.js';

@Module({
  controllers: [ProviderWebhookController],
  providers: [
    {
      provide: ProviderWebhookService,
      inject: [DATABASE, APP_CONFIG],
      useFactory: (database: Database, config: AppConfig): ProviderWebhookService => {
        const adapters =
          config.provider.mode === 'fake' &&
          config.provider.fakeWebhookKeyId &&
          config.provider.fakeWebhookSecret
            ? [
                new FakeProviderAdapter('succeeded', () => new Date(), {
                  keyId: config.provider.fakeWebhookKeyId,
                  secret: Buffer.from(config.provider.fakeWebhookSecret, 'base64url'),
                }),
              ]
            : [];
        return new ProviderWebhookService(
          database,
          new ProviderWebhookRegistry(adapters),
          config.provider.callbackDigestKeys
            ? new CallbackDigestKeyring(config.provider.callbackDigestKeys)
            : undefined,
          config.provider.webhookClockSkewSeconds,
        );
      },
    },
  ],
})
export class ProviderWebhookModule {}
