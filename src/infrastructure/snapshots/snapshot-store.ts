import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import {
  SCHEMA_VERSION,
  SNAPSHOT_SCOPE,
  SnapshotIdSchema,
  SnapshotTriggerSchema,
  getModIdFromRegistryPath,
  isAbsoluteWindowsPath,
  parseEnvironment,
  parseSnapshotMetadata,
  type Environment,
  type RegistrySnapshot,
  type SnapshotMetadata,
  type SnapshotTrigger,
} from '@shared/domain';
import { EnvironmentError, NotFoundError, ValidationError } from '@shared/errors';
import { parseRegFile } from '@core/registry/reg-codec';
import type { RegistryGateway } from '@core/registry/registry-gateway';
import { AtomicJsonFile, isNotFoundError } from '../storage/atomic-json-file';
import { NodeSnapshotFileSystem, type SnapshotFileSystem } from '../storage/snapshot-file-system';

export const DEFAULT_AUTOMATIC_RETENTION = 20;
export const MAX_SNAPSHOT_REG_BYTES = 16 * 1024 * 1024;
export const DEFAULT_SNAPSHOT_APP_VERSION = '0.0.0';

export const SNAPSHOT_EXCLUDED_PATHS = [
  '%ProgramData%\\Windhawk\\Engine\\Mods\\32',
  '%ProgramData%\\Windhawk\\Engine\\Mods\\64',
  '%ProgramData%\\Windhawk\\Engine\\Mods\\arm64',
  'HKLM\\SOFTWARE\\Windhawk\\Engine\\ModsWritable',
] as const;

const MODS_WRITABLE_ROOT = 'HKLM\\SOFTWARE\\Windhawk\\Engine\\ModsWritable';

const AUTOMATIC_TRIGGERS: ReadonlySet<SnapshotTrigger> = new Set(['pre-apply', 'pre-restore']);
const JSON_EXTENSION = '.json';
const REG_EXTENSION = '.reg';

export interface SnapshotContext {
  readonly environment: Environment;
  readonly profileId?: string | null;
  readonly appVersion?: string;
  readonly registryView?: '64-bit';
}

export interface SnapshotCaptureOptions {
  /** Retention is deferred by the executor until the journal exists. */
  readonly prune?: boolean;
}

export interface SnapshotRecord {
  readonly metadata: SnapshotMetadata;
  readonly registry: RegistrySnapshot;
}

/** A plan binds both the snapshot ID and the exact .reg path the helper must use. */
export interface SnapshotCaptureTarget {
  readonly id: string;
  readonly registryPath: string;
}

export interface SnapshotListItem {
  readonly metadata: SnapshotMetadata;
  readonly retained: boolean;
  readonly sizeBytes: number;
}

export interface SnapshotExport {
  readonly metadata: SnapshotMetadata;
  readonly metadataJson: string;
  readonly registryBytes: Uint8Array;
}

export interface SnapshotStoreWarning {
  readonly operation: 'list' | 'retention' | 'delete';
  readonly fileName?: string;
  readonly error: unknown;
}

export interface SnapshotStoreOptions {
  readonly gateway: RegistryGateway;
  readonly directory?: string;
  readonly fileSystem?: SnapshotFileSystem;
  readonly now?: () => Date;
  readonly activeJournalSnapshotIds?: () => Promise<ReadonlySet<string>>;
  readonly automaticRetentionLimit?: number;
  readonly onWarning?: (warning: SnapshotStoreWarning) => void;
}

export function defaultSnapshotsDirectory(): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData === undefined || localAppData.length === 0) {
    throw new EnvironmentError(
      'LOCALAPPDATA is not set; the snapshot directory cannot be located.',
    );
  }

  return join(localAppData, 'WindhawkProfileManager', 'snapshots');
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function compareSnapshotsNewestFirst(left: SnapshotMetadata, right: SnapshotMetadata): number {
  const difference = Date.parse(right.createdAt) - Date.parse(left.createdAt);
  return difference === 0 ? right.id.localeCompare(left.id) : difference;
}

export class SnapshotStore {
  private readonly gateway: RegistryGateway;
  private readonly directory: string;
  private readonly files: SnapshotFileSystem;
  private readonly metadataFiles: AtomicJsonFile;
  private readonly now: () => Date;
  private readonly activeJournalSnapshotIds: () => Promise<ReadonlySet<string>>;
  private automaticRetentionLimit: number;
  private readonly onWarning: (warning: SnapshotStoreWarning) => void;
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(options: SnapshotStoreOptions) {
    this.gateway = options.gateway;
    this.directory = options.directory ?? defaultSnapshotsDirectory();
    this.files = options.fileSystem ?? new NodeSnapshotFileSystem();
    this.metadataFiles = new AtomicJsonFile(this.directory, this.files);
    this.now = options.now ?? (() => new Date());
    this.activeJournalSnapshotIds =
      options.activeJournalSnapshotIds ?? (async () => new Set<string>());
    this.automaticRetentionLimit = options.automaticRetentionLimit ?? DEFAULT_AUTOMATIC_RETENTION;
    this.onWarning = options.onWarning ?? (() => undefined);

    if (!Number.isInteger(this.automaticRetentionLimit) || this.automaticRetentionLimit < 1) {
      throw new ValidationError(
        'The automatic snapshot retention limit must be a positive integer.',
      );
    }
  }

  async capture(
    trigger: SnapshotTrigger,
    context: SnapshotContext,
    options: SnapshotCaptureOptions = {},
  ): Promise<SnapshotRecord> {
    return this.captureWithTarget(trigger, context, null, options);
  }

  /**
   * Captures a snapshot at the ID and absolute .reg path already bound into a
   * helper plan. The path must stay inside this store's directory and filename
   * must match the metadata contract (`<id>.reg`).
   */
  async captureAt(
    trigger: SnapshotTrigger,
    context: SnapshotContext,
    target: SnapshotCaptureTarget,
    options: SnapshotCaptureOptions = {},
  ): Promise<SnapshotRecord> {
    return this.captureWithTarget(trigger, context, target, options);
  }

  private async captureWithTarget(
    trigger: SnapshotTrigger,
    context: SnapshotContext,
    target: SnapshotCaptureTarget | null,
    options: SnapshotCaptureOptions,
  ): Promise<SnapshotRecord> {
    if (!SnapshotTriggerSchema.safeParse(trigger).success) {
      throw new ValidationError(`Unknown snapshot trigger "${String(trigger)}".`);
    }
    if (trigger === 'imported') {
      throw new ValidationError('Imported snapshots must be created with import().');
    }

    return this.enqueueMutation(async () => {
      const environment = parseEnvironment(context.environment);
      const createdAt = this.nowIso();
      await this.files.ensureDirectory(this.directory);

      const id = target === null ? await this.nextId(createdAt) : target.id;
      if (!SnapshotIdSchema.safeParse(id).success) {
        throw new ValidationError('The planned snapshot ID is invalid.');
      }
      const registryFileName = `${id}${REG_EXTENSION}`;
      const registryPath =
        target === null ? join(this.directory, registryFileName) : target.registryPath;
      if (target !== null) this.assertCaptureTarget(target, registryPath);
      const metadataFileName = `${id}${JSON_EXTENSION}`;
      const metadataPath = join(this.directory, metadataFileName);

      if (target !== null) {
        if (await this.fileExists(registryPath)) {
          throw new ValidationError('The planned snapshot evidence file already exists.');
        }
        if (await this.fileExists(metadataPath)) {
          throw new ValidationError('The planned snapshot metadata file already exists.');
        }
      }

      let metadata: SnapshotMetadata;
      let registry: RegistrySnapshot;
      try {
        await this.gateway.exportReg(registryPath);
        const info = await this.files.stat(registryPath);
        if (info.isSymbolicLink || !info.isFile) {
          throw new ValidationError('The registry export was not written as a regular file.');
        }
        if (info.size > MAX_SNAPSHOT_REG_BYTES) {
          throw new ValidationError('The registry export exceeds the snapshot size limit.');
        }

        const bytes = await this.files.readBytes(registryPath);
        registry = parseRegFile(bytes, { capturedAt: createdAt });
        this.assertSnapshotRegistry(registry);
        await this.files.applyUserOnlyAcl(registryPath, 'file');

        metadata = this.buildMetadata({
          id,
          createdAt,
          trigger,
          context,
          environment,
          registry,
          registryFileName,
          bytes,
        });
        await this.metadataFiles.write(metadataFileName, metadata);
        await this.files.applyUserOnlyAcl(metadataPath, 'file');
      } catch (error) {
        await this.removeSnapshotFiles(id).catch(() => undefined);
        throw error;
      }

      if (options.prune !== false) await this.pruneSafely(id);
      return { metadata, registry };
    });
  }

  async list(): Promise<SnapshotListItem[]> {
    if (!(await this.directoryExists())) return [];

    const fileNames = await this.metadataFiles.list();
    const items: SnapshotListItem[] = [];
    for (const fileName of fileNames) {
      const id = fileName.slice(0, -JSON_EXTENSION.length);
      if (!SnapshotIdSchema.safeParse(id).success) continue;

      try {
        const metadata = await this.readMetadata(id);
        let sizeBytes = 0;
        try {
          const info = await this.files.stat(join(this.directory, metadata.registryFile));
          sizeBytes = info.size;
        } catch {
          // Keep the metadata visible even if the registry file is missing.
        }
        items.push({
          metadata,
          retained: !AUTOMATIC_TRIGGERS.has(metadata.trigger),
          sizeBytes,
        });
      } catch (error) {
        if (error instanceof ValidationError || error instanceof NotFoundError) {
          this.onWarning({ operation: 'list', fileName, error });
          continue;
        }
        throw error;
      }
    }

    return items.sort((left, right) => compareSnapshotsNewestFirst(left.metadata, right.metadata));
  }

  async get(id: string): Promise<SnapshotRecord> {
    const { metadata, registry } = await this.readSnapshot(id);
    return { metadata, registry };
  }

  async verify(id: string): Promise<SnapshotMetadata> {
    const metadata = await this.readMetadata(id);
    await this.readRegistryBytes(metadata);
    return metadata;
  }

  async export(id: string): Promise<SnapshotExport> {
    const { metadata, registryBytes } = await this.readSnapshot(id);
    return {
      metadata,
      metadataJson: `${JSON.stringify(metadata, null, 2)}\n`,
      registryBytes,
    };
  }

  async delete(id: string, options: { confirm: boolean }): Promise<void> {
    return this.enqueueMutation(async () => {
      if (options?.confirm !== true) {
        throw new ValidationError('Deleting a snapshot requires explicit confirmation.');
      }

      await this.readMetadata(id);
      const activeIds = await this.activeJournalSnapshotIds();
      if (activeIds.has(id)) {
        throw new ValidationError(
          `Snapshot "${id}" is referenced by an unfinished journal and cannot be deleted.`,
        );
      }

      await this.removeSnapshotFiles(id);
    });
  }

  async import(path: string, context: SnapshotContext): Promise<SnapshotRecord> {
    return this.enqueueMutation(async () => {
      if (!isAbsoluteWindowsPath(path) || !path.toLowerCase().endsWith(REG_EXTENSION)) {
        throw new ValidationError('Expected an absolute path to a .reg snapshot.');
      }

      const environment = parseEnvironment(context.environment);
      const sourceInfo = await this.files.stat(path);
      if (sourceInfo.isSymbolicLink || !sourceInfo.isFile) {
        throw new ValidationError('Snapshot imports must be regular .reg files, not symlinks.');
      }
      if (sourceInfo.size > MAX_SNAPSHOT_REG_BYTES) {
        throw new ValidationError('The .reg snapshot exceeds the size limit.');
      }

      const bytes = await this.files.readBytes(path);
      const createdAt = this.nowIso();
      const registry = parseRegFile(bytes, { capturedAt: createdAt });
      this.assertSnapshotRegistry(registry);

      await this.files.ensureDirectory(this.directory);
      const id = await this.nextId(createdAt);
      const registryFileName = `${id}${REG_EXTENSION}`;
      const metadataFileName = `${id}${JSON_EXTENSION}`;
      const metadataPath = join(this.directory, metadataFileName);

      let metadata: SnapshotMetadata;
      try {
        await this.writeRegistryBytes(registryFileName, bytes);
        metadata = this.buildMetadata({
          id,
          createdAt,
          trigger: 'imported',
          context: { ...context, profileId: null },
          environment,
          registry,
          registryFileName,
          bytes,
        });
        await this.metadataFiles.write(metadataFileName, metadata);
        await this.files.applyUserOnlyAcl(metadataPath, 'file');
      } catch (error) {
        await this.removeSnapshotFiles(id).catch(() => undefined);
        throw error;
      }

      await this.pruneSafely();
      return { metadata, registry };
    });
  }

  async setAutomaticRetentionLimit(limit: number): Promise<void> {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new ValidationError(
        'The automatic snapshot retention limit must be a positive integer.',
      );
    }
    this.automaticRetentionLimit = limit;
    await this.prune();
  }

  async prune(): Promise<string[]> {
    return this.enqueueMutation(() => this.pruneNow());
  }

  private async pruneNow(protectedIds: ReadonlySet<string> = new Set<string>()): Promise<string[]> {
    const items = await this.list();
    const activeIds = await this.activeJournalSnapshotIds();
    const deleted: string[] = [];
    let automaticCount = 0;

    for (const item of items) {
      if (!AUTOMATIC_TRIGGERS.has(item.metadata.trigger)) continue;
      automaticCount += 1;
      if (automaticCount <= this.automaticRetentionLimit) continue;
      if (activeIds.has(item.metadata.id) || protectedIds.has(item.metadata.id)) continue;

      await this.removeSnapshotFiles(item.metadata.id);
      deleted.push(item.metadata.id);
    }

    return deleted;
  }

  private assertCaptureTarget(target: SnapshotCaptureTarget, registryPath: string): void {
    if (!SnapshotIdSchema.safeParse(target.id).success) {
      throw new ValidationError('The planned snapshot ID is invalid.');
    }
    if (
      !isAbsoluteWindowsPath(registryPath) ||
      !registryPath.toLowerCase().endsWith(REG_EXTENSION)
    ) {
      throw new ValidationError('The planned snapshot path must be an absolute .reg path.');
    }
    if (basename(registryPath).toLowerCase() !== `${target.id}${REG_EXTENSION}`.toLowerCase()) {
      throw new ValidationError('The planned snapshot path must match its snapshot ID.');
    }
    const targetDirectory = resolve(dirname(registryPath)).replace(/\//g, '\\').toLowerCase();
    const storeDirectory = resolve(this.directory).replace(/\//g, '\\').toLowerCase();
    if (targetDirectory !== storeDirectory) {
      throw new ValidationError('The planned snapshot path must be inside the snapshot directory.');
    }
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      await this.files.stat(path);
      return true;
    } catch (error) {
      if (isNotFoundError(error)) return false;
      throw error;
    }
  }

  private async pruneSafely(protectedId?: string): Promise<void> {
    try {
      await this.pruneNow(protectedId === undefined ? new Set() : new Set([protectedId]));
    } catch (error) {
      this.onWarning({ operation: 'retention', error });
    }
  }

  private async readSnapshot(id: string): Promise<{
    metadata: SnapshotMetadata;
    registry: RegistrySnapshot;
    registryBytes: Uint8Array;
  }> {
    const metadata = await this.readMetadata(id);
    const registryBytes = await this.readRegistryBytes(metadata);
    const registry = parseRegFile(registryBytes, { capturedAt: metadata.createdAt });
    this.assertSnapshotRegistry(registry);
    return { metadata, registry, registryBytes };
  }

  private async readMetadata(id: string): Promise<SnapshotMetadata> {
    this.assertSnapshotId(id);
    if (!(await this.directoryExists())) {
      throw new NotFoundError(`Snapshot "${id}" was not found.`);
    }

    let raw: unknown;
    try {
      raw = await this.metadataFiles.read(`${id}${JSON_EXTENSION}`);
    } catch (error) {
      if (isNotFoundError(error)) {
        throw new NotFoundError(`Snapshot "${id}" was not found.`, { cause: error });
      }
      throw error;
    }

    const metadata = parseSnapshotMetadata(raw);
    if (metadata.id !== id || metadata.registryFile !== `${id}${REG_EXTENSION}`) {
      throw new ValidationError(
        `Snapshot metadata "${id}${JSON_EXTENSION}" does not match its file name.`,
      );
    }
    return metadata;
  }

  private async readRegistryBytes(metadata: SnapshotMetadata): Promise<Uint8Array> {
    const path = join(this.directory, metadata.registryFile);
    let info;
    try {
      info = await this.files.stat(path);
    } catch (error) {
      if (isNotFoundError(error)) {
        throw new NotFoundError(`The .reg file for snapshot "${metadata.id}" was not found.`, {
          cause: error,
        });
      }
      throw error;
    }

    if (info.isSymbolicLink || !info.isFile) {
      throw new ValidationError('Snapshot registry evidence must be a regular file.');
    }
    if (info.size > MAX_SNAPSHOT_REG_BYTES) {
      throw new ValidationError('Snapshot registry evidence exceeds the size limit.');
    }

    const bytes = await this.files.readBytes(path);
    if (sha256(bytes) !== metadata.registrySha256) {
      throw new ValidationError(`Snapshot "${metadata.id}" failed checksum verification.`, [
        {
          path: ['registrySha256'],
          message: 'The .reg bytes do not match the metadata checksum.',
        },
      ]);
    }
    return bytes;
  }

  private async writeRegistryBytes(fileName: string, bytes: Uint8Array): Promise<void> {
    const targetPath = join(this.directory, fileName);
    const temporaryPath = join(this.directory, `.${fileName}.${randomUUID()}.tmp`);

    try {
      await this.files.writeBytes(temporaryPath, bytes);
      await this.files.applyUserOnlyAcl(temporaryPath, 'file');
      await this.files.rename(temporaryPath, targetPath);
      await this.files.applyUserOnlyAcl(targetPath, 'file');
    } catch (error) {
      await this.files.remove(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private async directoryExists(): Promise<boolean> {
    try {
      const info = await this.files.stat(this.directory);
      if (info.isSymbolicLink || !info.isDirectory) {
        throw new ValidationError('The snapshot directory must be a regular directory.');
      }
      return true;
    } catch (error) {
      if (isNotFoundError(error)) return false;
      throw error;
    }
  }

  private async removeSnapshotFiles(id: string): Promise<void> {
    for (const extension of [JSON_EXTENSION, REG_EXTENSION]) {
      try {
        await this.files.remove(join(this.directory, `${id}${extension}`));
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
      }
    }
  }

  private async nextId(createdAt: string): Promise<string> {
    const base = createdAt.replace(/[:.]/g, '-');
    const names = new Set(
      (await this.files.listNames(this.directory)).map((name) => name.toLowerCase()),
    );
    const isFree = (candidate: string): boolean =>
      !names.has(`${candidate}${JSON_EXTENSION}`.toLowerCase()) &&
      !names.has(`${candidate}${REG_EXTENSION}`.toLowerCase());

    if (isFree(base)) return base;
    for (let index = 2; index < 10_000; index += 1) {
      const candidate = `${base}-${index}`;
      if (isFree(candidate)) return candidate;
    }

    throw new ValidationError('Unable to allocate a unique snapshot ID.');
  }

  private buildMetadata(args: {
    readonly id: string;
    readonly createdAt: string;
    readonly trigger: SnapshotTrigger;
    readonly context: SnapshotContext;
    readonly environment: Environment;
    readonly registry: RegistrySnapshot;
    readonly registryFileName: string;
    readonly bytes: Uint8Array;
  }): SnapshotMetadata {
    const modIds = new Set<string>();
    for (const key of args.registry.keys) {
      const modId = getModIdFromRegistryPath(key.path);
      if (modId !== null) modIds.add(modId.toLowerCase());
    }

    return parseSnapshotMetadata({
      schemaVersion: SCHEMA_VERSION,
      id: args.id,
      createdAt: args.createdAt,
      trigger: args.trigger,
      profileId: args.context.profileId ?? null,
      appVersion: args.context.appVersion ?? DEFAULT_SNAPSHOT_APP_VERSION,
      windowsBuild: args.environment.windows.build,
      registryView: args.context.registryView ?? '64-bit',
      windhawkVersion: args.environment.windhawk.version,
      windhawkStorageMode: args.environment.windhawk.storageMode,
      windhawkRegistryRoot: args.environment.windhawk.registryRoot,
      windhawkServiceName: args.environment.service.name,
      windhawkServiceState: args.environment.service.state,
      rainmeterRunning: args.environment.rainmeter.running,
      registryFile: args.registryFileName,
      registrySha256: sha256(args.bytes),
      modCount: modIds.size,
      scope: SNAPSHOT_SCOPE,
      excludedPaths: [...SNAPSHOT_EXCLUDED_PATHS],
    });
  }

  private assertSnapshotRegistry(registry: RegistrySnapshot): void {
    for (const key of registry.keys) {
      const normalized = key.path.replace(/\//g, '\\').toLowerCase();
      const excluded = MODS_WRITABLE_ROOT.toLowerCase();
      if (normalized === excluded || normalized.startsWith(`${excluded}\\`)) {
        throw new ValidationError(
          `Snapshot data contains the excluded registry subtree "${key.path}".`,
        );
      }
    }
  }

  private assertSnapshotId(id: string): void {
    const result = SnapshotIdSchema.safeParse(id);
    if (result.success) return;

    throw new ValidationError(`Invalid snapshot ID "${id}".`, [
      {
        path: ['id'],
        message: result.error.issues[0]?.message ?? 'Expected a filesystem-safe snapshot ID.',
      },
    ]);
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}
