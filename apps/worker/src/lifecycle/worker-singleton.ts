import type { Redis } from 'ioredis';

const RENEW_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('expire', KEYS[1], ARGV[2])
end
return 0
`;

const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;

export class WorkerSingletonAlreadyRunningError extends Error {
  constructor() {
    super('A queue worker is already running for this Redis namespace');
    this.name = 'WorkerSingletonAlreadyRunningError';
  }
}

export class WorkerSingletonLeaseLostError extends Error {
  constructor(options?: ErrorOptions) {
    super('The queue worker singleton lease could not be renewed', options);
    this.name = 'WorkerSingletonLeaseLostError';
  }
}

export class WorkerSingleton {
  private readonly key: string;

  constructor(
    private readonly redis: Redis,
    redisPrefix: string,
    private readonly owner: string,
    private readonly ttlSeconds: number,
  ) {
    this.key = `${redisPrefix}:worker:singleton:v1`;
  }

  async acquire(): Promise<boolean> {
    const result = await this.redis.set(this.key, this.owner, 'EX', this.ttlSeconds, 'NX');
    return result === 'OK';
  }

  async renew(): Promise<boolean> {
    const result = await this.redis.eval(RENEW_SCRIPT, 1, this.key, this.owner, this.ttlSeconds);
    return Number(result) === 1;
  }

  async assertRenewed(): Promise<void> {
    try {
      if (await this.renew()) return;
    } catch (cause) {
      throw new WorkerSingletonLeaseLostError({ cause });
    }
    throw new WorkerSingletonLeaseLostError();
  }

  async release(): Promise<boolean> {
    const result = await this.redis.eval(RELEASE_SCRIPT, 1, this.key, this.owner);
    return Number(result) === 1;
  }
}
