# Windhawk Registry Profiles: Safe Capture, Apply, and Rollback

**Research note for WindhawkProfileManager**  
**Date:** 2026-10-22  
**Scope:** Windows 11 x64; Windhawk 1.7.3 registry mode; Windhawk 2.0.0-alpha.7 CLI; Rainmeter 4.x; `.reg` files.  
**Method:** read-only inspection of local files, registry, running services, and the Windhawk source at tag `2.0.0-alpha.7`. No system-changing command was executed.  
**Evidence labels:** `[C]` confirmed by official documentation, local observation, or source code; `[I]` inferred from confirmed facts but not directly tested; `[U]` uncertain and requiring a test. `[L#]` is local evidence; `[R#]` is a reference at the end. All URLs were accessed 2026-10-22.

> **Implementation note (superseded in part).** Later `windhawk-internals.md` established that the engine watches `Engine\Mods` and reloads without a service restart, and that mod settings use only `REG_SZ`/`REG_DWORD`. v1 therefore does not stop/start the service, does not delete `<mod-id>` keys, and profiles accept only those two types. See SPEC FR-06/FR-08, §9.1, and ADR-0006/ADR-0008. The service-stop, key-deletion, and binary-profile passages below are retained as historical analysis, not as v1 instructions.

## 1. Executive summary

- `[C]` The local installation is Windhawk 1.7.3 in registry mode, with service name `Windhawk` (not `WindhawkService`) and registry root `HKLM\SOFTWARE\Windhawk`. The local `.reg` files are real exports of that store, not hand-written examples.
- `[C]` A profile and a snapshot are different artifacts. A profile is portable desired state; a snapshot is machine-specific rollback evidence including `LibraryFileName`, versions, timestamps, and per-user subtrees.
- `[C]` `reg.exe` is excellent for exporting a snapshot and for writing a trusted, generated file, but it has no multi-key transaction and its import is merge-oriented. It must not be the apply engine for untrusted profiles.
- `[I]` Correctness therefore needs a journaled saga: preflight, snapshot, stop service, apply typed values, verify, restart, commit; on failure, compensate from the snapshot. This is not a true transaction, and the rollback path must itself be tested.
- `[C]` Windhawk 2.0 introduces `windhawk-cli.exe data export/inspect/import`, but its import is explicitly “best-effort per mod, not transactional.” It is a useful backend, not a guarantee; wrap it with the same snapshot/journal.
- **Recommendation:** hand-write a strict TypeScript `.reg` parser/writer; keep a typed canonical model; write only an allowlist of Windhawk keys through a 64-bit-aware registry adapter; snapshot before every apply; verify by read-back; make Explorer/Rainmeter actions explicit, optional, and separately rollback-able.

## 2. Local evidence

| Evidence | Observation |
|---|---|
| Local machine `[L6]` | Windows `10.0.26300.9711`; Windhawk 1.7.3; service `Windhawk`, `LocalSystem`, `AUTO_START`, `RUNNING`; `windhawk.ini` has `Portable=0`, `RegistryKey=HKLM\SOFTWARE\Windhawk`, `AppDataPath=%ProgramData%\Windhawk` `[L9]`. |
| `Mac_BlurGlass_Profile.reg` `[L1]` | UTF-16LE with BOM (`FF FE`), 288 lines, 21 sections, 10 mods, 244 values: 193 `REG_SZ`, 51 `REG_DWORD`; 26 value lines contain `\"` (212 occurrences); longest value 343 characters. |
| `Reset_Default_Windows.reg` `[L2]` | ASCII/UTF-8 without BOM, 31 lines, 10 sections, 10 values; each value is only `"Disabled"=dword:00000001`. It does **not** clear settings. |
| Apply script `[L3]` | `reg import` → stamp `SettingsChangeTime` and `Disabled=0` → `net stop/start Windhawk` → start Rainmeter if absent → kill `SystemSettings.exe` and `explorer.exe` → `start explorer.exe`. No wait, read-back, or rollback. |
| Reset script `[L4]` | `reg import` (only `Disabled=1`) → PowerShell disables every mod → kill Rainmeter → kill Explorer → start Explorer. Comment says “falling back to PowerShell” but no distinct fallback command follows. |
| `reg export /?` `[L7]` | Supports `/y` and `/reg:32 | /reg:64`; documented return values are 0 success, 1 failure. |

The ten mods and their `Settings` counts in the Mac profile `[L1]`:

| Mod ID | Settings values |
|---|---:|
| `icon-resource-redirect` | 7 |
| `macos-minimize-animation` | 9 |
| `taskbar-dock-animation` | 12 |
| `translucent-windows` | 11 |
| `uxtheme-hook` | 1 |
| `windows-11-file-explorer-styler` | 9 |
| `windows-11-notification-center-styler` | 5 |
| `windows-11-settings-styler` | 102 |
| `windows-11-start-menu-styler` | 9 |
| `windows-11-taskbar-styler` | 7 |

**Findings that change the design**

- `[C]` Mod-level values are `LibraryFileName`, `Disabled`, `Include`, `Exclude`, `Architecture`, `Version`, and `SettingsChangeTime`; the actual settings are named values under `\Settings`. Local `LibraryFileName` values look like `icon-resource-redirect_1.3_310036.dll`, i.e. `<id>_<version>_<numeric-hash>.dll`.
- `[C]` `SettingsChangeTime` is a DWORD Unix-like timestamp (for example `0x6ad9eb02`). The apply script rewrites it to “now” so the engine notices a settings change. The 2.0 source confirms the engine reloads when this marker differs and that Windhawk’s writer never repeats an earlier stamp `[R14]`.
- `[C]` `iconTheme` is `macOS DarkMode|themes/icons/niivu/macOS%20Dark%20Mode.zip`. It is a user/machine-specific asset reference, not a portable setting. `[I]` A profile moved to another PC will silently point at a missing theme unless the manager maps or warns about it.
- `[C]` “Reset to default Windows” is a misnomer: it only disables the ten mods. All 244 Mac-profile values remain in the registry, so re-enabling a mod can resurrect the old theme.
- `[C]` The apply script imports first and stops the service only afterwards. `[I]` That leaves a window in which the running service can read or rewrite the same keys; the script also ignores stop/start failures and uses a one-second delay.

## 3. `.reg` format and a TypeScript parser

`[C]` A `.reg` file is a line-oriented text format with a header (`Windows Registry Editor Version 5.00`, or legacy `REGEDIT4`), `[Key]` sections, and `"ValueName"=data` lines; `@=` denotes the default value. `[I]` Regedit-compatible files may also contain `[-Key]` (delete key) and `"ValueName"=-` (delete value); those are dangerous in an imported profile and should be rejected by the profile validator.

`[C]` Observed value encodings: a quoted string is `REG_SZ`; `dword:00000000` is `REG_DWORD`; `hex:` is `REG_BINARY`; `hex(2):` is `REG_EXPAND_SZ`; `hex(7):` is `REG_MULTI_SZ`; `hex(b):` is `REG_QWORD`. `[C]` In strings, `\\` represents a literal backslash and `\"` a literal quote; this is not JSON escaping. Long hex values may continue on the next line with a trailing backslash.

`[C]` There is no formal Microsoft grammar for the whole format. Do not use a loose regex over the file: escaped quotes make `"..."` scanning ambiguous, and a text filter can retain a section header while dropping values or vice versa. The local Mac file alone contains 212 escaped-quote occurrences across 26 lines.

Recommended TypeScript shape:

```ts
type RegValue =
  | { type: "REG_SZ"; data: string }
  | { type: "REG_DWORD"; data: number }
  | { type: "REG_BINARY"; data: Uint8Array }
  | { type: "REG_EXPAND_SZ"; data: string }
  | { type: "REG_MULTI_SZ"; data: string[] };

type RegSection = { key: string; values: Map<string, RegValue>; deleted?: boolean };
type RegFile = { sections: RegSection[] };
```

Parser rules:

1. Sniff bytes: `FF FE` → UTF-16LE; `FE FF` → UTF-16BE; `EF BB BF` → UTF-8; otherwise UTF-8 with a Windows-1252 fallback. Strip the BOM before parsing. The local `reg export` output is UTF-16LE, but the reset file is ASCII, so both paths are required.
2. Verify the header, then run a state machine: section line, value line, blank line, or `;` comment. Join hex continuation lines before decoding.
3. Scan quoted strings with a real escape state; accept only `\\` and `\"`; reject unknown escapes rather than silently changing data. Preserve spaces and Unicode.
4. Parse `dword:` as exactly eight hex digits; parse `hex:` byte lists with optional whitespace; reject truncated or odd-length hex.
5. Reject duplicate value names within a section (or apply an explicit last-wins policy for snapshots), duplicate section keys, `@` default values, and delete directives in profile input.
6. Enforce limits: file size, section count, value count, key depth, value-name length, and per-value byte size. Fail closed.
7. Keep a canonical model and serialize `.reg` only for human export or evidence. Never serialize a profile and hand it to `reg.exe` as the apply path.
8. Test with both local fixtures: expect 21 sections/244 values for the Mac file and 10 sections/10 values for the reset file; property-test strings containing quotes, backslashes, brackets, CRLF, and non-ASCII.

`[C]` The Mac export proves the escaping rule: `"styleConstants[2]"="BgBorder=<SolidColorBrush Color=\"{ThemeResource Border}\" />"` imports as `Color="{ThemeResource Border}"`. A parser that treats `\"` as “backslash plus end of string” will corrupt this profile.

## 4. `reg.exe export` and `reg import`

- `[C]` `reg export <key> <file> [/y] [/reg:32|/reg:64]` writes a subtree to a file; `reg import <file> [/reg:32|/reg:64]` reads it back. Both document only 0 (success) and 1 (failure). `[R3][R4][L7]`
- `[C]` On 64-bit Windows, 32-bit and 64-bit applications can see different logical registry views; explicit `KEY_WOW64_64KEY` (or `/reg:64`) is required to reach the view Windhawk uses. Windhawk’s registry backend forces the 64-bit view throughout. `[R2][R10]`
- `[C]` `reg import` has no replace mode, no dry-run, no per-key transaction, and no rollback flag. `[R4]`
- `[I]` Import merges: values and subkeys not named in the file remain. This is the only safe assumption for rollback design. To make a profile authoritative, extra values under `\Settings` must be explicitly deleted first.
- `[I]` A failure partway through an import can leave earlier writes applied. There is no documented all-or-nothing guarantee. This is a strong inference from the command’s implementation model, not a tested failure injection.
- `[C]` A `.reg` file can contain delete directives. Importing an untrusted file as administrator is therefore equivalent to granting arbitrary HKLM write/delete rights within the imported hives.
- `[C]` `.reg` export does not carry security descriptors/ACLs. A snapshot can restore values but not the key’s original permissions.

**Practical rule:** use `reg export` only to capture evidence; parse the result into the canonical model; use `reg import` only for a file the application itself generated from already-validated data, and still snapshot and verify around it. The preferred apply path is typed registry writes, not import.

## 5. Windhawk registry model and version differences

| Path (64-bit view) | Meaning | In a profile? |
|---|---|---|
| `HKLM\SOFTWARE\Windhawk\Engine\Mods\<id>` | Per-mod config: `LibraryFileName`, `Disabled`, `Include`, `Exclude`, `Architecture`, `Version`, `SettingsChangeTime` | Only semantic fields (`Disabled`, optionally `Include`/`Exclude`) |
| `...\Engine\Mods\<id>\Settings` | Flat named settings (`Group.child`, `List[0]`, etc.) | Yes |
| `...\Engine\Mods\<id>\Users\<SID>\Settings` | 2.0 per-user settings | Only with explicit user scope |
| `...\Engine\ModsWritable\<id>\...` | Runtime `LocalStorage` / `SymbolCache` | No |
| `...\Engine\Settings`, `...\Settings` | Engine/app settings, including `SafeMode` | No |

- `[C]` The 1.7.3 install has no `windhawk-cli.exe`; its documented flags are `-tray-only`, `-exit`, `-restart`, and `-safe-mode` `[L8]`. Profiles must therefore use the registry path on 1.7.x.
- `[C]` Windhawk 2.0.0-alpha.7 adds `data export`, `data inspect`, and `data import`. Import requires `--yes`, installs each mod parked/disabled, applies settings/config, then enables it last; a failed mod is recorded and the loop continues. The source header says: “Import is best-effort per mod, not transactional.” `[R11]`
- `[C]` The 2.0 CLI can return exit 8 (`RESTART_REQUIRED`) when archived app settings would change a restart-requiring value; other relevant codes include 2 (usage), 4 (mod not installed), 11 (I/O), 12 (registry), 13 (invalid request), and 14 (internal). `[R12]`
- `[C]` Windhawk validates caller-supplied mod IDs against a bare charset of `0-9`, `a-z`, and `-` (with a `local@` form for local mods); this is exactly the path-component safety rule a profile manager needs. `[R9]`
- `[C]` Windhawk supports portable mode (`Portable=1`), where settings live in INI files rather than this registry tree. `[R9]` Detect it before offering registry profiles; a registry profile applied to a portable install is meaningless and potentially destructive.

## 6. Profile and snapshot schemas

**Profile** — portable, human-editable, no machine paths or runtime file names:

```json
{
  "schemaVersion": 1,
  "kind": "windhawk-profile",
  "id": "mac-blurglass",
  "name": "Mac BlurGlass",
  "createdAt": "2026-10-22T12:00:00Z",
  "updatedAt": "2026-10-22T12:00:00Z",
  "compatibility": { "windhawk": ">=1.7 <3", "windowsBuild": ">=22000", "arch": "x86-64" },
  "mods": [{
    "id": "windows-11-taskbar-styler",
    "version": "1.10",
    "enabled": true,
    "mode": "replace",
    "settings": { "theme": { "type": "REG_SZ", "data": "..." } }
  }],
  "actions": { "restartExplorer": true, "rainmeter": { "layout": "Mac BlurGlass", "quitFirst": true } },
  "source": { "type": "reg", "file": "Mac_BlurGlass_Profile.reg", "sha256": "..." }
}
```

**Snapshot** — machine-specific rollback evidence; never portable:

```json
{
  "schemaVersion": 1, "kind": "windhawk-snapshot", "id": "2026-10-22T12:00:00Z",
  "capturedAt": "2026-10-22T12:00:00Z", "windhawkVersion": "1.7.3",
  "windowsBuild": "10.0.26300.9711", "registryView": "64",
  "mods": [{
    "id": "windows-11-taskbar-styler", "existedBefore": true,
    "values": { "Disabled": { "type": "REG_DWORD", "data": 0 },
                "LibraryFileName": { "type": "REG_SZ", "data": "windows-11-taskbar-styler_1.10_944663.dll" } },
    "settings": { "theme": { "type": "REG_SZ", "data": "..." } },
    "users": { "S-1-5-21-...": { "settings": {} } }
  }],
  "rainmeter": { "running": true, "layout": "Mac BlurGlass", "iniSha256": "..." },
  "hash": "sha256:..."
}
```

- `[I]` `mode: "replace"` means “make `\Settings` exactly this set, deleting extra values”; `mode: "merge"` means “write these values, keep the rest.” Default to replace for deterministic profiles, but show the deletions in the preview.
- `[C]` Keep `LibraryFileName`, `Version`, `Architecture`, and `SettingsChangeTime` in snapshots, not in portable profiles. `LibraryFileName` embeds a version/hash and breaks after a mod update; `SettingsChangeTime` is machine state.
- `[C]` Store settings as tagged values, not untyped JSON. `REG_DWORD` numbers must not silently become strings, and binary values must remain base64 or byte arrays with an explicit type.
- `[I]` Include a `settingsHash` per mod in the plan to detect concurrent edits between preview and apply. The hash is over canonicalized names, types, and data.

## 7. Transactional apply and rollback design

`[I]` There is no usable multi-key registry transaction here; `reg.exe` has none, and the Win32 transacted-registry API is not used by Windhawk and would not cover the service, Explorer, or Rainmeter. Treat apply as a saga with a write-ahead journal and compensating actions.

**State machine:** `planned → snapshot_taken → service_stopped → applying → applied → verifying → committed`; any failure goes to `rolling_back → rolled_back` or `rollback_failed`.

1. **Preflight.** Require elevation; verify Windows x64, registry mode, Windhawk installed, service present, target mods installed, profile schema valid, all IDs/types/sizes allowlisted, and requested Rainmeter layout/processes resolvable. Compute a diff and a `beforeHash` per touched mod.
2. **Snapshot.** Stop the service first, then export each touched mod key with `/reg:64` to a unique evidence file and parse it. Re-read and compare `beforeHash`; abort if Windhawk changed the key while the preview was open. Record `existedBefore`.
3. **Journal.** Write `journal.json` with the plan, snapshot path/hash, state, and per-step results; fsync it before the first registry write.
4. **Quiesce.** Stop `Windhawk`; poll until `STOPPED` (timeout, typically 30 s). Do not proceed on `STOP_PENDING`. Do not kill the service process.
5. **Apply.** For each mod: create the key if needed; set changed values with the exact type; delete extra values for `replace`; set `Disabled`; never touch `ModsWritable`, `Engine\Settings`, or top-level `Settings`. Batch writes per mod and record each success.
6. **Stamp.** After settings are written, set `SettingsChangeTime` to `max(now, previous+1)` as a positive 31-bit value, matching Windhawk’s monotonic rule. `[R14]`
7. **Verify.** Read every touched value back, compare canonical hashes, and confirm the service is running. If a value differs, fail into rollback; do not “continue and hope.”
8. **Resume UI.** Start the service and wait for `RUNNING`. Then perform optional Explorer restart and Rainmeter actions. Those are separate steps with their own status, because a Rainmeter failure should not invalidate a correct registry apply.
9. **Commit.** Mark the journal `committed`, keep the pre-apply snapshot, and release the lock. Retain the last N snapshots (for example 10) plus the immediately previous profile.

**Rollback.** Stop the service; for every mod touched, delete only the values/settings the plan created or changed, and restore the snapshot’s typed values; if the mod key did not exist before, delete that mod key (and only that key). Never delete `HKLM\SOFTWARE\Windhawk` or `Engine\Mods` wholesale. Stamp `SettingsChangeTime` again so the engine reloads, start the service, verify, and then restore Explorer/Rainmeter. If rollback fails, leave the journal and snapshot in place and instruct the user; do not hide the failure.

**Crash recovery.** On startup, detect an incomplete journal and offer “roll back” before any new apply. A journal left in `applying` is not evidence that the registry is consistent.

## 8. Service control

- `[C]` The service name is `Windhawk` in the local install and in the 2.0 source (`kName = L"Windhawk"`). The executable is `windhawk.exe -service`, `LocalSystem`, `AUTO_START`. `[L6][R13]`
- `[C]` `sc.exe` commands map to SCM controls; `Stop-Service` sends a stop message and supports `-NoWait`/`-Force`. `[R5][R6]`
- `[I]` Do not trust `net stop`/`net start` alone: their output is localized, errors are easy to suppress, and a one-second sleep does not prove `STOPPED`. Poll `Get-Service` or `sc query` for `STOPPED`/`RUNNING` with a bounded timeout.
- `[C]` The local scripts suppress all `net` output (`>nul 2>&1`) and never check the result `[L3][L4]`; the prior-art tool additionally uses the wrong name `WindhawkService` with `-ErrorAction SilentlyContinue` `[R18]`. Both are anti-patterns.
- `[I]` If the service is absent, stop: the install is portable, broken, or not Windhawk. Do not fall back to editing `HKLM\SOFTWARE\Windhawk` blindly.
- `[I]` If `STOP_PENDING` exceeds the timeout, abort and report. Forcing termination risks half-unloaded mods and locked DLLs; a logoff/reboot is safer than `taskkill` on the service.

## 9. Explorer restart

- `[U]` No documented public API for “restart Explorer” was found. The common method is `taskkill /f /im explorer.exe`, followed by `start explorer.exe`. `[R19]`
- `[C]` On this machine `HKLM\...\Winlogon\AutoRestartShell=1`, so Windows normally restarts the shell automatically after a kill. Two `explorer.exe` processes were observed, which makes “kill, sleep, start” racy. `[L6]`
- `[I]` Forcibly terminating Explorer closes File Explorer windows, can disturb tray/IME/desktop state, and may lose unsaved view state. Prefer a graceful close or a user-confirmed restart; if force is required, warn first.
- **Recommended sequence:** detect the shell PID and `Shell_TrayWnd`; kill only if the user approved; wait for a new shell PID/window; only run `start explorer.exe` if no shell appears after a timeout. Do not also kill `SystemSettings.exe` unless the selected mods actually require it.
- `[I]` After a mod DLL is locked by an injected process, Explorer restart may not be enough. A logoff is the reliable last resort; offer it rather than silently forcing it.

## 10. Rainmeter quit, start, and layout detection

- `[C]` `!Quit` quits Rainmeter; `!LoadLayout "<name>"` loads a layout and will start Rainmeter if it is not running; `!ActivateConfig` activates a skin. `[R7]`
- `[C]` Layouts are stored under the Rainmeter settings folder (`%APPDATA%\Rainmeter` locally). Loading a layout automatically saves the current state as a layout named `@Backup`, so `@Backup` is not a stable rollback point. Global `[Rainmeter]` settings such as `SkinPath` and `Language` are not replaced by a layout load. `[R8]`
- `[C]` The local machine has Rainmeter 4.5.28 at `C:\Program Files\Rainmeter\Rainmeter.exe`, settings at `%APPDATA%\Rainmeter`, and layouts under `%APPDATA%\Rainmeter\Layouts`; both `Layouts\Rainmeter.ini` and `Layouts\<name>\Rainmeter.ini` were present. `[L6]`
- `[I]` Do not assume one on-disk layout shape across Rainmeter versions. Enumerate layouts, normalize names, and treat `!LoadLayout` as the authoritative operation. Validate the name (no quotes/control characters) and confirm it exists before apply.
- **Recommended sequence:** if running, send `!Quit` and wait for exit; if a layout is requested, invoke `Rainmeter.exe !LoadLayout "<name>"` (this also starts it); otherwise start `Rainmeter.exe` only if it was running before. Snapshot `Rainmeter.ini` and the target layout before loading.
- `[C]` `taskkill /f /im Rainmeter.exe` (used by the reset script) is a hard kill and can lose the current layout/state. Avoid it; use `!Quit`. `[L4][R19]`

## 11. Prior art

| Project/artifact | Approach | What to reuse | What to avoid |
|---|---|---|---|
| `osmanonurkoc/Windhawk-Backup-Manager` `[R17][R18]` | PowerShell/WPF; exports whole `HKLM\SOFTWARE\Windhawk`, text-filters `.reg` sections, imports on restore; copies `Engine\Mods`/`ModsSource`; prompts logoff | Useful UX for selective backup and the realization that compiled DLLs/sources matter | Wrong service name `WindhawkService` with silent errors; whole-hive export; text filtering instead of parsing; merge restore; no exit-code checks or read-back; logoff as the default recovery |
| `windhawk-cli data export/inspect/import` (2.0 alpha) `[R11]` | Official archive format; selection/conflict flags; install-then-patch; enables mod last | Best long-term backend; per-mod summaries; restart gate | Not transactional; requires 2.0; may reinstall/download mods; still needs snapshot and verification |
| Windhawk issue #626 / discussion #715 `[R15][R16]` | Feature requests for built-in config profiles; maintainer points to #626 | Confirms the user need and expected UX (profiles, merge/precedence, export/import) | No built-in profile API in 1.7.x; do not depend on it |
| Local batch scripts `[L3][L4]` | Import/stamp/restart; reset disables all; Explorer/Rainmeter refresh | Exact registry shape and the `SettingsChangeTime` trick | Import before stop; fixed sleeps; ignored errors; hard kills; no rollback; reset does not clear settings |

## 12. Atomic writes and concurrency

- `[I]` Recommended layout: `%APPDATA%\WindhawkProfileManager\profiles` for portable profiles; `%LOCALAPPDATA%\WindhawkProfileManager\{snapshots,backups,logs,state}` for machine-specific evidence. Do not put snapshots in a roaming share by default; they can contain user paths and secrets.
- `[I]` Write JSON atomically: create a temp file in the same directory, write, `fsync`, rename over the target, then update a manifest. `fs.rename` is the usual same-volume replacement primitive; true crash atomicity is an inference, not a documented guarantee. `[R20]` `write-file-atomic@8.0.0` packages this pattern but requires Node `^22.22.2 || ^24.15.0 || >=26` as of this writing. `[R21]`
- `[I]` Never write `journal.json` in place. Write a new revision and rename; keep the previous journal until the new one is durable.
- `[I]` Enforce one app instance with a named mutex (`Global\WindhawkProfileManager`) or an exclusive lock file containing PID + start time. A stale lock is detected by PID/start-time mismatch, not by age alone.
- `[I]` Use optimistic concurrency for profiles: a `revision` integer and `updatedAt`; an apply plan records the revision it previewed. Reject apply if the profile or the registry changed since preview.
- `[I]` Retain the pre-apply snapshot and the last N snapshots; never delete the only snapshot automatically. Verify snapshot hashes before restore.

## 13. Profile security validation

Treat every imported profile, snapshot, and `.reg` file as untrusted input, even if it looks like a Windhawk export.

- **Key allowlist:** only `HKLM\SOFTWARE\Windhawk\Engine\Mods\<valid-id>` and its `\Settings` subtree; optionally `\Users\<valid-SID>\Settings`. Reject other hives, `Engine\Settings`, top-level `Settings`, `ModsWritable`, `Services`, `Run`, and any path containing `..`, `\`, or a NUL.
- **ID validation:** `^[a-z0-9-]+$` for normal mod IDs; allow the documented `local@` prefix only if local mods are explicitly supported. SIDs must match canonical `S-1-5-...` form. Never interpolate unvalidated IDs into registry paths or file names.
- **Type allowlist:** `REG_SZ`, `REG_DWORD`, and `REG_BINARY` only; reject `REG_EXPAND_SZ`/`REG_MULTI_SZ` unless a real need appears; never accept `REG_LINK`. Reject type changes on existing values unless the preview says so.
- **Limits:** cap profile size, section/value counts, key depth, value-name length, string bytes, and binary bytes. A small file can otherwise cause a large registry or log write.
- **Deletion rules:** profiles may not contain `[-Key]` or `"name"=-`; only the application’s generated rollback plan may delete, and only keys/values it recorded as touched.
- **JSON hardening:** reject `__proto__`, `constructor`, and `prototype` keys; parse into null-prototype objects or `Map`s; validate with a schema that rejects unknown fields rather than passing them through.
- **Secrets:** mod settings can contain API keys, tokens, or paths. Redact values in logs and previews; store snapshots with a user-only ACL; consider DPAPI encryption for snapshot files. Never upload them.
- **No shell injection:** invoke `reg.exe`/PowerShell with argument arrays or a JSON plan over stdin, never by concatenating profile values into a command string.
- **Integrity:** record SHA-256 of the profile and snapshot; optionally sign exported profiles. A hash detects accidental corruption, not a malicious author.
- **Never import app settings:** `SafeMode`, logging, update, and injection settings are outside a profile’s trust boundary. A profile must not be able to disable Windhawk’s safety mechanisms.

## 14. Recommended design

**Core modules (TypeScript):**

- `reg/parse.ts`, `reg/serialize.ts`, `reg/model.ts` — strict parser/writer, limits, tagged values, local fixtures.
- `windhawk/layout.ts` — detect portable vs registry mode, read `windhawk.ini`, validate the registry root and service.
- `windhawk/registry.ts` — read/verify through a 64-bit-aware adapter; write via a single elevated PowerShell/.NET helper that accepts a JSON plan and returns per-operation results. `registry-js` is a useful read/verify option (it forces `KEY_WOW64_64KEY` and supports SZ/DWORD), but it lacks binary/delete operations, so it should not be the only writer. `[R22]`
- `windhawk/service.ts` — stop/start with state polling and timeouts.
- `windhawk/rainmeter.ts` — detect install/process, `!Quit`, `!LoadLayout`, layout enumeration.
- `profiles/validate.ts`, `profiles/plan.ts`, `profiles/apply.ts` — schema, diff, saga, rollback.
- `storage/atomic.ts`, `storage/journal.ts`, `storage/lock.ts` — atomic files, journal, single-instance lock.

**Backend matrix:**

| Environment | Read/snapshot | Apply |
|---|---|---|
| Windhawk 1.7.x registry mode | `reg export /reg:64`, parse | Typed helper; never direct profile import |
| Windhawk 2.0+ | `windhawk-cli data export` (if present), plus registry read | `windhawk-cli data import --yes` wrapped with snapshot/journal, or typed registry writes |
| Portable mode | INI read only | Refuse registry profiles; add an INI backend later |

**UX flow:** select profile → preflight report (mods missing, version/path warnings, Rainmeter layout missing, Explorer restart required) → diff preview including deletions → confirm elevation → progress with per-step state → verify → success with “Undo” (snapshot) available.

**Build order:** parser + local fixtures → read-only inventory/diff → snapshot + restore one mod → service control → full profile apply + journal/rollback → Rainmeter/Explorer actions → 2.0 CLI adapter. Acceptance tests should include: apply, crash mid-apply, rollback after partial failure, duplicate mod ID, escaped-quote profile, missing mod, portable mode, service timeout, and Rainmeter absent.

## 15. Open risks

| Severity | Risk | Mitigation |
|---|---|---|
| High | Multi-key apply is not atomic; a crash leaves mixed state | Journal, per-step status, startup recovery, tested compensation |
| High | `reg import` merges; rollback based on import leaves stale values | Typed replace with explicit deletions; snapshot/read-back; never rely on import alone |
| High | Cross-machine profile breaks on `LibraryFileName`, mod versions, `iconTheme` paths | Keep those out of profiles; version/path checks; explicit remap/warning |
| High | Wrong service assumptions (`WindhawkService`) silently do nothing | Discover the SCM name; verify state before/after; fail loudly |
| High | Untrusted `.reg` can delete/write arbitrary keys as admin | Strict parser, key/type allowlist, no direct import, signed/hashed profiles |
| Medium | Explorer hard kill loses windows/state or races auto-restart | User confirmation; wait for shell window; only start if absent; logoff fallback |
| Medium | Rainmeter `taskkill` and `@Backup` overwrite lose the previous layout | `!Quit`; copy `Rainmeter.ini`/layout first; validate layout name |
| Medium | 2.0 `Users\<SID>` schema and CLI behavior change | Feature-detect version/CLI; schema versioning; per-user scope opt-in |
| Medium | No official “mod actually injected” signal | Verify registry + service; report “applied, not confirmed loaded”; offer logoff |
| Low | `.reg` snapshot cannot restore ACLs; secrets may be captured | Document limitation; protect snapshot ACLs/encryption; audit |

## 16. References

All URLs accessed 2026-10-22.

- `[R1]` Microsoft, Registry value types — https://learn.microsoft.com/en-us/windows/win32/sysinfo/registry-value-types
- `[R2]` Microsoft, 32-bit and 64-bit application data in the registry — https://learn.microsoft.com/en-us/windows/win32/sysinfo/32-bit-and-64-bit-application-data-in-the-registry
- `[R3]` Microsoft, `reg export` — https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/reg-export
- `[R4]` Microsoft, `reg import` — https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/reg-import
- `[R5]` Microsoft, Controlling a service using SC — https://learn.microsoft.com/en-us/windows/win32/services/controlling-a-service-using-sc
- `[R6]` Microsoft, `Stop-Service` — https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/stop-service
- `[R7]` Rainmeter, Bangs — https://docs.rainmeter.net/manual/bangs/
- `[R8]` Rainmeter, Manage / Layouts — https://docs.rainmeter.net/manual/user-interface/manage/
- `[R9]` Windhawk 2.0.0-alpha.7, storage layout — https://github.com/ramensoftware/windhawk/blob/2.0.0-alpha.7/src/windhawk-core/core/src/services/storage.rs
- `[R10]` Windhawk 2.0.0-alpha.7, registry backend (64-bit view) — https://github.com/ramensoftware/windhawk/blob/2.0.0-alpha.7/src/windhawk-core/windows/src/registry.rs
- `[R11]` Windhawk 2.0.0-alpha.7, user-data import (best-effort, not transactional) — https://github.com/ramensoftware/windhawk/blob/2.0.0-alpha.7/src/windhawk-core/core/src/services/user_data.rs
- `[R12]` Windhawk 2.0.0-alpha.7, CLI error/exit codes — https://github.com/ramensoftware/windhawk/blob/2.0.0-alpha.7/src/windhawk-core/cli/src/error.rs
- `[R13]` Windhawk 2.0.0-alpha.7, service name — https://github.com/ramensoftware/windhawk/blob/2.0.0-alpha.7/src/windhawk/app/service_common.h
- `[R14]` Windhawk 2.0.0-alpha.7, `SettingsChangeTime` reload behavior — https://github.com/ramensoftware/windhawk/blob/2.0.0-alpha.7/src/windhawk/engine/mod.cpp
- `[R15]` Windhawk issue #626, Config Profiles — https://github.com/ramensoftware/windhawk/issues/626
- `[R16]` Windhawk discussion #715, Multiple mod profiles — https://github.com/ramensoftware/windhawk/discussions/715
- `[R17]` Windhawk Backup Manager repository — https://github.com/osmanonurkoc/Windhawk-Backup-Manager
- `[R18]` Windhawk Backup Manager script (service name/filtering/import) — https://github.com/osmanonurkoc/Windhawk-Backup-Manager/blob/main/Windhawk_Backup_Manager.ps1
- `[R19]` Microsoft, `taskkill` — https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill
- `[R20]` Node.js, `fs.rename` — https://nodejs.org/api/fs.html#fsrenamesyncoldpath-newpath
- `[R21]` npm, `write-file-atomic@8.0.0` — https://www.npmjs.com/package/write-file-atomic
- `[R22]` npm, `registry-js@1.16.1` — https://www.npmjs.com/package/registry-js

**Local evidence:** `[L1]` `C:\Users\Test\Documents\WindhawkProfiles\Mac_BlurGlass_Profile.reg`; `[L2]` `Reset_Default_Windows.reg`; `[L3]` `1-Apply-Mac-BlurGlass.bat`; `[L4]` `2-Reset-Default-Windows.bat`; `[L5]` `README.txt`; `[L6]` local `sc query`, `reg query`, `Get-Process`, and `Get-Item` observations; `[L7]` local `reg export /?`; `[L8]` `C:\Program Files\Windhawk\command-line.txt`; `[L9]` `C:\Program Files\Windhawk\windhawk.ini`.
