# Windhawk Profile Manager

Safe, reversible switching between Windhawk mod profiles on Windows 11. The app
ships with a **Mac Blur Glass** theme pack, a **Default Windows** reset profile,
and support for user-created profiles captured from the current machine.

> **Release status:** `v0.1.0-dev.1` is an **unsigned developer/test build**.
> The GUI and helper have no Authenticode signature; SmartScreen and Smart App
> Control may block them. Do not publish this artifact as a stable public
> release. See [`docs/UNSIGNED-BUILD.md`](./docs/UNSIGNED-BUILD.md) for the
> checksum, warnings, and test-VM guidance. A signed `v0.1.0` remains behind the
> release gate in ADR-0010.

## What it does

- **Apply** a profile: snapshot the current Windhawk state, write a reviewed
  plan through the elevated helper, verify it, and roll back automatically on
  failure.
- **Restore** a snapshot with a pre-restore snapshot, typed value reconciliation,
  and the same verification/rollback path.
- **Capture** the current enabled/disabled mods and settings into a reusable
  profile.
- **Review** every registry operation, missing mods, targeting warnings, and
  Rainmeter/Explorer actions before UAC.
- **Stay offline.** Profiles, snapshots, diagnostics, and logs remain on this PC.
  The app has no network calls; external links open only `windhawk.net`.

The Windhawk service is never stopped or restarted on the normal apply path.
The helper writes only `Disabled`, settings under a mod's `Settings` key, and
`SettingsChangeTime` last. It never writes `LibraryFileName`/`Version` and never
recreates a missing mod key.

## Install (developer/test artifact)

Requirements: Windows 11 x64, Windhawk installed for the machine, administrator
approval for the first apply. This v1 build requires the standard `C:\Windows`,
`C:\ProgramData`, and `C:\Users\<name>\AppData\Local` layout; a relocated system
or user data root fails closed with an explanatory error.

1. Build or obtain `Windhawk-Profile-Manager-0.1.0-x64.exe`.
2. Run the NSIS installer. It is per-machine and installs to
   `%ProgramFiles%\WindhawkProfileManager`; the install directory is fixed
   because the elevated helper must be a protected binary.
3. Launch **Windhawk Profile Manager** from the Start menu. The GUI runs
   non-elevated (`asInvoker`).
4. Review the first-run screen, then apply a profile. Windows asks for UAC only
   for the privileged phase.

The unsigned build may be blocked by Smart App Control. Build the final
installer on a signed build or a SAC-off test VM. Do not disable Smart App
Control on a primary machine just to run an unsigned build.

## Data and uninstall

| Data | Location |
| --- | --- |
| App state/settings | `%LOCALAPPDATA%\WindhawkProfileManager\state.json` |
| User profiles | `%APPDATA%\WindhawkProfileManager\profiles` |
| Snapshots | `%LOCALAPPDATA%\WindhawkProfileManager\snapshots` |
| Journal/recovery record | `%LOCALAPPDATA%\WindhawkProfileManager\journal.json` |
| Logs | `%LOCALAPPDATA%\WindhawkProfileManager\logs` |
| Private helper runs | `%ProgramData%\WindhawkProfileManager\runs` |

Uninstalling removes the installed application. User profiles, snapshots, and
logs are intentionally **not** deleted by the uninstaller. Remove the folders
above manually if you want a full cleanup. Export important snapshots first.

## Recovery

If the app or helper is interrupted during an apply/restore, the next launch
shows a recovery dialog. It names the run and pre-run snapshot and offers:

- restore the pre-run snapshot through the normal typed restore path, or
- keep the current state and close the run while preserving the snapshot.

The snapshot is never auto-deleted.

## Security model

- The renderer is untrusted and reaches the OS only through a typed preload
  bridge. Production uses a strict CSP, sandboxing, context isolation, and
  Electron fuses.
- The elevated helper is the running installed executable, fixed under
  `%ProgramFiles%\WindhawkProfileManager`; the installer does not allow a custom
  install directory.
- Plans are strict, size-capped, hash-bound, and validated again inside the
  helper. Registry writes are limited to the Windhawk mods subtree.
- Imports are strict JSON/`.reg` parsers that reject deletions, unsafe keys,
  unsupported types, reparse points, and oversized files.
- Logs redact Windows paths and settings values. Diagnostics never include
  settings values or personal paths.

## Development

Prerequisites: Windows 11 x64, Node 24, npm 11.

```powershell
npm ci
npm run dev
```

Quality gates:

```powershell
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:e2e
npm run build
```

Packaging and smoke checks:

```powershell
npm run package:dir
npm run smoke:asar
npm run smoke:fuses
npm run smoke:packaged
```

`npm run package` builds the NSIS installer. On a machine with Smart App Control
enabled, electron-builder can fail while running its unsigned intermediate
installer; use a signed build or a SAC-off test VM for the final installer.

Release checksums:

```powershell
npm run release:checksums
```

## Documents

- [`CONTEXT.md`](./CONTEXT.md) — domain glossary.
- [`docs/SPEC.md`](./docs/SPEC.md) — product behavior and acceptance criteria.
- [`docs/PLAN.md`](./docs/PLAN.md) — architecture, phases, risks.
- [`docs/adr/`](./docs/adr/) — hard-to-reverse decisions.
- [`docs/release-notes/`](./docs/release-notes/) - per-release notes.
- [`docs/UNSIGNED-BUILD.md`](./docs/UNSIGNED-BUILD.md) - unsigned developer build
  warnings, checksum, and test instructions.


## License

Proprietary; all rights reserved. See [`LICENSE`](./LICENSE). The app bundles
Windhawk theme metadata and profiles for interoperability; Windhawk itself is a
separate project.
