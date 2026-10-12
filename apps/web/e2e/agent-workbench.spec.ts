import { expect, test, type Page } from '@playwright/test';

import { agentMockIds, brainFailureSummary, createAgentApiMock } from './agent-api.mock';
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

type AgentTurnCreationPayload = Record<string, unknown> & {
  generation_preferences: Record<string, unknown>;
  message: string;
};

async function mockAuthApi(page: Page) {
  let authenticated = false;
  const mockAgentApi = createAgentApiMock();
  const mockResourceApi = createResourceApiMock();
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const cookies = await page.context().cookies('http://localhost:3001');
    const hasTestSession = cookies.some((cookie) => cookie.name === 's03-e2e-session');
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ headers: corsHeaders, status: 204 });
      return;
    }
    if (url.pathname === '/api/v1/me') {
      await route.fulfill({
        body: JSON.stringify(
          authenticated || hasTestSession
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
        status: authenticated || hasTestSession ? 200 : 401,
      });
      return;
    }
    if (url.pathname.endsWith('/login')) {
      authenticated = true;
      await route.fulfill({
        body: JSON.stringify({
          access: allowedAccess,
          user: {
            id: '00000000-0000-4000-8000-000000000001',
            email: 'review@example.com',
            display_name: 'Review user',
            email_verified: true,
          },
        }),
        contentType: 'application/json',
        headers: corsHeaders,
        status: 200,
      });
      return;
    }
    if (url.pathname.endsWith('/register')) {
      await route.fulfill({
        body: JSON.stringify({
          verification_ticket: 'test-verification-ticket-000000000000000000000000',
          email: 'n***@example.com',
          expires_in_seconds: 600,
          resend_cooldown_seconds: 60,
        }),
        contentType: 'application/json',
        headers: corsHeaders,
        status: 201,
      });
      return;
    }
    if (url.pathname.endsWith('/verify-email')) {
      authenticated = true;
      await route.fulfill({
        body: JSON.stringify({
          access: allowedAccess,
          user: {
            id: '00000000-0000-4000-8000-000000000001',
            email: 'new@example.com',
            display_name: 'Review user',
            email_verified: true,
          },
        }),
        contentType: 'application/json',
        headers: corsHeaders,
        status: 200,
      });
      return;
    }
    if (url.pathname.endsWith('/password-reset/request')) {
      await route.fulfill({
        body: JSON.stringify({ status: 'accepted' }),
        contentType: 'application/json',
        headers: corsHeaders,
        status: 202,
      });
      return;
    }
    if (url.pathname.endsWith('/password-reset/confirm')) {
      await route.fulfill({
        body: JSON.stringify({ status: 'reset' }),
        contentType: 'application/json',
        headers: corsHeaders,
        status: 200,
      });
      return;
    }
    if (url.pathname.endsWith('/email-verification/request')) {
      await route.fulfill({
        body: JSON.stringify({
          verification_ticket: 'test-verification-ticket-000000000000000000000000',
          expires_in_seconds: 600,
          resend_cooldown_seconds: 60,
        }),
        contentType: 'application/json',
        headers: corsHeaders,
        status: 200,
      });
      return;
    }
    if (await mockAgentApi(route)) return;
    if (await mockResourceApi(route)) return;
    await route.fulfill({
      body: JSON.stringify({}),
      contentType: 'application/json',
      headers: corsHeaders,
      status: 200,
    });
  });
}

async function mockAuthEndpoint(
  page: Page,
  path: string,
  status: number,
  body: Record<string, unknown>,
) {
  await page.route(`**${path}`, async (route) => {
    await route.fulfill({
      body: JSON.stringify(body),
      contentType: 'application/json',
      headers: corsHeaders,
      status,
    });
  });
}

async function setTestSession(page: Page) {
  await page
    .context()
    .addCookies([{ name: 's03-e2e-session', value: '1', url: 'http://localhost:3001' }]);
}

async function authenticateWithTestSession(page: Page) {
  await setTestSession(page);
  await page.reload();
  await expect(page.getByRole('button', { name: '使用 Skill：创意海报' })).toBeVisible();
}

async function selectRequiredCreativeSkill(page: Page) {
  await page.getByRole('button', { name: '使用 Skill：创意海报' }).click();
  await page.getByRole('button', { name: '选择风格：未选择' }).click();
  await page.getByRole('menuitem', { name: /清透杂志感/ }).click();
}

test.beforeEach(async ({ page }) => {
  await mockAuthApi(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
});

for (const viewport of [
  { width: 1280, height: 600 },
  { width: 1280, height: 400 },
  { width: 390, height: 600 },
  { width: 640, height: 400 },
]) {
  test(`long composer menus remain selectable at ${viewport.width}x${viewport.height}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const skills = Array.from({ length: 20 }, (_, index) => ({
      primary_skill_id: index === 1 ? agentMockIds.skill : `layout-study-${index}@1.0.0`,
      slug: index === 1 ? 'creative-poster' : `layout-study-${index}`,
      version: '1.0.0',
      name: index === 0 ? '自由创作' : index === 1 ? '创意海报' : `Study ${index + 1}`,
      description: '',
      domain: 'creative',
      category: 'creative',
      required_inputs: [],
      preset_slots:
        index === 1
          ? [
              {
                slot: 'style',
                label: '视觉风格',
                required: false,
                max_selections: 1,
                options: Array.from({ length: 20 }, (_, option) => ({
                  preset_id: `layout-style-${option}@1.0.0`,
                  name: `风格 ${option + 1}`,
                  description: '用于长列表边界验证的风格',
                })),
              },
            ]
          : [],
    }));
    await page.route('**/api/v1/skills', async (route) => {
      await route.fulfill({
        headers: corsHeaders,
        json: {
          data: {
            catalog_version: 'long-menu-test',
            response_version: '1',
            generation_policy: { schema_version: 2, policy_version: 'long-menu-test' },
            items: skills,
          },
        },
      });
    });
    await page.route('**/api/v1/model-catalog?*', async (route) => {
      const category = new URL(route.request().url()).searchParams.get('category');
      await route.fulfill({
        headers: corsHeaders,
        json: {
          catalog_revision: 7,
          items:
            category === 'video'
              ? []
              : Array.from({ length: 20 }, (_, index) => ({
                  id: `${category}-${index}`,
                  public_slug: `${category}-${index}`,
                  category,
                  version_no: 1,
                  display_name: `${category === 'brain' ? '推理' : '图片'}模型 ${index + 1}`,
                  description: '',
                  public_capabilities: {},
                  user_selectable: true,
                  is_default: index === 0,
                  availability: 'available',
                  pricing_summary: [],
                })),
        },
      });
    });
    await authenticateWithTestSession(page);

    const skillTrigger = page.getByRole('button', { name: /选择 Skill/ });
    await skillTrigger.click();
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem')).toHaveCount(20);
    await expectBoundedMenu(page);
    await expectItemInsideMenu(page, menu.getByRole('menuitem').first());
    await page.screenshot({ path: testInfo.outputPath('skill-menu-bounded.png') });
    await menu.getByRole('menuitem', { name: '自由创作', exact: true }).click();
    await expect(skillTrigger).toHaveAccessibleName('选择 Skill：自由创作');
    await skillTrigger.click();
    const lastSkill = menu.getByRole('menuitem').last();
    await lastSkill.scrollIntoViewIfNeeded();
    await expectItemInsideMenu(page, lastSkill);
    await lastSkill.click();
    await expect(skillTrigger).toHaveAccessibleName('选择 Skill：Study 20');

    await skillTrigger.focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('End');
    await expect(lastSkill).toBeFocused();
    await expectItemInsideMenu(page, lastSkill);
    await page.keyboard.press('Home');
    const firstSkill = menu.getByRole('menuitem').first();
    await expect(firstSkill).toBeFocused();
    await expectItemInsideMenu(page, firstSkill);
    await page.keyboard.press('Enter');
    await expect(skillTrigger).toHaveAccessibleName('选择 Skill：自由创作');
    await expect(skillTrigger).toBeFocused();
    await skillTrigger.click();
    await page.keyboard.press('Home');
    await page.keyboard.type('Study 20');
    await expect(lastSkill).toBeFocused();
    await expectItemInsideMenu(page, lastSkill);
    await page.keyboard.press('Enter');
    await expect(skillTrigger).toHaveAccessibleName('选择 Skill：Study 20');
    await expect(skillTrigger).toBeFocused();

    await page.getByRole('button', { name: '使用 Skill：创意海报' }).click();
    await page.getByRole('button', { name: /选择风格/ }).click();
    await expectBoundedMenu(page);
    const lastStyle = menu.getByRole('menuitem').last();
    await lastStyle.scrollIntoViewIfNeeded();
    await expectItemInsideMenu(page, lastStyle);
    await page.screenshot({ path: testInfo.outputPath('style-menu-bounded.png') });
    await lastStyle.click();
    await expect(page.getByRole('button', { name: '选择风格：风格 20' })).toBeVisible();
    const styleTrigger = page.getByRole('button', { name: /选择风格/ });
    await styleTrigger.click();
    await page.keyboard.press('Home');
    await page.keyboard.press('Enter');
    await expect(styleTrigger).toBeFocused();

    await page.getByRole('button', { name: /选择模型/ }).click();
    await expect(menu.getByRole('menuitem')).toHaveCount(40);
    await expectBoundedMenu(page);
    await expectItemInsideMenu(page, menu.getByRole('menuitem').first());
    const lastModel = menu.getByRole('menuitem').last();
    await lastModel.scrollIntoViewIfNeeded();
    await expectItemInsideMenu(page, lastModel);
    await page.screenshot({ path: testInfo.outputPath('model-menu-bounded.png') });
    await lastModel.click();
    await expect(page.getByRole('button', { name: '选择模型：图片模型 20' })).toBeVisible();
    const modelTrigger = page.getByRole('button', { name: '选择模型：图片模型 20' });
    await modelTrigger.click();
    await page.keyboard.press('Home');
    await page.keyboard.press('Enter');
    await expect(modelTrigger).toBeFocused();
    const designerTrigger = page.getByRole('button', { name: /设计师：/ });
    await designerTrigger.click();
    await expectBoundedMenu(page);
    await expect(menu.getByRole('menuitemradio')).toHaveCount(8);
    const lastDesigner = menu.getByRole('menuitemradio').last();
    await lastDesigner.scrollIntoViewIfNeeded();
    await expectItemInsideMenu(page, lastDesigner);
    await page.screenshot({ path: testInfo.outputPath('designer-menu-bounded.png') });
    await page.keyboard.press('Home');
    await page.keyboard.press('Enter');
    await expect(designerTrigger).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}

async function expectBoundedMenu(page: Page) {
  const menu = page.getByRole('menu');
  await expect
    .poll(() =>
      menu.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return (
          box.top >= 11 &&
          box.left >= 11 &&
          box.bottom <= innerHeight - 11 &&
          box.right <= innerWidth - 11 &&
          getComputedStyle(element).overflowY === 'auto' &&
          element.scrollHeight > element.clientHeight
        );
      }),
    )
    .toBe(true);
}

async function expectItemInsideMenu(page: Page, item: ReturnType<Page['getByRole']>) {
  await expect(item).toBeVisible();
  await expect
    .poll(async () => {
      const [menuBox, itemBox] = await Promise.all([
        page.getByRole('menu').boundingBox(),
        item.boundingBox(),
      ]);
      return Boolean(
        menuBox &&
        itemBox &&
        itemBox.y >= menuBox.y &&
        itemBox.y + itemBox.height <= menuBox.y + menuBox.height,
      );
    })
    .toBe(true);
}

for (const width of [1440, 390]) {
  test(`automatic designer resolves once and remains locked after refresh at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await authenticateWithTestSession(page);
    await selectRequiredCreativeSkill(page);
    await expect(page.getByRole('button', { name: '设计师：自动' })).toBeEnabled();
    await page.getByRole('textbox', { name: '创作输入' }).fill('[designer-resolved] 请创作海报');
    await page.getByRole('button', { name: '开始创作', exact: true }).click();
    await expect(page).toHaveURL(`/workspace/session/${agentMockIds.session}`, { timeout: 20_000 });
    const designer = page.getByRole('button', { name: '设计师：自动 · 材料实验' });
    await expect(designer).toBeDisabled();
    await page.reload();
    await expect(designer).toBeDisabled();
    await expect(
      page.getByRole('button', { name: '当前会话 Skill：创意海报，已锁定' }),
    ).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath('automatic-designer-locked.png'),
      fullPage: true,
    });
  });

  test(`designer selection submits and stays isolated across refresh at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await authenticateWithTestSession(page);
    await selectRequiredCreativeSkill(page);
    await expect(page.getByRole('button', { name: '设计师：自动' })).toBeVisible();
    await page.getByRole('button', { name: '设计师：自动' }).click();
    await expect(page.getByRole('menuitemradio')).toHaveCount(8);
    await page.screenshot({ path: testInfo.outputPath('designer-menu.png'), fullPage: true });
    await page.getByRole('menuitemradio', { name: /视觉隐喻/ }).click();
    await page.getByRole('textbox', { name: '创作输入' }).fill('请创作一张海报');
    const submitted = page.waitForRequest(
      (request) =>
        request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/agent/turns',
    );
    await page.getByRole('button', { name: '开始创作', exact: true }).click();
    const payload = (await submitted).postDataJSON() as AgentTurnCreationPayload;
    expect(payload.generation_preferences.creative_direction).toEqual({
      mode: 'profile',
      profile_id: 'visual-metaphor',
      version: 2,
    });
    await expect(page).toHaveURL(`/workspace/session/${agentMockIds.session}`);
    await expect(page.getByRole('button', { name: '设计师：视觉隐喻' })).toBeVisible();
    await expect(page.getByRole('button', { name: '设计师：视觉隐喻' })).toBeDisabled();
    await page.reload();
    await expect(page.getByRole('button', { name: '设计师：视觉隐喻' })).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath('designer-composer.png'), fullPage: true });
  });
}

test('visitor draft survives login and creates a server-backed Agent turn', async ({ page }) => {
  await expect(page.getByRole('heading', { name: '象塑', exact: true })).toBeVisible();

  await page.getByRole('textbox', { name: '创作输入' }).fill('一张冷调蓝色的未来城市海报');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByLabel('邮箱').fill('review@example.com');
  await page.getByLabel('密码', { exact: true }).fill('review123');
  await page.getByRole('button', { name: '登录并继续' }).click();

  await expect(page.getByText('登录成功，草稿已保留，请再次点击开始创作')).toBeVisible();
  await expect(page.getByRole('textbox', { name: '创作输入' })).toHaveValue(
    '一张冷调蓝色的未来城市海报',
  );
  await selectRequiredCreativeSkill(page);

  await page.getByRole('button', { name: '开始创作', exact: true }).click();
  await expect(page).toHaveURL(`/workspace/session/${agentMockIds.session}`);
  await expect(page.locator('#main-content').getByText('一张冷调蓝色的未来城市海报')).toBeVisible();
  await expect(
    page.getByText('方向已经整理完成；正式生图将在图片执行管线启用后进行。'),
  ).toBeVisible();
  await expect(page.getByRole('img', { name: /生成结果/ })).toHaveCount(0);
});

test('clarification pauses the turn and resumes after the user answers', async ({ page }) => {
  await authenticateWithTestSession(page);
  await selectRequiredCreativeSkill(page);
  await page.getByRole('textbox', { name: '创作输入' }).fill('[clarify] 为新品做一张社交传播海报');
  await page.getByRole('button', { name: '开始创作', exact: true }).click();

  await expect(page).toHaveURL(`/workspace/session/${agentMockIds.session}`);
  await expect(page.getByText('这张海报更偏产品展示还是氛围传播？')).toBeVisible();
  await expect(page.getByRole('button', { name: '确认并继续' })).toHaveCount(0);
  await expect(page.getByText('需要你确认', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '氛围传播' }).click();
  await expect(page.getByText('收到补充信息，我会按清透杂志感继续整理创意方向。')).toBeVisible();
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`clarification attachment reply uses the composer at ${viewport.width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await authenticateWithTestSession(page);
    await selectRequiredCreativeSkill(page);
    await page.getByRole('textbox', { name: '创作输入' }).fill('[clarify] 请先看看参考图');
    await page.getByRole('button', { name: '开始创作', exact: true }).click();
    await expect(page.getByText('这张海报更偏产品展示还是氛围传播？')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('clarification.png'), fullPage: true });
    await page.getByRole('button', { name: '附图回复' }).click();
    await page.getByRole('button', { name: /电影感时装大片/ }).click();
    await page.getByRole('button', { name: '加入本次输入' }).click();
    await expect(page.getByRole('button', { name: '氛围传播' })).toBeDisabled();
    await expect(page.getByRole('textbox', { name: '创作输入' })).toHaveValue('');
    await expect(page.getByRole('button', { name: '开始创作', exact: true })).toBeEnabled();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('attachment-reply.png'), fullPage: true });
    const request = page.waitForRequest(
      (item) => item.method() === 'POST' && new URL(item.url()).pathname === '/api/v1/agent/turns',
    );
    await page.getByRole('button', { name: '开始创作', exact: true }).click();
    const payload = (await request).postDataJSON() as {
      message: string;
      attachments: unknown[];
      session_id: string;
    };
    expect(payload.message).toBe('');
    expect(payload.attachments).toHaveLength(1);
    expect(payload.session_id).toBe(agentMockIds.session);
  });
}

test('generation starts without a browser-side cost confirmation or quote submit', async ({
  page,
}) => {
  let quoteSubmitRequests = 0;
  let agentConfirmRequests = 0;
  page.on('request', (request) => {
    if (request.url().includes(`/api/v1/run-quotes/${agentMockIds.quote}/submit`)) {
      quoteSubmitRequests += 1;
    }
    if (request.url().includes(`/api/v1/agent/turns/${agentMockIds.turn}/confirm`)) {
      agentConfirmRequests += 1;
    }
  });

  await authenticateWithTestSession(page);
  await selectRequiredCreativeSkill(page);
  await page.getByRole('textbox', { name: '创作输入' }).fill('帮我生成两张新品海报');
  await page.getByRole('button', { name: '开始创作', exact: true }).click();

  await expect(
    page.getByText('方向已经整理完成；正式生图将在图片执行管线启用后进行。'),
  ).toBeVisible();
  await expect(page.getByText('确认费用')).toHaveCount(0);
  expect(quoteSubmitRequests).toBe(0);
  expect(agentConfirmRequests).toBe(0);
});

test('SSE disconnect recovery completes the existing turn without creating another turn', async ({
  page,
}) => {
  let turnCreateRequests = 0;
  let eventConnections = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/api/v1/agent/turns')) turnCreateRequests += 1;
    if (request.url().includes('/api/v1/events?')) eventConnections += 1;
  });

  await authenticateWithTestSession(page);
  await selectRequiredCreativeSkill(page);
  await page.getByRole('textbox', { name: '创作输入' }).fill('[reconnect] test SSE recovery');
  await page.getByRole('button', { name: '开始创作', exact: true }).click();

  await expect.poll(() => eventConnections, { timeout: 15_000 }).toBeGreaterThan(1);
  await expect(page.getByText('SSE_RECOVERED_ASSISTANT_MESSAGE', { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect.poll(() => turnCreateRequests).toBe(1);
  await expect.poll(() => eventConnections).toBeGreaterThan(1);
});

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`image clarity exposes 1K 2K 4K at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await authenticateWithTestSession(page);
    await page.getByRole('button', { name: '图片清晰度：1K' }).click();
    for (const tier of ['1K', '2K', '4K']) {
      await expect(page.getByRole('menuitem', { name: tier, exact: true })).toBeVisible();
    }
    await expect(page.getByRole('menuitem', { name: '3K', exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('resolution-menu.png') });
    await page.getByRole('menuitem', { name: '4K', exact: true }).click();
    await expect(page.getByRole('button', { name: '图片清晰度：4K' })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
}

test('agent sends only supported immutable generation preferences', async ({ page }) => {
  const capturedPayload: { value: AgentTurnCreationPayload | null } = { value: null };
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/agent/turns') {
      capturedPayload.value = request.postDataJSON() as AgentTurnCreationPayload;
    }
  });

  await authenticateWithTestSession(page);
  await selectRequiredCreativeSkill(page);
  await page.getByRole('button', { name: '图片比例：智能比例' }).click();
  await page.getByRole('menuitem', { name: '3:4' }).click();
  await page.getByRole('button', { name: '图片清晰度：1K' }).click();
  await expect(page.getByRole('menuitem', { name: '3K', exact: true })).toHaveCount(0);
  await page.getByRole('menuitem', { name: '4K', exact: true }).click();
  await page.getByRole('textbox', { name: '创作输入' }).fill('帮我生成 6 张极简东方庭院概念图');
  await page.getByRole('button', { name: '开始创作', exact: true }).click();
  await expect.poll(() => capturedPayload.value).not.toBeNull();
  const creationPayload = capturedPayload.value;
  if (creationPayload === null) {
    throw new Error('Expected the Agent turn creation payload to be captured.');
  }
  expect(creationPayload).toMatchObject({
    generation_preferences: {
      aspect_ratio: '3:4',
      output_kind: 'image',
      resolution_tier: '4k',
      schema_version: 2,
    },
    message: '帮我生成 6 张极简东方庭院概念图',
  });
  expect(creationPayload).not.toHaveProperty('output_count');
  expect(creationPayload.generation_preferences).not.toHaveProperty('output_count');
});

test('video Agent stays unavailable until a published video model exists', async ({ page }) => {
  await authenticateWithTestSession(page);
  await page.getByRole('button', { name: /选择创作 Agent：智能生图 Agent/ }).click();
  await expect(page.getByRole('menuitem', { name: /智能视频 Agent/ })).toHaveCount(0);
});

test('composer menus do not lock the page or shift the composer', async ({ page }) => {
  const composer = page.getByRole('textbox', { name: '创作输入' });
  const composerFrame = page.getByRole('region', { name: '创作输入' });
  const ratioTrigger = page.getByRole('button', { name: '图片比例：智能比例' });
  const composerLeft = await composer.evaluate((element) => element.getBoundingClientRect().left);
  const beforeStyle = await composerFrame.evaluate((element) => {
    const style = getComputedStyle(element);
    return { borderColor: style.borderColor, boxShadow: style.boxShadow };
  });
  const triggerShadow = await ratioTrigger.evaluate(
    (element) => getComputedStyle(element).boxShadow,
  );

  await ratioTrigger.click();
  await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');
  await expect
    .poll(() => composer.evaluate((element) => element.getBoundingClientRect().left))
    .toBe(composerLeft);
  const afterOpenStyle = await composerFrame.evaluate((element) => {
    const style = getComputedStyle(element);
    return { borderColor: style.borderColor, boxShadow: style.boxShadow };
  });
  expect(afterOpenStyle).toEqual(beforeStyle);

  await page.getByRole('menuitem', { name: '3:4' }).click();
  const selectedTrigger = page.getByRole('button', { name: '图片比例：3:4' });
  await expect
    .poll(() => selectedTrigger.evaluate((element) => getComputedStyle(element).boxShadow))
    .toBe(triggerShadow);
  const afterSelectStyle = await composerFrame.evaluate((element) => {
    const style = getComputedStyle(element);
    return { borderColor: style.borderColor, boxShadow: style.boxShadow };
  });
  expect(afterSelectStyle).toEqual(beforeStyle);

  await composer.focus();
  await page.keyboard.press('Tab');
  const agentTrigger = page.getByRole('button', { name: /选择创作 Agent：智能生图 Agent/ });
  await expect(agentTrigger).toBeFocused();
  expect(await agentTrigger.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe(
    'none',
  );
});

test('attachment dialog preserves the composer position while locking the page', async ({
  page,
}) => {
  const composer = page.locator('textarea[aria-label="创作输入"]');
  const composerLeft = await composer.evaluate((element) => element.getBoundingClientRect().left);

  await page.getByRole('button', { name: '添加附件' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');
  const dialogComposerLeft = await composer.evaluate(
    (element) => element.getBoundingClientRect().left,
  );
  expect(dialogComposerLeft).toBe(composerLeft);
});

test('attachment stack expands from thumbnails without moving the prompt', async ({ page }) => {
  await page.getByRole('button', { name: '添加附件' }).click();
  await page.getByRole('button', { name: /电影感时装大片/ }).click();
  await page.getByRole('button', { name: /潮流运动视觉/ }).click();
  await page.getByRole('button', { name: '加入本次输入' }).click();

  const stack = page.locator('.attachment-stack');
  const prompt = page.getByRole('textbox', { name: '创作输入' });
  const promptLeft = await prompt.evaluate((element) => element.getBoundingClientRect().left);

  await page.locator('.attachment-stack-add').hover();
  await expect(stack).not.toHaveClass(/is-expanded/);

  await page.locator('.attachment-stack-item').last().hover();
  await expect(stack).toHaveClass(/is-expanded/);
  await expect
    .poll(() => prompt.evaluate((element) => element.getBoundingClientRect().left))
    .toBe(promptLeft);

  const secondRemove = page.getByRole('button', { name: '移除潮流运动视觉' });
  await secondRemove.focus();
  await expect(page.locator('.attachment-remove').nth(0)).toHaveCSS('opacity', '0');
  await expect(page.locator('.attachment-remove').nth(1)).toHaveCSS('opacity', '1');
  await secondRemove.click();
  await expect(page.locator('.attachment-stack-item')).toHaveCount(1);
});

test('more than six attachments remain manageable from the stack', async ({ page }) => {
  await page.getByRole('button', { name: '添加附件' }).click();
  await page.locator('input[type="file"]').setInputFiles(
    ['附件六.png', '附件七.png', '附件八.png'].map((name) => ({
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
      mimeType: 'image/png',
      name,
    })),
  );
  for (const name of [
    '电影感时装大片',
    '潮流运动视觉',
    '现代家居氛围',
    '香氛广告视觉',
    '彩妆创意平铺',
  ]) {
    await page.getByRole('button', { name: new RegExp(name) }).click();
  }
  await page.getByRole('button', { name: '加入本次输入' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();

  await expect(page.locator('.attachment-stack')).toHaveAttribute('aria-label', '8 个附件');
  await page.getByRole('button', { name: '管理另外 2 个附件' }).click();
  await expect(page.getByText('已选 8/9')).toBeVisible();

  await page.getByRole('button', { name: /附件八/ }).click();
  await page.getByRole('button', { name: '加入本次输入' }).click();
  await expect(page.locator('.attachment-stack')).toHaveAttribute('aria-label', '7 个附件');
});

test('registration stays in the login overlay and verifies the invite flow', async ({ page }) => {
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '注册账号' }).click();
  await expect(page.getByRole('heading', { name: '创建内测账号' })).toBeVisible();
  await page.getByLabel('邮箱').fill('new@example.com');
  await page.getByLabel('密码', { exact: true }).fill('review123');
  await page.getByLabel('邀请码').fill('BETA2026');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '注册并发送验证码' }).click();
  await expect(page.getByRole('heading', { name: '验证你的邮箱' })).toBeVisible();
  await page.getByLabel('邮箱验证码').fill('123456');
  await page.getByRole('button', { name: '完成验证' }).click();
  await expect(page.getByText('登录成功，草稿已保留，请再次点击开始创作')).toBeVisible();
});

test('an invalid invite stays in registration without entering verification', async ({ page }) => {
  await mockAuthEndpoint(page, '/api/v1/auth/register', 403, {
    error: {
      code: 'REGISTRATION_NOT_ELIGIBLE',
      message: '当前无法完成注册，请检查邀请码和邮箱是否正确',
    },
  });

  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '注册账号' }).click();
  await page.getByLabel('邮箱').fill('new@example.com');
  await page.getByLabel('密码', { exact: true }).fill('review123');
  await page.getByLabel('邀请码').fill('INVALID');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '注册并发送验证码' }).click();

  await expect(page.getByText('当前无法完成注册，请检查邀请码和邮箱是否正确')).toBeVisible();
  await expect(page.getByRole('heading', { name: '创建内测账号' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '验证你的邮箱' })).toHaveCount(0);
  await expect(page).toHaveURL('/');
});

test('an unverified login cannot start generation', async ({ page }) => {
  await mockAuthEndpoint(page, '/api/v1/auth/login', 201, {
    access: {
      can_create: false,
      can_upload: false,
      can_charge: false,
      restriction_reason: 'email_verification_required',
    },
    user: {
      id: '00000000-0000-4000-8000-000000000002',
      email: 'pending@example.com',
      display_name: 'Pending user',
      email_verified: false,
    },
  });

  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByLabel('邮箱').fill('pending@example.com');
  await page.getByLabel('密码', { exact: true }).fill('review123');
  await page.getByRole('button', { name: '登录并继续' }).click();

  await expect(page.getByText('邮箱尚未验证，请在原注册会话中完成验证')).toBeVisible();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: '正在制作商品图' })).toHaveCount(0);

  await page.getByRole('button', { name: '关闭' }).click();
  await expect(page.getByRole('button', { name: '开始创作', exact: true })).toBeDisabled();
});

test('password reset returns to login without creating a session', async ({ page }) => {
  let submittedReset: Record<string, unknown> | undefined;
  await page.route('**/api/v1/auth/password-reset/confirm', async (route) => {
    submittedReset = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      body: JSON.stringify({ status: 'reset' }),
      contentType: 'application/json',
      headers: corsHeaders,
      status: 201,
    });
  });

  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '忘记密码？' }).click();
  await page.getByLabel('邮箱').fill('review@example.com');
  await page.getByRole('button', { name: '发送验证码' }).click();
  await expect(page.getByRole('heading', { name: '确认重置身份' })).toBeVisible();

  await page.getByLabel('邮箱验证码').fill('123456');
  await page.getByLabel('新密码').fill('new-password-123');
  await page.getByRole('button', { name: '完成验证' }).click();

  await expect(page.getByText('密码已重置，请使用新密码登录')).toBeVisible();
  await expect(page.getByRole('button', { name: '登录并继续' })).toBeVisible();
  expect(submittedReset).toEqual({
    email: 'review@example.com',
    code: '123456',
    new_password: 'new-password-123',
  });

  await page.getByRole('button', { name: '关闭' }).click();
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('authenticated users can open and restore previous sessions', async ({ page }) => {
  await authenticateWithTestSession(page);
  await page.goto(`/workspace/session/${agentMockIds.session}`);

  await expect(page.getByText('你')).toBeVisible();
  await expect(page.getByText('给我一个秋季上新海报方向')).toBeVisible();
  await expect(
    page.getByText('我会先整理视觉方向；正式生图将在图片执行管线启用后进行。'),
  ).toBeVisible();
});

for (const width of [1440, 390]) {
  test(`session navigation keeps list search, pages and scroll at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await authenticateWithTestSession(page);
    const sessions = Array.from({ length: 40 }, (_, index) => ({
      id: `11000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`,
      title: `会话 ${String(index + 1).padStart(2, '0')}`,
      revision: 1,
      last_message_preview: '',
      last_turn_id: null,
      last_turn_status: null,
      updated_at: '2026-10-10T00:00:00.000Z',
    }));
    let listRequests = 0;
    await page.route('**/api/v1/agent/sessions**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/v1/agent/sessions') {
        listRequests += 1;
        const secondPage = url.searchParams.get('cursor') === 'page-two';
        await route.fulfill({
          json: {
            data: {
              items: secondPage ? sessions.slice(20) : sessions.slice(0, 20),
              next_cursor: secondPage ? null : 'page-two',
            },
          },
          headers: corsHeaders,
        });
        return;
      }
      const session = sessions.find((item) => url.pathname.endsWith(`/${item.id}`));
      if (!session) return route.fallback();
      await route.fulfill({
        json: {
          data: {
            session: {
              ...session,
              primary_skill_slug: null,
              preset_selections: [],
              created_at: session.updated_at,
            },
            messages: [
              {
                id: `message-${session.id}`,
                role: 'user',
                content: `${session.title}的聊天内容`,
                attachments: [],
                turn_id: null,
                created_at: session.updated_at,
              },
            ],
            turns: [],
            active_turn_id: null,
            older_cursor: null,
          },
        },
        headers: corsHeaders,
      });
    });
    const first = sessions[0]!;
    const target = sessions[25]!;
    await page.goto(`/workspace/session/${first.id}`);
    await expect(page.getByText(`${first.title}的聊天内容`, { exact: true })).toBeVisible();
    if (width === 390) await page.getByRole('button', { name: first.title, exact: true }).click();
    const history =
      width === 390
        ? page.getByRole('dialog')
        : page.getByRole('complementary', { name: '会话栏' });
    const search = history.getByRole('textbox', { name: '搜索会话' });
    await expect(history.getByRole('button', { name: /^会话 \d+/ })).toHaveCount(20);
    await search.fill('会话');
    await expect.poll(() => listRequests).toBe(2);
    await expect(history.getByRole('button', { name: '加载更多', exact: true })).toBeEnabled();
    await history.getByRole('button', { name: '加载更多', exact: true }).click();
    await expect(history.getByRole('button', { name: /^会话 \d+/ })).toHaveCount(40);
    const expectedRequests = listRequests;
    const scrollArea = history.locator('div.overflow-y-auto');
    await history
      .getByRole('button', { name: `${target.title} 尚未发送内容`, exact: true })
      .scrollIntoViewIfNeeded();
    const scrollTop = await scrollArea.evaluate((element) => element.scrollTop);
    expect(scrollTop).toBeGreaterThan(0);
    await history
      .getByRole('button', { name: `${target.title} 尚未发送内容`, exact: true })
      .click();
    await expect(page).toHaveURL(`/workspace/session/${target.id}`);
    await expect(page.getByText(`${target.title}的聊天内容`, { exact: true })).toBeVisible();

    const verifyList = async (title: string | null) => {
      if (width === 390)
        await page.getByRole('button', { name: title ?? '新对话', exact: true }).click();
      await expect(search).toHaveValue('会话');
      await expect(history.getByRole('button', { name: /^会话 \d+/ })).toHaveCount(40);
      await expect.poll(() => scrollArea.evaluate((element) => element.scrollTop)).toBe(scrollTop);
      if (title)
        await expect(scrollArea.locator('button[aria-current="page"]')).toContainText(title);
      else await expect(scrollArea.locator('button[aria-current="page"]')).toHaveCount(0);
    };
    await verifyList(target.title);
    await history.evaluate((element) => element.setAttribute('data-navigation-marker', 'kept'));
    await expect(history).toHaveCSS('opacity', '1');
    await expect(history).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await page.screenshot({ path: testInfo.outputPath(`session-switch-${width}.png`) });
    if (width === 390) await history.getByRole('button', { name: '关闭', exact: true }).click();
    await page.goBack();
    await expect(page.getByText(`${first.title}的聊天内容`, { exact: true })).toBeVisible();
    await verifyList(first.title);
    if (width === 1440) await expect(history).toHaveAttribute('data-navigation-marker', 'kept');
    if (width === 390) await history.getByRole('button', { name: '关闭', exact: true }).click();
    await page.goForward();
    await expect(page.getByText(`${target.title}的聊天内容`, { exact: true })).toBeVisible();
    await verifyList(target.title);
    await history
      .getByRole('button', { name: width === 390 ? '新建会话' : '新对话', exact: true })
      .click();
    await expect(page).toHaveURL('/workspace/session/new');
    await expect(page.getByRole('heading', { name: '你好，想创作什么？' })).toBeVisible();
    await verifyList(null);
    await page.waitForTimeout(300);
    expect(listRequests).toBe(expectedRequests);
  });
}

for (const width of [1440, 390]) {
  test(`Brain failure reason is readable and survives reload at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 960 });
    await authenticateWithTestSession(page);
    await selectRequiredCreativeSkill(page);
    await page.getByRole('textbox', { name: '创作输入' }).fill('[brain-failure] 生成海报');
    await page.getByRole('button', { name: '开始创作', exact: true }).click();
    const failure = page.getByText(brainFailureSummary, { exact: true });
    await expect(failure).toBeVisible();
    await expect(page.getByRole('button', { name: /重新生成/ })).toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    expect(
      await failure.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return (
          box.left >= 0 &&
          box.right <= window.innerWidth &&
          element.scrollWidth <= element.clientWidth
        );
      }),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`brain-failure-${width}.png`),
      fullPage: true,
    });
    await page.reload();
    await expect(failure).toBeVisible();
    await expect(page.getByRole('button', { name: /重新生成/ })).toHaveCount(0);
  });

  test(`Markdown streams alongside visible progress and survives reload at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 960 });
    await authenticateWithTestSession(page);
    await selectRequiredCreativeSkill(page);
    await page.getByRole('textbox', { name: '创作输入' }).fill('[markdown] 先讨论海报方向');
    await page.getByRole('button', { name: '开始创作', exact: true }).click();
    const draft = page.getByLabel('实时回复草稿');
    await expect(draft.getByRole('heading', { name: '海报方向' })).toBeVisible();
    await expect(page.getByRole('region', { name: '创作过程', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: '创作过程', exact: true })).toContainText(
      '正在分析参考图片',
    );
    await page.screenshot({
      path: testInfo.outputPath(`markdown-stream-${width}.png`),
      fullPage: true,
    });
    await expect(draft).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByRole('table')).toBeVisible();
    await expect(page.getByRole('heading', { name: '海报方向' })).toHaveCount(1);
    await expect(
      page.getByText('我先查看照片中的人物与远山，再整理适合这张照片的海报方向。'),
    ).toBeVisible();
    await expect(page.getByText('创作助手', { exact: true })).toHaveCount(1);
    const commentary = page.getByText('我先查看照片中的人物与远山，再整理适合这张照片的海报方向。');
    const finalHeading = page.getByRole('heading', { name: '海报方向' });
    expect(
      await commentary.evaluate((element) => element.getBoundingClientRect().top),
    ).toBeLessThan(await finalHeading.evaluate((element) => element.getBoundingClientRect().top));
    const checkOverflow = async () => {
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    };
    await checkOverflow();
    await page.screenshot({
      path: testInfo.outputPath(`markdown-final-${width}.png`),
      fullPage: true,
    });
    await page.reload();
    await expect(page.getByRole('heading', { name: '海报方向' })).toHaveCount(1);
    await expect(
      page.getByText('我先查看照片中的人物与远山，再整理适合这张照片的海报方向。'),
    ).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible();
    await checkOverflow();
  });
}

test('the session sidebar new conversation action opens the empty session workspace', async ({
  page,
}) => {
  await authenticateWithTestSession(page);
  await page.goto(`/workspace/session/${agentMockIds.session}`);

  await page.getByRole('button', { name: '新对话' }).click();
  await expect(page).toHaveURL('/workspace/session/new');
  await expect(page.getByRole('heading', { name: '你好，想创作什么？' })).toBeVisible();
});

test('home creates a session and the creation navigation returns to home', async ({ page }) => {
  await authenticateWithTestSession(page);
  await selectRequiredCreativeSkill(page);

  await page.getByRole('textbox', { name: '创作输入' }).fill('一张安静的东方庭院概念图');
  await page.getByRole('button', { name: '开始创作', exact: true }).click();
  await expect(page).toHaveURL(`/workspace/session/${agentMockIds.session}`);
  await expect(
    page.locator('#main-content').getByText('一张安静的东方庭院概念图', { exact: true }),
  ).toBeVisible();

  const creationNavigation = page.getByRole('button', { name: '创作', exact: true }).first();
  await expect(creationNavigation).not.toHaveAttribute('aria-current', 'page');
  await creationNavigation.click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: '象塑', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '创作输入' })).toHaveValue('');
});

test('session sidebar renames and archives a conversation through server mutations', async ({
  page,
}) => {
  await authenticateWithTestSession(page);
  await page.goto(`/workspace/session/${agentMockIds.session}`);

  await page.getByRole('button', { name: '管理会话：秋季上新海报' }).click();
  await page.getByRole('menuitem', { name: '重命名' }).click();
  await page.getByRole('textbox', { name: '会话名称' }).fill('双十一主视觉');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('双十一主视觉', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '管理会话：双十一主视觉' }).click();
  await page.getByRole('menuitem', { name: '删除会话' }).click();
  await expect(page).toHaveURL('/workspace/session/new');
  await expect(page.getByText('暂无会话')).toBeVisible();
});

for (const width of [1440, 390]) {
  test(`selected session and search are styled consistently at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await authenticateWithTestSession(page);
    await page.goto(`/workspace/session/${agentMockIds.session}`);
    if (width === 390)
      await page.getByRole('button', { name: '秋季上新海报', exact: true }).click();
    const history =
      width === 390
        ? page.getByRole('dialog')
        : page.getByRole('complementary', { name: '会话栏' });
    const selected = history.locator('button[aria-current="page"]');
    await expect(selected).toHaveCount(1);
    await expect(selected).toContainText('秋季上新海报');
    expect(
      await selected.evaluate((button) => getComputedStyle(button.parentElement!).backgroundColor),
    ).toBe('rgb(232, 243, 241)');
    const search = history.getByRole('textbox', { name: '搜索会话' });
    await search.fill('秋季');
    await expect(search).toHaveValue('秋季');
    await expect(selected).toBeVisible();
    await expect(history).toHaveCSS('opacity', '1');
    await expect(history).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath(`xiangsu-session-selection-${width}.png`),
      fullPage: true,
      caret: 'initial',
    });
  });
}

test.describe('mobile session history', () => {
  test.use({ viewport: { height: 844, width: 390 } });

  test('opens the session drawer without covering its close and new-session actions', async ({
    page,
  }) => {
    await authenticateWithTestSession(page);
    await page.goto(`/workspace/session/${agentMockIds.session}`);

    await page.getByRole('button', { name: '秋季上新海报' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('heading', { name: '生成' })).toBeVisible();
    await page.getByRole('button', { name: '新建会话' }).click();
    await expect(page).toHaveURL('/workspace/session/new');
    await expect(page.getByRole('dialog')).toBeHidden();
  });
});

test.describe('touch attachment controls', () => {
  test.use({ hasTouch: true, viewport: { height: 844, width: 390 } });

  test('mobile users can see and remove an attachment', async ({ page }) => {
    await page.getByRole('button', { name: '添加附件' }).click();
    await page.getByRole('button', { name: /电影感时装大片/ }).click();
    await page.getByRole('button', { name: '加入本次输入' }).click();

    await page.locator('.attachment-stack-item').tap({ position: { x: 8, y: 24 } });
    const removeButton = page.getByRole('button', { name: '移除电影感时装大片' });
    await expect(removeButton).toHaveCSS('opacity', '1');
    await expect(page.getByRole('dialog', { name: '图片查看器' })).toHaveCount(0);
    await removeButton.tap();
    await expect(page.locator('.attachment-stack')).toHaveAttribute('aria-label', '暂无附件');
  });
});
