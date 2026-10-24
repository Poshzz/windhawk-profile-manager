import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses';

const executablePath = resolve('release/win-unpacked/WindhawkProfileManager.exe');
const wire = await getCurrentFuseWire(executablePath);

assert.equal(wire[FuseV1Options.RunAsNode], FuseState.DISABLE);
assert.equal(wire[FuseV1Options.EnableNodeOptionsEnvironmentVariable], FuseState.DISABLE);
assert.equal(wire[FuseV1Options.EnableNodeCliInspectArguments], FuseState.DISABLE);
assert.equal(wire[FuseV1Options.OnlyLoadAppFromAsar], FuseState.ENABLE);
assert.equal(wire[FuseV1Options.GrantFileProtocolExtraPrivileges], FuseState.ENABLE);

console.log(JSON.stringify({ executablePath, fuseWire: wire }, null, 2));
