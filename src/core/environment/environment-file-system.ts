export interface EnvironmentFileSystem {
  readTextFile(path: string): Promise<string | null>;
  readDirectory(path: string): Promise<readonly string[] | null>;
  fileExists(path: string): Promise<boolean>;
}

function normalizePath(path: string): string {
  return path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

export interface FakeEnvironmentFileSystemState {
  readonly files?: Readonly<Record<string, string>>;
  readonly directories?: Readonly<Record<string, readonly string[]>>;
}

export class FakeEnvironmentFileSystem implements EnvironmentFileSystem {
  private readonly files = new Map<string, string>();
  private readonly directories = new Map<string, readonly string[]>();
  failWith: Error | null = null;

  constructor(state: FakeEnvironmentFileSystemState = {}) {
    for (const [path, text] of Object.entries(state.files ?? {})) {
      this.setFile(path, text);
    }
    for (const [path, entries] of Object.entries(state.directories ?? {})) {
      this.setDirectory(path, entries);
    }
  }

  setFile(path: string, text: string): void {
    this.files.set(normalizePath(path), text);
  }

  setDirectory(path: string, entries: readonly string[]): void {
    this.directories.set(normalizePath(path), [...entries]);
  }

  async readTextFile(path: string): Promise<string | null> {
    if (this.failWith !== null) throw this.failWith;
    return this.files.get(normalizePath(path)) ?? null;
  }

  async readDirectory(path: string): Promise<readonly string[] | null> {
    if (this.failWith !== null) throw this.failWith;
    return this.directories.get(normalizePath(path)) ?? null;
  }

  async fileExists(path: string): Promise<boolean> {
    if (this.failWith !== null) throw this.failWith;
    return this.files.has(normalizePath(path));
  }
}
