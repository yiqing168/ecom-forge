import { expect, test, type Page } from '@playwright/test';

import { createResourceApiMock } from './resource-api.mock';

const corsHeaders = {
  'access-control-allow-credentials': 'true',
  'access-control-allow-headers': 'content-type,idempotency-key',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-origin': 'http://127.0.0.1:3100',
};

const allowedAccess = {
  can_create: true,
  can_upload: true,
  can_charge: true,
  restriction_reason: null,
};

const sessionState = {
  agentMode: 'image',
  aspectRatio: '1:1',
  attachments: [],
  outputCount: 4,
  prompt: '',
  referencedAttachmentIds: [],
  requestDomain: 'creative',
  selectedSkillId: null,
  stage: 'idle',
  videoDuration: '5 秒',
  videoResolution: '1080P',
};

async function mockAuthApi(page: Page, initiallyAuthenticated = false, authDelayMs = 0) {
  let authenticated = initiallyAuthenticated;
  const mockResourceApi = createResourceApiMock();
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ headers: corsHeaders, status: 204 });
      return;
    }
    if (url.pathname.endsWith('/login')) {
      authenticated = true;
    }
    if (await mockResourceApi(route)) return;
    if (url.pathname === '/api/v1/credits/account') {
      await route.fulfill({
        body: JSON.stringify({
          as_of: '2026-08-30T00:00:00.000Z',
          available: '88.00',
          balance: '88.00',
          currency: 'credits',
          frozen: '2.00',
        }),
        contentType: 'application/json',
        headers: corsHeaders,
        status: 200,
      });
      return;
    }
    if (url.pathname === '/api/v1/credits/ledger') {
      await route.fulfill({
        body: JSON.stringify({
          items: [
            {
              amount: '10.00',
              balance_after: '88.00',
              created_at: '2026-08-30T08:00:00.000Z',
              frozen_after: '2.00',
              id: 'ledger-review-1',
              reservation_id: null,
              type: 'grant',
              workflow_run_id: null,
            },
          ],
          next_cursor: null,
        }),
        contentType: 'application/json',
        headers: corsHeaders,
        status: 200,
      });
      return;
    }
    if (url.pathname !== '/api/v1/me' && !url.pathname.endsWith('/login')) {
      await route.fulfill({ body: JSON.stringify({}), headers: corsHeaders, status: 200 });
      return;
    }
    if (url.pathname === '/api/v1/me' && authDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, authDelayMs));
    }
    await route.fulfill({
      body: JSON.stringify(
        authenticated
          ? {
              access: allowedAccess,
              user: {
                id: '00000000-0000-4000-8000-000000000001',
                email: 'review@example.com',
                display_name: 'Review user',
                email_verified: true,
              },
            }
          : { error: { code: 'AUTH_SESSION_REQUIRED', message: '未登录' } },
      ),
      contentType: 'application/json',
      headers: corsHeaders,
      status: authenticated ? 200 : 401,
    });
  });
}

async function authenticate(page: Page) {
  await mockAuthApi(page, true);
  await page.addInitScript((state) => {
    window.localStorage.setItem('ecom-forge-ui-prototype', JSON.stringify(state));
  }, sessionState);
}

async function authenticateWithDelayedRefresh(page: Page) {
  await mockAuthApi(page, true, 800);
  await page.addInitScript((state) => {
    window.localStorage.setItem('ecom-forge-ui-prototype', JSON.stringify(state));
  }, sessionState);
}

const routes = [
  { path: '/', text: '象塑' },
  { path: '/products', text: '以商品和 SKU 组织素材' },
  { path: '/products/sku-001', text: '夏季轻盈连衣裙' },
  { path: '/assets', text: '管理上传素材、参考图和生成结果' },
  { path: '/artifacts', text: '查看每次生成的最终结果' },
  { path: '/tasks', text: '任务中心' },
  { path: '/account', text: '积分与账户安全' },
  { path: '/batches', text: '我的批量创作' },
  { path: '/batches/new', text: '步骤 1 / 4' },
  { path: '/batches/batch-001', text: '夏季女装主图更新' },
  { path: '/discover', text: '查找可复用的创作模板' },
  { path: '/discover/editorial-fashion', text: '电影感时装光影' },
  { path: '/suites', text: '商品套图' },
  { path: '/suites/new', text: '步骤 1 / 6' },
  { path: '/suites/suite-001', text: '步骤 5 / 6' },
  { path: '/canvases', text: '手工组织文本、图片和视频节点' },
  { path: '/s/demo-share', text: '城市里的夏日时装' },
] as const;

test('all product routes render their intended state', async ({ page }) => {
  await authenticate(page);
  for (const route of routes) {
    const response = await page.goto(route.path, { waitUntil: 'domcontentloaded' });
    expect(response?.ok()).toBeTruthy();
    await expect(page.locator('body')).toContainText(route.text);
  }
});

for (const width of [1440, 390]) {
  test(`light brand styling preserves product menus and page layouts at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await authenticate(page);
    for (const path of ['/', '/assets', '/artifacts', '/account']) {
      await page.goto(path);
      await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
      if (path === '/assets' || path === '/artifacts') {
        await expect(page.locator('main img')).toHaveCount(path === '/assets' ? 5 : 1);
      }
      if (path === '/account') {
        await expect(page.getByText('review@example.com', { exact: true })).toBeVisible();
        await expect(page.getByText('积分发放', { exact: true })).toBeVisible();
      }
      const navigation = page.getByRole('navigation', {
        name: width === 390 ? '移动端主要导航' : '主要导航',
        exact: true,
      });
      await expect(navigation).toBeVisible();
      const menuNames = await navigation.getByRole('button').allTextContents();
      expect(menuNames).toEqual(
        width === 390 ? ['创作', '生成', '资产', '作品', '我的'] : ['创作', '生成', '资产', '作品'],
      );
      expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
        'rgb(247, 249, 251)',
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page
        .locator('main img')
        .evaluateAll((images) =>
          Promise.all(images.map((image) => (image as HTMLImageElement).decode())),
        );
      await page.screenshot({
        animations: 'disabled',
        path: testInfo.outputPath(`xiangsu-${path === '/' ? 'home' : path.slice(1)}-${width}.png`),
        fullPage: true,
        caret: 'initial',
      });
    }
  });
}

test('the public web application does not expose inactive routes', async ({ page }) => {
  for (const path of ['/admin', '/account/membership']) {
    const response = await page.goto(path, { waitUntil: 'domcontentloaded' });
    expect(response?.status()).toBe(404);
  }
});

test('main creation navigation always returns to the creation home', async ({ page }) => {
  await authenticate(page);
  for (const path of ['/products', '/assets', '/tasks']) {
    await page.goto(path);
    await page.evaluate(() => {
      const stored = JSON.parse(
        window.localStorage.getItem('ecom-forge-ui-prototype') ?? '{}',
      ) as Record<string, unknown>;
      window.localStorage.setItem(
        'ecom-forge-ui-prototype',
        JSON.stringify({ ...stored, prompt: '不应带回首页的旧会话输入', stage: 'completed' }),
      );
    });
    await page.getByRole('button', { name: '创作', exact: true }).first().click();
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('heading', { name: '象塑', exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: '创作输入' })).toHaveValue('');
  }
});

test('generation navigation opens a new conversation with access to previous sessions', async ({
  page,
}) => {
  await authenticate(page);
  await page.goto('/');
  await page.getByRole('button', { name: '生成', exact: true }).first().click();
  await expect(page).toHaveURL('/workspace/session/new');
  await expect(page.getByRole('heading', { name: '你好，想创作什么？' })).toBeVisible();
  await expect(page.getByRole('button', { name: '新对话', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '搜索会话' })).toBeVisible();
});

test('protected navigation keeps the application shell stable while authentication refreshes', async ({
  page,
}) => {
  await authenticateWithDelayedRefresh(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '象塑', exact: true })).toBeVisible();

  await page.getByRole('button', { name: '资产', exact: true }).first().click();
  await expect(page).toHaveURL('/assets');
  await expect(page.getByRole('status', { name: '正在验证登录状态' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '主要导航' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '资产' })).toBeVisible();

  await page.getByRole('button', { name: '生成', exact: true }).first().click();
  await expect(page).toHaveURL('/workspace/session/new');
  await expect(page.getByRole('status', { name: '正在验证登录状态' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '主要导航' })).toBeVisible();
  await expect(page.getByRole('button', { name: '新对话', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '你好，想创作什么？' })).toBeVisible();
});

test('contextual creation actions still open an empty session workspace', async ({ page }) => {
  await authenticate(page);
  await page.goto('/products/sku-001');
  await page.getByRole('button', { name: '用这个商品创作' }).click();
  await expect(page).toHaveURL('/workspace/session/new');
  await expect(page.getByRole('heading', { name: '你好，想创作什么？' })).toBeVisible();
});

test('canvas editor supports adding nodes and opening task logs', async ({ page }) => {
  await authenticate(page);
  await page.goto('/canvases/fashion-campaign');
  await expect(page.locator('.react-flow__node')).toHaveCount(4);
  await page.getByRole('button', { name: '添加附件' }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(5);
  await expect(page.locator('.react-flow__edge')).toHaveCount(5);
  await page.getByRole('button', { name: '任务日志' }).click();
  await expect(page.getByRole('heading', { name: '任务日志' })).toBeVisible();
});

test('protected deep links return to the workbench and request login', async ({ page }) => {
  await mockAuthApi(page);
  await page.goto('/products');
  await expect(page).toHaveURL('/');
  await expect
    .poll(() => page.evaluate(() => window.sessionStorage.getItem('ecom-forge-auth-required')))
    .toBe('/products');
  await expect(page.getByRole('heading', { name: '登录后开始创作' })).toBeVisible();
  await page.getByLabel('邮箱').fill('review@example.com');
  await page.getByLabel('密码', { exact: true }).fill('review123');
  await page.getByRole('button', { name: '登录并继续' }).click();
  await expect(page).toHaveURL('/products');
  await expect
    .poll(() => page.evaluate(() => window.sessionStorage.getItem('ecom-forge-auth-required')))
    .toBeNull();
});

test('the standalone canvas shell also enforces authentication', async ({ page }) => {
  await mockAuthApi(page);
  await page.goto('/canvases/fashion-campaign');
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: '登录后开始创作' })).toBeVisible();
});

test('canvas restores nodes, edges and node parameters after refresh', async ({ page }) => {
  await authenticate(page);
  await page.goto('/canvases/fashion-campaign');
  const prompt = page.getByLabel('时装主视觉提示词');
  await prompt.fill('保留面料纹理，增加自然侧光');
  await page.getByRole('button', { name: '3:4' }).click();
  await page.getByRole('button', { name: '添加附件' }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(5);
  await page.waitForTimeout(700);
  await page.reload();

  await expect(page.locator('.react-flow__node')).toHaveCount(5);
  await expect(page.locator('.react-flow__edge')).toHaveCount(5);
  await expect(page.getByLabel('时装主视觉提示词')).toHaveValue('保留面料纹理，增加自然侧光');
  await expect(page.getByRole('button', { name: '16:9' })).toBeVisible();
});

test('whole canvas workflow runs after one cost confirmation', async ({ page }) => {
  await authenticate(page);
  await page.goto('/canvases/fashion-campaign');
  await page.getByRole('button', { name: '运行工作流' }).click();
  await expect(page.getByRole('heading', { name: '确认运行工作流' })).toBeVisible();
  await page.getByRole('button', { name: '确认并运行' }).click();
  await expect(page.getByText(/已通过环、引用和上游就绪校验/)).toBeVisible();
  await expect(page.getByText('工作流运行完成')).toBeVisible({ timeout: 5000 });
});

test('mobile canvas is view-only', async ({ page }) => {
  await authenticate(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/canvases/fashion-campaign');
  await expect(page.getByText('移动端为查看模式')).toBeVisible();
  await expect(page.getByRole('button', { name: '添加附件' })).toHaveCount(0);
});

test('canvas offers reload and save-copy actions for revision conflicts', async ({ page }) => {
  await authenticate(page);
  await page.goto('/canvases/fashion-campaign');
  await page.getByRole('button', { name: '版本历史' }).click();
  await page.getByRole('button', { name: '模拟 revision 冲突' }).click();
  await expect(page.getByRole('heading', { name: '画布已在其他窗口更新' })).toBeVisible();
  await expect(page.getByRole('button', { name: '重新加载' })).toBeVisible();
  await expect(page.getByRole('button', { name: '另存副本' })).toBeVisible();
});

test('desktop navigation hides features that are not active for the first release', async ({
  page,
}) => {
  await authenticate(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: '生成', exact: true }).first()).toBeVisible();
  for (const label of ['商品', '任务', '批量', '套图', '发现', '画布']) {
    await expect(page.getByRole('button', { name: label, exact: true })).toHaveCount(0);
  }
});
