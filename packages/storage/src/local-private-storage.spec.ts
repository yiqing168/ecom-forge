import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { LocalPrivateStorage, StoragePathError } from './local-private-storage.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('LocalPrivateStorage', () => {
  it('writes and reads a private object', async () => {
    const root = await mkdtemp(join(tmpdir(), 's10-storage-'));
    roots.push(root);
    const storage = new LocalPrivateStorage(root);
    await storage.initialize();
    await storage.writeExclusive('objects/a/file.bin', Buffer.from('content'));
    await expect(storage.read('objects/a/file.bin')).resolves.toEqual(Buffer.from('content'));
  });

  it.each(['../secret', '/absolute', 'a\\b', 'a/../b', 'a\0b'])(
    'rejects unsafe key %s',
    async (key) => {
      const root = await mkdtemp(join(tmpdir(), 's10-storage-'));
      roots.push(root);
      const storage = new LocalPrivateStorage(root);
      await storage.initialize();
      await expect(storage.write(key, Buffer.from('x'))).rejects.toBeInstanceOf(StoragePathError);
    },
  );

  it('rejects a symlink that leaves the configured root', async () => {
    const root = await mkdtemp(join(tmpdir(), 's10-storage-'));
    const outside = await mkdtemp(join(tmpdir(), 's10-storage-outside-'));
    roots.push(root, outside);
    await mkdir(join(root, 'objects'), { recursive: true });
    await symlink(outside, join(root, 'objects', 'escape'), 'junction');
    const storage = new LocalPrivateStorage(root);
    await storage.initialize();
    await expect(storage.write('objects/escape/file.bin', Buffer.from('x'))).rejects.toBeInstanceOf(
      StoragePathError,
    );
  });
});
