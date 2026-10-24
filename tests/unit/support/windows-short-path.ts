import { execFileSync } from 'node:child_process';

/**
 * Windows can expose the same directory through an 8.3 short name. The test is
 * a no-op on hosts where 8.3 names are disabled or the alias is unavailable.
 */
export function windowsShortPath(path: string): string | null {
  if (process.platform !== 'win32') return null;

  const escaped = path.replace(/'/g, "''");
  try {
    const output = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${escaped}').ShortPath`,
      ],
      { encoding: 'utf8', windowsHide: true },
    ).trim();
    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
}
