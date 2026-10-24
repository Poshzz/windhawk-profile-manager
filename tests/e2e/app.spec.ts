import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import packageJson from '../../package.json';
import th from '../../src/renderer/i18n/locales/th.json';

interface LaunchResult {
  app: ElectronApplication;
  userDataDir: string;
}

function createUserDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'wpm-e2e-'));
}

async function launch(
  mode: 'overlay' | 'custom',
  userDataDir = createUserDataDir(),
  fakeEnv: 'ready' | 'missing' | 'readonly' | 'stopped' | 'drift' = 'ready',
  fakeApply:
    | 'success'
    | 'noop'
    | 'partial'
    | 'warning'
    | 'rollback'
    | 'rollback-failed'
    | 'cancel' = 'success',
  fakeIo = false,
  extraEnv: Record<string, string> = {},
): Promise<LaunchResult> {
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      WPM_TITLEBAR: mode,
      WPM_LOCALE: 'en',
      WPM_FAKE_ENV: fakeEnv,
      WPM_FAKE_APPLY: fakeApply,
      ...(fakeIo ? { WPM_FAKE_IO_DIR: userDataDir } : {}),
      ...extraEnv,
      NODE_ENV: 'test',
    },
  });
  return { app, userDataDir };
}

async function openApplyDialog(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Apply active profile' }).click();
  await expect(page.getByRole('heading', { name: 'Review Mac Blur Glass' })).toBeVisible();
}

async function cleanup(app: ElectronApplication, userDataDir: string): Promise<void> {
  await app.close().catch(() => undefined);
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

test('opens at the designed size, enforces the minimum, and exposes the typed bridge', async () => {
  const { app, userDataDir } = await launch('overlay');
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    await expect(page.getByRole('heading', { name: 'Windhawk Profile Manager' })).toBeVisible();

    const windowState = await app.evaluate(({ BrowserWindow, screen }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (window === undefined) throw new Error('No application window');
      const bounds = window.getBounds();
      window.setSize(700, 400);
      return {
        bounds,
        minimum: window.getMinimumSize(),
        enforced: window.getSize(),
        workArea: screen.getPrimaryDisplay().workAreaSize,
      };
    });
    // The CI desktop can be 1024px wide; the OS clamps the requested window to
    // the work area. Windows also adds a small invisible frame at some scales.
    const expectedWidth = Math.min(1120, windowState.workArea.width);
    const expectedHeight = Math.min(740, windowState.workArea.height);
    expect(windowState.bounds.width).toBeGreaterThanOrEqual(expectedWidth - 8);
    expect(windowState.bounds.width).toBeLessThanOrEqual(expectedWidth + 8);
    expect(windowState.bounds.height).toBeGreaterThanOrEqual(expectedHeight - 8);
    expect(windowState.bounds.height).toBeLessThanOrEqual(expectedHeight + 8);
    expect(windowState.minimum).toEqual([900, 600]);
    expect(windowState.enforced[0]).toBeGreaterThanOrEqual(900);
    expect(windowState.enforced[1]).toBeGreaterThanOrEqual(600);

    const result = await page.evaluate(async () => {
      const [ping, versions, config] = await Promise.all([
        window.api.ping(),
        window.api.getVersions(),
        window.api.getConfig(),
      ]);

      return {
        ping,
        versions,
        config,
        hasRequire: 'require' in window,
        hasProcess: 'process' in window,
        hasElectron: 'electron' in window,
        theme: document.documentElement.dataset['theme'],
        lang: document.documentElement.lang,
      };
    });

    expect(result.ping).toMatchObject({ ok: true, message: 'pong' });
    expect(result.versions.app).toBe(packageJson.version);
    expect(result.config.titlebarMode).toBe('overlay');
    expect(result.config.systemLocale).toBe('en');
    expect(['mica', 'opaque']).toContain(result.config.backgroundMaterial);
    expect(['light', 'dark']).toContain(result.theme);
    expect(result.lang).toBe('en');
    expect(result.hasRequire).toBe(false);
    expect(result.hasProcess).toBe(false);
    expect(result.hasElectron).toBe(false);

    await expect(page.getByText(`Version ${packageJson.version}`)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Component gallery' })).toHaveCount(0);
  } finally {
    await cleanup(app, userDataDir);
  }
});

test('navigates all five sidebar screens', async () => {
  const { app, userDataDir } = await launch('overlay');
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    const nav = page.getByRole('navigation', { name: 'Primary' });
    const screens = [
      [
        'Profiles',
        'Switch between complete Windhawk setups. Capture the current machine, edit a copy, and keep built-in profiles read-only.',
      ],
      [
        'Snapshots',
        'Review snapshot evidence, verify checksums, restore a captured state, and export or delete .reg files.',
      ],
      ['Theme Packs', 'All 10 required mods are installed.'],
      [
        'Settings',
        'Control language, appearance, Explorer restarts, snapshot retention, and support diagnostics. Everything stays on this PC.',
      ],
    ] as const;

    for (const [label, body] of screens) {
      const button = nav.getByRole('button', { name: label });
      await button.click();
      await expect(button).toHaveAttribute('aria-current', 'page');
      await expect(page.getByText(body)).toBeVisible();
    }

    await nav.getByRole('button', { name: 'Home' }).click();
    await expect(page.getByRole('heading', { name: 'Windhawk Profile Manager' })).toBeVisible();
  } finally {
    await cleanup(app, userDataDir);
  }
});

test('reaches every shell control by keyboard with a visible focus ring', async () => {
  const { app, userDataDir } = await launch('overlay');
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('h1');

    const stops = ['Home', 'Profiles', 'Snapshots', 'Theme Packs', 'Settings', 'EN', 'TH'];
    for (const name of stops) {
      await page.keyboard.press('Tab');
      const focused = page.getByRole('button', { name, exact: true });
      await expect(focused).toBeFocused();
      await expect
        .poll(() => focused.evaluate((element) => getComputedStyle(element).outlineWidth))
        .toBe('2px');
    }

    await page.keyboard.press('Tab');
    await expect(page.getByRole('combobox', { name: 'Theme' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeFocused();
  } finally {
    await cleanup(app, userDataDir);
  }
});

test('renders the fake environment, active profile, and drift on Home', async () => {
  const { app, userDataDir } = await launch('overlay', undefined, 'ready');
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    await expect(page.getByText('10 of 10 enabled')).toBeVisible();
    await expect(page.getByText('Windhawk 1.7.3')).toBeVisible();
    await expect(page.getByText('Running', { exact: true })).toBeVisible();
    await expect(page.getByText('Mac Blur Glass', { exact: true })).toBeVisible();
    await expect(page.getByText('Matches', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Recent snapshots' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Back up now' })).toBeEnabled();
  } finally {
    await cleanup(app, userDataDir);
  }
});

test('shows a missing Windhawk state and disables apply', async () => {
  const { app, userDataDir } = await launch('overlay', undefined, 'missing');
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    await expect(page.getByText('Not found', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Apply active profile' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Back up now' })).toBeDisabled();
  } finally {
    await cleanup(app, userDataDir);
  }
});

test('shows read-only mode and a stopped service action', async () => {
  const { app, userDataDir } = await launch('overlay', undefined, 'readonly');
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByText('Read-only mode')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Apply active profile' })).toBeDisabled();
  } finally {
    await cleanup(app, userDataDir);
  }
});

test('starts a stopped Windhawk service from Home', async () => {
  const { app, userDataDir } = await launch('overlay', undefined, 'stopped');
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    await expect(page.getByText('Windhawk service is stopped')).toBeVisible();
    await page.getByRole('button', { name: 'Start service' }).click();
    await expect(page.getByText('Windhawk service is stopped')).toHaveCount(0);
  } finally {
    await cleanup(app, userDataDir);
  }
});

test('shows drift details when a managed mod differs', async () => {
  const { app, userDataDir } = await launch('overlay', undefined, 'drift');
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    await expect(page.getByText('1 differences', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Show drift details' }).click();
    await expect(page.getByText(/is disabled but the profile wants it enabled/)).toBeVisible();
  } finally {
    await cleanup(app, userDataDir);
  }
});

test('applies a fake profile from the plan dialog through success', async () => {
  const { app, userDataDir } = await launch('overlay', undefined, 'drift', 'success');
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    await page.getByRole('button', { name: 'Snapshots', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Snapshots', level: 1 })).toBeVisible();
    await expect(page.getByRole('listitem').first()).toBeVisible();
    const snapshotCountBefore = await page.locator('button[aria-expanded]').count();
    await page.getByRole('button', { name: 'Home', exact: true }).click();
    await openApplyDialog(page);

    await expect(
      page.getByText('A snapshot will be created before any registry write.'),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Apply now' }).click();
    await expect(page.getByText('Applying profile')).toBeVisible();
    await expect(page.getByText('Applied; reload requested, not confirmed loaded.')).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByRole('button', { name: 'View snapshot' })).toBeVisible();
    await page.getByRole('button', { name: 'View snapshot' }).click();
    await expect(page.getByRole('heading', { name: 'Snapshots', level: 1 })).toBeVisible();
    await expect
      .poll(() => page.locator('button[aria-expanded]').count())
      .toBe(snapshotCountBefore + 1);
    await page.getByRole('button', { name: 'Home', exact: true }).click();
    await expect(page.getByText('Matches', { exact: true })).toBeVisible();
  } finally {
    await cleanup(app, userDataDir);
  }
});

test('shows a no-op plan without starting a run', async () => {
  const { app, userDataDir } = await launch('overlay', undefined, 'ready', 'noop');
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await openApplyDialog(page);

    await expect(
      page.getByText('No registry or finishing action changes are needed.'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Apply now' })).toBeDisabled();
  } finally {
    await cleanup(app, userDataDir);
  }
});

test('shows skipped mods from a partial apply result', async () => {
  const { app, userDataDir } = await launch('overlay', undefined, 'ready', 'partial');
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await openApplyDialog(page);
    await page.getByRole('button', { name: 'Apply now' }).click();

    await expect(page.getByText(/A managed mod is not installed/).first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText('Skipped mods')).toBeVisible();
  } finally {
    await cleanup(app, userDataDir);
  }
});

test('shows the rolled-back result and keeps the snapshot offer', async () => {
  const { app, userDataDir } = await launch('overlay', undefined, 'ready', 'rollback');
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await openApplyDialog(page);
    await page.getByRole('button', { name: 'Apply now' }).click();

    await expect(page.getByText('Rolled back', { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByRole('button', { name: 'View snapshot' })).toBeVisible();
  } finally {
    await cleanup(app, userDataDir);
  }
});

test('shows manual recovery steps after a rollback failure', async () => {
  const { app, userDataDir } = await launch('overlay', undefined, 'ready', 'rollback-failed');
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await openApplyDialog(page);
    await page.getByRole('button', { name: 'Apply now' }).click();

    await expect(page.getByText('Rollback failed', { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText(/Restore this snapshot manually/)).toBeVisible();
  } finally {
    await cleanup(app, userDataDir);
  }
});

test('returns to the plan with a neutral notice when UAC is canceled', async () => {
  const { app, userDataDir } = await launch('overlay', undefined, 'ready', 'cancel');
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await openApplyDialog(page);
    await page.getByRole('button', { name: 'Apply now' }).click();

    await expect(page.getByText(/UAC prompt was canceled/)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'Apply now' })).toBeEnabled();
  } finally {
    await cleanup(app, userDataDir);
  }
});

test('shows a ready theme-pack checklist and opens the apply plan', async () => {
  const { app, userDataDir } = await launch('overlay', undefined, 'ready');
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.getByRole('button', { name: 'Theme Packs', exact: true }).click();

    await expect(page.getByText('All 10 required mods are installed.')).toBeVisible();
    const apply = page.getByRole('button', { name: 'Apply Mac Blur Glass' });
    await expect(apply).toBeEnabled();
    await apply.click();
    await expect(page.getByRole('heading', { name: 'Review Mac Blur Glass' })).toBeVisible();
  } finally {
    await cleanup(app, userDataDir);
  }
});

test('shows a missing theme-pack checklist and disables apply', async () => {
  const { app, userDataDir } = await launch('overlay', undefined, 'missing');
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.getByRole('button', { name: 'Theme Packs', exact: true }).click();

    await expect(page.getByText('10 required mods are missing.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Apply Mac Blur Glass' })).toBeDisabled();
    await expect(page.getByText('Icon Resource Redirect').first()).toBeVisible();
  } finally {
    await cleanup(app, userDataDir);
  }
});

test('captures, duplicates, edits, and deletes profiles', async () => {
  const userDataDir = createUserDataDir();
  const { app } = await launch('overlay', userDataDir, 'ready', 'success', true);
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.getByRole('button', { name: 'Profiles', exact: true }).click();

    await expect(page.getByRole('heading', { name: 'Profiles', level: 1 })).toBeVisible();
    const builtin = page.locator('article[aria-labelledby="profiles-card-mac-blur-glass"]');
    await expect(builtin).toBeVisible();
    await expect(builtin.getByRole('button', { name: 'Edit' })).toHaveCount(0);
    await expect(builtin.getByRole('button', { name: 'Delete' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Capture current setup' }).first().click();
    await page.getByLabel('Profile name').fill('E2E Capture');
    await expect(page.getByRole('checkbox', { name: /Include disabled mods/ })).toBeChecked();
    await page.getByRole('button', { name: 'Capture profile' }).click();
    await expect(page.getByText('Profile captured')).toBeVisible();
    await page.getByRole('button', { name: 'Open profile' }).click();
    await expect(page.getByRole('heading', { name: 'Edit E2E Capture' })).toBeVisible();
    await page.getByRole('button', { name: 'Back to profiles' }).click();

    await builtin.getByRole('button', { name: 'Duplicate' }).click();
    await expect(page.getByText('Profile duplicated')).toBeVisible();
    const copy = page.locator('article[aria-labelledby="profiles-card-mac-blur-glass-copy"]');
    await expect(copy).toBeVisible();
    await copy.getByRole('button', { name: 'Edit' }).click();
    await page.getByLabel('Name', { exact: true }).fill('E2E Edited');
    await page.getByRole('button', { name: 'Save profile' }).click();
    await expect(page.getByText('Profile saved')).toBeVisible();

    const edited = page.locator('article[aria-labelledby="profiles-card-mac-blur-glass-copy"]');
    await expect(edited.getByRole('heading', { name: 'E2E Edited' })).toBeVisible();
    await edited.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('button', { name: 'Delete profile' }).click();
    await expect(page.getByText('Profile deleted')).toBeVisible();
    await expect(edited).toHaveCount(0);
  } finally {
    await cleanup(app, userDataDir);
  }
});

test('imports and exports a profile through the fake file dialog', async () => {
  const userDataDir = createUserDataDir();
  const imported = JSON.parse(
    readFileSync(join(process.cwd(), 'resources', 'profiles', 'default-windows.json'), 'utf8'),
  ) as Record<string, unknown>;
  imported.id = 'imported-e2e';
  imported.name = 'Imported E2E';
  imported.source = 'user';
  imported.revision = 1;
  imported.basedOn = null;
  imported.createdAt = '2026-10-22T20:05:00.000Z';
  imported.updatedAt = '2026-10-22T20:05:00.000Z';
  writeFileSync(join(userDataDir, 'import-profile.json'), JSON.stringify(imported, null, 2));

  const { app } = await launch('overlay', userDataDir, 'ready', 'success', true);
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.getByRole('button', { name: 'Profiles', exact: true }).click();

    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(page.getByText('Profile imported')).toBeVisible();
    const card = page.locator('article[aria-labelledby="profiles-card-imported-e2e"]');
    await expect(card.getByRole('heading', { name: 'Imported E2E' })).toBeVisible();

    await card.getByRole('button', { name: 'Export' }).click();
    await expect(page.getByText('Profile exported')).toBeVisible();
    const exportedPath = join(userDataDir, 'imported-e2e-export.json');
    expect(existsSync(exportedPath)).toBe(true);
    expect(JSON.parse(readFileSync(exportedPath, 'utf8'))).toEqual(imported);
  } finally {
    await cleanup(app, userDataDir);
  }
});

test('restores a snapshot through the fake registry and keeps the pre-restore snapshot', async () => {
  const { app, userDataDir } = await launch('overlay', undefined, 'ready');
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.getByRole('button', { name: 'Snapshots', exact: true }).click();

    await expect(page.getByRole('heading', { name: 'Snapshots', level: 1 })).toBeVisible();
    await page.locator('button[aria-expanded]').first().click();
    await expect(page.getByText('Checksum verified')).toBeVisible();
    await page.getByRole('button', { name: 'Restore', exact: true }).click();
    await expect(page.getByText('Restore this snapshot?')).toBeVisible();
    await expect(page.getByText(/full-state restore/)).toBeVisible();
    await expect(page.getByText(/pre-restore snapshot is created/)).toBeVisible();
    await page.getByRole('button', { name: 'Restore now' }).click();

    await expect(page.getByText('Restored', { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/pre-restore snapshot was created/)).toBeVisible();
    await page.getByRole('button', { name: 'Close', exact: true }).last().click();
    await expect(page.getByText('Pre-restore', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Home', exact: true }).click();
    await expect(page.getByText('1 differences', { exact: true })).toBeVisible();
  } finally {
    await cleanup(app, userDataDir);
  }
});

test('imports, exports, and deletes a snapshot through fake dialogs', async () => {
  const userDataDir = createUserDataDir();
  writeFileSync(
    join(userDataDir, 'import-snapshot.reg'),
    readFileSync(join(process.cwd(), 'tests', 'fixtures', 'Mac_BlurGlass_Profile.reg')),
  );
  const { app } = await launch('overlay', userDataDir, 'ready', 'success', true);
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.getByRole('button', { name: 'Snapshots', exact: true }).click();

    await page.getByRole('button', { name: 'Import .reg snapshot' }).click();
    await expect(page.getByText('Snapshot imported', { exact: true })).toBeVisible();
    await page.locator('button[aria-expanded]').first().click();
    await expect(page.getByText('Checksum verified')).toBeVisible();
    await page.getByRole('button', { name: 'Export .reg' }).click();
    await expect(page.getByText('Snapshot exported', { exact: true })).toBeVisible();
    const exported = readdirSync(userDataDir).filter((name) => name.endsWith('-export.reg'));
    expect(exported.length).toBeGreaterThan(0);
    expect(readFileSync(join(userDataDir, exported[0]!)).byteLength).toBeGreaterThan(0);
    const exportedMetadata = readdirSync(userDataDir).filter((name) =>
      name.endsWith('-export.json'),
    );
    expect(exportedMetadata.length).toBeGreaterThan(0);
    expect(
      JSON.parse(readFileSync(join(userDataDir, exportedMetadata[0]!), 'utf8')),
    ).toHaveProperty('registrySha256');

    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByText('Delete this snapshot?')).toBeVisible();
    await page.getByRole('button', { name: 'Delete snapshot' }).click();
    await expect(page.getByText('Snapshot deleted')).toBeVisible();
  } finally {
    await cleanup(app, userDataDir);
  }
});

test('completes first-run onboarding exactly into the chosen destination', async () => {
  const { app, userDataDir } = await launch('overlay', undefined, 'ready', 'success', false, {
    WPM_FAKE_FIRST_RUN: '1',
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    await expect(
      page.getByRole('heading', { name: 'Welcome to Windhawk Profile Manager' }),
    ).toBeVisible();
    await expect(page.getByText(/A snapshot comes first/)).toBeVisible();
    await page.getByRole('button', { name: 'Continue to Home' }).click();
    await expect(
      page.getByRole('heading', { name: 'Windhawk Profile Manager', level: 1 }),
    ).toBeVisible();
  } finally {
    await cleanup(app, userDataDir);
  }
});

test('restores an interrupted run from the recovery dialog', async () => {
  const { app, userDataDir } = await launch('overlay', undefined, 'ready', 'success', false, {
    WPM_FAKE_RECOVERY: '1',
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    await expect(page.getByText('Recover an unfinished run')).toBeVisible();
    await expect(page.getByText('run-fake-recovery', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Restore pre-apply snapshot' }).click();
    await expect(page.getByText('Restored', { exact: true })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Close', exact: true }).last().click();
    await expect(page.getByText('Recover an unfinished run')).toHaveCount(0);
  } finally {
    await cleanup(app, userDataDir);
  }
});

test('persists settings changes and applies language and theme live', async () => {
  const { app, userDataDir } = await launch('overlay');
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();

    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
    await page.getByLabel('Appearance').selectOption('dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByLabel('Language', { exact: true }).selectOption('th');
    await expect(page.getByRole('navigation', { name: 'การนำทางหลัก' })).toBeVisible();
    await page.getByRole('button', { name: 'EN', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  } finally {
    await cleanup(app, userDataDir);
  }
});

test('switches Thai and English live and persists the choice', async () => {
  const { app, userDataDir } = await launch('overlay');
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    await page.getByRole('button', { name: 'TH', exact: true }).click();
    await expect(page.getByRole('navigation', { name: th.a11y.primaryNavigation })).toBeVisible();
    await expect(page.getByText(th.home.body)).toBeVisible();
    await expect(page.getByRole('button', { name: th.nav.profiles, exact: true })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'th');

    await page.reload();
    await expect(page.getByRole('navigation', { name: th.a11y.primaryNavigation })).toBeVisible();
    await expect(page.getByText(th.home.body)).toBeVisible();

    await page.getByRole('button', { name: 'EN', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  } finally {
    await cleanup(app, userDataDir);
  }
});

test('applies light, dark, and system themes and persists the choice', async () => {
  const { app, userDataDir } = await launch('overlay');
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    const select = page.getByRole('combobox', { name: 'Theme' });

    await select.selectOption('dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect
      .poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource))
      .toBe('dark');

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.getByRole('combobox', { name: 'Theme' }).selectOption('light');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect
      .poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource))
      .toBe('light');

    await page.getByRole('combobox', { name: 'Theme' }).selectOption('system');
    const systemDark = await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors);
    await expect(page.locator('html')).toHaveAttribute('data-theme', systemDark ? 'dark' : 'light');
  } finally {
    await cleanup(app, userDataDir);
  }
});

test('remembers window size and position across launches', async () => {
  const userDataDir = createUserDataDir();
  let first = await launch('overlay', userDataDir);
  try {
    const page = await first.app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await first.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setBounds({ x: 90, y: 80, width: 1000, height: 650 });
    });
    await first.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close();
    });
    await new Promise<void>((resolve) => first.app.process().once('exit', () => resolve()));
    await first.app.close().catch(() => undefined);

    first = await launch('overlay', userDataDir);
    const pageAfter = await first.app.firstWindow();
    await pageAfter.waitForLoadState('domcontentloaded');
    const bounds = await first.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (window === undefined) throw new Error('No application window');
      return window.getBounds();
    });
    expect(bounds.width).toBeGreaterThanOrEqual(995);
    expect(bounds.width).toBeLessThanOrEqual(1005);
    expect(bounds.height).toBeGreaterThanOrEqual(645);
    expect(bounds.height).toBeLessThanOrEqual(655);
    expect(Math.abs(bounds.x - 90)).toBeLessThanOrEqual(2);
    expect(Math.abs(bounds.y - 80)).toBeLessThanOrEqual(2);
  } finally {
    await cleanup(first.app, userDataDir);
  }
});

test('custom titlebar controls maximize, restore, minimize, and close the window', async () => {
  const { app, userDataDir } = await launch('custom');
  let closed = false;
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByRole('button', { name: 'Maximize window' })).toBeVisible();

    const isMaximized = (): Promise<boolean> =>
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMaximized() ?? false);
    const isMinimized = (): Promise<boolean> =>
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMinimized() ?? false);

    await page.getByRole('button', { name: 'Maximize window' }).click();
    await expect.poll(isMaximized).toBe(true);
    await page.getByRole('button', { name: 'Restore window' }).click();
    await expect.poll(isMaximized).toBe(false);

    await page.locator('header').dblclick();
    await expect.poll(isMaximized).toBe(true);
    await page.locator('header').dblclick();
    await expect.poll(isMaximized).toBe(false);

    const appRegion = await page
      .locator('header')
      .evaluate((element) => getComputedStyle(element).getPropertyValue('-webkit-app-region'));
    expect(appRegion).toBe('drag');

    await page.getByRole('button', { name: 'Minimize window' }).click();
    await expect.poll(isMinimized).toBe(true);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.restore());
    await expect.poll(isMinimized).toBe(false);

    const exitPromise = new Promise<void>((resolve) => {
      app.process().once('exit', () => resolve());
    });
    await page.getByRole('button', { name: 'Close window' }).click();
    await exitPromise;
    closed = true;
  } finally {
    if (!closed) {
      await cleanup(app, userDataDir);
    } else {
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
});
