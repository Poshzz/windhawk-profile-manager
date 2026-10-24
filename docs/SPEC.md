# SPEC — Windhawk Profile Manager v1

**Status:** Ready for review (research integrated)
**Platform:** Windows 11 (x64), per-machine desktop app
**Last updated:** 2026-10-22

---

## 1. Summary

Windhawk Profile Manager switches a Windows 11 machine between named Windhawk mod configurations. A **profile** declares which mods are enabled, optional settings overrides, and app actions such as Rainmeter. Applying a profile creates a **snapshot** first, executes a reviewed **apply plan** through a short-lived elevated helper, verifies the result, and rolls back automatically on failure.

The first release ships a **Mac Blur Glass** theme pack (10 mods) and a **Default Windows** profile, plus user-created profiles captured from the current machine.

---

## 2. Goals

| ID | Goal |
|----|------|
| G1 | Switch between Mac Blur Glass and stock Windows in one guided flow, with a visible plan before anything changes. |
| G2 | Support multiple user profiles, not just two hardcoded modes. |
| G3 | Make every apply recoverable: snapshot before writing, journal during the run, rollback on failure, recovery after a crash. |
| G4 | Be safe on machines with missing or unlisted mods. Never silently disable a mod the profile does not own. |
| G5 | Be shareable: per-machine installer, no hardcoded user paths, Thai and English UI, install checklist for the theme pack. |
| G6 | Be transparent: show every registry write, service action, and process action before it happens. |

## 3. Non-goals for v1

- Installing Windhawk or Windhawk mods automatically.
- A raw per-setting editor for every mod setting (settings are captured and applied, but edited only by capture/import in v1).
- Wallpaper, cursor, sound, or icon-file management. Icon theme selection remains a mod setting.
- Windows 10, ARM64, or multi-user support.
- Auto-update, code signing, tray icon, global hotkeys, auto-start, or silent scheduled-task mode.
- Cloud sync or telemetry.

---

## 4. Users and jobs

**Owner (primary).** Has Windhawk and the 10 Mac theme mods installed. Wants to switch looks without remembering which files to run, and wants a way back if a switch breaks the shell.

**Shared user (secondary).** Downloaded the app. May have Windhawk but only some mods. Needs to see what is missing, install it from the official mod page, and understand exactly what the app will touch.

**Jobs**

- J1 "Switch to Mac Blur Glass for a while, then go back to stock Windows."
- J2 "Save the current setup before I experiment."
- J3 "Something broke after an apply; put it back."
- J4 "Share my setup with a friend."

---

## 5. Domain model

The canonical vocabulary lives in [`CONTEXT.md`](../CONTEXT.md). This spec uses **profile**, **snapshot**, **apply**, **reset**, **restore**, **managed mod**, **unlisted mod**, **missing mod**, **apply plan**, **apply run**, and **journal** exactly as defined there.

---

## 6. Information architecture

A single window with a custom macOS-style titlebar and a left sidebar.

| Screen | Purpose |
|--------|---------|
| **Home** | Active profile, drift, Windhawk/Rainmeter status, quick actions. |
| **Profiles** | Built-in and user profiles; apply, duplicate, edit, capture, import/export. |
| **Snapshots** | Timeline of snapshots; restore, export, import, delete. |
| **Theme Packs** | Bundled packs, required mods, install checklist, compatibility notes. |
| **Settings** | Language, appearance, Explorer behavior, backup retention, logs, diagnostics. |

Window: default 1120 × 740, minimum 900 × 600. Dark and light themes. Mica background on Windows 11 22H2+ with an opaque fallback. The titlebar uses `titleBarStyle: 'hidden'` plus the native overlay, with a custom macOS-style control cluster only in the `WPM_TITLEBAR=custom` fallback. ADR-0009 records the spike: the native overlay was chosen for native snap layouts, the system menu, and accessibility; both modes passed drag, double-click, snap, restore, and Mica checks on Electron 45.

---

## 7. Functional requirements

### FR-01 — Detect the environment

On launch and on manual refresh, the app detects:

- Windows version and build; warn and disable apply on unsupported builds.
- Windhawk installation, resolved in this order: installer metadata `HKLM\SOFTWARE\WOW6432Node\Windhawk\install_dir` (32-bit view), the `Windhawk` service `ImagePath`, then `%ProgramFiles%\Windhawk`. Read `<install>\windhawk.ini` for `Portable`, `RegistryKey`, and paths.
- Windhawk mode: registry mode, portable mode (unsupported read-only), and the configured registry root. v1 supports only `HKLM\SOFTWARE\Windhawk`; another root such as `HKCU` or `HKU` is read-only with an explanation.
- Service presence and state; engine version from the `Engine\<version>` folder.
- Installed mods: a mod is installed when `LibraryFileName` exists and is non-empty. Report enabled/disabled state, settings key count, and per-user overrides.
- Per-user config: a `Users\<current-SID>\Disabled` subtree exists and `UserScoped=1` makes it active. v1 detects this and blocks writes rather than reporting false global drift.
- Rainmeter: installed path and running state.

**Acceptance:** With Windhawk absent, Home shows a clear "Windhawk not found" state with a link to the official installer and Apply is disabled. With Windhawk present but the service stopped, status shows "stopped" and Apply can start it.

### FR-02 — Profile library

- Two built-in, read-only profiles: **Mac Blur Glass** and **Default Windows**.
- User profiles: create blank, capture current, duplicate, rename, edit description, delete.
- Built-in profiles can be duplicated into an editable user profile.
- Profile cards show name, source, managed mod count, last applied time, and compatibility status.

**Acceptance:** Duplicating a built-in profile produces an independent user profile. Deleting a user profile requires confirmation and never deletes snapshots.

### FR-03 — Basic profile editor

v1 supports editing:

- Profile name and description.
- Which installed mods the profile manages (checkbox list).
- Desired enabled/disabled state per managed mod.
- Rainmeter action: start, stop, or leave unchanged.
- Unlisted-mod policy: leave untouched or disable all others.
- Explorer restart preference: ask, always, or never (profile-level default; the apply dialog can override).

Per-setting values are preserved from capture/import but are not hand-edited in v1.

**Acceptance:** A profile with no managed mods cannot be applied; the editor explains why. A profile that references an uninstalled mod saves normally and reports it as missing at apply time.

### FR-04 — Capture current setup

- Reads all installed mods and their settings.
- Creates a user profile preserving enabled state and settings.
- Defaults the name to `My setup — YYYY-MM-DD HH:mm`.
- Excludes volatile, targeting, and machine-specific registry values from the profile (see §9.5).
- Offers to open the new profile immediately.

**Acceptance:** Capturing then applying the captured profile on the same machine produces no registry changes other than the reload action.

### FR-05 — Apply plan and preflight

Before any change, the app computes an **apply plan** and shows it in a confirmation dialog:

- Preflight report: Windows build, Windhawk version and storage mode (registry vs. portable), service state, installed/missing mods, version mismatches, Rainmeter state.
- Managed mods with transitions: `off → on`, `on → off`, `unchanged`.
- Settings values to write, grouped by mod, with a count and an expandable list.
- Settings values to **delete** when a mod is in `replace` mode, including a distinct "delete all settings" warning when the profile's map is empty.
- Reload behavior: the Windhawk engine watches the registry and reloads automatically; no service restart is planned. If the service is stopped, the plan offers to start it.
- A per-mod `settingsHash` and a registry `beforeHash`; if either changed since the preview, the plan is stale and must be rebuilt.
- Missing mods: skipped, with a link to the mod page.
- Unlisted mods: listed, with the active policy (`leave` or `disable`).
- Service action (start only if stopped), Rainmeter action, and Explorer restart behavior.
- "A snapshot will be created before any registry write."

**Acceptance:** The dialog lists every value the app will write or delete, and a `replace` mod with an empty map is shown as "delete all settings" with an explicit confirmation. Canceling the dialog writes nothing, starts no process, and creates no snapshot. A plan whose `beforeHash` or profile `revision` no longer matches is rejected with a "rebuild the plan" message.

### FR-06 — Apply execution

Apply has two phases.

**Privileged phase — elevated helper:**

1. Preflight: elevation, x64 process, supported registry root, service running (offer to start it if stopped), target mods installed, no active per-user `UserScoped=1` configuration, schema/allowlist/size limits, per-mod `settingsHash` and plan `beforeHash` still current, and read/write access to the supplied plan, snapshot, journal, and result paths.
2. Snapshot: export the mods subtree with `/reg:64` while the service runs, parse it, record each mod's `LibraryFileName`, and write snapshot metadata. Compare the snapshot's canonical hash to the plan's `beforeHash`; a mismatch aborts before the journal or any write. No service stop is needed.
3. Write the journal (`state: journaling`).
4. Apply typed values per managed mod in the safe order:
   - Mods being **disabled**: write `Disabled=1` first, then settings and the marker.
   - Mods being **enabled**: write settings and the marker first, then `Disabled=0` last.
   - Already enabled: write settings, then the marker.
   - For `replace` mode, delete values under `Settings` that the profile omits; for `merge`, leave them.
   - Do not replace the whole `Settings` key; read the current map and write only the intended values. Never create a key for a missing mod.
   - Batch `SettingsChangeTime` writes at the end and close together so the engine's 200 ms debounce coalesces reloads.
5. Stamp `SettingsChangeTime` only for mods whose settings changed, using `max(now & 0x7fffffff, previous + 1)` as a positive 31-bit integer; if that would exceed `0x7fffffff`, wrap to `1`. Do not bump it for a `Disabled`-only change.
6. Settle for about 300–500 ms, then verify every touched value by read-back, compare canonical hashes, and confirm the service is running. There is no engine acknowledgement.
7. Mark the journal `privileged-complete` and write `result.json`.

**Finishing phase — non-elevated main process:**

8. Apply the Rainmeter action: graceful quit via the Rainmeter bang when running; start only if the profile requests it.
9. Restart Explorer only if requested, detecting the shell process first and waiting for a new shell. Avoid racing a mod's own restart prompt.
10. Mark the journal complete, update the active profile, and record the result.

Rainmeter and Explorer run in the main process because starting them from an elevated helper would create elevated user processes, and Explorer may refuse to start elevated.

**Acceptance:** No registry write occurs before the snapshot and journal exist. No service stop/start occurs on the happy path; the engine reloads from its registry watch. On failure before step 7, the helper restores typed values, deletes values the plan added, re-stamps the reload marker, verifies, and reports both the failure and the rollback result. A failure in the finishing phase is reported as `succeeded-with-warning`; the registry apply is not rolled back. The result says **"applied, reload requested, not confirmed loaded"** because Windhawk exposes no signal that a mod actually injected.

### FR-07 — Reset to Default Windows

Reset is applying the built-in **Default Windows** profile:

- Disable the 10 theme mods if installed; keep their settings by using `merge` mode on every mod.
- Stop Rainmeter if running.
- Leave unlisted mods untouched (unless the user duplicated the profile and opted into `disable`).
- Snapshot, write `Disabled=1`, verify, and let the engine reload; same execution and rollback path as any apply.

**Acceptance:** Reset does not erase Mac settings. Re-applying Mac Blur Glass restores the previous look without re-entering settings.

### FR-08 — Snapshots and restore

- Automatic snapshot before every apply and before every restore.
- Manual "Back up now".
- List shows timestamp, trigger, active profile, mod count, and size.
- Restore a snapshot: confirm, take a pre-restore snapshot, **reconcile typed values while the service runs**:
  - Set every captured value with its recorded type, including `Disabled`, settings, and targeting values (`Include`, `Exclude`, `Architecture`, custom lists) on the same machine.
  - Delete values added after the snapshot inside captured keys.
  - Never write `LibraryFileName` or `Version`; report installed-version differences instead.
  - Do **not** delete `<mod-id>` subkeys or the `Engine\Mods` root: the engine holds a notify handle on the root, and key deletion needs a VM test. Mods installed after the snapshot are listed as newer and left in place.
  - Re-stamp `SettingsChangeTime` for mods whose settings changed, verify, and report.
  - Skip captured mods whose `<mod-id>` key no longer exists; never recreate a key without an installed mod, and list the skipped mods.
- Restore is full-state within the snapshot's scope: it reverts captured mod configuration, including unlisted mods. It does not restore mod DLLs or `ModsWritable` mod-owned storage. For an imported snapshot, the preview flags captured targeting values as machine-specific and warns before writing them.
- Snapshots are stored with a user-only ACL and may contain machine-specific paths; they are never uploaded.
- Retention: keep the 20 most recent automatic snapshots and all manual snapshots. Deleting is explicit.

**Acceptance:** Restoring the snapshot taken immediately before an apply returns every captured value to its pre-apply state and removes values the apply added inside captured keys. A pre-restore snapshot exists even if the restore fails. A snapshot cannot restore registry ACLs or mod DLLs; the app documents both limitations.

### FR-09 — Import and export

- Export a profile as versioned JSON; import validates schema, types, and values before saving.
- Export a snapshot as `.reg` evidence plus metadata JSON; import a `.reg` as a snapshot only after strict parsing and allowlist validation.
- Imported `.reg` files are evidence, never applied directly; restore goes through the typed reconciliation path.
- Importing an invalid or out-of-allowlist file shows a specific error and writes nothing.
- The legacy kit's `.reg` files can be imported as snapshots; the Mac profile is seeded at build time, not read from the user's Documents folder at runtime.

**Acceptance:** A profile JSON with an unknown field, a forbidden registry path, a disallowed value type, or a dangerous JSON key (`__proto__`, `constructor`, `prototype`) is rejected. A valid export/import round-trip produces an identical profile.

### FR-10 — Theme pack: Mac Blur Glass

- Bundled metadata for the 10 mods: display name, mod ID, official page URL, tested version.
- Status per mod: installed, missing, version mismatch, disabled.
- The built-in Mac profile's Apply button is disabled until every required mod is installed; the page shows the exact missing list and links.
- User-created profiles may apply with missing mods; those mods are skipped with a warning.
- Version mismatch warns but does not block (Windhawk may auto-update mods).
- Notes machine-specific settings (for example absolute theme paths in a user capture) that may need adjustment; the built-in `iconTheme` option is portable.

**Acceptance:** On a machine with all 10 mods, the pack shows "Ready" and Apply is enabled. With 9 of 10, Apply is disabled, the missing mod is named, and its official page opens from the app.

### FR-11 — Drift detection

- Compare current registry state with the active profile.
- Show "matches", "N differences", or "unknown" when Windhawk is unavailable.
- Provide a details view and a refresh action.
- Drift never auto-applies or auto-corrects.

**Acceptance:** Toggling a managed mod in Windhawk produces drift on the next refresh. Toggling an unlisted mod does not.

### FR-12 — Startup recovery

On launch, if the journal shows an unfinished apply run:

- Show a recovery banner naming the interrupted run and its snapshot.
- Offer "Restore pre-apply snapshot" and "Keep current state and close the run".
- Never delete the snapshot automatically.

**Acceptance:** Killing the app during execution and relaunching produces the recovery banner. Restoring returns the pre-apply state; dismissing marks the run closed while preserving the snapshot.

### FR-13 — Settings and diagnostics

- Language: System, Thai, English. Persist the choice; default from OS locale.
- Appearance: System, Light, Dark.
- Explorer restart: Ask, Always, Never (default Ask).
- Automatic snapshot retention: 5–50 (default 20).
- Logs: open folder, view recent entries, copy diagnostics.
- Diagnostics include app version, Windows build, Windhawk version/storage mode/registry root/service state, mod count, and the last run result; no registry values or personal paths.
- No network requests in v1.

**Acceptance:** Changing language updates the UI without a restart where practical, and persists across launches.

### FR-14 — Error states

Every failure maps to a specific, actionable message:

| Condition | Behavior |
|-----------|----------|
| Windhawk not installed | Disable apply; link to installer. |
| Windhawk service stopped | Offer "Start service"; if it cannot start, show the service name, error code, and retry. Apply never restarts a running service. |
| Portable Windhawk, non-HKLM registry root, or active per-user config | Read-only mode; explain why and link to compatibility notes. |
| Missing helper or helper path not writable by administrators | Disable apply; ask the user to reinstall. |
| UAC canceled | No changes; return to the plan dialog with a neutral notice. |
| Plan is stale (`beforeHash`, `settingsHash`, or profile revision changed) | Do not write; ask the user to rebuild the plan. |
| Missing required mods (built-in pack) | Disable apply; list and link. |
| Missing mods (user profile) | Skip and report in plan and result. |
| Invalid profile/snapshot | Reject with field-level reason; write nothing. |
| Apply failed | Auto-rollback, then report both outcomes. |
| Rollback failed | Keep journal and snapshot; show snapshot path and manual restore steps. |
| Explorer restart failed | Report; do not roll back registry. |
| Rainmeter not installed | Skip action; report. |
| Unsupported Windows build | Read-only mode; explain the supported range. |

### FR-15 — First run

1. Detect environment.
2. Seed built-in profiles from bundled data.
3. Show a short intro: what the app changes, that it asks for admin only on apply, and that it snapshots first.
4. Offer "Capture my current setup" and "Open Mac Blur Glass pack".
5. Persist first-run completion.

**Acceptance:** A fresh profile directory produces the two built-in profiles and no user profiles. The intro appears once.

---

## 8. Apply state machine

```
draft
  └─ plan built ──────────────► planned
                                  └─ user confirms ─► awaiting-elevation
                                                        ├─ UAC canceled ─► canceled (no changes)
                                                        └─ helper starts ─► preflight
                                                                              └─ export + parse ─► snapshotting
                                                                                    └─ journal writes ─► journaling
                                                                                          └─ typed writes + markers ─► applying
                                                                                                ├─ success ─► settling ─► verifying ─► privileged-complete
                                                                                                │                                          └─ finishing
                                                                                                │                                               ├─ actions ok ─► succeeded
                                                                                                │                                               └─ action failed ─► succeeded-with-warning
                                                                                                └─ failure ─► rolling-back
                                                                                                                ├─ success ─► rolled-back
                                                                                                                └─ failure ─► rollback-failed
interrupted (journal found on startup) ─► recovery offered
```

Rules:

- Only one apply or restore may run at a time. The journal acts as the lock across processes.
- A run may be canceled before elevation. Once the helper starts, the UI shows progress and cannot abort mid-write; it can only wait for the result or rollback.
- The service stays running. The engine watches the registry and reloads after a ~200 ms debounce; apply does not stop or start it on the happy path.
- If the service is stopped, preflight offers to start it before applying; a stopped service means no mods are loaded.
- The snapshot is written, parsed, and flushed before the journal is marked `journaling`; the journal is durable before the first registry write.
- A stale `beforeHash` or `settingsHash` aborts the run before any write and asks the user to rebuild the plan.
- `SettingsChangeTime` is written last, only for mods whose settings changed, and never for a `Disabled`-only transition.
- The snapshot is never deleted by automatic retention until its journal is complete or explicitly dismissed.
- Rainmeter and Explorer failures occur after `privileged-complete`; they downgrade the result to `succeeded-with-warning` and never trigger a registry rollback.

---

## 9. Data formats

Persistent app data lives under two roots; the elevated handoff uses a third, ephemeral directory:

```
%APPDATA%\WindhawkProfileManager\        (roaming; user intent)
  profiles/<profile-id>.json

%LOCALAPPDATA%\WindhawkProfileManager\   (machine-specific; never roams)
  snapshots/<snapshot-id>.json
  snapshots/<snapshot-id>.reg
  logs/app.log
  state.json
  journal.json

%ProgramData%\WindhawkProfileManager\runs\<runId>\  (ephemeral handoff)
  plan.json
  result.json
```

Profiles are user intent and may roam. Snapshots are machine-specific evidence and may contain paths or secrets, so they stay local and are written with a user-only ACL. Run directories are ACL-restricted to the current user and Administrators and are deleted after the result is read.

Writes are atomic: write to a temp file in the same directory, flush, then rename.

### 9.1 Profile

```json
{
  "schemaVersion": 1,
  "id": "mac-blur-glass",
  "name": "Mac Blur Glass",
  "description": "macOS-style blur, dock, and menu treatment.",
  "source": "builtin",
  "basedOn": null,
  "revision": 1,
  "createdAt": "2026-10-22T12:00:00.000Z",
  "updatedAt": "2026-10-22T12:00:00.000Z",
  "requiredMods": [
    {
      "modId": "windows-11-taskbar-styler",
      "state": "enabled",
      "mode": "replace",
      "settings": {
        "TaskbarHeight": { "type": "dword", "value": 48 },
        "Theme": { "type": "string", "value": "macOS" }
      }
    }
  ],
  "unlistedMods": "leave",
  "actions": {
    "rainmeter": "start",
    "restartExplorer": "ask"
  }
}
```

- `revision` increments on every edit and is recorded in the apply plan; a stale revision rejects the plan.
- `requiredMods[].state` is `enabled` or `disabled`.
- `requiredMods[].mode` is `replace` (default) or `merge`.
  - `replace`: the profile's `settings` map is authoritative; values under `Settings` that the profile omits are deleted. The plan lists the deletions.
  - `merge`: the profile writes its values and leaves other settings untouched.
- Reverse safety: `replace` with an empty `settings` map means **delete every setting** for that mod. The plan labels it "delete all settings" and requires an explicit confirmation. The built-in Default Windows profile uses `merge` on every mod so Reset preserves settings. The editor defaults a newly added mod to `merge` until settings are captured or imported.
- Profile `settings` supports `string` (`REG_SZ`) and `dword` (`REG_DWORD`) only. Windhawk mod settings use no other types; `binary`, `qword`, `expandString`, `multiString`, and `none` are rejected at import.
- `source` is `builtin`, `user`, or `imported`.
- `basedOn` records the built-in profile a user duplicated, for provenance.
- Profiles never contain targeting or machine-specific values: `Include`, `Exclude`, `Architecture`, `IncludeCustom`, `ExcludeCustom`, `IncludeExcludeCustomOnly`, logging flags, `LibraryFileName`, `Version`, `SettingsChangeTime`, or per-user `Users\<SID>` settings. Snapshots capture them for full rollback.

### 9.2 Snapshot metadata

```json
{
  "schemaVersion": 1,
  "id": "2026-10-22T20-02-14-123Z",
  "createdAt": "2026-10-22T20:02:14.123Z",
  "trigger": "pre-apply",
  "profileId": "mac-blur-glass",
  "appVersion": "0.1.0",
  "windowsBuild": "22631",
  "registryView": "64-bit",
  "windhawkVersion": "1.7.3",
  "windhawkStorageMode": "registry",
  "windhawkServiceName": "Windhawk",
  "windhawkServiceState": "running",
  "rainmeterRunning": true,
  "registryFile": "2026-10-22T20-02-14-123Z.reg",
  "registrySha256": "…",
  "modCount": 10
}
```

`trigger` is `pre-apply`, `pre-restore`, `manual`, or `imported`. The `.reg` file is raw evidence; restore parses it with the strict codec and reconciles typed values instead of importing it. A snapshot covers `Engine\Mods` configuration only: it excludes mod DLLs under `%ProgramData%\Windhawk\Engine\Mods\{32,64,arm64}` and mod-owned storage under `Engine\ModsWritable`. It also cannot capture registry ACLs. The app states these limits when restoring.

### 9.3 Journal

```json
{
  "schemaVersion": 1,
  "runId": "run-2026-10-22T20-02-14-123Z",
  "state": "applying",
  "startedAt": "2026-10-22T20:02:14.123Z",
  "updatedAt": "2026-10-22T20:02:18.000Z",
  "snapshotId": "2026-10-22T20-02-14-123Z",
  "planHash": "sha256:…",
  "beforeHash": "sha256:…",
  "profileRevision": 3,
  "plan": { "…": "the validated execution plan" },
  "result": null
}
```

Journal states: `preflight`, `snapshotting`, `journaling`, `applying`, `settling`, `verifying`, `privileged-complete`, `finishing`, `succeeded`, `succeeded-with-warning`, `rolling-back`, `rolled-back`, `rollback-failed`, `closed-interrupted`.

### 9.3a Execution plan envelope

Apply and restore share one privileged protocol, one journal, and one rollback path. The helper accepts a single envelope:

```json
{
  "schemaVersion": 1,
  "kind": "apply",
  "runId": "run-…",
  "snapshotId": "…",
  "profileId": "mac-blur-glass",
  "profileRevision": 3,
  "beforeHash": "sha256:…",
  "paths": {
    "plan": "…",
    "snapshotRegistry": "…",
    "journal": "…",
    "result": "…"
  },
  "actions": { "rainmeter": "start", "restartExplorer": "ask" },
  "planHash": "sha256:…"
}
```

- `kind: "apply"` adds the list of mod changes: typed settings sets, typed deletions, `Disabled`, and a `settingsHash` per mod.
- `kind: "restore"` adds `sourceSnapshotId` and the source snapshot's absolute `.reg` path. The helper parses it and reconciles values; it never passes the file to `reg import`.
- `beforeHash` is a canonical hash of the current managed registry state. The helper re-reads and compares before writing; a mismatch aborts the run.
- `unlistedPolicy` (`leave` or `disable`) is hashed into the plan. A `disable` policy also covers the installed unlisted set, so a mod installed after the plan or during snapshot capture makes the plan stale rather than silently staying enabled.
- `deleteAllSettingsConfirmed` records the explicit confirmation for any `replace` mod with an empty settings map. The helper rejects an unconfirmed delete-all plan before the service check, snapshot, journal, or any write; dry run remains available for preview.
- `SettingsChangeTime` is not an input; the helper computes it from the current value and writes it last.
- Both kinds share the same state machine, verification, and rollback behavior.
- `paths` are absolute and supplied by the main process; the helper never derives them from its own user profile.

### 9.3b Helper launch and exit codes

The GUI launches the fixed per-machine binary `%ProgramFiles%\WindhawkProfileManager\WindhawkProfileManager.exe` with:

```text
--helper --plan <absolute plan.json> --hash <sha256> [--dry-run]
```

Helper mode is selected before the single-instance lock and before any `BrowserWindow` is created. It reads the single plan file once, checks its size, rejects duplicate JSON keys, compares its SHA-256 hash with `--hash` in constant time, and revalidates the schema and allowlist before any registry or service call. It writes `result.json` beside the plan and exits with a stable code:

| Exit | Meaning |
| --- | --- |
| `0` | Success. A dry run also exits `0` after writing a `dry-run` result. |
| `2` | Validation failure: the plan was rejected, a supplied path is inaccessible, or the environment is incompatible. No registry write occurred after validation failed. |
| `3` | Apply failure. The result is `failed` or `rolled-back`; the pre-apply snapshot is the recovery source. |
| `4` | Rollback failure. The result is `rollback-failed`; the journal blocks another run until resolved. |

The broker maps Win32 `ERROR_CANCELLED` (`1223`) to `ElevationCanceledError`; cancellation leaves no snapshot or journal. The plan and result live in `%ProgramData%\WindhawkProfileManager\runs\<runId>\`, with an ACL for the invoking user, Administrators, and SYSTEM. The broker deletes that directory after reading a successful result and keeps it after an apply, rollback, validation, or launch failure for diagnostics. Before writing a plan, the broker requires the fixed helper and its directory to be regular, inside the real `%ProgramFiles%`, and not writable by the current filtered user token. That check uses the Windows effective-access API (`AccessCheck`); `fs.access(W_OK)` is not sufficient because Windows reports protected directories as writable for standard users.

A `--dry-run` validates the plan and environment, writes a `dry-run` result, and makes no registry, snapshot, journal, or service change. The helper is an x64 process and all registry access uses the 64-bit view; it only checks or starts a stopped Windhawk service and never stops or restarts a running service.

If the UAC prompt is completed by a different administrator account, the helper can read the run directory because Administrators have access. It still needs the invoking user's `%LOCALAPPDATA%` snapshot and journal directories. If that account cannot reach them, the helper aborts during path preflight before any registry write and returns an actionable validation error; the owner should sign in as the same Windows user for apply.

Node has no direct `ShellExecuteEx` binding. The broker uses a fixed hidden PowerShell host that calls `ShellExecuteExW` with the `runas` verb and `SEE_MASK_NOCLOSEPROCESS`. It does not use `Start-Process`, a shell string, or `shell: true`.

### 9.4 App state

```json
{
  "schemaVersion": 1,
  "activeProfileId": "mac-blur-glass",
  "lastAppliedAt": "2026-10-22T20:02:20.000Z",
  "lastRunId": "run-2026-10-22T20-02-14-123Z",
  "firstRunCompleted": true,
  "language": "system",
  "appearance": "system",
  "explorerRestart": "ask",
  "snapshotRetention": 20
}
```

### 9.5 Values excluded from captured profiles

Captured profiles exclude values that are derived, targeting-specific, or machine-specific:

- `LibraryFileName` and `Version` — owned by Windhawk's installer/updater; `LibraryFileName` changes on update.
- `SettingsChangeTime` — a reload marker, not user intent.
- `Include`, `Exclude`, `Architecture`, `IncludeCustom`, `ExcludeCustom`, `IncludeExcludeCustomOnly` — process targeting, not the look being switched. `Architecture=x86-64` would break an ARM64 machine.
- `PatternsMatchCriticalSystemProcesses`, `LoggingEnabled`, `DebugLoggingEnabled` — behavior flags, not profile intent.
- Any value outside the mod's own key and `Settings` subkey, including `ModsWritable` and per-user `Users\<SID>` trees.

Snapshots keep the full exported `Engine\Mods` subtree because they are rollback evidence. They still exclude mod DLLs and `ModsWritable`; see §9.2.

---

## 10. Safety and security requirements

| ID | Requirement |
|----|-------------|
| SR-1 | Every write targets `HKLM\SOFTWARE\Windhawk\Engine\Mods\<mod-id>` or its `Settings` subkey. Mod IDs match `^[a-z0-9][a-z0-9-]{0,63}$`. |
| SR-2 | The GUI runs non-elevated. Only the helper runs elevated, only for the privileged registry phase and a service check/start. Rainmeter and Explorer actions run in the main process. |
| SR-3 | The helper receives a plan file path and a hash. It validates the schema, the allowlist, and the hash before writing. |
| SR-4 | Profiles and snapshots are validated at import and before execution; unknown fields and out-of-allowlist keys are rejected. |
| SR-5 | The helper never accepts a shell command, script text, or registry path from the renderer. |
| SR-6 | The renderer has `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, and a strict CSP. No remote content. |
| SR-7 | UAC cancellation leaves the system untouched and is not treated as an error. |
| SR-8 | Logs record mod IDs, counts, and result codes; they do not dump settings values or full user paths. |
| SR-9 | A snapshot and journal exist before the first write; a failed rollback preserves both. |
| SR-10 | Snapshot imports are validated and applied only through the same allowlisted registry gateway. |
| SR-11 | The helper receives absolute plan, snapshot, journal, and result paths from the main process; it never derives storage paths from its own user profile. The broker anchors snapshot and journal paths to the invoking user's `%LOCALAPPDATA%\WindhawkProfileManager`, and the helper revalidates the canonical layout. |
| SR-12 | Helper mode bypasses the single-instance lock and creates no window. |
| SR-13 | The helper is an x64 process and writes the 64-bit registry view. |
| SR-14 | Every IPC handler validates the sender frame against the app's own origin; navigation and new windows are denied. |
| SR-15 | Production builds enable fuses: `RunAsNode` off, `NODE_OPTIONS` off, CLI inspect off, `OnlyLoadAppFromAsar` on. CSP is delivered as a response header. |
| SR-16 | Plan hash comparison uses a constant-time compare; plan size is capped; duplicate JSON keys are rejected. |
| SR-17 | The helper enforces a watchdog deadline by failing the run and rolling back; it never terminates while a registry write is in flight. |
| SR-18 | The helper executes from an admin-writable install directory under `%ProgramFiles%`, never from a user-writable temp or portable extraction directory. |
| SR-19 | v1 writes only when the configured registry root is `HKLM\SOFTWARE\Windhawk`. Portable Windhawk, another root, or an active `UserScoped=1` per-user configuration forces read-only mode. |
| SR-20 | Settings writes are read-merge-write per value; the helper never replaces the whole `Settings` key. `replace` mode deletes only values the plan explicitly lists. |
| SR-21 | `SettingsChangeTime` is written last, only when settings changed, as `max(now & 0x7fffffff, previous + 1)`. |
| SR-22 | Restore never deletes the `Engine\Mods` root or any `<mod-id>` subkey; it deletes only values inside captured keys and reports newer mods. |
| SR-23 | Profiles accept only `REG_SZ` and `REG_DWORD` settings. Snapshots may carry other types, but the helper writes only allowlisted values and rejects a restore that would overwrite or delete a current value whose type it cannot write back. |
| SR-24 | Snapshot files are written with a user-only ACL and never uploaded. |
| SR-25 | JSON is parsed with null-prototype objects; `__proto__`, `constructor`, and `prototype` keys are rejected. |
| SR-26 | The helper re-reads the managed state and rejects a stale `beforeHash` or `settingsHash` before the first write. |

Threat notes:

- **Malicious profile:** constrained by the allowlist and `REG_SZ`/`REG_DWORD` values; cannot write outside the Windhawk subtree or run commands.
- **Malicious snapshot:** parsed with the strict codec, validated against the allowlist, and reconciled as typed values; no key deletion and no `reg import`.
- **Malicious plan file:** the helper validates the hash written by the main process and the same allowlist; a modified file is rejected.
- **Privilege escalation:** the helper is a fixed executable under `%ProgramFiles%`, invoked with a fixed verb; no user-controlled executable path.
- **Supply chain:** pin dependencies and commit the lockfile; no postinstall scripts from untrusted packages.

---

## 11. Internationalization and accessibility

- Thai and English from day one; Thai is the default when the OS locale is `th-TH`, otherwise English.
- All user-facing strings live in locale files; no hardcoded strings in components.
- Thai uses a single CLDR plural category (`_other`); pass `count` for every pluralized key.
- Dates and numbers use `Intl` with the active locale. Use `calendar: 'gregory'` explicitly so Thai does not default to the Buddhist calendar.
- Thai has no word spaces: test buttons, table headers, and labels at 125% and 150% scaling; wrap instead of truncating.
- Keyboard: every action reachable by keyboard; visible focus rings; Escape closes non-destructive dialogs.
- Screen readers: labeled controls, live regions for apply progress, and a text summary of the plan.
- Reduced motion: honor the OS setting; progress remains legible without animation.
- Contrast: meet WCAG AA in both themes.

---

## 12. Non-functional requirements

| Area | Target |
|------|--------|
| Apply duration | Under 5 s typical, excluding UAC and Explorer restart. |
| Snapshot export | Under 2 s for a typical Windhawk subtree. |
| Startup | Interactive within 3 s on the target machine. |
| Memory | Under 300 MB resident with the window open. |
| Reliability | Journaled writes, typed rollback, atomic app files, startup recovery. |
| Offline | Zero network requests in v1. |
| Logging | Rotate at 2 MB, keep 5 files. |
| Compatibility | Windows 11 22H2+ x64 on the standard `C:\Windows`, `C:\ProgramData`, and `C:\Users\<name>\AppData\Local` layout; fail closed elsewhere. |
| Packaging | Per-machine NSIS installer; GUI launches without admin; helper installed under `%ProgramFiles%`. |
| Privacy | No telemetry; diagnostics are copied locally by the user. |

---

## 13. Packaging and distribution

- `electron-builder` NSIS per-machine installer; installs the GUI and helper under `%ProgramFiles%\WindhawkProfileManager`.
- The GUI manifest is `asInvoker`, so launching the app does not prompt for admin. The helper is elevated per apply through the `runas` verb.
- App data stays under `%APPDATA%` (profiles) and `%LOCALAPPDATA%` (snapshots, state, logs), not next to the executable.
- App ID: `com.poshzz.windhawk-profile-manager` (placeholder until branding is final).
- Version: semver, starting at `0.1.0`.
- Unsigned v1; the release notes explain the SmartScreen prompt. Smart App Control may block unsigned builds entirely regardless of the SmartScreen prompt, so the unsigned build is a developer artifact; signing both binaries is a public-release gate (ADR-0010).
- No auto-update in v1; the app shows its version and a link to releases.
- Public release channel: GitHub Releases (repository URL to be confirmed).

---

## 14. Acceptance criteria for v1

1. **Apply Mac:** Given Windhawk and all 10 mods installed, applying Mac Blur Glass enables the 10 mods, writes the stored settings, bumps `SettingsChangeTime` only where settings changed, starts Rainmeter, restarts Explorer when chosen, leaves a pre-apply snapshot, and does not restart the Windhawk service. The result says "applied, reload requested, not confirmed loaded."
2. **Reset:** Given the Mac profile is active, Reset disables the 10 mods, preserves their settings, stops Rainmeter, and leaves unlisted mods untouched.
3. **Round trip:** Applying Mac, resetting, then applying Mac again restores the same effective state without re-entering settings.
4. **Missing mods:** A user profile referencing a missing mod applies the remaining mods, reports the skipped mod, and never writes or creates its key.
5. **Unlisted mods:** An installed mod outside the profile remains enabled through both Apply and Reset when the policy is `leave`; it is disabled only when the profile opts into `disable`.
6. **Rollback:** A forced failure after the first write restores the pre-apply values, deletes values the run added inside captured keys, leaves the service running, and reports both outcomes.
7. **Interrupted run:** Killing the app mid-apply and relaunching shows the recovery banner; restoring returns the pre-apply state.
8. **UAC cancel:** Canceling the prompt leaves the registry, service, Rainmeter, and Explorer unchanged.
9. **Malicious import:** A profile with a key outside the allowlist, a disallowed value type, or a dangerous JSON key is rejected with a specific message and no writes.
10. **i18n:** Switching between Thai and English updates every screen without a restart.
11. **Install:** the per-machine installer places the GUI and helper under `%ProgramFiles%`, the GUI launches without admin, and Apply prompts for UAC. Run this on a signed build or a VM with Smart App Control off; an unsigned build may be blocked before startup (ADR-0010).
12. **No network:** A full apply and restore generate no outbound requests.
13. **Unsupported modes:** Portable Windhawk, a non-HKLM registry root, an active `UserScoped=1` user configuration, and Windows 10 disable writes and explain why.
14. **Targeting untouched on apply:** Applying a profile never writes `Include`, `Exclude`, `Architecture`, or per-user settings; snapshots capture them, and a restore may reconcile them on the same machine.

---

## 15. Resolved decisions and remaining questions

Resolved by research (see `docs/research/`):

1. **Service restart:** not required. The engine watches `Engine\Mods` with `RegNotifyChangeKeyValue` and reloads after a ~200 ms debounce. v1 does not stop or start the service on the happy path.
2. **`SettingsChangeTime`:** required for settings changes. It is a Unix-seconds DWORD; write `max(now & 0x7fffffff, previous + 1)` last, only when settings changed.
3. **Targeting fields:** `Include`, `Exclude`, `Architecture`, custom lists, and logging flags stay out of profiles; snapshots capture them.
4. **Icon theme:** the Mac profile's `iconTheme` value is a built-in option and portable. Absolute `themePaths`/`themeFolder` values in a user capture are machine-specific and flagged.
5. **Per-machine install:** GUI and helper under `%ProgramFiles%` (ADR-0007).
6. **Signing:** unsigned v1 for development; sign both binaries before public release. Smart App Control can block an unsigned build before startup, so a successful SmartScreen bypass is not enough (ADR-0010).
7. **Profiles:** `replace` is the schema default; captured profiles use it, while a newly added mod in the editor starts in `merge` until settings are captured. Deletions and the empty-map delete-all case are shown in the plan.
8. **Per-user 2.0 config:** v1 detects `Users\<SID>` with `UserScoped=1` and blocks writes; scope-aware read/write is deferred.
9. **Portable Windhawk:** unsupported; read-only with an explanation.
10. **Rainmeter:** v1 starts or gracefully quits the process; layout management is out of scope.

Still open:

11. VM tests: does deleting a `<mod-id>` subkey keep the engine watch alive; is `reg import` confirmed merge-only; does a settings write while the service is stopped apply on the next start. v1 avoids key deletion and service stops, so these are validation, not blockers.
12. Mod update migrations: whether removed settings keys are dropped or left stale. v1 writes only keys the profile captured and warns on version mismatch.
13. Explorer restart ownership: the Taskbar Styler may prompt on its own. The app restarts only when the user chose "always"; otherwise the mod prompt is allowed to own it.
14. App icon and final branding.
15. Public repository URL and license.
16. Titlebar QA: high-DPI, multi-monitor, RTL, and the native Snap Layouts flyout still need a manual pass; the approach itself is decided in ADR-0009.

---

## 16. References

- `docs/research/windhawk-internals.md`
- `docs/research/electron-windows.md`
- `docs/research/registry-and-prior-art.md`
- `docs/adr/0001`–`0008`
- Original kit: `C:\Users\Test\Documents\WindhawkProfiles`
