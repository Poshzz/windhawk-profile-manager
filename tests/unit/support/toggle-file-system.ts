import type { AtomicFileSystem } from '@infra/storage/atomic-json-file';

/**
 * Test-only filesystem wrapper. It can fail the final rename step so the
 * atomic-write path can be exercised without touching the previous file.
 */
export class ToggleFileSystem implements AtomicFileSystem {
  failRename = false;
  failWrite = false;
  failAfterWrite = false;

  constructor(private readonly inner: AtomicFileSystem) {}

  ensureDirectory(directory: string): Promise<void> {
    return this.inner.ensureDirectory(directory);
  }

  readText(path: string): Promise<string> {
    return this.inner.readText(path);
  }

  async writeText(path: string, contents: string): Promise<void> {
    if (this.failWrite) throw new Error('simulated write failure');
    await this.inner.writeText(path, contents);
    if (this.failAfterWrite) throw new Error('simulated post-write failure');
  }

  rename(from: string, to: string): Promise<void> {
    if (this.failRename) return Promise.reject(new Error('simulated rename failure'));
    return this.inner.rename(from, to);
  }

  remove(path: string): Promise<void> {
    return this.inner.remove(path);
  }

  listNames(directory: string): Promise<string[]> {
    return this.inner.listNames(directory);
  }
}
