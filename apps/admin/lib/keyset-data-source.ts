export interface KeysetPage<T> {
  items: T[];
  next_cursor: string | null;
}

export interface KeysetLoadInput {
  cursor?: string;
  filters: Record<string, unknown>;
  limit: number;
  sort: Record<string, unknown>;
}

export interface KeysetNavigation {
  canNext: boolean;
  canPrevious: boolean;
  page: number;
}

export class KeysetPaginationError extends Error {
  constructor() {
    super('KEYSET_CURSOR_LOOP');
    this.name = 'KeysetPaginationError';
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function canonicalTableState(value: Record<string, unknown>): string {
  return JSON.stringify(canonicalize(value));
}

export class KeysetRequestController<T> {
  readonly #limit: number;
  #cursors: (string | null)[] = [null];
  #filterKey = '';
  #pageIndex = 0;

  constructor(limit = 20) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError('keyset limit must be an integer between 1 and 100');
    }
    this.#limit = limit;
  }

  get navigation(): KeysetNavigation {
    return {
      canNext: typeof this.#cursors[this.#pageIndex + 1] === 'string',
      canPrevious: this.#pageIndex > 0,
      page: this.#pageIndex + 1,
    };
  }

  next(): boolean {
    if (!this.navigation.canNext) return false;
    this.#pageIndex += 1;
    return true;
  }

  previous(): boolean {
    if (!this.navigation.canPrevious) return false;
    this.#pageIndex -= 1;
    return true;
  }

  reset(): void {
    this.#cursors = [null];
    this.#filterKey = '';
    this.#pageIndex = 0;
  }

  async request(
    params: Record<string, unknown>,
    sort: Record<string, unknown>,
    filters: Record<string, unknown>,
    load: (input: KeysetLoadInput) => Promise<KeysetPage<T>>,
  ): Promise<{ data: T[]; success: true }> {
    const query = Object.fromEntries(
      Object.entries(params).filter(([key]) => key !== 'current' && key !== 'pageSize'),
    );
    const nextFilterKey = canonicalTableState({ filters, query, sort });
    if (this.#filterKey !== nextFilterKey) {
      this.#cursors = [null];
      this.#filterKey = nextFilterKey;
      this.#pageIndex = 0;
    }

    const cursor = this.#cursors[this.#pageIndex];
    const page = await load({
      ...(cursor ? { cursor } : {}),
      filters: { ...query, ...filters },
      limit: this.#limit,
      sort,
    });
    if (
      page.next_cursor !== null &&
      (page.items.length === 0 ||
        this.#cursors.slice(0, this.#pageIndex + 1).includes(page.next_cursor))
    ) {
      throw new KeysetPaginationError();
    }
    const knownNext = this.#cursors[this.#pageIndex + 1];
    if (page.next_cursor === null) {
      this.#cursors.splice(this.#pageIndex + 1);
    } else if (knownNext !== page.next_cursor) {
      this.#cursors.splice(this.#pageIndex + 1, Infinity, page.next_cursor);
    }
    return { data: page.items, success: true };
  }
}
