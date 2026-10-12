import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

export interface QuarantineResourceReader {
  read(storageKey: string, maxBytes: number): Promise<Uint8Array>;
}

export class LocalQuarantineResourceReader implements QuarantineResourceReader {
  constructor(private readonly root: string) {}

  async read(storageKey: string, maxBytes: number): Promise<Uint8Array> {
    if (
      !storageKey ||
      isAbsolute(storageKey) ||
      storageKey.includes('\\') ||
      storageKey.split('/').includes('..')
    ) {
      throw new Error('SKILL_PACKAGE_STORAGE_KEY_INVALID');
    }
    const root = await realpath(resolve(this.root));
    const candidate = resolve(root, storageKey);
    const lexicalRelative = relative(root, candidate);
    if (lexicalRelative.startsWith('..') || isAbsolute(lexicalRelative)) {
      throw new Error('SKILL_PACKAGE_STORAGE_KEY_INVALID');
    }
    const metadata = await lstat(candidate);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size <= 0 ||
      metadata.size > maxBytes
    ) {
      throw new Error('SKILL_PACKAGE_RESOURCE_SIZE_INVALID');
    }
    const actual = await realpath(candidate);
    const actualRelative = relative(root, actual);
    if (actualRelative.startsWith('..') || isAbsolute(actualRelative)) {
      throw new Error('SKILL_PACKAGE_STORAGE_KEY_INVALID');
    }
    const content = await readFile(actual);
    if (content.byteLength !== metadata.size)
      throw new Error('SKILL_PACKAGE_RESOURCE_SIZE_INVALID');
    return content;
  }
}

export class MemoryQuarantineResourceReader implements QuarantineResourceReader {
  constructor(private readonly resources: ReadonlyMap<string, Uint8Array>) {}

  read(storageKey: string, maxBytes: number): Promise<Uint8Array> {
    const content = this.resources.get(storageKey);
    if (!content || content.byteLength === 0 || content.byteLength > maxBytes) {
      return Promise.reject(new Error('SKILL_PACKAGE_RESOURCE_SIZE_INVALID'));
    }
    return Promise.resolve(content);
  }
}
