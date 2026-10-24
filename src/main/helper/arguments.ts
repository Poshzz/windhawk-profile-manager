import { isAbsoluteWindowsPath } from '@shared/domain';
import { ValidationError } from '@shared/errors';

export interface HelperPlanArguments {
  readonly serviceStart: false;
  readonly planPath: string;
  /** Always normalized to the lowercase `sha256:<hex>` form used by plans. */
  readonly expectedHash: string;
  readonly dryRun: boolean;
}

export interface HelperServiceArguments {
  readonly serviceStart: true;
}

export type HelperArguments = HelperPlanArguments | HelperServiceArguments;

const HASH_PATTERN = /^(?:sha256:)?([a-f0-9]{64})$/i;

export function normalizePlanHash(value: string): string {
  const match = HASH_PATTERN.exec(value);
  if (match === null) {
    throw new ValidationError('The helper hash must be a SHA-256 hex digest.');
  }
  return `sha256:${match[1]?.toLowerCase() ?? ''}`;
}

/**
 * Returns null for a normal GUI launch. Once `--helper` is present every other
 * argument is validated strictly so a typo cannot silently start the GUI.
 */
export function parseHelperArguments(argv: readonly string[]): HelperArguments | null {
  if (!argv.includes('--helper')) return null;

  let planPath: string | null = null;
  let expectedHash: string | null = null;
  let dryRun = false;
  let helperSeen = false;
  let serviceStart = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case '--helper': {
        if (helperSeen) throw new ValidationError('The --helper argument may only be given once.');
        helperSeen = true;
        break;
      }
      case '--service-start': {
        if (serviceStart) {
          throw new ValidationError('The --service-start argument may only be given once.');
        }
        serviceStart = true;
        break;
      }
      case '--plan': {
        if (planPath !== null)
          throw new ValidationError('The --plan argument may only be given once.');
        const value = argv[index + 1];
        if (value === undefined || value.startsWith('--')) {
          throw new ValidationError('The --plan argument requires an absolute .json path.');
        }
        if (!isAbsoluteWindowsPath(value) || !value.toLowerCase().endsWith('.json')) {
          throw new ValidationError('The --plan argument requires an absolute .json path.');
        }
        planPath = value;
        index += 1;
        break;
      }
      case '--hash': {
        if (expectedHash !== null) {
          throw new ValidationError('The --hash argument may only be given once.');
        }
        const value = argv[index + 1];
        if (value === undefined || value.startsWith('--')) {
          throw new ValidationError('The --hash argument requires a SHA-256 digest.');
        }
        expectedHash = normalizePlanHash(value);
        index += 1;
        break;
      }
      case '--dry-run': {
        if (dryRun) throw new ValidationError('The --dry-run argument may only be given once.');
        dryRun = true;
        break;
      }
      default:
        throw new ValidationError(`Unknown helper argument "${String(argument)}".`);
    }
  }

  if (serviceStart) {
    if (planPath !== null || expectedHash !== null || dryRun) {
      throw new ValidationError('The service-start helper mode does not accept a plan.');
    }
    return { serviceStart: true };
  }

  if (planPath === null) throw new ValidationError('The helper requires --plan <path>.');
  if (expectedHash === null) throw new ValidationError('The helper requires --hash <sha256>.');

  return { serviceStart: false, planPath, expectedHash, dryRun };
}
