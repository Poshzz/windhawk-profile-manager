import { join } from 'node:path';
import {
  EntityIdSchema,
  SCHEMA_VERSION,
  parseProfile,
  parseProfileJson,
  type Profile,
  type ProfileActions,
  type ProfileMod,
} from '@shared/domain';
import {
  EnvironmentError,
  NotFoundError,
  StaleProfileError,
  ValidationError,
} from '@shared/errors';
import {
  AtomicJsonFile,
  isNotFoundError,
  type AtomicFileSystem,
} from '../storage/atomic-json-file';

const PROFILE_FILE_EXTENSION = '.json';
const MAX_PROFILE_ID_LENGTH = 64;
const MAX_PROFILE_NAME_LENGTH = 100;
const RESERVED_WINDOWS_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export interface CreateProfileInput {
  name: string;
  description?: string;
  requiredMods?: ProfileMod[];
  unlistedMods?: Profile['unlistedMods'];
  actions?: Partial<ProfileActions>;
}

export interface UpdateProfileInput {
  name?: string;
  description?: string;
  requiredMods?: ProfileMod[];
  unlistedMods?: Profile['unlistedMods'];
  actions?: Partial<ProfileActions>;
}

export interface ProfileStoreWarning {
  readonly fileName: string;
  readonly error: unknown;
}

export interface ProfileStoreOptions {
  builtins: readonly Profile[];
  directory?: string;
  fileSystem?: AtomicFileSystem;
  now?: () => Date;
  onWarning?: (warning: ProfileStoreWarning) => void;
}

export function defaultProfilesDirectory(): string {
  const appData = process.env.APPDATA;
  if (appData === undefined || appData.length === 0) {
    throw new EnvironmentError('APPDATA is not set; the profile directory cannot be located.');
  }

  return join(appData, 'WindhawkProfileManager', 'profiles');
}

export function slugifyProfileName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_PROFILE_ID_LENGTH)
    .replace(/-+$/g, '');

  const base = slug.length === 0 ? 'profile' : slug;
  return RESERVED_WINDOWS_NAME.test(base) ? `${base}-profile` : base;
}

function assertProfileId(id: string): void {
  const result = EntityIdSchema.safeParse(id);
  if (result.success) return;

  const issue = result.error.issues[0];
  throw new ValidationError(`Invalid profile ID "${id}".`, [
    { path: ['id'], message: issue?.message ?? 'Expected a lowercase slug.' },
  ]);
}

function assertProfileName(name: string): void {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new ValidationError('A profile name is required.');
  }
}

function copyName(name: string): string {
  const suffix = ' copy';
  const available = MAX_PROFILE_NAME_LENGTH - suffix.length;
  const trimmed = name.length > available ? name.slice(0, available).trimEnd() : name;
  return `${trimmed}${suffix}`;
}

function cloneProfile(profile: Profile): Profile {
  return structuredClone(profile);
}

function compareUpdatedAtDescending(left: Profile, right: Profile): number {
  const difference = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  return difference === 0 ? left.id.localeCompare(right.id) : difference;
}

export class ProfileStore {
  private readonly directory: string;
  private readonly files: AtomicJsonFile;
  private readonly builtins = new Map<string, Profile>();
  private readonly now: () => Date;
  private readonly onWarning: (warning: ProfileStoreWarning) => void;
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(options: ProfileStoreOptions) {
    this.directory = options.directory ?? defaultProfilesDirectory();
    this.files = new AtomicJsonFile(this.directory, options.fileSystem);
    this.now = options.now ?? (() => new Date());
    this.onWarning = options.onWarning ?? (() => undefined);

    for (const builtin of options.builtins) {
      const profile = parseProfile(builtin);
      if (profile.source !== 'builtin') {
        throw new ValidationError(`Built-in profile "${profile.id}" must have source "builtin".`);
      }
      if (this.builtins.has(profile.id)) {
        throw new ValidationError(`Duplicate built-in profile ID "${profile.id}".`);
      }
      this.builtins.set(profile.id, profile);
    }
  }

  async list(): Promise<Profile[]> {
    const fileNames = await this.files.list();
    const users = await Promise.all(
      fileNames.map(async (fileName) => {
        const id = fileName.slice(0, -PROFILE_FILE_EXTENSION.length);
        if (!EntityIdSchema.safeParse(id).success || this.builtins.has(id)) return null;
        try {
          return await this.readUserProfile(id);
        } catch (error) {
          if (error instanceof ValidationError || error instanceof NotFoundError) {
            this.onWarning({ fileName, error });
            return null;
          }
          throw error;
        }
      }),
    );

    const sortedUsers = users
      .filter((profile): profile is Profile => profile !== null)
      .sort(compareUpdatedAtDescending);

    return [
      ...Array.from(this.builtins.values(), (profile) => cloneProfile(profile)),
      ...sortedUsers,
    ];
  }

  async get(id: string): Promise<Profile> {
    assertProfileId(id);

    const builtin = this.builtins.get(id);
    if (builtin !== undefined) return cloneProfile(builtin);

    return this.readUserProfile(id);
  }

  async create(input: CreateProfileInput): Promise<Profile> {
    return this.enqueueMutation(async () => {
      assertProfileName(input.name);
      const id = await this.nextId(input.name);
      const timestamp = this.nowIso();
      const profile = parseProfile({
        schemaVersion: SCHEMA_VERSION,
        id,
        name: input.name,
        description: input.description ?? '',
        source: 'user',
        basedOn: null,
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        requiredMods: input.requiredMods ?? [],
        unlistedMods: input.unlistedMods ?? 'leave',
        actions: input.actions ?? {},
      });

      await this.writeProfile(profile);
      return profile;
    });
  }

  async update(id: string, expectedRevision: number, input: UpdateProfileInput): Promise<Profile> {
    return this.enqueueMutation(async () => {
      const current = await this.getWritableProfile(id);
      if (current.revision !== expectedRevision) {
        throw new StaleProfileError(
          `Profile "${id}" changed (expected revision ${expectedRevision}, found ${current.revision}). Reload it and try again.`,
        );
      }

      const profile = parseProfile({
        ...current,
        name: input.name ?? current.name,
        description: input.description ?? current.description,
        requiredMods: input.requiredMods ?? current.requiredMods,
        unlistedMods: input.unlistedMods ?? current.unlistedMods,
        actions:
          input.actions === undefined ? current.actions : { ...current.actions, ...input.actions },
        revision: current.revision + 1,
        updatedAt: this.nowIso(),
      });

      await this.writeProfile(profile);
      return profile;
    });
  }

  async delete(id: string, options: { confirm: boolean }): Promise<void> {
    return this.enqueueMutation(async () => {
      if (options?.confirm !== true) {
        throw new ValidationError('Deleting a profile requires explicit confirmation.');
      }

      this.assertWritableId(id);
      try {
        await this.files.delete(`${id}${PROFILE_FILE_EXTENSION}`);
      } catch (error) {
        if (isNotFoundError(error)) {
          throw new NotFoundError(`Profile "${id}" was not found.`, { cause: error });
        }
        throw error;
      }
    });
  }

  async duplicate(id: string, name?: string): Promise<Profile> {
    return this.enqueueMutation(async () => {
      const source = await this.get(id);
      const duplicateName = name ?? copyName(source.name);
      assertProfileName(duplicateName);

      const duplicateId = await this.nextId(duplicateName);
      const timestamp = this.nowIso();
      const profile = parseProfile({
        ...source,
        id: duplicateId,
        name: duplicateName,
        source: 'user',
        basedOn: source.id,
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      });

      await this.writeProfile(profile);
      return profile;
    });
  }

  async import(json: string): Promise<Profile> {
    return this.enqueueMutation(async () => {
      const profile = parseProfileJson(json);
      if (profile.source === 'builtin') {
        throw new ValidationError(
          'Built-in profiles cannot be imported. Duplicate the built-in instead.',
        );
      }
      if (this.builtins.has(profile.id)) {
        throw new ValidationError(`A built-in profile already uses the ID "${profile.id}".`);
      }

      if (await this.fileExists(`${profile.id}${PROFILE_FILE_EXTENSION}`)) {
        throw new ValidationError(`A profile with ID "${profile.id}" already exists.`);
      }

      await this.writeProfile(profile);
      return profile;
    });
  }

  async export(id: string): Promise<string> {
    const profile = await this.get(id);
    return `${JSON.stringify(profile, null, 2)}\n`;
  }

  private assertWritableId(id: string): void {
    assertProfileId(id);
    if (this.builtins.has(id)) {
      throw new ValidationError(
        `Built-in profile "${id}" is read-only. Duplicate it to make an editable copy.`,
      );
    }
  }

  private async getWritableProfile(id: string): Promise<Profile> {
    this.assertWritableId(id);
    return this.readUserProfile(id);
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async readUserProfile(id: string): Promise<Profile> {
    let raw: unknown;
    try {
      raw = await this.files.read(`${id}${PROFILE_FILE_EXTENSION}`);
    } catch (error) {
      if (isNotFoundError(error)) {
        throw new NotFoundError(`Profile "${id}" was not found.`, { cause: error });
      }
      throw error;
    }

    const profile = parseProfile(raw);
    if (profile.id !== id) {
      throw new ValidationError(
        `Profile file "${id}${PROFILE_FILE_EXTENSION}" contains ID "${profile.id}".`,
      );
    }
    return profile;
  }

  private async fileExists(fileName: string): Promise<boolean> {
    const normalized = fileName.toLowerCase();
    const fileNames = await this.files.list();
    return fileNames.some((name) => name.toLowerCase() === normalized);
  }

  private async writeProfile(profile: Profile): Promise<void> {
    await this.files.write(`${profile.id}${PROFILE_FILE_EXTENSION}`, profile);
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  private async nextId(name: string): Promise<string> {
    const base = slugifyProfileName(name);
    const fileNames = await this.files.list();
    const existing = new Set<string>(this.builtins.keys());
    for (const fileName of fileNames) {
      if (!fileName.toLowerCase().endsWith(PROFILE_FILE_EXTENSION)) continue;
      existing.add(fileName.slice(0, -PROFILE_FILE_EXTENSION.length).toLowerCase());
    }

    if (!existing.has(base)) return base;

    for (let index = 2; index < 10_000; index += 1) {
      const suffix = `-${index}`;
      const available = Math.max(1, MAX_PROFILE_ID_LENGTH - suffix.length);
      const prefix = base.slice(0, available).replace(/-+$/g, '');
      const candidate = `${prefix}${suffix}`;
      if (!existing.has(candidate)) return candidate;
    }

    throw new ValidationError('Unable to allocate a unique profile ID.');
  }
}
