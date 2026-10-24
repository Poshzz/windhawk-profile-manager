import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve('.');

describe('release configuration', () => {
  it('keeps the helper install directory fixed under Program Files', () => {
    const builder = readFileSync(resolve(root, 'electron-builder.yml'), 'utf8');
    expect(builder).toContain('allowToChangeInstallationDirectory: false');
    expect(builder).toContain('executableName: WindhawkProfileManager');
    expect(builder).toContain('perMachine: true');
  });

  it('ships a real Windows icon and references it', () => {
    const icon = resolve(root, 'resources', 'icon.ico');
    expect(existsSync(icon)).toBe(true);
    expect(statSync(icon).size).toBeGreaterThan(1_000);
    const bytes = readFileSync(icon);
    expect(bytes.readUInt16LE(0)).toBe(0);
    expect(bytes.readUInt16LE(2)).toBe(1);
    expect(readFileSync(resolve(root, 'electron-builder.yml'), 'utf8')).toContain(
      'icon: resources/icon.ico',
    );
  });

  it('documents the release gate, MIT license, notes, and checksum script', () => {
    const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
    expect(readme).toContain('Developer Build Notice');
    expect(readme).toContain('Smart App Control');
    expect(readme).toContain('MIT License');
    expect(readme).toContain('npm run release:checksums');
    expect(existsSync(resolve(root, 'LICENSE'))).toBe(true);
    expect(readFileSync(resolve(root, 'LICENSE'), 'utf8')).toContain('MIT License');
    expect(existsSync(resolve(root, 'docs', 'release-notes', 'v0.1.0.md'))).toBe(true);
    expect(existsSync(resolve(root, 'scripts', 'write-checksums.mjs'))).toBe(true);
  });

  it('keeps production fuses and packaged smoke assertions wired', () => {
    const afterPack = readFileSync(resolve(root, 'scripts', 'after-pack.cjs'), 'utf8');
    expect(afterPack).toContain('RunAsNode');
    expect(afterPack).toContain('OnlyLoadAppFromAsar');
    const packagedSmoke = readFileSync(resolve(root, 'scripts', 'smoke-packaged.mjs'), 'utf8');
    expect(packagedSmoke).toContain('getCurrentFuseWire');
    expect(packagedSmoke).toContain('externalRequests');
    expect(packagedSmoke).toContain('inlineRan');
    const fuseSmoke = readFileSync(resolve(root, 'scripts', 'verify-fuses.mjs'), 'utf8');
    expect(fuseSmoke).toContain('GrantFileProtocolExtraPrivileges');
    expect(fuseSmoke).toContain('OnlyLoadAppFromAsar');
  });
});
