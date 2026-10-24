import { readFile, readdir, stat } from 'node:fs/promises';
import type { EnvironmentFileSystem } from '@core/environment/environment-file-system';
import { EnvironmentError } from '@shared/errors';

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = (error as { readonly code?: unknown }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

export class NodeEnvironmentFileSystem implements EnvironmentFileSystem {
  async readTextFile(path: string): Promise<string | null> {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return null;
      throw new EnvironmentError(`Could not read ${path}.`, { cause: error });
    }
  }

  async readDirectory(path: string): Promise<readonly string[] | null> {
    try {
      const entries = await readdir(path, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw new EnvironmentError(`Could not list ${path}.`, { cause: error });
    }
  }

  async fileExists(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isFile();
    } catch (error) {
      if (isNotFound(error)) return false;
      throw new EnvironmentError(`Could not inspect ${path}.`, { cause: error });
    }
  }
}
