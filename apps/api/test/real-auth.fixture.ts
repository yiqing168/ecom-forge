import { stdin } from 'node:process';

import {
  authAccounts,
  authSessions,
  creditAccounts,
  creditLedger,
  createDatabaseClient,
  eq,
  inviteCodeRedemptions,
  inviteCodes,
  mailDeliveries,
  registrationClaims,
  registrationRewardClaims,
  userActivityLogs,
  users,
} from '@ecom-forge/db';

import { loadAppConfig } from '../src/config/app-config.js';
import { DrizzleInviteCodeStore } from '../src/modules/auth/invite/drizzle-invite-code.store.js';
import { InviteCodeService } from '../src/modules/auth/invite/invite-code.service.js';
import { HmacKeyring } from '../src/modules/auth/security/hmac-keyring.js';

async function readStdin(): Promise<string> {
  const chunks: string[] = [];
  stdin.setEncoding('utf8');
  for await (const chunk of stdin) {
    if (typeof chunk !== 'string') throw new Error('Expected UTF-8 fixture input');
    chunks.push(chunk);
  }
  return chunks.join('');
}

async function run(): Promise<void> {
  if (process.env.S03_LIVE_E2E !== '1') {
    throw new Error('This fixture is restricted to the S03 live E2E harness');
  }
  const action = process.argv[2];
  if (!action || process.argv.length > 3 || !['create', 'cleanup'].includes(action)) {
    throw new Error('Expected exactly one action: create or cleanup');
  }

  const config = loadAppConfig();
  const databaseHostname = config.databaseUrl
    ? new URL(config.databaseUrl).hostname.replace(/^\[|\]$/g, '')
    : 'localhost';
  if (config.appEnv !== 'local' || !['127.0.0.1', '::1', 'localhost'].includes(databaseHostname)) {
    throw new Error('S03 live E2E fixtures require a local app environment and loopback database');
  }
  const resource = createDatabaseClient(
    config.databaseUrl ? { databaseUrl: config.databaseUrl } : {},
  );
  try {
    if (action === 'create') {
      const service = new InviteCodeService(
        new DrizzleInviteCodeStore(resource.db),
        new HmacKeyring(config.auth.inviteHashKeys),
      );
      const invite = await service.createInvite({
        maxUses: 1,
        emailAllowlist: [],
        expiresAt: new Date(Date.now() + 30 * 60_000),
        issuedBy: null,
      });
      process.stdout.write(
        `${JSON.stringify({ inviteId: invite.id, inviteCode: invite.plaintextCode })}\n`,
      );
      return;
    }

    const input = JSON.parse(await readStdin()) as { email?: unknown; inviteId?: unknown };
    if (typeof input.email !== 'string' || typeof input.inviteId !== 'string') {
      throw new Error('Cleanup requires email and inviteId strings on stdin');
    }
    if (!/^s(?:0[36]|10)-live-[0-9a-f-]{36}@example\.com$/.test(input.email)) {
      throw new Error('Cleanup is restricted to live E2E users');
    }
    const user = await resource.db.query.users.findFirst({ where: eq(users.email, input.email) });
    if (user) {
      await resource.db
        .delete(registrationRewardClaims)
        .where(eq(registrationRewardClaims.userId, user.id));
      await resource.db.delete(creditLedger).where(eq(creditLedger.userId, user.id));
      await resource.db.delete(creditAccounts).where(eq(creditAccounts.userId, user.id));
      await resource.db
        .delete(inviteCodeRedemptions)
        .where(eq(inviteCodeRedemptions.userId, user.id));
      await resource.db.delete(mailDeliveries).where(eq(mailDeliveries.userId, user.id));
      await resource.db.delete(userActivityLogs).where(eq(userActivityLogs.userId, user.id));
      await resource.db.delete(registrationClaims).where(eq(registrationClaims.userId, user.id));
      await resource.db.delete(authSessions).where(eq(authSessions.userId, user.id));
      await resource.db.delete(authAccounts).where(eq(authAccounts.userId, user.id));
      await resource.db.delete(users).where(eq(users.id, user.id));
    }
    await resource.db
      .delete(registrationClaims)
      .where(eq(registrationClaims.inviteCodeId, input.inviteId));
    await resource.db.delete(inviteCodes).where(eq(inviteCodes.id, input.inviteId));
    process.stdout.write(`${JSON.stringify({ status: 'cleaned' })}\n`);
  } finally {
    await resource.client.end();
  }
}

await run();
