import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseProfile, parseThemePack, type Profile, type ThemePack } from '@shared/domain';
import { ValidationError } from '@shared/errors';

export interface BundledContent {
  readonly profiles: Profile[];
  readonly themePacks: ThemePack[];
}

async function readProfiles(directory: string): Promise<Profile[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    throw new ValidationError('The bundled profiles directory could not be read.', [], {
      cause: error,
    });
  }

  const profiles: Profile[] = [];
  for (const name of names.filter((entry) => entry.toLowerCase().endsWith('.json')).sort()) {
    const text = await readFile(join(directory, name), 'utf8');
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new ValidationError(`Bundled profile "${name}" is not valid JSON.`, [], {
        cause: error,
      });
    }
    const profile = parseProfile(value);
    if (profile.source !== 'builtin') {
      throw new ValidationError(`Bundled profile "${profile.id}" must have source "builtin".`);
    }
    profiles.push(profile);
  }

  return profiles;
}

async function readThemePacks(directory: string): Promise<ThemePack[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new ValidationError('The bundled theme-packs directory could not be read.', [], {
      cause: error,
    });
  }

  const packs: ThemePack[] = [];
  for (const entry of entries
    .filter((item) => item.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const text = await readFile(join(directory, entry.name, 'pack.json'), 'utf8');
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new ValidationError(`Theme pack "${entry.name}" is not valid JSON.`, [], {
        cause: error,
      });
    }
    packs.push(parseThemePack(value));
  }
  return packs;
}

/**
 * Loads the immutable files shipped under `resources/`. Both the GUI and the
 * elevated helper read them from the app path, never from a user-editable
 * location.
 */
export async function loadBundledContent(directory: string): Promise<BundledContent> {
  const [profiles, themePacks] = await Promise.all([
    readProfiles(join(directory, 'profiles')),
    readThemePacks(join(directory, 'theme-packs')),
  ]);
  const profileIds = new Set(profiles.map((profile) => profile.id));
  if (profileIds.size !== profiles.length) {
    throw new ValidationError('Bundled profiles contain duplicate IDs.');
  }
  for (const pack of themePacks) {
    for (const profileId of pack.profiles) {
      if (!profileIds.has(profileId)) {
        throw new ValidationError(
          `Theme pack "${pack.id}" references missing bundled profile "${profileId}".`,
        );
      }
    }
  }

  return {
    profiles: profiles.sort((left, right) => left.id.localeCompare(right.id)),
    themePacks,
  };
}
