import { stdin, stdout } from 'node:process';
import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';

import { createDatabaseClient } from '@ecom-forge/db';

import { loadAppConfig } from '../config/app-config.js';
import { AdminAuthService } from '../modules/admin-auth/admin-auth.service.js';
import { createTotpSecret, totpProvisioningUri } from '../modules/admin-auth/admin-crypto.js';

async function readHidden(prompt: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== 'function') {
    throw new Error('Admin bootstrap requires an interactive TTY');
  }
  stdout.write(prompt);
  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise<string>((resolve, reject) => {
    let value = '';
    const finish = (error?: Error) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string | Buffer) => {
      const input = chunk.toString();
      if (input === '\u0003') {
        finish(new Error('Admin bootstrap cancelled'));
        return;
      }
      if (input === '\r' || input === '\n') {
        finish();
        return;
      }
      if (input === '\u007f' || input === '\b') {
        if (value.length > 0) {
          value = value.slice(0, -1);
          stdout.write('\b \b');
        }
        return;
      }
      if (/^[\x20-\x7E]+$/.test(input) && value.length + input.length <= 128) {
        value += input;
        stdout.write('*'.repeat(input.length));
      }
    };
    stdin.on('data', onData);
  });
}

async function run(): Promise<void> {
  if (process.argv.length !== 2) {
    throw new Error('Admin bootstrap does not accept command-line arguments');
  }
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error('Admin bootstrap requires an interactive terminal');
  }
  const config = loadAppConfig();
  const readline = createInterface({ input: stdin, output: stdout, terminal: true });
  const identifier = (await readline.question('管理员登录标识: ')).trim();
  const displayName = (await readline.question('管理员显示名称: ')).trim();
  readline.close();
  const password = await readHidden('新密码（至少 12 位）: ');
  const confirmation = await readHidden('再次输入新密码: ');
  if (password.length < 12 || password !== confirmation) {
    throw new Error('Password confirmation failed');
  }
  if (!displayName || displayName.length > 80) {
    throw new Error('Display name must contain 1 to 80 characters');
  }

  const totpSecret = createTotpSecret();
  stdout.write('\n请立即将以下 TOTP URI 添加到认证器；该信息不会再次显示。\n');
  stdout.write(`${totpProvisioningUri(totpSecret, identifier)}\n\n`);
  const totpReader = createInterface({ input: stdin, output: stdout, terminal: true });
  const totpCode = (await totpReader.question('输入认证器当前 6 位验证码: ')).trim();
  const confirmationText = (
    await totpReader.question('输入 CREATE 确认创建首个 super_admin: ')
  ).trim();
  totpReader.close();
  if (confirmationText !== 'CREATE') throw new Error('Admin bootstrap cancelled');

  const resource = createDatabaseClient(
    config.databaseUrl ? { databaseUrl: config.databaseUrl } : {},
  );
  try {
    const service = new AdminAuthService(resource.db, config);
    const result = await service.bootstrap({
      identifier,
      displayName,
      password,
      totpSecret,
      totpCode,
    });
    stdout.write(`\n管理员已创建：${result.principalId}\n`);
    stdout.write('以下恢复码仅显示一次，请立即保存到受控密码库：\n');
    for (const code of result.recoveryCodes) stdout.write(`${code}\n`);
  } finally {
    await resource.client.end();
  }
}

await run();
