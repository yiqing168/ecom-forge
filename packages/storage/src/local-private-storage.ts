import { mkdir, open, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

export class StoragePathError extends Error {
  constructor() {
    super('STORAGE_KEY_INVALID');
    this.name = 'StoragePathError';
  }
}

function assertStorageKey(key: string): void {
  if (
    key.length === 0 ||
    key.length > 512 ||
    key.includes('\0') ||
    key.includes('\\') ||
    isAbsolute(key) ||
    key.split('/').some((segment) => segment === '' || segment === '.' || segment === '..') ||
    !/^[A-Za-z0-9._/-]+$/.test(key)
  ) {
    throw new StoragePathError();
  }
}

export class LocalPrivateStorage {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  async read(key: string): Promise<Buffer> {
    return readFile(await this.resolveExisting(key));
  }

  async size(key: string): Promise<number> {
    const info = await stat(await this.resolveExisting(key));
    if (!info.isFile()) throw new StoragePathError();
    return info.size;
  }

  async write(key: string, contents: Uint8Array): Promise<void> {
    const target = this.resolveTarget(key);
    await mkdir(dirname(target), { recursive: true });
    await this.assertCanonicalParent(target);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 });
    await rename(temporary, target);
  }

  async writeExclusive(key: string, contents: Uint8Array): Promise<void> {
    const target = this.resolveTarget(key);
    await mkdir(dirname(target), { recursive: true });
    await this.assertCanonicalParent(target);
    const handle = await open(target, 'wx', 0o600);
    try {
      await handle.writeFile(contents);
    } finally {
      await handle.close();
    }
  }

  async delete(key: string): Promise<void> {
    await unlink(await this.resolveExisting(key));
  }

  private resolveTarget(key: string): string {
    assertStorageKey(key);
    const target = resolve(this.root, ...key.split('/'));
    const pathFromRoot = relative(this.root, target);
    if (pathFromRoot === '' || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
      throw new StoragePathError();
    }
    return target;
  }

  private async resolveExisting(key: string): Promise<string> {
    const target = this.resolveTarget(key);
    const [canonicalRoot, canonicalTarget] = await Promise.all([
      realpath(this.root),
      realpath(target),
    ]);
    const pathFromRoot = relative(canonicalRoot, canonicalTarget);
    if (pathFromRoot === '' || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
      throw new StoragePathError();
    }
    return canonicalTarget;
  }

  private async assertCanonicalParent(target: string): Promise<void> {
    const [canonicalRoot, canonicalParent] = await Promise.all([
      realpath(this.root),
      realpath(dirname(target)),
    ]);
    const pathFromRoot = relative(canonicalRoot, canonicalParent);
    if (pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
      throw new StoragePathError();
    }
  }
}
