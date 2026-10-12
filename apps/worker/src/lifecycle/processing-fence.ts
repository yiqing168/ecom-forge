export class WorkerWriteFence {
  private writesAllowed = true;
  private readonly abortController = new AbortController();

  disableWrites(): void {
    this.writesAllowed = false;
    this.abortController.abort(new Error('Worker write fence is closed'));
  }

  isWriteAllowed(): boolean {
    return this.writesAllowed;
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  assertWritesAllowed(): void {
    if (!this.writesAllowed) {
      throw new Error('Worker write fence is closed');
    }
  }
}

export class ActiveWorkTracker {
  private active = 0;
  private readonly waiters = new Set<() => void>();

  get activeCount(): number {
    return this.active;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    this.active += 1;
    try {
      return await work();
    } finally {
      this.active -= 1;
      if (this.active === 0) {
        for (const resolve of this.waiters) resolve();
        this.waiters.clear();
      }
    }
  }

  waitForIdle(): Promise<void> {
    if (this.active === 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.add(resolve));
  }
}
