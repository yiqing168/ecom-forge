export class SseConnectionLimitError extends Error {
  constructor() {
    super('SSE connection limit exceeded');
    this.name = 'SseConnectionLimitError';
  }
}

export class SseConnectionRegistry {
  private total = 0;
  private readonly byUser = new Map<string, number>();

  constructor(
    private readonly maxConnections: number,
    private readonly maxConnectionsPerUser: number,
  ) {}

  acquire(userId: string): () => void {
    const userConnections = this.byUser.get(userId) ?? 0;
    if (this.total >= this.maxConnections || userConnections >= this.maxConnectionsPerUser) {
      throw new SseConnectionLimitError();
    }
    this.total += 1;
    this.byUser.set(userId, userConnections + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total -= 1;
      const current = this.byUser.get(userId) ?? 1;
      if (current <= 1) this.byUser.delete(userId);
      else this.byUser.set(userId, current - 1);
    };
  }

  active(): number {
    return this.total;
  }
}
