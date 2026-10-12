import { expect, test, type Page } from '@playwright/test';

async function localLogin(page: Page): Promise<void> {
  await page.goto('/models');
  const shortcut = page.getByRole('button', { name: '一键进入本地管理台' });
  const navigation = page.getByRole('navigation', { name: '管理台主导航' });
  // Local login availability arrives after the initial render.
  await expect(shortcut.or(navigation).first()).toBeVisible();
  if (await shortcut.isVisible()) await shortcut.click();
  await expect(navigation).toBeVisible();
  await expect(page).toHaveURL(/\/models$/);
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);
}

test('uses one local login and keeps the session after refresh', async ({ page }) => {
  await localLogin(page);
  await expect(page.getByLabel('模型配置', { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByLabel('模型配置', { exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '管理台主导航' })).toBeVisible();
});

test('exposes one model workflow and no retired control-plane concepts', async ({ page }) => {
  await localLogin(page);
  const navigation = page.getByRole('navigation', { name: '管理台主导航' });
  await navigation.getByRole('menuitem', { name: /内测准入/ }).click();
  await expect(navigation.getByText('邀请码')).toBeVisible();
  await expect(navigation.getByText('模型配置')).toBeVisible();
  await expect(navigation.getByText('对象存储')).toBeVisible();
  for (const retired of ['服务通道', '适配器注册表', '模型快照', '模型目录', '规格与积分']) {
    await expect(navigation.getByText(retired, { exact: true })).toHaveCount(0);
  }

  await page.getByRole('button', { name: '添加模型' }).first().click();
  const drawer = page.getByRole('dialog', { name: '添加模型' });
  await expect(drawer.getByText('用途')).toBeVisible();
  await expect(drawer.getByText('协议')).toBeVisible();
  await drawer.getByText('Gemini', { exact: true }).click();
  await expect(drawer.getByRole('radio', { name: 'Gemini' })).toBeChecked();
  await expect(drawer.getByLabel('接口地址')).toBeVisible();
  await expect(drawer.getByLabel('API Key')).toBeVisible();
  await expect(drawer.getByRole('button', { name: '获取模型' })).toBeVisible();
  await expect(drawer.getByText('通道')).toHaveCount(0);
  await expect(drawer.getByText('快照')).toHaveCount(0);
});

test('retired pages and low-level admin APIs stay unavailable', async ({ page, request }) => {
  await localLogin(page);
  for (const route of ['/providers', '/pricing']) {
    expect((await request.get(route)).status(), route).toBe(404);
  }
  for (const route of [
    '/api/v1/admin/providers',
    '/api/v1/admin/provider-channels',
    '/api/v1/admin/models',
    '/api/v1/admin/model-catalog',
    '/api/v1/admin/billing-skus',
    '/api/v1/admin/pricing-releases',
    '/api/v1/admin/moderation-runtime',
  ]) {
    expect((await page.request.get(route)).status(), route).toBe(404);
  }
});

test('model configuration fits desktop and mobile viewports', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await localLogin(page);
  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: 'test-results/model-configurations-1440.png', fullPage: true });
  await page.getByRole('button', { name: '添加模型' }).first().click();
  const drawer = page.getByRole('dialog', { name: '添加模型' });
  await drawer.getByText('Gemini', { exact: true }).click();
  await expect(drawer.getByRole('radio', { name: 'Gemini' })).toBeChecked();
  await assertNoHorizontalOverflow(page);
  await page.screenshot({
    path: 'test-results/google-model-drawer-1440.png',
    fullPage: true,
    animations: 'disabled',
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByLabel('模型配置', { exact: true })).toBeVisible();
  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: 'test-results/model-configurations-390.png', fullPage: true });
  await page.getByRole('button', { name: '添加模型' }).first().click();
  await drawer.getByText('Gemini', { exact: true }).click();
  await expect(drawer.getByRole('radio', { name: 'Gemini' })).toBeChecked();
  await assertNoHorizontalOverflow(page);
  await page.screenshot({
    path: 'test-results/google-model-drawer-390.png',
    fullPage: true,
    animations: 'disabled',
  });
});
