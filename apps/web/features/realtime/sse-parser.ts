import { createParser, type EventSourceMessage } from 'eventsource-parser';

export interface ParsedSseEvent {
  id: string | undefined;
  event: string | undefined;
  data: string;
}

export function createSseChunkParser(onEvent: (event: ParsedSseEvent) => void) {
  const parser = createParser({
    onEvent(event: EventSourceMessage) {
      onEvent({ id: event.id, event: event.event, data: event.data });
    },
  });
  const decoder = new TextDecoder();
  return {
    feed(chunk: Uint8Array): void {
      parser.feed(decoder.decode(chunk, { stream: true }));
    },
    finish(): void {
      const remainder = decoder.decode();
      if (remainder) parser.feed(remainder);
      parser.reset({ consume: true });
    },
  };
}
