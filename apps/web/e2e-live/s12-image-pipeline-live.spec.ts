import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const tsxPath = resolve(repoRoot, 'node_modules/tsx/dist/cli.mjs');
const s11FixturePath = resolve(repoRoot, 'apps/api/test/s11-live.fixture.ts');
const s12FixturePath = resolve(repoRoot, 'apps/api/test/s12-live.fixture.ts');
const apiOrigin = 'http://127.0.0.1:3101';

type S11Fixture = {
  user_cookie: string;
  primary_skill_id: string;
};

function fixture<T>(
  path: string,
  action: 'setup' | 'cleanup' | 'diagnose',
  input: unknown = {},
): T {
  const result = spawnSync(process.execPath, [tsxPath, path, action], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
    input: JSON.stringify(input),
  });
  if (result.status !== 0) {
    throw new Error(`S12 live fixture ${action} failed: ${result.stderr || result.stdout}`);
  }
  const output = result.stdout.trim().split(/\r?\n/).at(-1);
  if (!output) throw new Error(`S12 live fixture ${action} returned no result`);
  return JSON.parse(output) as T;
}

async function installCookie(context: BrowserContext, header: string): Promise<void> {
  await context.addCookies(
    header.split(';').map((entry) => {
      const separator = entry.indexOf('=');
      if (separator < 1) throw new Error('S12 live fixture returned an invalid cookie');
      return {
        name: entry.slice(0, separator),
        value: entry.slice(separator + 1),
        domain: '127.0.0.1',
        path: '/',
        httpOnly: true,
        sameSite: 'Lax' as const,
      };
    }),
  );
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client);
}

test('generates from the workbench and restores its image after reconnect and reload', async ({
  context,
  page,
}, testInfo) => {
  let base: S11Fixture | undefined;
  let s12: Record<string, unknown> | undefined;
  let turnCreateRequests = 0;
  let publicQuoteSubmissions = 0;
  let eventConnections = 0;
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && path === '/api/v1/agent/turns') turnCreateRequests += 1;
    if (request.method() === 'POST' && /\/run-quotes\/[^/]+\/submit$/.test(path))
      publicQuoteSubmissions += 1;
    if (path === '/api/v1/events') eventConnections += 1;
  });
  const assetName = `s12-live-product-${testInfo.project.name}.png`;
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );

  try {
    base = fixture<S11Fixture>(s11FixturePath, 'setup');
    s12 = fixture<Record<string, unknown>>(s12FixturePath, 'setup');
    await installCookie(context, base.user_cookie);

    await page.goto('/assets', { waitUntil: 'domcontentloaded' });
    const uploadComplete = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/v1/assets/complete',
    );
    await page.getByLabel('上传素材').setInputFiles({
      name: assetName,
      mimeType: 'image/png',
      buffer: png,
    });
    expect((await uploadComplete).status()).toBe(202);
    await expect(page.getByText('素材处理完成')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: `选择${assetName}` })).toBeEnabled();

    await page.goto('/workspace/session/new', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '添加附件' }).click();
    const assetChoice = page.getByRole('button', { name: new RegExp(assetName) });
    await expect(assetChoice).toBeVisible();
    await assetChoice.click();
    await page.getByRole('button', { name: '加入本次输入' }).click();
    await expect(page.getByLabel('1 个附件')).toBeVisible();

    await page.getByRole('button', { name: /选择 Skill/ }).click();
    await page.getByRole('menuitem', { name: 'S11 Live Creative' }).click();
    await page.getByRole('button', { name: /选择风格/ }).click();
    await page.getByRole('menuitem', { name: /S11 Live Style/ }).click();
    const prompt = '[s12-generate] 为这个商品生成一张干净的白底主图';
    await page.getByRole('textbox', { name: '创作输入' }).fill(prompt);
    const createResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/v1/agent/turns',
    );
    await page.getByRole('button', { name: '开始创作' }).click();
    const createdResponse = await createResponse;
    expect(createdResponse.status()).toBe(201);
    const created = (await createdResponse.json()) as {
      data: { session_id: string; turn_id: string };
    };

    await expect(page.getByRole('heading', { name: '确认商品事实' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByLabel('商品名称')).toHaveValue('蓝色陶瓷杯');
    await expect.poll(() => eventConnections).toBeGreaterThan(0);
    const connectionsBeforeReconnect = eventConnections;
    await context.setOffline(true);
    await expect(page.getByText('连接中断，正在恢复')).toBeVisible({ timeout: 15_000 });
    await context.setOffline(false);
    await expect
      .poll(() => eventConnections, { timeout: 15_000 })
      .toBeGreaterThan(connectionsBeforeReconnect);
    await page.getByLabel('当前图片没有可见文字').click();
    const factsResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === `/api/v1/agent/turns/${created.data.turn_id}/confirm`,
    );
    await page.getByRole('button', { name: '确认商品事实并继续' }).click();
    expect((await factsResponse).status()).toBe(202);

    await expect(page.getByRole('heading', { name: '确认本次费用' })).toHaveCount(0);

    try {
      await expect
        .poll(
          async () => {
            const response = await context.request.get(
              `${apiOrigin}/api/v1/agent/sessions/${created.data.session_id}`,
            );
            if (!response.ok()) return null;
            const payload = (await response.json()) as {
              data?: {
                turns: Array<{ id: string; user_status: string; workflow_run_id: string | null }>;
              };
            };
            return payload.data?.turns.find((turn) => turn.id === created.data.turn_id) ?? null;
          },
          { timeout: 60_000 },
        )
        .toMatchObject({ user_status: 'completed', workflow_run_id: expect.any(String) });
    } catch (error) {
      const diagnosis = fixture<Record<string, unknown>>(s12FixturePath, 'diagnose', {
        turn_id: created.data.turn_id,
      });
      throw new Error(`S12 artifact did not publish: ${JSON.stringify(diagnosis)}`, {
        cause: error,
      });
    }

    await expect(page).toHaveURL(`/workspace/session/${created.data.session_id}`);
    const preview = page.getByRole('img', { name: '生成的图片', exact: true });
    await expect(preview).toHaveCount(1);
    await expect(preview).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => preview.evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBeGreaterThan(0);
    expect(turnCreateRequests).toBe(1);
    expect(publicQuoteSubmissions).toBe(0);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(preview).toHaveCount(1);
    await expect(preview).toBeVisible();
    await expect
      .poll(() => preview.evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBeGreaterThan(0);
    expect(turnCreateRequests).toBe(1);
    await assertNoHorizontalOverflow(page);
    await page.screenshot({
      fullPage: true,
      path: testInfo.outputPath(`s12-${testInfo.project.name}.png`),
    });
  } finally {
    if (s12) fixture(s12FixturePath, 'cleanup', s12);
    fixture(s11FixturePath, 'cleanup');
  }
});
