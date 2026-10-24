import { createHash, timingSafeEqual } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import {
  canonicalPlanHashInput,
  isAbsoluteWindowsPath,
  parsePlan,
  type ExecutionPlan,
} from '@shared/domain';
import { MAX_HELPER_PLAN_BYTES } from '@shared/constants';
import { hashCanonical } from '@core/planner/registry-state';
import { ValidationError } from '@shared/errors';
import { normalizePlanHash } from './arguments';
import { parseStrictJson } from './strict-json';

export interface HelperPlanFile {
  readonly plan: ExecutionPlan;
  readonly fileHash: string;
}

export interface ReadHelperPlanOptions {
  readonly maxBytes?: number;
}

function planHash(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function hashesEqual(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected.slice('sha256:'.length), 'hex');
  const actualBytes = Buffer.from(actual.slice('sha256:'.length), 'hex');
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

async function readLimitedBytes(path: string, maxBytes: number): Promise<Buffer> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    throw new ValidationError('The helper plan file could not be read.', [], { cause: error });
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new ValidationError('The helper plan must be a regular file, not a symlink.');
  }
  if (info.size <= 0) {
    throw new ValidationError('The helper plan file is empty.');
  }
  if (info.size > maxBytes) {
    throw new ValidationError('The helper plan file exceeds the size limit.');
  }

  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) {
      throw new ValidationError('The helper plan file exceeds the size limit.');
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

/**
 * Reads the broker-provided plan bytes, checks size and the constant-time file
 * hash, then parses the schema. Nothing in this function performs a registry or
 * service call, so a tampered plan is rejected before privileged work begins.
 */
export async function readHelperPlanFile(
  path: string,
  expectedHash: string,
  options: ReadHelperPlanOptions = {},
): Promise<HelperPlanFile> {
  if (!isAbsoluteWindowsPath(path) || !path.toLowerCase().endsWith('.json')) {
    throw new ValidationError('The helper plan path must be an absolute .json path.');
  }

  const expected = normalizePlanHash(expectedHash);
  const bytes = await readLimitedBytes(path, options.maxBytes ?? MAX_HELPER_PLAN_BYTES);
  const actual = planHash(bytes);
  if (!hashesEqual(expected, actual)) {
    throw new ValidationError('The plan file hash does not match the expected hash.');
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new ValidationError('The helper plan is not valid UTF-8.', [], { cause: error });
  }

  const plan = parsePlan(parseStrictJson(text));
  const internalHash = hashCanonical(canonicalPlanHashInput(plan));
  if (internalHash !== plan.planHash) {
    throw new ValidationError('The plan contents do not match the plan hash.');
  }

  return { plan, fileHash: actual };
}
