import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const tsxPath = resolve(repoRoot, 'node_modules/tsx/dist/cli.mjs');
const authFixturePath = resolve(repoRoot, 'apps/api/test/real-auth.fixture.ts');
const resourceFixturePath = resolve(repoRoot, 'apps/api/test/s10-live.fixture.ts');

function fixture<T>(path: string, action: string, input?: unknown): T {
  const result = spawnSync(process.execPath, [tsxPath, path, action], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
    input: input === undefined ? undefined : JSON.stringify(input),
  });
  if (result.status !== 0) {
    throw new Error(`S10 live fixture ${action} failed: ${result.stderr || result.stdout}`);
  }
  const output = result.stdout.trim().split(/\r?\n/).at(-1);
  if (!output) throw new Error(`S10 live fixture ${action} returned no result`);
  return JSON.parse(output) as T;
}

async function consoleOtp(purpose: string): Promise<string | undefined> {
  const collector = process.env.S03_LIVE_MAIL_COLLECTOR;
  if (!collector) throw new Error('Live mail collector is not configured');
  const response = await fetch(`${collector}/latest?purpose=${encodeURIComponent(purpose)}`);
  if (!response.ok) return undefined;
  const message = (await response.json()) as { otp?: unknown };
  return typeof message.otp === 'string' ? message.otp : undefined;
}

test('real product, private upload, Worker thumbnail, facts, and Agent attachment flow', async ({
  page,
}) => {
  const invite = fixture<{ inviteCode: string; inviteId: string }>(authFixturePath, 'create');
  const email = `s10-live-${randomUUID()}@example.com`;
  const password = 's10-live-password-123';
  const productName = `S10 联调商品 ${randomUUID().slice(0, 8)}`;
  const assetName = 's10-live-product.png';
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );

  try {
    await page.goto('/health');
    const registration = await page.evaluate(
      async ({ emailAddress, inviteCode, userPassword }) => {
        const response = await fetch('/api/v1/auth/register', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/json',
            'Idempotency-Key': `s10-live-register-${crypto.randomUUID()}`,
          },
          body: JSON.stringify({
            email: emailAddress,
            password: userPassword,
            display_name: 'S10 Live User',
            invite_code: inviteCode,
            agreement_version: '2026-08-09',
          }),
        });
        return { body: (await response.json()) as unknown, status: response.status };
      },
      { emailAddress: email, inviteCode: invite.inviteCode, userPassword: password },
    );
    expect(registration.status).toBe(201);
    const ticket = (registration.body as { verification_ticket?: unknown }).verification_ticket;
    expect(ticket).toEqual(expect.any(String));
    await expect.poll(() => consoleOtp('email_verification')).toMatch(/^\d{6}$/);
    const otp = await consoleOtp('email_verification');
    if (!otp || typeof ticket !== 'string') throw new Error('Registration OTP was not captured');
    expect(
      await page.evaluate(
        async ({ code, verificationTicket }) => {
          const response = await fetch('/api/v1/auth/verify-email', {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ verification_ticket: verificationTicket, code }),
          });
          return response.status;
        },
        { code: otp, verificationTicket: ticket },
      ),
    ).toBe(201);

    await page.goto('/products');
    await expect(page.getByRole('heading', { name: '商品', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '新建商品' }).click();
    await page.getByLabel('商品名称').fill(productName);
    await page.getByLabel('SKU 编号').fill('s10-live-sku');
    const createResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/products') && response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '创建商品' }).click();
    const created = await createResponse;
    expect(created.status()).toBe(201);
    const createdBody = (await created.json()) as { data?: { id?: unknown } };
    const productId = createdBody.data?.id;
    if (typeof productId !== 'string') throw new Error('Product API did not return an ID');
    await expect(page.getByRole('heading', { name: productName })).toBeVisible();

    await page.goto('/assets');
    await page.getByLabel('按商品筛选').selectOption(productId);
    const completeResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/assets/complete') &&
        response.request().method() === 'POST',
    );
    await page.getByLabel(/上传素材/).setInputFiles({
      name: assetName,
      mimeType: 'image/png',
      buffer: png,
    });
    expect((await completeResponse).status()).toBe(202);
    await expect(page.getByText('素材处理完成')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: `选择${assetName}` })).toBeEnabled();
    const preview = page.locator(`img[alt="${assetName}"]`);
    await expect(preview).toBeVisible();
    expect(await preview.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(
      0,
    );

    await page.goto(`/products/${productId}`);
    await page.getByRole('button', { name: '设置主图' }).click();
    await page.getByLabel('已处理素材').selectOption({ label: assetName });
    const setPrimaryResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/v1/products/${productId}`) &&
        response.request().method() === 'PATCH',
    );
    await page.getByRole('button', { name: '设为主图' }).click();
    expect((await setPrimaryResponse).status()).toBe(200);
    await expect(page.getByRole('img', { name: productName })).toBeVisible();

    await page.getByRole('button', { name: '确认事实' }).click();
    await page.getByLabel('主体颜色').fill('蓝色，白色');
    await page.getByLabel('材质').fill('棉');
    const factsResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/v1/products/${productId}/fact-sets`) &&
        response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '保存' }).click();
    expect((await factsResponse).status()).toBe(201);
    await expect(page.getByText('v1')).toBeVisible();
    await expect(page.getByText('蓝色')).toBeVisible();

    await page.goto('/');
    await page.getByRole('button', { name: '添加附件' }).click();
    const assetChoice = page.getByRole('button', { name: new RegExp(assetName) });
    await expect(assetChoice).toBeVisible();
    await assetChoice.click();
    await page.getByRole('button', { name: '加入本次输入' }).click();
    await expect(page.getByLabel('1 个附件')).toBeVisible();
    await expect(page.getByRole('dialog')).toBeHidden();

    await page.screenshot({ path: 'test-results/s10-live-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/assets');
    await expect(page.getByRole('heading', { name: '资产库' })).toBeVisible();
    const mobilePreview = page.locator(`img[alt="${assetName}"]`);
    await expect(mobilePreview).toBeVisible();
    await expect
      .poll(() => mobilePreview.evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBeGreaterThan(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: 'test-results/s10-live-mobile.png', fullPage: true });
  } finally {
    fixture(resourceFixturePath, 'cleanup', { email });
    fixture(authFixturePath, 'cleanup', { email, inviteId: invite.inviteId });
  }
});
