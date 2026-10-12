import { describe, expect, it } from 'vitest';

import { createSseChunkParser } from './sse-parser';

describe('SSE chunk parser', () => {
  it('handles UTF-8 and frame fields split across arbitrary chunks', () => {
    const events: Array<{
      id: string | undefined;
      event: string | undefined;
      data: string;
    }> = [];
    const parser = createSseChunkParser((event) => events.push(event));
    const encoded = new TextEncoder().encode(
      'id: 2\nevent: task.status_changed\ndata: {"message":"处理中"}\n\n',
    );
    parser.feed(encoded.slice(0, 7));
    parser.feed(encoded.slice(7, 29));
    parser.feed(encoded.slice(29));
    parser.finish();
    expect(events).toEqual([
      { id: '2', event: 'task.status_changed', data: '{"message":"处理中"}' },
    ]);
  });
});
