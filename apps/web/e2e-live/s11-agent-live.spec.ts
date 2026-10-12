import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const tsxPath = resolve(repoRoot, 'node_modules/tsx/dist/cli.mjs');
const fixturePath = resolve(repoRoot, 'apps/api/test/s11-live.fixture.ts');
const apiOrigin = 'http://127.0.0.1:3101';

type FixtureResult = {
  user_cookie: string;
  user_email: string;
  primary_skill_id: string;
  preset_id: string;
  brain_catalog_entry_id: string;
  image_catalog_entry_id: string;
  catalog_revision: number;
};

function fixture<T>(action: 'setup' | 'cleanup', input: unknown = {}): T {
  const result = spawnSync(process.execPath, [tsxPath, fixturePath, action], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
    input: JSON.stringify(input),
  });
  if (result.status !== 0) {
    throw new Error(`S11 live fixture ${action} failed: ${result.stderr || result.stdout}`);
  }
  const output = result.stdout.trim().split(/\r?\n/).at(-1);
  if (!output) throw new Error(`S11 live fixture ${action} returned no result`);
  return JSON.parse(output) as T;
}

async function installCookie(context: BrowserContext, header: string): Promise<void> {
  const cookies = header.split(';').map((entry) => {
    const separator = entry.indexOf('=');
    if (separator < 1) throw new Error('S11 live fixture returned an invalid cookie');
    return {
      name: entry.slice(0, separator),
      value: entry.slice(separator + 1),
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
      sameSite: 'Lax' as const,
    };
  });
  await context.addCookies(cookies);
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
}

test('real workbench restores one completed turn across desktop and mobile', async ({
  context,
  page,
}, testInfo) => {
  let turnCreateRequests = 0;
  let eventConnections = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/agent/turns') {
      turnCreateRequests += 1;
    }
    if (new URL(request.url()).pathname === '/api/v1/events') eventConnections += 1;
  });

  try {
    const live = fixture<FixtureResult>('setup');
    await installCookie(context, live.user_cookie);
    await page.goto('/workspace/session/new', { waitUntil: 'domcontentloaded' });

    const [skillsResponse, brainResponse, imageResponse] = await Promise.all([
      context.request.get(`${apiOrigin}/api/v1/skills`),
      context.request.get(`${apiOrigin}/api/v1/model-catalog?category=brain`),
      context.request.get(`${apiOrigin}/api/v1/model-catalog?category=image`),
    ]);
    expect(skillsResponse.ok()).toBe(true);
    expect(brainResponse.ok()).toBe(true);
    expect(imageResponse.ok()).toBe(true);
    const skills = (await skillsResponse.json()) as {
      data: { items: Array<{ primary_skill_id: string }> };
    };
    const brain = (await brainResponse.json()) as {
      catalog_revision: number;
      items: Array<{ id: string }>;
    };
    const image = (await imageResponse.json()) as {
      catalog_revision: number;
      items: Array<{ id: string }>;
    };
    expect(skills.data.items.some((item) => item.primary_skill_id === live.primary_skill_id)).toBe(
      true,
    );
    expect(brain.catalog_revision).toBe(live.catalog_revision);
    expect(brain.items.some((item) => item.id === live.brain_catalog_entry_id)).toBe(true);
    expect(image.catalog_revision).toBe(live.catalog_revision);
    expect(image.items.some((item) => item.id === live.image_catalog_entry_id)).toBe(true);

    const skillTrigger = page.getByRole('button', { name: /选择 Skill/ });
    await expect(skillTrigger).toBeVisible();
    await expect(page.getByRole('button', { name: /S11 Live Image/ })).toBeVisible();
    await skillTrigger.click();
    await page.getByRole('menuitem', { name: 'S11 Live Creative' }).click();
    await page.getByRole('button', { name: /选择风格/ }).click();
    await page.getByRole('menuitem', { name: /S11 Live Style/ }).click();

    const prompt = `S11 live creative request ${testInfo.project.name}`;
    const promptInput = page.getByRole('textbox', { name: '创作输入' });
    const submitButton = page.getByRole('button', { name: '开始创作', exact: true });
    await promptInput.fill(prompt);
    await expect(promptInput).toHaveValue(prompt);
    await expect(submitButton).toBeEnabled();
    const createResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/v1/agent/turns',
    );
    await submitButton.click();
    const createResponse = await createResponsePromise;
    expect(createResponse.status()).toBe(201);
    const created = (await createResponse.json()) as {
      data: { session_id: string; turn_id: string };
    };
    await expect(page).toHaveURL(`/workspace/session/${created.data.session_id}`);
    await expect(page.locator('#main-content').getByText(prompt, { exact: true })).toBeVisible();

    await expect
      .poll(
        async () => {
          const response = await context.request.get(
            `${apiOrigin}/api/v1/agent/sessions/${created.data.session_id}`,
          );
          if (!response.ok()) return null;
          const payload = (await response.json()) as {
            data: {
              turns: Array<{
                id: string;
                user_status: string;
                skill_selection: { primary_skill_id: string } | null;
                model_selection: {
                  catalog_revision: number;
                  brain: { catalog_entry_id: string };
                  image?: { catalog_entry_id: string };
                } | null;
                execution_authorization: { kind: string } | null;
              }>;
            };
          };
          return payload.data.turns.find((turn) => turn.id === created.data.turn_id) ?? null;
        },
        { timeout: 30_000 },
      )
      .toMatchObject({
        user_status: 'completed',
        skill_selection: { primary_skill_id: live.primary_skill_id },
        model_selection: {
          catalog_revision: live.catalog_revision,
          brain: { catalog_entry_id: live.brain_catalog_entry_id },
          image: { catalog_entry_id: live.image_catalog_entry_id },
        },
        execution_authorization: { kind: 'generate_action' },
      });

    const selectedSkillTrigger = page.getByRole('button', {
      name: /选择 Skill.*S11 Live Creative/,
    });
    await expect(selectedSkillTrigger).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => eventConnections, { timeout: 15_000 }).toBeGreaterThan(0);
    expect(turnCreateRequests).toBe(1);
    await assertNoHorizontalOverflow(page);
    await page.screenshot({
      fullPage: true,
      path: testInfo.outputPath(`s11-${testInfo.project.name}.png`),
    });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#main-content').getByText(prompt, { exact: true })).toBeVisible();
    await expect(selectedSkillTrigger).toBeVisible();
    expect(turnCreateRequests).toBe(1);
    await assertNoHorizontalOverflow(page);
  } finally {
    fixture('cleanup');
  }
});
