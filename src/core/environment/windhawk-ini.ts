export interface WindhawkIni {
  readonly portable: boolean;
  readonly registryKey: string | null;
  readonly appDataPath: string | null;
  readonly enginePath: string | null;
}

function isTrue(value: string | null): boolean {
  if (value === null) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function normalized(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function parseWindhawkIni(text: string): WindhawkIni {
  const values = new Map<string, string>();
  let section = '';

  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith(';') || line.startsWith('#')) continue;

    const sectionMatch = /^\[(.+)]$/.exec(line);
    if (sectionMatch !== null) {
      section = (sectionMatch[1] ?? '').trim().toLowerCase();
      continue;
    }

    const equals = line.indexOf('=');
    if (equals === -1) continue;

    const key = line.slice(0, equals).trim().toLowerCase();
    let value = line.slice(equals + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    values.set(`${section}\u0000${key}`, value);
  }

  const get = (key: string): string | null =>
    values.get(`storage\u0000${key}`) ?? values.get(`\u0000${key}`) ?? null;

  return {
    portable: isTrue(get('portable')),
    registryKey: normalized(get('registrykey')),
    appDataPath: normalized(get('appdatapath')),
    enginePath: normalized(get('enginepath')),
  };
}

export function engineVersionFromPath(value: string | null): string | null {
  const normalizedPath = normalized(value);
  if (normalizedPath === null) return null;

  const segments = normalizedPath.split(/[\\/]/).filter((segment) => segment.length > 0);
  const candidate = segments.at(-1);
  if (candidate === undefined) return null;
  return /^\d+\.\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?$/.test(candidate) ? candidate : null;
}

export function compareVersions(left: string, right: string): number {
  const leftParts = left.split(/[.-]/);
  const rightParts = right.split(/[.-]/);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;

    const leftNumber = Number(leftPart);
    const rightNumber = Number(rightPart);
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
      if (leftNumber !== rightNumber) return leftNumber - rightNumber;
      continue;
    }

    const comparison = leftPart.localeCompare(rightPart);
    if (comparison !== 0) return comparison;
  }

  return 0;
}

export function pickHighestVersion(values: readonly string[]): string | null {
  const versions = values.filter((value) => engineVersionFromPath(value) === value);
  if (versions.length === 0) return null;
  return [...versions].sort((left, right) => compareVersions(right, left))[0] ?? null;
}
