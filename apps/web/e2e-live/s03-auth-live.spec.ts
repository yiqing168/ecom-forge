import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const fixturePath = resolve(repoRoot, 'apps/api/test/real-auth.fixture.ts');
const tsxPath = resolve(repoRoot, 'node_modules/tsx/dist/cli.mjs');

function fixture<T>(action: 'cleanup' | 'create', input?: unknown): T {
  const result = spawnSync(process.execPath, [tsxPath, fixturePath, action], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
    input: input === undefined ? undefined : JSON.stringify(input),
  });
  if (result.status !== 0) {
    throw new Error(`S03 fixture ${action} failed: ${result.stderr || result.stdout}`);
  }
  const output = result.stdout.trim().split(/\r?\n/).at(-1);
  if (!output) throw new Error(`S03 fixture ${action} returned no result`);
  return JSON.parse(output) as T;
}

async function consoleOtp(purpose: string): Promise<string | undefined> {
  const collector = process.env.S03_LIVE_MAIL_COLLECTOR;
  if (!collector) throw new Error('S03 live mail collector is not configured');
  const response = await fetch(`${collector}/latest?purpose=${encodeURIComponent(purpose)}`);
  if (!response.ok) return undefined;
  const message = (await response.json()) as { otp?: unknown };
  return typeof message.otp === 'string' ? message.otp : undefined;
}

test('real web and console-mail API complete registration, verification, and login', async ({
  context,
  page,
}) => {
  const created = fixture<{ inviteCode: string; inviteId: string }>('create');
  const email = `s03-live-${randomUUID()}@example.com`;
  const password = 's03-live-password-123';

  try {
    await page.goto('/');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('button', { name: '注册账号' }).click();
    await page.getByLabel('邮箱').fill(email);
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByLabel('邀请码').fill(created.inviteCode);
    await page.getByRole('checkbox').check();

    const registrationResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/auth/register') && response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '注册并发送验证码' }).click();
    const registered = await registrationResponse;
    expect(registered.status()).toBe(201);
    expect(registered.headers()['cache-control']).toBe('no-store');
    await expect(page.getByRole('heading', { name: '验证你的邮箱' })).toBeVisible();

    await expect.poll(() => consoleOtp('email_verification')).toMatch(/^\d{6}$/);
    const otp = await consoleOtp('email_verification');
    if (!otp) throw new Error('ConsoleMailAdapter did not emit an email verification OTP');
    await page.getByLabel('邮箱验证码').fill(otp);

    const verificationResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/auth/verify-email') &&
        response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '完成验证' }).click();
    const verified = await verificationResponse;
    expect(verified.status()).toBe(201);
    expect(verified.headers()['cache-control']).toBe('no-store');
    await expect(page.getByText('登录成功，草稿已保留，请再次点击开始创作')).toBeVisible();

    const verifiedSession = await page.evaluate(async () => {
      const response = await fetch('/api/v1/me');
      const body: unknown = await response.json();
      return { body, cacheControl: response.headers.get('cache-control') };
    });
    expect(verifiedSession.cacheControl).toBe('no-store');
    expect(verifiedSession.body).toMatchObject({
      user: { email, email_verified: true },
      access: { can_create: true },
    });

    await context.clearCookies();
    await page.reload();
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByLabel('邮箱').fill(email);
    await page.getByLabel('密码', { exact: true }).fill(password);
    const loginResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/auth/login') && response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '登录并继续' }).click();
    const loggedIn = await loginResponse;
    expect(loggedIn.status()).toBe(201);
    expect(loggedIn.headers()['cache-control']).toBe('no-store');
    await expect(page.getByText('登录成功，草稿已保留，请再次点击开始创作')).toBeVisible();
    await expect(page.getByRole('dialog')).toBeHidden();
    await page.screenshot({ path: 'test-results/s03-live-auth-success.png', fullPage: true });
  } finally {
    fixture('cleanup', { email, inviteId: created.inviteId });
  }
});
