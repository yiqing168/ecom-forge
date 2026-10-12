import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

import { createAgentApiMock } from './agent-api.mock';

const catalog = JSON.parse(
  readFileSync(new URL('../public/showcase/catalog.json', import.meta.url), 'utf8'),
) as {
  name: string;
  skillSlug: string;
  prompt: string;
  images: { title: string; src: string }[];
}[];
const firstGroup = catalog[0]!;
const first = firstGroup.images[0]!;

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
]) {
  test(`real static showcase previews stay bounded at ${viewport.width}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const mockAgent = createAgentApiMock();
    const calls: string[] = [];
    await page.route('**/api/v1/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      calls.push(`${request.method()} ${url.pathname}`);
      if (url.pathname === '/api/v1/me') {
        await route.fulfill({
          status: 401,
          json: { error: { code: 'AUTH_SESSION_REQUIRED', message: '未登录' } },
        });
      } else if (!(await mockAgent(route))) {
        await route.fulfill({
          status: 404,
          json: { error: { code: 'NOT_FOUND', message: 'Not found' } },
        });
      }
    });
    await page.goto('/');
    const section = page.getByRole('region', { name: '创作精选' });
    await section.scrollIntoViewIfNeeded();
    await expect(section.getByRole('img')).toHaveCount(4);
    await expect
      .poll(() =>
        section
          .getByRole('img')
          .evaluateAll((images) =>
            images.every(
              (image) =>
                image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
            ),
          ),
      )
      .toBe(true);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath('showcase-home.png'), fullPage: true });

    const trigger = section.getByRole('button', { name: `预览${first.title}：${firstGroup.name}` });
    await trigger.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.evaluate((element) =>
      Promise.all(element.getAnimations().map((animation) => animation.finished)),
    );
    await expect
      .poll(async () => {
        const src = await dialog.getByRole('img').getAttribute('src');
        return src ? new URL(src, page.url()).pathname : null;
      })
      .toBe(first.src);
    await expect
      .poll(() =>
        dialog
          .getByRole('img')
          .evaluate(
            (image) =>
              image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
          ),
      )
      .toBe(true);
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(15);
    expect(bounds!.y).toBeGreaterThanOrEqual(15);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width - 15);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height - 15);
    await expect(dialog.getByRole('button', { name: '使用此 Skill' })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('showcase-preview.png') });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await section.getByRole('button', { name: '换一批' }).click();
    await expect(
      section.getByRole('button', { name: `预览${first.title}：${firstGroup.name}` }),
    ).toHaveCount(0);
    expect(calls.every((call) => call.startsWith('GET '))).toBe(true);
    expect(calls.some((call) => /artifacts|access-url/.test(call))).toBe(false);
  });
}

test('a featured Skill selects the current catalog version without starting generation', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const mockAgent = createAgentApiMock();
  const methods: string[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    methods.push(request.method());
    if (pathname === '/api/v1/me') {
      await route.fulfill({
        json: {
          access: {
            can_create: true,
            can_upload: true,
            can_charge: true,
            restriction_reason: null,
          },
          user: {
            id: '00000000-0000-4000-8000-000000000001',
            email: 'showcase@example.com',
            display_name: 'Showcase tester',
            email_verified: true,
          },
        },
      });
    } else if (pathname === '/api/v1/skills') {
      await route.fulfill({
        json: {
          data: {
            catalog_version: 'showcase-test',
            response_version: '1',
            generation_policy: { schema_version: 2, policy_version: 'showcase-test' },
            items: [
              {
                primary_skill_id: `${firstGroup.skillSlug}@9.0.0`,
                slug: firstGroup.skillSlug,
                version: '9.0.0',
                name: firstGroup.name,
                description: 'Test catalog entry',
                domain: 'creative',
                category: 'creative',
                required_inputs: ['authorized-scene-photo'],
                preset_slots: [],
              },
            ],
          },
        },
      });
    } else if (!(await mockAgent(route))) {
      await route.fulfill({ status: 200, json: {} });
    }
  });
  await page.goto('/');
  const input = page.getByRole('textbox', { name: '创作输入' });
  await input.fill('My original draft');
  await page.getByRole('button', { name: `预览${first.title}：${firstGroup.name}` }).click();
  const select = page.getByRole('dialog').getByRole('button', { name: '使用此 Skill' });
  await expect(select).toBeVisible();
  expect(await page.locator('textarea').inputValue()).toBe('My original draft');
  await select.click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(input).toHaveValue(firstGroup.prompt);
  await expect(page.getByRole('button', { name: `选择 Skill：${firstGroup.name}` })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        (skillId) =>
          Object.keys(localStorage).some((key) =>
            (localStorage.getItem(key) ?? '').includes(skillId),
          ),
        `${firstGroup.skillSlug}@9.0.0`,
      ),
    )
    .toBe(true);
  expect(methods.every((method) => method === 'GET')).toBe(true);
});
