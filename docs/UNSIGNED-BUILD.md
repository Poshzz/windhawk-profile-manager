# Unsigned Developer/Test Build

**Status:** developer/test only. This build has **no Authenticode signature** and
is **not a public release**.

- Artifact: `release/Windhawk-Profile-Manager-0.1.0-x64.exe`
- SHA-256: `117146d52a69e0d14fc98c215e34dc45311ee4205661c7e8c73e10af1cb9c3c2`
- Source tag: `v0.1.0-dev.2`
- Installer type: per-machine NSIS; installs to
  `%ProgramFiles%\WindhawkProfileManager`
- Signature: **NotSigned**

## Why it is unsigned

Code signing certificates cost money and require identity validation. Until a
certificate is purchased, this build is intended only for the developer and
testers. A SHA-256 checksum proves the file was not changed in transit, but it
does **not** prove who published it.

## Windows warnings

Windows may block or warn in several ways:

- **Smart App Control:** blocks unsigned/untrusted executables. Do not turn it
  off on a primary machine just to run this build. Use a disposable test VM or a
  machine where Smart App Control is already disabled for testing.
- **SmartScreen:** may show "Unknown publisher" or "Windows protected your PC".
  Only bypass it if you personally built or obtained the file from the expected
  source and verified the checksum.
- **Antivirus/EDR:** may quarantine an unsigned installer or helper.

The developer's test run required temporarily disabling Smart App Control, then
restoring it. That is a test-environment action, not an installation instruction
for end users.

## Verify the artifact

```powershell
Get-FileHash .\Windhawk-Profile-Manager-0.1.0-x64.exe -Algorithm SHA256
# Expected:
# F7BD3D6D88B918AF986D005B3B9A1535A23A6F2BE35FD381E2CCBD73C54606E3
```

Use it only if the hash matches and the file came from the expected build/source.
Do not trust a mirror or chat attachment.

## Install / test

1. Use Windows 11 x64 with Windhawk installed for the machine.
2. Prefer a disposable VM or test machine.
3. Run the installer as administrator. The install directory is fixed; the
   helper must be a protected binary.
4. Review the first-run screen. Applying a profile asks for UAC only for the
   privileged phase.
5. Keep the generated `SHA256SUMS.txt` with the installer.

The installer and app are unsigned, so the installed copy may be blocked as soon
as Smart App Control enforcement is restored. Uninstall it if you no longer need
the test build.

## Data and recovery

| Data | Location |
| --- | --- |
| App state/settings | `%LOCALAPPDATA%\WindhawkProfileManager\state.json` |
| User profiles | `%APPDATA%\WindhawkProfileManager\profiles` |
| Snapshots | `%LOCALAPPDATA%\WindhawkProfileManager\snapshots` |
| Journal/recovery | `%LOCALAPPDATA%\WindhawkProfileManager\journal.json` |
| Logs | `%LOCALAPPDATA%\WindhawkProfileManager\logs` |

Uninstalling preserves profiles, snapshots, logs, and settings. The app never
uploads them. Recovery after an interrupted run is available on the next launch.

## Scope

This v1 build requires the standard `C:\Windows`, `C:\ProgramData`, and
`C:\Users\<name>\AppData\Local` layout and supports x64 Windows 11 only. Tray,
hotkeys, auto-start, auto-update, and silent scheduling are out of scope.

## Rebuild

```powershell
npm ci
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:e2e
npm run package
npm run smoke:asar
npm run smoke:fuses
npm run smoke:packaged
npm run release:checksums
```

`smoke:packaged` requires a build that Smart App Control will allow or a SAC-off
test VM. A future signed build can reuse the same source and packaging pipeline;
no architecture change is required.
