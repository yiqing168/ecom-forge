import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';

import { checkDatabase } from './check.js';
import { requireTestDatabaseUrl } from './test-database-env.js';

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));

describe('database migrations', () => {
  // Applying every migration from zero is legitimately slow and slower still when the rest of the
  // monorepo test suite runs concurrently, so this test carries its own explicit timeout instead
  // of inheriting the 30s default (which made `pnpm check` flaky under parallel load).
  it(
    'applies from zero to an isolated empty PostgreSQL database',
    { timeout: 180_000 },
    async () => {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('Migration tests must not run against a production environment');
      }

      const databaseName = `ecom_forge_test_s03_${randomUUID().replaceAll('-', '')}`;
      const targetUrl = new URL(requireTestDatabaseUrl());
      const adminUrl = new URL(targetUrl);
      adminUrl.pathname = '/postgres';
      targetUrl.pathname = `/${databaseName}`;

      const admin = postgres(adminUrl.toString(), { max: 1 });
      let target: ReturnType<typeof postgres> | undefined;

      try {
        await admin.unsafe(`create database "${databaseName}"`);
        target = postgres(targetUrl.toString(), {
          max: 1,
          connection: { client_min_messages: 'warning' },
        });
        await expect(checkDatabase(targetUrl.toString())).rejects.toThrow(
          'database schema is incomplete or migrations have not been applied',
        );
        await migrate(drizzle(target), { migrationsFolder });
        await checkDatabase(targetUrl.toString());

        const [tableResult] = await target<{ count: string }[]>`
          select count(*)::text as count
          from information_schema.tables
          where table_schema = 'public' and table_type = 'BASE TABLE'
        `;
        const [foreignKeyResult] = await target<{ count: string }[]>`
          select count(*)::text as count
          from information_schema.table_constraints
          where constraint_schema = 'public' and constraint_type = 'FOREIGN KEY'
        `;
        const tableNames = await target<{ tableName: string }[]>`
          select table_name as "tableName"
          from information_schema.tables
          where table_schema = 'public' and table_type = 'BASE TABLE'
        `;
        const enumResult = await target<{ enumlabel: string }[]>`
          select enumlabel
          from pg_enum
          join pg_type on pg_type.oid = pg_enum.enumtypid
          where pg_type.typname = 'artifact_visibility'
          order by pg_enum.enumsortorder
        `;

        expect(Number(tableResult?.count)).toBe(90);
        expect(tableNames.map((row) => row.tableName)).toContain('model_configurations');
        expect(Number(foreignKeyResult?.count)).toBeGreaterThan(50);
        expect(enumResult.map((row) => row.enumlabel)).toContain('quarantined');

        const userId = randomUUID();
        await target`
          insert into users (id, email, display_name)
          values (${userId}, ${`${userId}@example.test`}, 'Migration test')
        `;
        await target`
          insert into credit_accounts (user_id, balance, frozen)
          values (${userId}, '12.30', '4.50')
        `;
        const [account] = await target<{ balance: string; frozen: string }[]>`
          select balance, frozen from credit_accounts where user_id = ${userId}
        `;

        expect(account).toEqual({ balance: '12.30', frozen: '4.50' });

        const inviteId = randomUUID();
        await target`
          insert into invite_codes (id, code_digest, key_id, code_prefix, max_uses)
          values (${inviteId}, 'digest-1', 'invite-key-1', 'BETA', 1)
        `;
        await target`
          insert into registration_claims (
            invite_code_id, email_hash, ticket_hash, ticket_nonce, request_hash,
            idempotency_key, expires_at
          ) values (
            ${inviteId}, 'email-hash-1', 'ticket-hash-1', 'nonce-1', 'request-hash-1',
            'register-1', now() + interval '30 minutes'
          )
        `;
        await expect(
          target`
            insert into registration_claims (
              invite_code_id, email_hash, ticket_hash, ticket_nonce, request_hash,
              idempotency_key, expires_at
            ) values (
              ${inviteId}, 'email-hash-1', 'ticket-hash-2', 'nonce-2', 'request-hash-2',
              'register-2', now() + interval '30 minutes'
            )
          `,
        ).rejects.toMatchObject({ code: '23505' });
        await expect(
          target`
            insert into mail_deliveries (
              recipient_hash, recipient_hash_key_id, purpose, provider, idempotency_key
            ) values ('recipient-1', 'mail-key-1', 'email_verification', 'unknown', 'mail-1')
          `,
        ).rejects.toMatchObject({ code: '23514' });
        await expect(
          target`
            insert into credit_ledger (
              user_id, type, amount, idempotency_key, balance_after, frozen_after
            ) values (${userId}, 'consume', '1.00', 'bad-consume', '12.30', '4.50')
          `,
        ).rejects.toMatchObject({ code: '23514' });
        await expect(
          target`
            insert into credit_ledger (
              user_id, type, amount, idempotency_key, balance_after, frozen_after
            ) values (${userId}, 'release', '-1.00', 'bad-release', '12.30', '4.50')
          `,
        ).rejects.toMatchObject({ code: '23514' });

        await target`
          insert into asset_folders (user_id, parent_folder_id, name)
          values (${userId}, null, 'Root')
        `;
        await expect(
          target`
            insert into asset_folders (user_id, parent_folder_id, name)
            values (${userId}, null, 'Root')
          `,
        ).rejects.toMatchObject({ code: '23505' });

        await target`
          insert into run_quotes (
            user_id, source, status, prompt_preview, estimated_call_count,
            estimated_total_credits, idempotency_key, input_signature,
            confirmation_snapshot, expires_at
          ) values
            (${userId}, 'chat', 'submitted', '{}'::jsonb, 1, '1.00', 'submitted-1', 'same-input', '{}'::jsonb, now() + interval '30 minutes'),
            (${userId}, 'chat', 'submitted', '{}'::jsonb, 1, '1.00', 'submitted-2', 'same-input', '{}'::jsonb, now() + interval '30 minutes'),
            (${userId}, 'chat', 'quoted', '{}'::jsonb, 1, '1.00', 'quoted-1', 'same-input', '{}'::jsonb, now() + interval '30 minutes')
        `;
        await expect(
          target`
            insert into run_quotes (
              user_id, source, status, prompt_preview, estimated_call_count,
              estimated_total_credits, idempotency_key, input_signature,
              confirmation_snapshot, expires_at
            ) values (
              ${userId}, 'chat', 'quoted', '{}'::jsonb, 1, '1.00', 'quoted-2',
              'same-input', '{}'::jsonb, now() + interval '30 minutes'
            )
          `,
        ).rejects.toMatchObject({ code: '23505' });
      } finally {
        await target?.end();
        await admin.end();
        // Intentional retention policy (not an oversight): isolated migration databases are kept
        // for failure inspection and migration-history audit because recreating them from zero
        // costs minutes. Nothing here touches the acceptance or development databases. Manual
        // cleanup goes through `packages/db/src/test-database-cli.ts drop`, which refuses any
        // database name this harness did not provision.
        console.info(`Migration test database retained: ${databaseName}`);
      }
    },
  );
});
