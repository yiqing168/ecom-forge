import { describe, expect, it, vi } from 'vitest';

import {
  canonicalTableState,
  KeysetPaginationError,
  KeysetRequestController,
} from './keyset-data-source';

describe('KeysetRequestController', () => {
  it('uses cursor and limit without forwarding page-number parameters', async () => {
    const controller = new KeysetRequestController<{ id: string }>(20);
    const load = vi
      .fn()
      .mockResolvedValueOnce({ items: [{ id: 'first' }], next_cursor: 'cursor-2' })
      .mockResolvedValueOnce({ items: [{ id: 'second' }], next_cursor: null });

    await controller.request(
      { current: 9, pageSize: 20, status: 'active' },
      { created_at: 'descend' },
      {},
      load,
    );
    expect(controller.navigation).toEqual({ canNext: true, canPrevious: false, page: 1 });
    expect(controller.next()).toBe(true);
    await controller.request(
      { current: 2, pageSize: 20, status: 'active' },
      { created_at: 'descend' },
      {},
      load,
    );

    expect(load).toHaveBeenNthCalledWith(1, {
      filters: { status: 'active' },
      limit: 20,
      sort: { created_at: 'descend' },
    });
    expect(load).toHaveBeenNthCalledWith(2, {
      cursor: 'cursor-2',
      filters: { status: 'active' },
      limit: 20,
      sort: { created_at: 'descend' },
    });
    expect(controller.navigation).toEqual({ canNext: false, canPrevious: true, page: 2 });
  });

  it('resets the cursor chain when filters change', async () => {
    const controller = new KeysetRequestController<{ id: string }>();
    const load = vi
      .fn()
      .mockResolvedValueOnce({ items: [{ id: 'active' }], next_cursor: 'cursor-2' })
      .mockResolvedValueOnce({ items: [{ id: 'disabled' }], next_cursor: null });

    await controller.request({ status: 'active' }, {}, {}, load);
    controller.next();
    await controller.request({ status: 'disabled' }, {}, {}, load);

    expect(load).toHaveBeenLastCalledWith({
      filters: { status: 'disabled' },
      limit: 20,
      sort: {},
    });
    expect(controller.navigation.page).toBe(1);
  });

  it('supports previous-page navigation without requesting an offset', async () => {
    const controller = new KeysetRequestController<{ id: string }>();
    const load = vi
      .fn()
      .mockResolvedValueOnce({ items: [{ id: 'first' }], next_cursor: 'cursor-2' })
      .mockResolvedValueOnce({ items: [{ id: 'second' }], next_cursor: null })
      .mockResolvedValueOnce({ items: [{ id: 'first' }], next_cursor: 'cursor-2' });

    await controller.request({}, {}, {}, load);
    controller.next();
    await controller.request({}, {}, {}, load);
    expect(controller.previous()).toBe(true);
    await controller.request({}, {}, {}, load);

    expect(load).toHaveBeenLastCalledWith({ filters: {}, limit: 20, sort: {} });
    expect(controller.navigation).toEqual({ canNext: true, canPrevious: false, page: 1 });
  });

  it('fails closed when a page repeats an earlier cursor', async () => {
    const controller = new KeysetRequestController<{ id: string }>();
    await controller.request({}, {}, {}, () =>
      Promise.resolve({ items: [{ id: 'first' }], next_cursor: 'cursor-2' }),
    );
    controller.next();

    await expect(
      controller.request({}, {}, {}, () =>
        Promise.resolve({ items: [{ id: 'second' }], next_cursor: 'cursor-2' }),
      ),
    ).rejects.toBeInstanceOf(KeysetPaginationError);
  });

  it('fails closed when an empty page claims another cursor', async () => {
    const controller = new KeysetRequestController<{ id: string }>();
    await expect(
      controller.request({}, {}, {}, () => Promise.resolve({ items: [], next_cursor: 'cursor-2' })),
    ).rejects.toBeInstanceOf(KeysetPaginationError);
  });

  it('canonicalizes equivalent filter objects to the same key', () => {
    expect(canonicalTableState({ b: 2, a: { d: 4, c: 3 } })).toBe(
      canonicalTableState({ a: { c: 3, d: 4 }, b: 2 }),
    );
  });

  it('rejects limits outside the API contract', () => {
    expect(() => new KeysetRequestController(0)).toThrow(RangeError);
    expect(() => new KeysetRequestController(101)).toThrow(RangeError);
  });
});
