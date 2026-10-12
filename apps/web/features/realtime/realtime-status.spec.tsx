import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { RealtimeStatus } from './realtime-status';

describe('RealtimeStatus', () => {
  it('announces recovery without showing a redundant live label', () => {
    const { rerender } = render(<RealtimeStatus status="reconnecting" />);
    expect(screen.getByRole('status').textContent).toBe('正在恢复实时进度');
    rerender(<RealtimeStatus status="recovered" />);
    expect(screen.getByRole('status').textContent).toBe('实时进度已恢复');
    rerender(<RealtimeStatus status="live" />);
    expect(screen.queryByRole('status')).toBeNull();
  });
});
