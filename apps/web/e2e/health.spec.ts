import { expect, test } from '@playwright/test';

test('web health page is available', async ({ page }) => {
  await page.route('**/api/v1/me', async (route) => {
    await route.fulfill({
      body: JSON.stringify({ error: { code: 'AUTH_SESSION_REQUIRED', message: '未登录' } }),
      contentType: 'application/json',
      status: 401,
    });
  });
  await page.goto('/health');

  await expect(page.getByTestId('web-health-status')).toHaveText('ok');
});
