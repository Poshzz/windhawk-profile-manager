import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { parseApplyResult, parsePlan, type ApplyResult, type ExecutionPlan } from '@shared/domain';
import { MAX_HELPER_PLAN_BYTES } from '@shared/constants';
import {
  ApplyError,
  ElevationCanceledError,
  EnvironmentError,
  ValidationError,
} from '@shared/errors';
import { parseJson } from '@shared/validation/json';
import type { ElevationBroker, ElevationRunOptions } from '@core/elevation/elevation-broker';
import { ShellExecuteExLauncher, type ElevationLauncher } from './shell-execute-launcher';
import { WindowsRunDirectoryAcl, type RunDirectoryAcl } from './run-directory';
import { WindowsPathAccessChecker } from './windows-path-access';
import { resolveLocalAppData, resolveProgramData } from './system-paths';

const HELPER_DIRECTORY = 'WindhawkProfileManager';
const HELPER_FILE_NAME = 'WindhawkProfileManager.exe';
const PLAN_FILE_NAME = 'plan.json';
const RESULT_FILE_NAME = 'result.json';
const MAX_RESULT_BYTES = 4 * 1024 * 1024;
const ERROR_CANCELLED = 1223;

export interface ElevationBrokerLogger {
  warn(message: string, details?: unknown): void;
}

export interface WindowsElevationBrokerOptions {
  readonly programFiles?: string;
  readonly programData?: string;
  readonly localAppData?: string;
  /** Injectable for tests; production defaults to the running installed executable. */
  readonly helperPath?: string;
  readonly launcher?: ElevationLauncher;
  readonly acl?: RunDirectoryAcl;
  /** Injectable for tests; production uses an effective-ACL check. */
  readonly isUserWritable?: (path: string) => Promise<boolean>;
  readonly isUserWritableMany?: (paths: readonly string[]) => Promise<boolean[]>;
  readonly logger?: ElevationBrokerLogger;
}

function pathKey(path: string): string {
  return path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function samePath(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right);
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

const defaultPathAccessChecker = new WindowsPathAccessChecker();

async function isWritableByCurrentUser(path: string): Promise<boolean> {
  return defaultPathAccessChecker.canWrite(path);
}

async function areWritableByCurrentUser(paths: readonly string[]): Promise<boolean[]> {
  return defaultPathAccessChecker.canWriteMany(paths);
}

function planHash(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/**
 * The only way the GUI reaches the elevated helper. The helper path is fixed,
 * the plan is written once with an exclusive create, and the result is read from
 * result.json beside it. The helper's exit code and result status must agree.
 */
export class WindowsElevationBroker implements ElevationBroker {
  private readonly programFiles: string;
  private readonly programData: string;
  private readonly localAppData: string;
  private readonly helperFilePath: string;
  private readonly helperIsRunningExecutable: boolean;
  private readonly launcher: ElevationLauncher;
  private readonly acl: RunDirectoryAcl;
  private readonly isUserWritable: (path: string) => Promise<boolean>;
  private readonly isUserWritableMany: (paths: readonly string[]) => Promise<boolean[]>;
  private readonly logger: ElevationBrokerLogger;

  constructor(options: WindowsElevationBrokerOptions = {}) {
    this.programFiles = options.programFiles ?? process.env.ProgramFiles ?? 'C:\\Program Files';
    this.programData = options.programData ?? resolveProgramData();
    this.localAppData = options.localAppData ?? resolveLocalAppData();
    const runningExecutableIsHelper =
      basename(process.execPath).toLowerCase() === HELPER_FILE_NAME.toLowerCase();
    this.helperIsRunningExecutable = runningExecutableIsHelper && options.helperPath === undefined;
    this.helperFilePath =
      options.helperPath ??
      (runningExecutableIsHelper
        ? process.execPath
        : join(this.programFiles, HELPER_DIRECTORY, HELPER_FILE_NAME));
    this.launcher = options.launcher ?? new ShellExecuteExLauncher();
    this.acl = options.acl ?? new WindowsRunDirectoryAcl();
    this.isUserWritable = options.isUserWritable ?? isWritableByCurrentUser;
    this.isUserWritableMany =
      options.isUserWritableMany ??
      (options.isUserWritable === undefined
        ? areWritableByCurrentUser
        : async (paths) => Promise.all(paths.map((path) => this.isUserWritable(path))));
    this.logger = options.logger ?? { warn: () => undefined };
  }

  get helperPath(): string {
    return this.helperFilePath;
  }

  async startService(): Promise<void> {
    await this.assertFixedHelperPath();
    const launched = await this.launcher.launch({
      helperPath: this.helperPath,
      arguments: ['--helper', '--service-start'],
      workingDirectory: dirname(this.helperPath),
    });
    const exitCode = launched.exitCode;

    if (exitCode === ERROR_CANCELLED) {
      throw new ElevationCanceledError('The UAC prompt was canceled; the service was not started.');
    }
    if (exitCode !== 0) {
      throw new ApplyError(`The elevated service start failed (exit code ${exitCode}).`);
    }
  }

  async run(input: ExecutionPlan, options: ElevationRunOptions = {}): Promise<ApplyResult> {
    const plan = parsePlan(input);
    await this.assertFixedHelperPath();

    const runRoot = join(this.programData, HELPER_DIRECTORY, 'runs');
    const runDirectory = join(runRoot, plan.runId);
    const planPath = join(runDirectory, PLAN_FILE_NAME);
    const resultPath = join(runDirectory, RESULT_FILE_NAME);

    if (!samePath(plan.paths.plan, planPath) || !samePath(plan.paths.result, resultPath)) {
      throw new ValidationError(
        'The plan paths do not match the private run directory for this run ID.',
      );
    }

    this.assertCanonicalDataPaths(plan);

    const text = `${JSON.stringify(plan, null, 2)}\n`;
    if (Buffer.byteLength(text, 'utf8') > MAX_HELPER_PLAN_BYTES) {
      throw new ValidationError('The plan exceeds the helper plan size limit.');
    }
    const hash = planHash(text);

    await mkdir(runRoot, { recursive: true });
    try {
      await mkdir(runDirectory);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error) {
        if ((error as { readonly code?: unknown }).code === 'EEXIST') {
          throw new ValidationError('The private run directory already exists.');
        }
      }
      throw new EnvironmentError('The private run directory could not be created.', {
        cause: error,
      });
    }

    try {
      await this.acl.apply(runDirectory, plan.invokingUser);
      await this.writePlan(planPath, text);
    } catch (error) {
      await this.cleanup(runDirectory);
      throw error;
    }

    const helperArgs = [
      '--helper',
      '--plan',
      planPath,
      '--hash',
      hash,
      ...(options.dryRun === true ? ['--dry-run'] : []),
    ];

    let exitCode: number;
    try {
      const launched = await this.launcher.launch({
        helperPath: this.helperPath,
        arguments: helperArgs,
        workingDirectory: dirname(this.helperPath),
      });
      exitCode = launched.exitCode;
    } catch (error) {
      if (error instanceof ElevationCanceledError) {
        await this.cleanup(runDirectory);
      }
      throw error;
    }

    if (exitCode === ERROR_CANCELLED) {
      await this.cleanup(runDirectory);
      throw new ElevationCanceledError('The UAC prompt was canceled; no changes were made.');
    }

    const result = await this.readResultIfPresent(resultPath);
    if (result === null) {
      if (exitCode === 2) {
        throw new ValidationError('The elevated helper rejected the plan; no changes were made.');
      }
      throw new ApplyError(
        `The elevated helper exited with code ${exitCode} without writing result.json.`,
      );
    }

    if (result.runId !== plan.runId || result.kind !== plan.kind) {
      throw new ApplyError('The helper result does not belong to the executed plan.');
    }

    if (exitCode === 0) {
      if (
        result.status !== 'succeeded' &&
        result.status !== 'succeeded-with-warning' &&
        result.status !== 'dry-run'
      ) {
        throw new ApplyError(
          `The helper exited successfully with unexpected result status "${result.status}".`,
        );
      }
      await this.cleanup(runDirectory);
      return result;
    }

    if (exitCode === 2) {
      throw new ValidationError(result.error?.message ?? 'The elevated helper rejected the plan.');
    }

    if (exitCode === 3) {
      if (
        result.status !== 'failed' &&
        result.status !== 'rolled-back' &&
        result.status !== 'canceled'
      ) {
        throw new ApplyError(
          `The helper reported apply failure exit 3 with unexpected status "${result.status}".`,
        );
      }
      return result;
    }

    if (exitCode === 4) {
      if (result.status !== 'rollback-failed') {
        throw new ApplyError(
          `The helper reported rollback failure exit 4 with unexpected status "${result.status}".`,
        );
      }
      return result;
    }

    throw new ApplyError(`The elevated helper exited with unexpected code ${exitCode}.`);
  }

  private assertCanonicalDataPaths(plan: ExecutionPlan): void {
    if (this.localAppData.length === 0) {
      throw new ValidationError(
        'LOCALAPPDATA is not set; the snapshot and journal paths cannot be verified.',
      );
    }
    const appRoot = join(this.localAppData, HELPER_DIRECTORY);
    const expectedJournal = join(appRoot, 'journal.json');
    const expectedSnapshot = join(appRoot, 'snapshots', `${plan.snapshotId}.reg`);
    if (
      !samePath(plan.paths.journal, expectedJournal) ||
      !samePath(plan.paths.snapshotRegistry, expectedSnapshot)
    ) {
      throw new ValidationError(
        'The plan paths do not match the canonical WindhawkProfileManager data directory.',
      );
    }
    if (plan.kind === 'restore') {
      const expectedSource = join(appRoot, 'snapshots', `${plan.sourceSnapshotId}.reg`);
      if (!samePath(plan.paths.sourceSnapshotRegistry, expectedSource)) {
        throw new ValidationError(
          'The restore source does not match the canonical snapshot directory.',
        );
      }
    }
  }

  private async assertFixedHelperPath(): Promise<void> {
    const helperPath = this.helperPath;
    const helperDirectory = dirname(helperPath);

    let helperInfo;
    try {
      helperInfo = await lstat(helperPath);
    } catch (error) {
      throw new ValidationError(
        'The fixed elevated helper is missing. Reinstall Windhawk Profile Manager.',
        [],
        { cause: error },
      );
    }
    if (helperInfo.isSymbolicLink() || !helperInfo.isFile()) {
      throw new ValidationError('The fixed elevated helper must be a regular file.');
    }

    let directoryInfo;
    try {
      directoryInfo = await lstat(helperDirectory);
    } catch (error) {
      throw new ValidationError(
        'The fixed elevated helper directory is missing. Reinstall Windhawk Profile Manager.',
        [],
        { cause: error },
      );
    }
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
      throw new ValidationError('The fixed elevated helper directory is not a regular directory.');
    }

    let realHelper: string;
    let realProgramFiles: string;
    try {
      realHelper = await realpath(helperPath);
      realProgramFiles = await realpath(this.programFiles);
    } catch (error) {
      throw new ValidationError(
        'The fixed elevated helper location could not be verified. Reinstall Windhawk Profile Manager.',
        [],
        { cause: error },
      );
    }
    if (this.helperIsRunningExecutable) {
      // The installed GUI is the helper. Do not let an env-supplied ProgramFiles
      // choose the privileged binary; it must be this exact running image.
      let realRunningExecutable: string;
      try {
        realRunningExecutable = await realpath(process.execPath);
      } catch (error) {
        throw new ValidationError('The running helper executable could not be verified.', [], {
          cause: error,
        });
      }
      if (!samePath(realHelper, realRunningExecutable)) {
        throw new ValidationError(
          'The elevated helper is not the running installed executable. Reinstall Windhawk Profile Manager.',
        );
      }
    } else if (!isInside(realProgramFiles, realHelper)) {
      throw new ValidationError('The elevated helper is outside the fixed Program Files location.');
    }

    const [helperWritable, directoryWritable] = await this.isUserWritableMany([
      helperPath,
      helperDirectory,
    ]);
    if (helperWritable === true || directoryWritable === true) {
      throw new ValidationError(
        'The elevated helper or its directory is writable by a standard user. Reinstall it under a protected Program Files location.',
      );
    }
  }

  private async writePlan(path: string, text: string): Promise<void> {
    let handle;
    try {
      handle = await open(path, 'wx', 0o600);
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } catch (error) {
      throw new EnvironmentError('The helper plan could not be written.', { cause: error });
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async readResultIfPresent(path: string): Promise<ApplyResult | null> {
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size <= 0 || info.size > MAX_RESULT_BYTES) {
        throw new ApplyError('The helper result file has an invalid size.');
      }
      const text = await readFile(path, 'utf8');
      return parseApplyResult(parseJson(text));
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error) {
        if ((error as { readonly code?: unknown }).code === 'ENOENT') return null;
      }
      throw error;
    }
  }

  private async cleanup(runDirectory: string): Promise<void> {
    try {
      await rm(runDirectory, { recursive: true, force: true });
    } catch (error) {
      this.logger.warn('The private run directory could not be removed.', error);
    }
  }
}
