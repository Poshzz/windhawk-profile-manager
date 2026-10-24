import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function readFixture(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), 'tests', 'fixtures', relativePath), 'utf8');
}

export function readFixtureBytes(relativePath: string): Uint8Array {
  return readFileSync(resolve(process.cwd(), 'tests', 'fixtures', relativePath));
}

export function readJsonFixture(relativePath: string): unknown {
  return JSON.parse(readFixture(relativePath)) as unknown;
}
