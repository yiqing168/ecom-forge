import { createInterface } from 'node:readline/promises';

import { createDatabaseClient } from '@ecom-forge/db';

import { loadAppConfig } from '../config/app-config.js';
import { DrizzleInviteCodeStore } from '../modules/auth/invite/drizzle-invite-code.store.js';
import { InviteCodeService } from '../modules/auth/invite/invite-code.service.js';
import { HmacKeyring } from '../modules/auth/security/hmac-keyring.js';

async function run(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Invite creation requires an interactive terminal');
  }
  if (process.argv.length > 2) {
    throw new Error('Invite creation does not accept command-line arguments');
  }

  const config = loadAppConfig();
  const { db, client } = createDatabaseClient(
    config.databaseUrl ? { databaseUrl: config.databaseUrl } : {},
  );
  const readline = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const maxUsesInput = (await readline.question('Maximum uses [1]: ')).trim() || '1';
    const maxUses = Number(maxUsesInput);
    const allowlistInput = (
      await readline.question('Email allowlist (comma-separated, optional): ')
    ).trim();
    const confirm = (await readline.question('Create invite now? [y/N]: ')).trim().toLowerCase();
    if (confirm !== 'y' && confirm !== 'yes') {
      console.info('Invite creation cancelled.');
      return;
    }

    const service = new InviteCodeService(
      new DrizzleInviteCodeStore(db),
      new HmacKeyring(config.auth.inviteHashKeys),
    );
    const invite = await service.createInvite({
      maxUses,
      emailAllowlist: allowlistInput ? allowlistInput.split(',').map((email) => email.trim()) : [],
      expiresAt: null,
      issuedBy: null,
    });

    console.info('Invite created. This plaintext is shown once and cannot be recovered:');
    console.info(invite.plaintextCode);
  } finally {
    readline.close();
    await client.end();
  }
}

await run();
