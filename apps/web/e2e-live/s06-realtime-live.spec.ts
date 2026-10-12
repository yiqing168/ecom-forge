import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const tsxPath = resolve(repoRoot, 'node_modules/tsx/dist/cli.mjs');
const authFixturePath = resolve(repoRoot, 'apps/api/test/real-auth.fixture.ts');
const realtimeFixturePath = resolve(repoRoot, 'apps/api/test/s06-live.fixture.ts');

function fixture<T>(path: string, action: string, input?: unknown): T {
  const result = spawnSync(process.execPath, [tsxPath, path, action], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
    input: input === undefined ? undefined : JSON.stringify(input),
  });
  if (result.status !== 0) {
    throw new Error(`Live fixture ${action} failed: ${result.stderr || result.stdout}`);
  }
  const output = result.stdout.trim().split(/\r?\n/).at(-1);
  if (!output) throw new Error(`Live fixture ${action} returned no result`);
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

test('real browser recovers workflow state across SSE updates, refresh, and offline time', async ({
  context,
  page,
}) => {
  const invite = fixture<{ inviteCode: string; inviteId: string }>(authFixturePath, 'create');
  const email = `s06-live-${randomUUID()}@example.com`;
  const password = 's06-live-password-123';
  let workflow: { workflowRunId: string; taskId: string } | undefined;

  try {
    await page.goto('/health');
    const registration = await page.evaluate(
      async ({ emailAddress, inviteCode, userPassword }) => {
        const response = await fetch('/api/v1/auth/register', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/json',
            'Idempotency-Key': `s06-live-register-${crypto.randomUUID()}`,
          },
          body: JSON.stringify({
            email: emailAddress,
            password: userPassword,
            display_name: 'S06 Live User',
            invite_code: inviteCode,
            agreement_version: '2026-08-09',
          }),
        });
        const body: unknown = await response.json();
        return { status: response.status, body };
      },
      { emailAddress: email, inviteCode: invite.inviteCode, userPassword: password },
    );
    expect(registration.status).toBe(201);
    const ticket = (registration.body as { verification_ticket?: unknown }).verification_ticket;
    expect(ticket).toEqual(expect.any(String));

    await expect.poll(() => consoleOtp('email_verification')).toMatch(/^\d{6}$/);
    const otp = await consoleOtp('email_verification');
    if (!otp || typeof ticket !== 'string') throw new Error('Registration OTP was not captured');
    const verificationStatus = await page.evaluate(
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
    );
    expect(verificationStatus).toBe(201);

    const createdWorkflow = fixture<{ workflowRunId: string; taskId: string }>(
      realtimeFixturePath,
      'create',
      { email },
    );
    workflow = createdWorkflow;
    await page.goto(
      `/test-support/s06-realtime?workflow_run_id=${encodeURIComponent(createdWorkflow.workflowRunId)}`,
    );
    await expect(page.getByTestId('hydration-status')).toHaveText('hydrated');
    await expect(page.getByTestId('workflow-status')).toHaveText('queued');
    await expect(page.getByTestId(`task-status-${createdWorkflow.taskId}`)).toHaveText('queued');
    await expect(page.getByTestId('last-event-seq')).toHaveText('1');
    await expect(page.getByTestId('connection-status')).toHaveText(/live|recovered/);

    fixture(realtimeFixturePath, 'advance', {
      email,
      workflowRunId: createdWorkflow.workflowRunId,
      taskId: createdWorkflow.taskId,
      target: 'running',
    });
    await expect(page.getByTestId('workflow-status')).toHaveText('running');
    await expect(page.getByTestId(`task-status-${createdWorkflow.taskId}`)).toHaveText('running');
    await expect(page.getByTestId('last-event-seq')).toHaveText('3');

    await page.reload();
    await expect(page.getByTestId('workflow-status')).toHaveText('running');
    await expect(page.getByTestId('last-event-seq')).toHaveText('3');
    await expect(page.locator('[data-task-id]')).toHaveCount(1);

    await context.setOffline(true);
    await expect(page.getByTestId('connection-status')).toHaveText(/reconnecting|polling/);
    fixture(realtimeFixturePath, 'advance', {
      email,
      workflowRunId: createdWorkflow.workflowRunId,
      taskId: createdWorkflow.taskId,
      target: 'succeeded',
    });
    await context.setOffline(false);

    await expect(page.getByTestId('workflow-status')).toHaveText('succeeded');
    await expect(page.getByTestId(`task-status-${createdWorkflow.taskId}`)).toHaveText('succeeded');
    await expect(page.getByTestId('last-event-seq')).toHaveText('5');
    await expect(page.getByTestId('connection-status')).toHaveText(/live|recovered/);
    await expect(page.locator('[data-task-id]')).toHaveCount(1);
  } finally {
    await context.setOffline(false).catch(() => undefined);
    if (workflow) {
      fixture(realtimeFixturePath, 'cleanup', {
        email,
        workflowRunId: workflow.workflowRunId,
        taskId: workflow.taskId,
      });
    }
    fixture(authFixturePath, 'cleanup', { email, inviteId: invite.inviteId });
  }
});
