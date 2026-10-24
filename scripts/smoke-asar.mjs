import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const executablePath = resolve(root, 'node_modules/electron/dist/electron.exe');
const asarPath = resolve(root, 'release/win-unpacked/resources/app.asar');

const app = await electron.launch({
  executablePath,
  args: [asarPath],
  env: {
    ...process.env,
    WPM_TITLEBAR: 'overlay',
  },
});

try {
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(500);

  const processInfo = await app.evaluate(({ app: electronApp }) => ({
    isPackaged: electronApp.isPackaged,
    name: electronApp.getName(),
    version: electronApp.getVersion(),
  }));

  const webPreferences = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return window?.webContents.getLastWebPreferences() ?? null;
  });
  assert.equal(webPreferences?.sandbox, true, 'renderer sandbox must be enabled');
  assert.equal(webPreferences?.contextIsolation, true, 'context isolation must be enabled');
  assert.equal(webPreferences?.nodeIntegration, false, 'node integration must be disabled');

  const csp = await page.evaluate(() => {
    const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    const marker = document.createElement('script');
    marker.textContent = 'window.__wpmCspProbe = 1';
    document.head.append(marker);
    marker.remove();
    return {
      content: meta?.getAttribute('content') ?? '',
      inlineRan: 'wpmCspProbe' in window,
    };
  });
  assert.match(csp.content, /script-src 'self'/);
  assert.equal(csp.inlineRan, false, 'production CSP must block inline scripts');

  const rendererInfo = await page.evaluate(async () => {
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
    };
  });
  assert.equal(
    rendererInfo.ping.rendererSandboxed,
    true,
    'the packaged preload must report a sandboxed renderer',
  );

  console.log(
    JSON.stringify(
      {
        executablePath,
        asarPath,
        processInfo,
        webPreferences,
        csp,
        rendererInfo,
      },
      null,
      2,
    ),
  );
} finally {
  await app.close();
}
