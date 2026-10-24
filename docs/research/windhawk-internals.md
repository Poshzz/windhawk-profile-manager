# Windhawk internals

**Status:** research complete · **Evidence cut-off:** 2026-10-22
**Targets:** Windhawk 1.7.3 (installed on this machine) and 2.0.0-alpha.7 (current source)
**Purpose:** answer the Windhawk questions blocking `docs/SPEC.md` §15 and `docs/PLAN.md` §10. This document is read-only research: no registry writes, service changes, or mod installs were performed.

**Evidence labels.** `[C]` confirmed by source, official docs, or direct observation. `[I]` inferred from source behaviour but not directly exercised. `[U]` unknown; needs a test before implementation. `[S#]` and `[L1]` refer to §13.

> **Implementation note.** v1 adopts the recommendations in §9 except `<mod-id>` key deletion: restore reconciles typed values and leaves keys in place (ADR-0006). Profiles use only `REG_SZ`/`REG_DWORD` settings and exclude targeting fields. The service stays running; only a stopped service is started.

---

## 1. Summary

- Mod state is plain registry data under `HKLM\SOFTWARE\Windhawk\Engine\Mods\<mod-id>`: `Disabled` (DWORD), a flat `Settings` subkey, and install metadata. There is no profile/JSON layer. `[C]`
- The engine watches that subtree and reloads mods and settings live, in every injected process. Stopping/starting the `Windhawk` service is **not** required to apply a profile. `[C]`
- Enable/disable is just `Disabled`; settings additionally require bumping `SettingsChangeTime`, or the new values are never picked up. `[C]`
- Mod settings use only `REG_SZ` and `REG_DWORD` (mod-owned storage can contain `REG_BINARY`). Arrays are flattened into indexed value names (`List[0]`), not stored as `REG_MULTI_SZ`; list-like **config** fields use `|`-joined strings. `[C]`
- Windhawk 1.7.3 has no CLI. `windhawk-cli.exe` exists only in 2.0 alpha, needs elevation for writes, and is an optional fast path — the registry remains the portable integration. `[C]`

---

## 2. Runtime shape and versions

Windhawk has three layers: a Windows service (`Windhawk`, running as `windhawk.exe -service`) that launches a per-session daemon; an engine DLL injected into target processes; and the UI. Each injected engine reads the same registry configuration and owns the reload/watch loop. `[C]` `[S1]` `[S7]` `[L1]`

On this machine: app and engine **1.7.3** (engine folder `Engine\1.7.3`), service `Windhawk` Running/Auto with ImagePath `"C:\Program Files\Windhawk\windhawk.exe" -service`, registry root `HKLM\SOFTWARE\Windhawk` (from `windhawk.ini` `RegistryKey`), engine data `%ProgramData%\Windhawk\Engine` (from `engine.ini` `AppDataPath`), mod DLLs in `%ProgramData%\Windhawk\Engine\Mods\{32,64,arm64}` (64-bit mods in `...\64`). `[C]` `[L1]`

Windhawk 2.0 (alpha) changes the UI and adds features but keeps this storage model: the Rust core still opens `<root>\Engine\Mods\<id>` and its `Settings` tree. `[C]` `[S9]` `[S11]` Version-specific additions: `windhawk-cli.exe` from 2.0 alpha 1 (absent in 1.7.3) `[S17]`; whole-user-data `data export/import` from alpha 2 `[S18]`; `windhawk-ui.exe` + broker pipe from alpha 3 `[S19]` `[S20]`; per-user mod configuration and `mod settings write`/`defaults` from alpha 7 `[S19]` `[S13]`; Windows 10+ x64/ARM64 only from alpha 1 `[S17]`. `[C]`

---

## 3. Install detection and paths

### 3.1 Non-portable (the normal case)

Resolution order that works on 1.7.3 and 2.0:

1. Installer metadata: `HKLM\SOFTWARE\WOW6432Node\Windhawk` value `install_dir` (32-bit view; the installer is 32-bit). `[C]` `[L1]`
2. Service ImagePath: `HKLM\SYSTEM\CurrentControlSet\Services\Windhawk` → quoted `windhawk.exe` path. `[C]` `[L1]`
3. Fallback: `%ProgramFiles%\Windhawk`. `[I]`

Then read `<install>\windhawk.ini` (`[Storage]`): `Portable`, `AppDataPath`, `RegistryKey`, `EnginePath`, `UIPath`, `CompilerPath`. `[C]` `[S5]` `[L1]` Important: `WOW6432Node\Windhawk` and `SOFTWARE\Windhawk` are **different keys**. The former is installer bookkeeping; the latter is live settings. Do not use the installer key for mod state. `[C]` `[L1]`

### 3.2 Portable mode

`Portable=1` in `windhawk.ini` switches all storage to INI files beside the app, skips service startup, and has no per-user configuration. `AppDataPath` in `windhawk.ini` / `engine.ini` controls the exact folders. `[C]` `[S5]` `[S8]` `[S19]` Our v1 targets the installed (non-portable) case, but portable detection should be explicit: if `Portable=1`, show "unsupported" rather than reading an unrelated HKLM key.

### 3.3 Configurable registry root

`RegistryKey` may be `HKLM\...`, `HKCU\...`, or `HKU\...`; the engine accepts all three. `[C]` `[S5]` The app's allowlist (SPEC SR-1) hardcodes `HKLM\SOFTWARE\Windhawk\Engine\Mods`. For v1, detect a different root and switch to read-only/unsupported rather than silently reading the wrong hive. `[I]`

### 3.4 64-bit view

The engine opens `Engine\Mods` with `KEY_WOW64_64KEY`. `[C]` `[S1]` Every gateway read/write must use the 64-bit registry view (`RegistryView.Registry64`, `reg.exe /reg:64`), otherwise a 32-bit helper would read/write a redirected view. This is especially easy to get wrong in an Electron helper built as x86. `[I]` (direct consequence of the flag)

---

## 4. Registry data model

```
HKLM\SOFTWARE\Windhawk
├─ Settings\                          app settings (SafeMode, language, ...)   ← not ours
└─ Engine
   ├─ Settings\                       engine settings (Include/Exclude, logging)   ← not ours
   ├─ Mods\<mod-id>\
   │  ├─ LibraryFileName REG_SZ  "<id>_<version>_<build>.dll";  Version REG_SZ
   │  ├─ Disabled REG_DWORD 0/1;  SettingsChangeTime REG_DWORD (reload marker)
   │  ├─ Include / Exclude / Architecture REG_SZ (pipe-joined patterns)
   │  ├─ IncludeCustom / ExcludeCustom / IncludeExcludeCustomOnly
   │  ├─ PatternsMatchCriticalSystemProcesses / LoggingEnabled / DebugLoggingEnabled
   │  ├─ UpdatesDisabledForVersion / Nuked   (2.0)
   │  ├─ Settings\   flat value names → REG_SZ or REG_DWORD
   │  └─ Users\<SID>\   per-user override (2.0 alpha 7+)
   └─ ModsWritable\<mod-id>\   mod-owned storage (LocalStorage, ...)   ← not ours
```

`[C]` for the tree, value names, and types: `[S1]` `[S2]` `[S9]` `[L1]`.

Key semantics:

- **Installed** means `LibraryFileName` exists and is non-empty. The engine enumerates every subkey; a key with no `LibraryFileName` is still enumerated and produces a load error. Never create keys for mods that are not installed. `Version` and `LibraryFileName` are owned by Windhawk's installer/updater, and `LibraryFileName` changes on update — never derive or cache them as profile data. `[C]` `[S1]` `[S9]` `[L1]`
- `Disabled` absent means enabled (`GetInt(...).value_or(0) != 0`). Any non-zero value is disabled. `[C]` `[S2]`
- `Settings` has no child keys on this machine — only values. Nested/array settings are flattened into names (`Group.child`, `List[0]`, `List[0].field`). `[C]` `[S9]` `[L1]`
- `ModsWritable\<id>\LocalStorage` holds mod-written data, including `REG_BINARY`. It is a sibling of `Mods`, not inside it, so a `Mods` snapshot does not cover it. `[C]` `[S1]` `[S11]`

### 4.1 Per-user configuration (2.0)

A user configuration exists when `...\Mods\<id>\Users\<SID>\Disabled` is present; `UserScoped` (in that same user tree) says whether it is active. While active, the user's `Disabled`, settings, and custom lists override the global ones; `Include`/`Exclude`/`Architecture` still come from the global tree. Portable mode has no user configurations. `[C]` `[S9]` `[S19]`

Consequence: on a 2.0 machine with `UserScoped=1`, reading only the global key gives the wrong effective state. v1 should detect any `Users\<current-SID>` subtree with `UserScoped=1` and refuse apply (or at minimum display read-only), rather than report false drift. `[I]`

---

## 5. Settings value encoding

| Kind | Storage | Example |
|---|---|---|
| Boolean | `REG_DWORD` 0/1 | `disableThumbnails = 0x1` |
| Integer | `REG_DWORD`, signed 32-bit | `duration_ms = 0x1c2` |
| String | `REG_SZ` | `engine = "classic"` |
| `$float` | `REG_SZ` containing decimal text | `"0.5"` |
| String/number array | one value per element: `List[0]`, `List[1]` | `themePaths[0] = ""` |
| Nested object | flattened name: `Group.child` | `redirectionResourcePaths[0].original` |
| Color (`colorRgb`/`colorArgb`) | `REG_SZ`; **2.0 alpha 7 adds a leading `#`** | version-sensitive `[S19]` |

`[C]` `[S9]` `[S10]` `[S12]` `[S16]` `[L1]`

No `REG_QWORD`, `REG_EXPAND_SZ`, or `REG_MULTI_SZ` is used for mod settings; a reader that only understands `REG_SZ`/`REG_DWORD` is correct, and anything else is invisible to the engine. `[C]` `[S9]` **Arrays are not pipe-joined.** The `|` codec is only for the mod **config** fields `Include`, `Exclude`, `Architecture`, `IncludeCustom`, `ExcludeCustom`. `[C]` `[S10]` `[S12]` A settings string may legitimately contain `|` — the live `iconTheme` value does. Settings must therefore be treated as opaque name → scalar, never parsed or re-encoded by type. `[C]` `[L1]`

`Settings` values are written as a map; Windhawk's own `setModSettings` **replaces the whole `Settings` key**, it does not merge. `[C]` `[S9]` The CLI's `mod settings set` compensates by reading the current map, merging the requested pairs, and writing the result back in one call; `mod settings write` is the destructive replace-all variant. `[C]` `[S14]` Our app must do the same read-merge-write, or it will delete settings it did not intend to touch.

---

## 6. Reload semantics

### 6.1 The watch loop

The engine opens `HKLM\SOFTWARE\Windhawk\Engine\Mods` (the engine `RegistryKey` + `\Mods`) with `KEY_NOTIFY | KEY_WOW64_64KEY` and arms `RegNotifyChangeKeyValue(..., bWatchSubtree=TRUE, REG_NOTIFY_CHANGE_NAME | REG_NOTIFY_CHANGE_LAST_SET | REG_NOTIFY_THREAD_AGNOSTIC)`. On a signal it waits **200 ms** to coalesce a burst of writes, then calls `ModsManager::ReloadModsAndSettings()`. `[C]` `[S1]` `[S4]`

The reload is in-process: each injected engine instance re-enumerates the mods, re-reads the config, unloads/reloads as needed, and calls `Wh_ModSettingsChanged` where the marker changed. There is no service RPC and no UI involvement. `[C]` `[S3]`

### 6.2 What each write triggers

| Change | Reload trigger | Extra requirement |
|---|---|---|
| `Disabled` 0↔1 | Any subtree notification; `Disabled` is re-read on every reload | None |
| `Settings` values | Notification causes a reload, but settings are only applied if the marker differs | Bump `SettingsChangeTime` |
| `Version` / `LibraryFileName` | Notification; `LibraryFileName` change forces a full reload | None (Windhawk-owned) |
| `Include` / `Exclude` / `Architecture` | Notification; re-evaluated on reload | None |

`[C]` `[S2]` `[S3]`

`IsModDisabled` reads the user scope’s `Disabled` when a user config is active, otherwise the global one. `[C]` `[S2]`

### 6.3 `SettingsChangeTime`

The engine compares the current marker with the last marker it read (`MakeChangeMarker` → `ChangeMarker.settingsChangeTime`, type `int`, default 0). It calls `Wh_ModSettingsChanged` only when the value differs. `[C]` `[S2]`

Canonical writer algorithm (2.0 core): `now = (unix_ms / 1000) & 0x7fffffff`; if a previous value exists and `previous >= now`, use `(previous + 1) & 0x7fffffff`, otherwise use `now`. `[C]` `[S9]` (function `settings_change_time`, tests cover same-second and `i32::MAX` wrap). The live value `0x6ad9ee0d` decodes to 2026-10-22 11:05:49 UTC, confirming Unix seconds rather than FILETIME. `[C]` `[L1]`

Maintainer guidance: “it can be any value, as long as it's different from the previous value.” `[C]` `[S24]` Use the canonical time-based algorithm anyway: it is debuggable and avoids ABA when other tools also write.

Do **not** bump the marker when only `Disabled` changes: it causes an unnecessary mod reload and a spurious `Wh_ModSettingsChanged` in every process. `[I]`

### 6.4 Service stop/start is unnecessary

Because the watch lives in the engine DLL and reacts to registry changes, a running Windhawk applies a profile within roughly 200 ms plus reload time. Stopping the service is a heavier, riskier operation: it unloads mods from all processes, can fail or time out, and leaves the machine without mods if the subsequent start fails. `[C]` `[S1]` `[S4]`; risk assessment `[I]`

Closing the Windhawk UI does not save or rewrite settings either; `CMainWindow::OnDestroy` only unregisters the hotkey and exits. `[C]` `[S6]` The service controller should remain in the app for repair/“service was stopped” cases, not as part of every apply.

### 6.5 Process-level effects

Reload affects processes that already have the engine loaded. New processes get the engine on creation. `[C]` `[S21]` `[S22]` Some mods still need their target process restarted because they hook at process start or cache UI objects. The Taskbar Styler, for example, explicitly prompts “Restarting Explorer is required for the mod to activate.” `[C]` `[S27]` Our Explorer-restart action is therefore a real requirement for some mods, but it is mod-specific, not a Windhawk-wide reload requirement. Avoid prompting twice: either let the mod prompt or let the app restart Explorer, not both. `[I]`

### 6.6 Safe write order

1. For a mod being disabled: write `Disabled=1` first (unload), then settings + marker (harmless while unloaded).
2. For a mod being enabled: write settings + marker first, then `Disabled=0` (loads once with final settings).
3. For an already-enabled mod: write settings, then marker.
4. Write all per-mod values, then the markers last and close together, so the 200 ms debounce coalesces them into as few reloads as possible.
5. Verify by reading back the registry. There is no public “reload completed” event; a short settle delay (≈300–500 ms) is the only practical confirmation. `[I]`

If a crash occurs mid-write, the marker is still old, so running mods keep their previous settings; the next reload picks up the partial tree. This makes “marker last” a useful safety property. `[I]` (consistent with the debounce and marker comparison in `[S2]` `[S4]`)

---

## 7. Mod identity, versions, and the Mac pack

`LibraryFileName` must be a bare file name (`<id>_<version>_<build>.dll`); the engine rejects path separators/root names, `:`, and the names `.`/`..`. `[C]` `[S2]` The DLL lives in `Mods\64` (or `32`/`arm64`). `[C]` `[S1]` `[L1]` A mod can have DLLs in multiple architecture folders; `LibraryFileName` is the same name in each. `[C]` `[L1]` The ten Mac Blur Glass mods, with versions verified against the official source endpoint `https://mods.windhawk.net/mods/<id>.wh.cpp` on 2026-10-22:

| Mod ID | Name | Version | Page |
|---|---|---|---|
| `icon-resource-redirect` | Resource Redirect | 1.3 | https://windhawk.net/mods/icon-resource-redirect |
| `macos-minimize-animation` | MacOS Minimize Animation | 3.1.7 | https://windhawk.net/mods/macos-minimize-animation |
| `taskbar-dock-animation` | Taskbar Dock Animation | 1.9.2 | https://windhawk.net/mods/taskbar-dock-animation |
| `translucent-windows` | Translucent Windows | 1.8.2 | https://windhawk.net/mods/translucent-windows |
| `uxtheme-hook` | UXTheme hook | 1.4 | https://windhawk.net/mods/uxtheme-hook |
| `windows-11-file-explorer-styler` | Windows 11 File Explorer Styler | 1.7 | https://windhawk.net/mods/windows-11-file-explorer-styler |
| `windows-11-notification-center-styler` | Windows 11 Notification Center Styler | 1.7 | https://windhawk.net/mods/windows-11-notification-center-styler |
| `windows-11-settings-styler` | Windows 11 Settings Styler | 1.1 | https://windhawk.net/mods/windows-11-settings-styler |
| `windows-11-start-menu-styler` | Windows 11 Start Menu Styler | 1.7 | https://windhawk.net/mods/windows-11-start-menu-styler |
| `windows-11-taskbar-styler` | Windows 11 Taskbar Styler | 1.10 | https://windhawk.net/mods/windows-11-taskbar-styler |

`[C]` `[S27]` `[S28]` The public mod pages are a single-page app and do not expose the version in server-rendered HTML; the source header (`// @version`) is the reliable machine-readable field. `[C]` `[S27]`

Schema drift is real: settings are not versioned, and a mod update may rename/add/remove keys. Windhawk migrates installed settings during update, but a profile captured from an older schema can carry stale names. `[I]` Store `testedVersion` in the theme pack, warn on mismatch (SPEC FR-10), and write only keys the profile actually captured.

---

## 8. Targeting: Include, Exclude, Architecture

- `Include`, `Exclude`, `Architecture`, `IncludeCustom`, `ExcludeCustom` are `REG_SZ` with `|`-separated patterns (not `REG_MULTI_SZ`). Empty means “no restriction”; `Include` is often `*` for all-process mods. `[C]` `[S2]` `[L1]`
- Matching is wildcard-based (`*`, `?`, path patterns). Critical system processes and the mods-excluded process list only receive pattern-based includes when `PatternsMatchCriticalSystemProcesses=1`; otherwise only an explicit, non-wildcard name matches. `[C]` `[S2]` `[S22]`
- `IncludeExcludeCustomOnly=1` ignores the mod author’s lists and uses only the custom lists. `Include`/`Exclude`/`Architecture` come from the installed mod’s global config; custom lists and their switches are scopeable (per-user). `[C]` `[S2]` `[S9]`
- `Architecture` tokens: `x86`, `x86-64`, `amd64`, `arm64`; empty = all. On ARM64, `x86-64` also matches ARM64 (compatibility semantics). An unknown token such as `*` matches nothing. `[C]` `[S2]`

Recommendation for v1: **do not manage these fields in profiles.** They describe how a mod targets processes, not the look the user is switching. Writing a captured `Include=explorer.exe` onto another machine can silently narrow or break a mod. Capture them in snapshots (full rollback) but keep them out of hand-written profiles. If a future profile needs targeting, model it as a separate, explicit section with validation. `[I]`

Live examples show why: 7 of the 10 mods carry `Architecture=x86-64`; 6 carry an `Include` list (`explorer.exe`, `ShellExperienceHost.exe|ShellHost.exe`, etc.). Copying those blindly to an ARM64 machine would disable mods. `[C]` `[L1]`

---

## 9. Official automation surfaces

### 9.1 Windhawk 1.7.3: none

There is no `windhawk-cli.exe` in the 1.7.3 install; the directory contains only `windhawk.exe`, the helper, the uninstaller, the INI, and `command-line.txt`. `[C]` `[L1]` The legacy flags are process-level only (`-tray-only`, `-exit [-wait]`, `-restart [-tray-only]`, `-safe-mode`) `[C]` `[S23]` `[L1]`. The `windhawk://` protocol is registered, but on 1.7.3 it invokes the VSCodium UI with `--open-url`; it is not an automation API. `[C]` `[L1]`

### 9.2 Windhawk 2.0: `windhawk-cli.exe`

Command groups (2.0.0-alpha.7): `mod list/show/enable/disable/remove/install/update/compile`, `mod config get/set`, `mod settings get/set/write/defaults/options`, `mod user-config`, `repo list/versions/show`, `source`, `app settings get/set`, `update`, `data export/inspect/import`. Globals: `--json`, `--yes`, `--quiet`, `--app-root <dir>`, `--arch auto|x64|arm64|all`. `[C]` `[S13]`

Properties that matter to us:

- Writes require elevation. The CLI has no self-elevation manifest; `mod enable`/`mod remove`/`mod config set`/`mod settings set`/`app settings set` fail with exit 11/12 and `RegCreateKeyEx ... os error 5` from a normal shell. Reads (`mod list/show`, `* get`, `repo *`, `data export`) work unelevated. `[C]` `[S20]`
- `mod settings set` merges; `mod settings write` replaces the whole settings map. `data export/import` is a whole-user-data archive (app settings, mods, per-mod settings/config, optional offline source), with conflict policy and `--yes` gating — not a named-profile feature. `[C]` `[S14]` `[S15]` `[S18]`
- `--app-root` supports non-default installs. Because the CLI exists only in 2.0 alpha, using it as the primary write path would exclude 1.7.3. Keep the registry gateway as the source of truth; add CLI detection as an optional capability later. `[C]` `[S13]` `[I]`

The 2.0 UI itself is unelevated and talks to an elevated helper over a named pipe (`\\.\pipe\Windhawk.Broker.<id>`); the CLI does not use that broker yet. `[C]` `[S20]` This is a precedent for our own elevated-helper design, not an API we can call.

---

## 10. Backup and restore reality check

`.reg` is a merge format, not an image. `reg import` copies the file’s keys and values into the registry; it does not remove keys or values that exist on the machine but are absent from the file. `[I]` (high confidence; the format has no “absence” record, and Microsoft documents import as copying contents in — `[S29]`). Verify this on a disposable key in a VM before relying on it for “full-state restore”.

Consequences for SPEC FR-08:

- Restoring by `reg import` alone leaves behind mods and values added after the snapshot. A true restore needs a diff: delete extra `<mod-id>` subkeys and extra values, then write the snapshot values. That is a job for the typed gateway, not `reg.exe`.
- **Never delete the `Mods` root itself.** The engine holds a notify handle on that key; deleting and recreating it can invalidate the watch and stop live reload. The `Engine` key even carries a `Warning` value saying not to delete it, “even if it's empty”. `[C]` `[L1]` Deleting individual `<mod-id>` subkeys is safer; the watcher sees the subtree change. `[I]` (needs a VM test)
- A snapshot of `Engine\Mods` contains configuration only — no DLLs (`%ProgramData%\...\Mods\64`) and no `ModsWritable`. Restoring a key whose DLL was uninstalled creates an orphan key that the engine enumerates and fails to load. Skip such mods or mark them missing in the restore report. `[C]` `[S1]` `[S11]`
- `reg export` of a non-existent key fails (exit 1); handle “no mods installed” explicitly. Use the 64-bit `reg.exe` / `/reg:64`; a 32-bit process otherwise gets the redirected view. `[I]` (same view issue as §3.4)

Official 2.0 backup/restore (`data export/import`) solves the same problem at whole-user-data granularity, including mods and app settings. It is not a substitute for named profiles and is unavailable on 1.7.3. `[C]` `[S18]` `[S15]` Community practice is consistent: the maintainer-listed backup set is `%ProgramData%\Windhawk\Engine\Mods`, `%ProgramData%\Windhawk\ModsSource`, `HKLM\SOFTWARE\Windhawk\Engine\Mods`, and `...\ModsWritable`; users also export the whole `HKLM\SOFTWARE\Windhawk` key. `[C]` `[S26]` Our snapshot scope (config only) is narrower by design; document that DLLs and mod storage are not rolled back.

---

## 11. Implications for our app

1. **Remove service stop/start from the happy path.** Apply writes registry values; the engine reloads. Keep `ServiceController` for a stopped service and an explicit “repair/reload” action. Update SPEC FR-06 steps 4/7 and PLAN §5. Order writes for minimal reloads: disable first when turning a mod off, enable last when turning it on, batch markers at the end (the 200 ms debounce coalesces them).
2. **Bump `SettingsChangeTime` only when settings values change**, using the canonical algorithm, as the last write for that mod. Never bump it for `Disabled`-only transitions.
3. **Read-merge-write settings.** Never replace the `Settings` key wholesale. Copy the current values, apply overrides, write back, then bump the marker.
4. **Restrict the profile value model to `dword` and `string`** (plus flattened keys) and treat settings as opaque scalars. SPEC §9.1 currently allows `qword`, `expandString`, `multiString`, `binary`, and `none`; Windhawk never uses them, and keeping them invites imports that cannot round-trip. Do not parse `|`, numbers, booleans, or colors: `iconTheme` proves a string can contain `|`, `$float` values are strings, and color encoding changed in 2.0 alpha 7. `[C]` `[S9]` `[S19]` `[L1]`
5. **Keep `Include`, `Exclude`, `Architecture`, custom lists, logging flags, `Version`, `LibraryFileName`, and `SettingsChangeTime` out of profiles.** Capture them only in full snapshots. Extend SPEC §9.5’s exclusion list with the targeting and logging fields.
6. **Detect per-user configuration** (`Users\<SID>` with `UserScoped=1`) before reading or writing. If present, either read the user tree for drift and block writes in v1, or implement scope-aware reads/writes. Silent global-only access produces false drift on 2.0 machines.
7. **Treat “installed” as non-empty `LibraryFileName`**, not file existence, and never create a key for a missing mod. Build restore as a typed diff, not a raw `reg import`: snapshot the subtree, compute extra keys/values, delete only `<mod-id>` subkeys (never the `Mods` root), write the snapshot values, verify, and keep a pre-restore snapshot as SPEC requires.
8. **Use the 64-bit registry view everywhere** and read the root from `windhawk.ini`; do not assume `HKLM` if `RegistryKey` says otherwise.
9. **Verify the registry, not the desktop.** There is no engine acknowledgement. Read back values, wait a short settle period, and report “written/reload requested”; do not claim a mod is visually active.
10. **Plan for 1.7.3 and 2.0.** Feature-detect `windhawk-cli.exe`, `UserScoped`, `Nuked`, and `UpdatesDisabledForVersion`; never require them. The CLI can later be an optional 2.0 write path, but the registry gateway remains the baseline.
11. **Icon theme portability:** the live Mac profile uses the built-in `iconTheme` option (`macOS DarkMode|themes/icons/niivu/macOS%20Dark%20Mode.zip`) and leaves `themePaths[0]`/`themeFolder` empty, so the look is portable. `themePaths`/`themeFolder` are absolute-path fields and must be treated as machine-specific if a user’s capture contains them. `[C]` `[L1]` `[S27]`

---

## 12. Open questions (resolve before/while implementing)

1. **Deletion and import semantics (two VM tests).** Does deleting a `<mod-id>` subkey (not the root) keep the engine’s subtree watch alive and reload correctly? And is `reg import` really merge-only? These decide whether diff-based restore can delete keys while the service runs, and whether the gateway must handle deletions itself.
2. **Does a settings write while the service is stopped get applied on the next service start?** Expected yes (the engine reads on load), but test on 1.7.3.
3. **1.7.3 vs 2.0 field and value differences.** `Nuked`, `UserScoped`, `IncludeCustom`/`ExcludeCustom`, and `UpdatesDisabledForVersion` are 2.0-era; 2.0 alpha 7 also writes `#`-prefixed colors. Decide whether the v1 reader ignores unknown fields (recommended), whether a 2.0 machine is supported, and whether to normalize colors or store the raw string with a version tag.
4. **Mod update migrations.** Does Windhawk drop settings keys removed by a new mod version, or leave them? (The UI’s replace-whole-tree write suggests it drops them on save, but installation migration may differ.) Affects how aggressively we prune stale keys on apply.
5. **Explorer restart ownership.** Will the Taskbar Styler’s own restart prompt fire on apply and race our action? Test with the real mod; choose one owner (probably the app when the user selected “always”, otherwise let the mod prompt).
6. **CLI feasibility on 2.0.** Whether an unelevated app can drive `windhawk-cli` through the existing broker pipe, or must ship its own elevated helper. Issue #1050 is unresolved; assume our own helper.
7. **Per-user support in v1.** Is blocking on `UserScoped=1` acceptable, or must drift/apply be scope-aware from day one? This is a product decision, not a technical unknown.

---

## 13. Sources

All URLs accessed **2026-10-22**.

| ID | Source | URL |
|---|---|---|
| S1 | Windhawk v1.7.3, engine storage manager (watch, paths, 64-bit view) | https://github.com/ramensoftware/windhawk/blob/v1.7.3/src/windhawk/engine/storage_manager.cpp |
| S2 | Windhawk v1.7.3, engine mod (change marker, disabled, architecture, patterns) | https://github.com/ramensoftware/windhawk/blob/v1.7.3/src/windhawk/engine/mod.cpp |
| S3 | Windhawk v1.7.3, mods manager (reload loop) | https://github.com/ramensoftware/windhawk/blob/v1.7.3/src/windhawk/engine/mods_manager.cpp |
| S4 | Windhawk v1.7.3, customization session (watch, 200 ms debounce) | https://github.com/ramensoftware/windhawk/blob/v1.7.3/src/windhawk/engine/customization_session.cpp |
| S5 | Windhawk v1.7.3, app storage manager (`windhawk.ini`, portable, registry root) | https://github.com/ramensoftware/windhawk/blob/v1.7.3/src/windhawk/app/storage_manager.cpp |
| S6 | Windhawk v1.7.3, main window (`OnDestroy`) | https://github.com/ramensoftware/windhawk/blob/v1.7.3/src/windhawk/app/main_window.cpp |
| S7 | Windhawk v1.7.3, service constants | https://github.com/ramensoftware/windhawk/blob/v1.7.3/src/windhawk/app/service_common.h |
| S8 | Windhawk v1.7.3, app entry (portable vs service) | https://github.com/ramensoftware/windhawk/blob/v1.7.3/src/windhawk/app/app.cpp |
| S9 | Windhawk 2.0.0-alpha.7, core mod services (scope, settings replace, marker algorithm) | https://github.com/ramensoftware/windhawk/blob/2.0.0-alpha.7/src/windhawk-core/core/src/services/mods.rs |
| S10 | Windhawk 2.0.0-alpha.7, settings I/O helpers (pipe lists, bool/int) | https://github.com/ramensoftware/windhawk/blob/2.0.0-alpha.7/src/windhawk-core/core/src/services/settings_io.rs |
| S11 | Windhawk 2.0.0-alpha.7, storage paths (registry/INI, users, writable) | https://github.com/ramensoftware/windhawk/blob/2.0.0-alpha.7/src/windhawk-core/core/src/services/storage.rs |
| S12 | Windhawk 2.0.0-alpha.7, settings codec | https://github.com/ramensoftware/windhawk/blob/2.0.0-alpha.7/src/windhawk-core/domain/src/settings_codec.rs |
| S13 | Windhawk 2.0.0-alpha.7, CLI arguments | https://github.com/ramensoftware/windhawk/blob/2.0.0-alpha.7/src/windhawk-core/cli/src/args.rs |
| S14 | Windhawk 2.0.0-alpha.7, CLI `mod settings` (merge vs write) | https://github.com/ramensoftware/windhawk/blob/2.0.0-alpha.7/src/windhawk-core/cli/src/commands/mods/settings.rs |
| S15 | Windhawk 2.0.0-alpha.7, CLI `data` commands | https://github.com/ramensoftware/windhawk/blob/2.0.0-alpha.7/src/windhawk-core/cli/src/commands/data.rs |
| S16 | Windhawk 2.0.0-alpha.7, CLI settings validation (`$float` as string) | https://github.com/ramensoftware/windhawk/blob/2.0.0-alpha.7/src/windhawk-core/cli/src/validate/mod_settings.rs |
| S17 | Release 2.0.0-alpha.1 (CLI, Windows support) | https://github.com/ramensoftware/windhawk/releases/tag/2.0.0-alpha.1 |
| S18 | Release 2.0.0-alpha.2 (backup & restore) | https://github.com/ramensoftware/windhawk/releases/tag/2.0.0-alpha.2 |
| S19 | Release 2.0.0-alpha.7 (per-user config, CLI additions, color format) | https://github.com/ramensoftware/windhawk/releases/tag/2.0.0-alpha.7 |
| S20 | Issue #1050, CLI elevation and 2.0 broker pipe | https://github.com/ramensoftware/windhawk/issues/1050 |
| S21 | Wiki: Mod lifetime (`Wh_ModSettingsChanged`) | https://github.com/ramensoftware/windhawk/wiki/Mod-lifetime |
| S22 | Wiki: Injection targets and critical system processes | https://github.com/ramensoftware/windhawk/wiki/Injection-targets-and-critical-system-processes |
| S23 | Wiki: Command-line flags | https://github.com/ramensoftware/windhawk/wiki/Command-line-flags |
| S24 | Discussion #393, maintainer on `SettingsChangeTime` | https://github.com/ramensoftware/windhawk/discussions/393#discussioncomment-12093003 |
| S25 | Discussion #73, registry `Disabled` toggle | https://github.com/ramensoftware/windhawk/discussions/73 |
| S26 | Discussion #155, backup set and community scripts | https://github.com/ramensoftware/windhawk/discussions/155 |
| S27 | Official mod source endpoint (`// @version` headers) | https://mods.windhawk.net/mods/windows-11-taskbar-styler.wh.cpp (and the same path for each ID) |
| S28 | Windhawk mod pages | https://windhawk.net/mods/ (one page per ID listed in §7) |
| S29 | Microsoft Learn: `reg import` | https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/reg-import |
| L1 | Local read-only inspection, Windows 11 x64, 2026-10-22 | `reg query HKLM\SOFTWARE\Windhawk\Engine\Mods /s`; `Get-CimInstance Win32_Service -Filter "Name='Windhawk'"`; `Get-Content "C:\Program Files\Windhawk\windhawk.ini"`; `Get-ChildItem "C:\ProgramData\Windhawk\Engine\Mods\64"` |
