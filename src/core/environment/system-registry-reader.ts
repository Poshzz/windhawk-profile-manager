export interface SystemRegistryReader {
  readString(keyPath: string, valueName: string): Promise<string | null>;
}

function normalizedKey(keyPath: string, valueName: string): string {
  return `${keyPath.toLowerCase()}\u0000${valueName.toLowerCase()}`;
}

export class FakeSystemRegistryReader implements SystemRegistryReader {
  private readonly values = new Map<string, string>();
  failWith: Error | null = null;

  constructor(values: Readonly<Record<string, Readonly<Record<string, string>>>> = {}) {
    for (const [keyPath, entries] of Object.entries(values)) {
      for (const [valueName, value] of Object.entries(entries)) {
        this.setValue(keyPath, valueName, value);
      }
    }
  }

  setValue(keyPath: string, valueName: string, value: string): void {
    this.values.set(normalizedKey(keyPath, valueName), value);
  }

  deleteValue(keyPath: string, valueName: string): void {
    this.values.delete(normalizedKey(keyPath, valueName));
  }

  async readString(keyPath: string, valueName: string): Promise<string | null> {
    if (this.failWith !== null) throw this.failWith;
    return this.values.get(normalizedKey(keyPath, valueName)) ?? null;
  }
}
