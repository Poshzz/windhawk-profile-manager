import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { hasControlCharacters } from '@shared/domain/common';
import { ValidationError } from '@shared/errors';
import { parseJson, sanitizeJsonValue } from '@shared/validation/json';

export interface AtomicFileSystem {
  ensureDirectory(directory: string): Promise<void>;
  readText(path: string): Promise<string>;
  writeText(path: string, contents: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  listNames(directory: string): Promise<string[]>;
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
}

export function isNotFoundError(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}

// The non-elevated GUI polls the journal while the elevated helper replaces it.
// A reader briefly holding the destination handle can make MoveFileEx return
// EPERM even though the file is replaceable; retry across several poll gaps.
const RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80, 160, 320, 640, 1000, 1500] as const;
const TRANSIENT_RENAME_ERROR_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);

export async function renameWithRetry(
  renameFile: (from: string, to: string) => Promise<void>,
  from: string,
  to: string,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameFile(from, to);
      return;
    } catch (error) {
      const delayMs = RENAME_RETRY_DELAYS_MS[attempt];
      const code = errorCode(error);
      if (
        delayMs === undefined ||
        typeof code !== 'string' ||
        !TRANSIENT_RENAME_ERROR_CODES.has(code)
      ) {
        throw error;
      }
      await delay(delayMs);
    }
  }
}

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const INVALID_FILE_NAME_CHARACTERS = /[<>:"/\\|?*]/;

function isSafeFileName(fileName: string): boolean {
  return (
    fileName.length > 0 &&
    fileName.length <= 255 &&
    fileName === basename(fileName) &&
    fileName !== '.' &&
    fileName !== '..' &&
    !hasControlCharacters(fileName) &&
    !INVALID_FILE_NAME_CHARACTERS.test(fileName) &&
    !WINDOWS_RESERVED_NAME.test(fileName)
  );
}

function assertSafeFileName(fileName: string): void {
  if (isSafeFileName(fileName)) return;

  throw new ValidationError(`Unsafe file name "${fileName}".`, [
    { path: [], message: 'Expected a plain file name without a path or reserved name.' },
  ]);
}

export class NodeAtomicFileSystem implements AtomicFileSystem {
  async ensureDirectory(directory: string): Promise<void> {
    await mkdir(directory, { recursive: true });
  }

  async readText(path: string): Promise<string> {
    return readFile(path, 'utf8');
  }

  async writeText(path: string, contents: string): Promise<void> {
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async rename(from: string, to: string): Promise<void> {
    await renameWithRetry(rename, from, to);
  }

  async remove(path: string): Promise<void> {
    await unlink(path);
  }

  async listNames(directory: string): Promise<string[]> {
    return readdir(directory);
  }
}

/**
 * A small atomic JSON file helper: write a complete temporary file in the same
 * directory, flush it, then rename it over the target. A failed write never
 * truncates the previous file.
 */
export class AtomicJsonFile {
  constructor(
    private readonly directory: string,
    private readonly filesystem: AtomicFileSystem = new NodeAtomicFileSystem(),
  ) {}

  async read(fileName: string): Promise<unknown> {
    assertSafeFileName(fileName);
    const text = await this.filesystem.readText(join(this.directory, fileName));
    return parseJson(text);
  }

  async write(fileName: string, value: unknown): Promise<void> {
    assertSafeFileName(fileName);
    await this.filesystem.ensureDirectory(this.directory);

    const targetPath = join(this.directory, fileName);
    const temporaryPath = join(this.directory, `.${fileName}.${randomUUID()}.tmp`);
    const contents = `${JSON.stringify(sanitizeJsonValue(value), null, 2)}\n`;

    try {
      await this.filesystem.writeText(temporaryPath, contents);
      await this.filesystem.rename(temporaryPath, targetPath);
    } catch (error) {
      try {
        await this.filesystem.remove(temporaryPath);
      } catch {
        // Best-effort cleanup; preserve the original write error.
      }
      throw error;
    }
  }

  async delete(fileName: string): Promise<void> {
    assertSafeFileName(fileName);
    await this.filesystem.remove(join(this.directory, fileName));
  }

  async list(): Promise<string[]> {
    try {
      const names = await this.filesystem.listNames(this.directory);
      return names
        .filter((name) => name.toLowerCase().endsWith('.json') && isSafeFileName(name))
        .sort();
    } catch (error) {
      if (isNotFoundError(error)) return [];
      throw error;
    }
  }
}
