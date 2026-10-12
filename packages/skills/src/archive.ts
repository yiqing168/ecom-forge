import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import yauzl, { type Entry, type ZipFile } from 'yauzl';

import {
  type SkillPackageContentResource,
  type SkillPackageContentValidation,
  validateSkillPackageContents,
} from './content-validator.js';
import { parseSkillPackageManifest, type SkillPackageManifest } from './package.js';

export const SKILL_PACKAGE_ARCHIVE_LIMITS = {
  compressedBytes: 32 * 1024 * 1024,
  uncompressedBytes: 128 * 1024 * 1024,
  entryCount: 256,
  textBytes: 1024 * 1024,
  imageBytes: 16 * 1024 * 1024,
  timeoutMs: 10_000,
} as const;

export interface IsolatedSkillPackage {
  archiveSha256: string;
  manifest: SkillPackageManifest;
  resources: SkillPackageContentResource[];
  validation: SkillPackageContentValidation;
}

function archiveError(code: string): never {
  throw new Error(code);
}

function assertArchivePath(path: string): void {
  if (
    path !== path.normalize('NFC') ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path) ||
    path.split('/').includes('..') ||
    !path.startsWith('skill-package/')
  ) {
    archiveError('SKILL_PACKAGE_ARCHIVE_PATH_INVALID');
  }
}

function assertRegularEntry(entry: Entry): void {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const fileType = unixMode & 0xf000;
  if (fileType !== 0 && fileType !== 0x8000 && fileType !== 0x4000) {
    archiveError('SKILL_PACKAGE_ARCHIVE_LINK_FORBIDDEN');
  }
}

function openArchive(buffer: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      buffer,
      { lazyEntries: true, decodeStrings: true, strictFileNames: true, validateEntrySizes: true },
      (error, zipFile) => {
        if (error || !zipFile) reject(new Error('SKILL_PACKAGE_ARCHIVE_INVALID'));
        else resolve(zipFile);
      },
    );
  });
}

function readEntry(zipFile: ZipFile, entry: Entry, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(new Error('SKILL_PACKAGE_ARCHIVE_INVALID'));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      stream.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxBytes) stream.destroy(new Error('SKILL_PACKAGE_ENTRY_TOO_LARGE'));
        else chunks.push(chunk);
      });
      stream.once('error', reject);
      stream.once('end', () => resolve(Buffer.concat(chunks)));
    });
  });
}

function mediaLimit(mediaType: SkillPackageManifest['resources'][number]['media_type']): number {
  return mediaType.startsWith('image/')
    ? SKILL_PACKAGE_ARCHIVE_LIMITS.imageBytes
    : SKILL_PACKAGE_ARCHIVE_LIMITS.textBytes;
}

async function parseArchive(buffer: Buffer): Promise<IsolatedSkillPackage> {
  const zipFile = await openArchive(buffer);
  const entries = new Map<string, Buffer>();
  let totalBytes = 0;
  let entryCount = 0;

  try {
    await new Promise<void>((resolve, reject) => {
      zipFile.once('error', reject);
      zipFile.once('end', resolve);
      zipFile.on('entry', (entry: Entry) => {
        void (async () => {
          try {
            assertArchivePath(entry.fileName);
            assertRegularEntry(entry);
            if (entry.fileName.endsWith('/')) {
              zipFile.readEntry();
              return;
            }
            entryCount += 1;
            totalBytes += entry.uncompressedSize;
            if (
              entryCount > SKILL_PACKAGE_ARCHIVE_LIMITS.entryCount ||
              totalBytes > SKILL_PACKAGE_ARCHIVE_LIMITS.uncompressedBytes ||
              entries.has(entry.fileName)
            ) {
              archiveError('SKILL_PACKAGE_ARCHIVE_LIMIT_EXCEEDED');
            }
            const content = await readEntry(
              zipFile,
              entry,
              Math.min(entry.uncompressedSize + 1, SKILL_PACKAGE_ARCHIVE_LIMITS.imageBytes),
            );
            entries.set(entry.fileName, content);
            zipFile.readEntry();
          } catch (error) {
            reject(error instanceof Error ? error : new Error('SKILL_PACKAGE_ARCHIVE_INVALID'));
          }
        })();
      });
      zipFile.readEntry();
    });
  } finally {
    zipFile.close();
  }

  const manifestBytes = entries.get('skill-package/skill-package.json');
  if (!manifestBytes || manifestBytes.byteLength > SKILL_PACKAGE_ARCHIVE_LIMITS.textBytes) {
    archiveError('SKILL_PACKAGE_MANIFEST_MISSING');
  }
  let manifestInput: unknown;
  try {
    manifestInput = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
  } catch {
    archiveError('SKILL_PACKAGE_MANIFEST_INVALID');
  }
  const manifest = parseSkillPackageManifest(manifestInput);
  const expectedPaths = new Set([
    'skill-package/skill-package.json',
    ...manifest.resources.map((resource) => resource.path),
  ]);
  if (
    entries.size !== expectedPaths.size ||
    [...entries.keys()].some((path) => !expectedPaths.has(path))
  ) {
    archiveError('SKILL_PACKAGE_RESOURCE_INVENTORY_INVALID');
  }
  const resources = manifest.resources.map((expected) => {
    const content = entries.get(expected.path);
    if (!content || content.byteLength > mediaLimit(expected.media_type)) {
      return archiveError('SKILL_PACKAGE_ENTRY_TOO_LARGE');
    }
    return { path: expected.path, mediaType: expected.media_type, content };
  });
  const validation = validateSkillPackageContents({ manifest, resources });
  return {
    archiveSha256: createHash('sha256').update(buffer).digest('hex'),
    manifest,
    resources,
    validation,
  };
}

export async function readIsolatedSkillPackageBuffer(
  buffer: Buffer,
): Promise<IsolatedSkillPackage> {
  if (buffer.byteLength === 0 || buffer.byteLength > SKILL_PACKAGE_ARCHIVE_LIMITS.compressedBytes) {
    archiveError('SKILL_PACKAGE_ARCHIVE_SIZE_INVALID');
  }
  return Promise.race([
    parseArchive(buffer),
    new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error('SKILL_PACKAGE_ARCHIVE_TIMEOUT')),
        SKILL_PACKAGE_ARCHIVE_LIMITS.timeoutMs,
      );
      timer.unref();
    }),
  ]);
}

export async function readIsolatedSkillPackageFile(path: string): Promise<IsolatedSkillPackage> {
  if (!path.toLowerCase().endsWith('.skillpkg')) archiveError('SKILL_PACKAGE_EXTENSION_INVALID');
  return readIsolatedSkillPackageBuffer(await readFile(path));
}
