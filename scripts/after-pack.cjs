const fs = require('node:fs');
const path = require('node:path');

module.exports = async function afterPack(context) {
  const { flipFuses, FuseVersion, FuseV1Options } = await import('@electron/fuses');
  const appOutDir = context.appOutDir;
  const candidates = fs
    .readdirSync(appOutDir)
    .filter(
      (name) => name.toLowerCase().endsWith('.exe') && !name.toLowerCase().startsWith('elevate'),
    );

  if (candidates.length === 0) {
    throw new Error(`No Electron executable found in ${appOutDir}`);
  }

  const preferred = `${context.packager.appInfo.productFilename}.exe`;
  const executable = candidates.includes(preferred) ? preferred : candidates[0];
  const executablePath = path.join(appOutDir, executable);

  await flipFuses(executablePath, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    // Keep file:// subresource loading working for the asar renderer; the
    // renderer remains sandboxed and CSP-restricted.
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: true,
  });

  console.log(`Applied Electron fuses to ${executable}`);
};
