import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses';

const mode = process.env.WPM_TITLEBAR === 'custom' ? 'custom' : 'overlay';
const executablePath = resolve('release/win-unpacked/WindhawkProfileManager.exe');
const screenshotPath = resolve(`.tmp/packaged-smoke/titlebar-${mode}.png`);
const userDataDir = resolve(`.tmp/packaged-smoke-${mode}`);
const port = 9333;

async function waitForPort(portNumber, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connected = await new Promise((resolveConnection) => {
      const socket = connect({ host: '127.0.0.1', port: portNumber }, () => {
        socket.end();
        resolveConnection(true);
      });
      socket.on('error', () => resolveConnection(false));
      socket.setTimeout(500, () => {
        socket.destroy();
        resolveConnection(false);
      });
    });
    if (connected) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  throw new Error(`Timed out waiting for the DevTools port ${portNumber}`);
}

await rm(userDataDir, { recursive: true, force: true });
const child = spawn(
  executablePath,
  [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`],
  {
    env: { ...process.env, WPM_TITLEBAR: mode },
    stdio: 'ignore',
    windowsHide: true,
  },
);

let browser;
try {
  await waitForPort(port);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  if (context === undefined) throw new Error('No CDP browser context');
  const page = context.pages()[0] ?? (await context.waitForEvent('page'));
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(500);

  const fuseWire = await getCurrentFuseWire(executablePath);
  assert.equal(fuseWire[FuseV1Options.RunAsNode], FuseState.DISABLE);
  assert.equal(fuseWire[FuseV1Options.EnableNodeOptionsEnvironmentVariable], FuseState.DISABLE);
  assert.equal(fuseWire[FuseV1Options.EnableNodeCliInspectArguments], FuseState.DISABLE);
  assert.equal(fuseWire[FuseV1Options.OnlyLoadAppFromAsar], FuseState.ENABLE);

  const externalRequests = [];
  page.on('request', (request) => {
    const url = request.url();
    if (/^https?:/i.test(url) && !url.startsWith('http://127.0.0.1:9333')) {
      externalRequests.push(url);
    }
  });
  await page.addInitScript(() => {
    const attempts = [];
    window.__wpmNetworkAttempts = attempts;
    const originalFetch = window.fetch;
    window.fetch = (...args) => {
      attempts.push(String(args[0]));
      return originalFetch(...args);
    };
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      attempts.push(String(url));
      return originalOpen.call(this, method, url, ...rest);
    };
    const originalBeacon = navigator.sendBeacon?.bind(navigator);
    if (originalBeacon !== undefined) {
      navigator.sendBeacon = (url, data) => {
        attempts.push(String(url));
        return originalBeacon(url, data);
      };
    }
  });
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(500);
  const networkAttempts = await page.evaluate(() => window.__wpmNetworkAttempts ?? []);

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
  assert.deepEqual(externalRequests, [], 'the app must not make outbound network requests');
  assert.deepEqual(networkAttempts, [], 'the app must not attempt outbound network requests');

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
  await mkdir(resolve('.tmp/packaged-smoke'), { recursive: true });
  await page.screenshot({ path: screenshotPath, fullPage: true });

  console.log(
    JSON.stringify(
      {
        executablePath,
        titlebarMode: mode,
        screenshotPath,
        fuseWire,
        csp,
        externalRequests,
        networkAttempts,
        rendererInfo,
      },
      null,
      2,
    ),
  );
} finally {
  const exitPromise = new Promise((resolveExit) => child.once('exit', resolveExit));
  await browser?.close().catch(() => undefined);
  child.kill();
  await exitPromise;
  await rm(userDataDir, { recursive: true, force: true });
}
