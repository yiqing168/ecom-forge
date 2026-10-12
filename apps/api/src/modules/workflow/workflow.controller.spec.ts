import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { WorkflowController } from './workflow.controller.js';

const userId = '00000000-0000-4000-8000-000000000001';
const runId = '00000000-0000-4000-8000-000000000002';

function fixture(session = true) {
  const authentication = {
    currentSession: vi.fn().mockResolvedValue(
      session
        ? {
            user: { id: userId },
            headers: new Headers(),
          }
        : null,
    ),
  };
  const queries = {
    getWorkflowSnapshot: vi.fn(),
    listTasks: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
  };
  const retries = { retryFailedImage: vi.fn() };
  const controller = new WorkflowController(
    authentication as never,
    queries as never,
    retries as never,
  );
  const request = { headers: {}, socket: {} };
  const response = { append: vi.fn(), status: vi.fn() };
  return { controller, authentication, queries, retries, request, response };
}

describe('WorkflowController', () => {
  it('treats the failed-slot click as authorization for one direct image retry', async () => {
    const state = fixture();
    const taskId = '00000000-0000-4000-8000-000000000003';
    state.retries.retryFailedImage.mockResolvedValue({
      workflow_run_id: '00000000-0000-4000-8000-000000000004',
      task_id: '00000000-0000-4000-8000-000000000005',
      status: 'queued',
      replayed: false,
    });

    const result = await state.controller.retryFailedImage(
      runId,
      'image-retry-request-1',
      { task_id: taskId },
      state.request,
      state.response,
    );
    expect(result.data.status).toBe('queued');
    expect(result.data.replayed).toBe(false);
    expect(state.retries.retryFailedImage).toHaveBeenCalledWith({
      userId,
      workflowRunId: runId,
      taskId,
      idempotencyKey: 'image-retry-request-1',
    });
  });

  it('requires an authenticated session for task queries', async () => {
    const state = fixture(false);

    await expect(
      state.controller.getTasks({}, state.request, state.response),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(state.queries.listTasks).not.toHaveBeenCalled();
  });

  it('compares offset date filters by instant instead of their source text', async () => {
    const state = fixture();

    await expect(
      state.controller.getTasks(
        {
          from: '2026-08-10T02:00:00-08:00',
          to: '2026-08-10T09:00:00Z',
        },
        state.request,
        state.response,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(state.authentication.currentSession).not.toHaveBeenCalled();
  });

  it('maps malformed and cross-filter cursors to REQUEST_INVALID', async () => {
    const state = fixture();
    state.queries.listTasks.mockRejectedValue(new Error('Task cursor is invalid'));

    await expect(
      state.controller.getTasks({ cursor: 'malformed' }, state.request, state.response),
    ).rejects.toMatchObject({ response: { error: { code: 'REQUEST_INVALID' } } });
  });

  it('passes only validated filters and the session user to the query service', async () => {
    const state = fixture();

    await expect(
      state.controller.getTasks(
        { status: 'running', source: 'chat', limit: '25' },
        state.request,
        state.response,
      ),
    ).resolves.toEqual({ items: [], next_cursor: null });
    expect(state.queries.listTasks).toHaveBeenCalledWith({
      userId,
      filters: { status: 'running', source: 'chat' },
      limit: 25,
    });
  });

  it('returns the same 404 for an absent or inaccessible workflow', async () => {
    const state = fixture();
    state.queries.getWorkflowSnapshot.mockResolvedValue(null);

    await expect(
      state.controller.getWorkflow(runId, state.request, state.response),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(state.queries.getWorkflowSnapshot).toHaveBeenCalledWith(userId, runId);
  });
});
