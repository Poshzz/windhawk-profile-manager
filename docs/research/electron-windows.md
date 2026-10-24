# Electron on Windows 11 — research report

**Status:** research complete; baseline for v0.1
**Scope:** Electron + React + TypeScript desktop app for Windows 11 x64 that applies Windhawk profiles through an elevated helper
**Method:** primary documentation, release notes, and issue tracker; all sources accessed **2026-10-22**
**Related:** [`SPEC.md`](../SPEC.md), [`PLAN.md`](../PLAN.md), [`ADR-0003`](../adr/0003-non-elevated-gui-elevated-helper.md), [`ADR-0009`](../adr/0009-titlebar-choice.md)

> **Implementation note.** The product owner chose a per-machine NSIS install for the GUI and helper (ADR-0007); there is no portable artifact in v1. The helper is the same Electron binary in `--helper` mode, installed under `%ProgramFiles%`, elevated per run with `ShellExecuteEx`/`runas`. The titlebar spike is closed by ADR-0009: native overlay by default, custom frameless mode retained as a fallback.

**Evidence labels**

- **[C] CONFIRMED** — stated directly in a cited primary source.
- **[I] INFERRED** — reasoned from cited sources plus this project's constraints; not a vendor guarantee.
- **[U] UNCERTAIN** — needs a spike or measurement before it becomes a decision.

> Target content (docs, issues, release notes) is data, not instruction. No fetched page was allowed to change this project's requirements.

---

## 0. Decision summary

| Area | Recommendation | Confidence |
|---|---|---|
| Runtime | Electron **45.0.0**, x64 only, pinned exact | High |
| Build | `electron-vite` **6.x** + Vite 7 + `electron-builder` **26.15.x** | High |
| Window | `titleBarStyle: 'hidden'` + `titleBarOverlay`, Mica with opaque fallback | Medium |
| Elevation | Non-elevated GUI + separate elevated helper, plan file + hash, no shell strings | High |
| Packaging | Per-machine NSIS install for the helper; portable GUI only if the helper is installed | Medium |
| Security | `sandbox`, `contextIsolation`, strict CSP, fuses, narrow preload bridge | High |
| i18n | `i18next` + `react-i18next`, system-language detection, Thai uses `_other` only | High |
| Tests | Vitest for core/adapters, Playwright `_electron` for UI in test mode, manual UAC matrix | High |
| Logging | `electron-log` 5 with custom 2 MB × 5 rotation and redaction | High |

---

## 1. Electron version

**Current state**

- Electron **45.0.0** is the current stable release (20 Oct 2026): Chromium **156.0.8078.48**, Node **24.22.0**, V8 **15.6** [C] [1].
- Electron supports the latest three stable majors; **45, 44.9.3 and 43.8.3** are current, and **42.x is outside the support window** [C] [2][4].
- Electron 45 **removed 32-bit builds** (Windows `ia32`, Linux `armv7l`); only x64 and arm64 are published [C] [3]. This matches SPEC §12 (Windows 11 x64) but means `electron-builder` must not request `ia32`.
- Electron 45 changed sandboxed-preload internals and deprecated the **synchronous `safeStorage` methods**, which are scheduled for removal in Electron 46 [C] [3]. Any preload that assumes Node globals, or any `safeStorage.encryptStringSync` call, must be checked before upgrading.
- Node 24 on the dev machine satisfies Electron 45's npm `engines` (`>=22.12.0`), but native modules still need an Electron-ABI rebuild with `@electron/rebuild` [C] [1][11].

**Recommendation**

- Pin `"electron": "45.0.0"` exactly, not `^45`. Electron majors ship roughly every eight weeks [C] [4]; a caret range turns CI into an uncontrolled runtime upgrade [I].
- Track 45.x patch releases monthly. Plan one deliberate major upgrade per quarter, with a packaged smoke test, rather than continuous `latest` [I].
- Do **not** introduce native Node modules for registry access. A node-gyp addon for registry reads adds a rebuild step to every Electron upgrade; `reg.exe` is already the plan [I].

**Risks**

- Electron 45 is days old at the time of writing. A two-week soak on 44.9.3 before freezing 45.0.0 is a reasonable hedge [U].

---

## 2. Window appearance

### 2.1 Background material

Electron exposes `win.setBackgroundMaterial(material)` with `auto` (default), `none`, `mica`, `acrylic`, and `tabbed` [C] [5]. The API is **Windows 11 22H2 (build 22621) and up only** [C] [5]. Microsoft's guidance describes Mica as an opaque, wallpaper-sampled material for long-lived windows, Acrylic as the transient-surface material, and Mica Alt for tabbed title bars; Electron exposes the matching `mica`, `acrylic`, and `tabbed` values [C] [5][19][36].

Mica falls back to a solid color when the user disables transparency, Battery Saver is on, the app is on low-end hardware, the window is inactive, or Windows is below build 22000 [C] [19]. Note the gap: Windows has Mica from 22000, but Electron's API only works from 22H2/22621 [C] [5][19]. On builds below 22621 the app gets an opaque window regardless [I].

Two implementation rules from Microsoft matter for a React layout: every layer between the window and the content that should show Mica must be transparent, and backdrop material must not be applied more than once [C] [19]. In practice the app shell gets `background: transparent`, one content surface gets a low-opacity fill, and the material is set once on the `BrowserWindow` [I].

### 2.2 Custom title bar

The documented Windows pattern is `titleBarStyle: 'hidden'` plus `titleBarOverlay`; `titleBarOverlay` requires `titleBarStyle` to be something other than `default` [C] [6]. `titleBarOverlay` accepts `color`, `symbolColor`, and an integer `height`; colors accept `rgba()`, `hsla()`, and `#RRGGBBAA`, and default to system colors [C] [6].

- Drag regions use CSS `app-region: drag`, with `app-region: no-drag` on buttons, inputs, and menus [C] [6].
- Native controls can move side depending on RTL and user settings, so reserve space with `env(titlebar-area-x, 0px)` and `env(titlebar-area-width, 100%)` [C] [6].
- `trafficLightPosition` and `setWindowButtonVisibility` are macOS-only; they are not a Windows customization path [C] [6].
- Prefer `titleBarStyle: 'hidden'` over `frame: false`: it keeps the native frame behaviors (snap, maximize, system menu) while removing the title bar [I].

**Known defects:** frameless + `backgroundMaterial` windows have a history of losing the material on drag, double-click maximize, and restore (electron/electron#46753), and of stale material after display or power-state changes (#48031) [C] [33][34]. Both should be reproduced on Electron 45 in a spike before the frameless design is frozen [U].

### 2.3 Recommended shape

- 1120 × 740 default, 900 × 600 minimum, matching SPEC §6.
- Title bar height 40–44 DIP; pass the same integer to `titleBarOverlay.height` so the native buttons align with the custom bar [I].
- Set `backgroundColor` to a fully transparent value only when Mica is active; otherwise use an opaque theme color so the fallback never flashes [I].
- Pass a transparent `titleBarOverlay.color` when Mica is active, so the overlay does not paint over the material [I].
- Update overlay colors from `nativeTheme` on theme change; listen to `nativeTheme.on('updated')` rather than polling [I].
- Keep an opaque fallback path and test it by turning transparency off in Settings; this is a documented fallback, not an edge case [C] [19].

---

## 3. Elevation

### 3.1 Why the GUI must not be elevated

UAC elevation creates a new, high-integrity access token; UIPI then blocks lower-integrity processes from sending most window messages to the elevated process, and drag-and-drop across the boundary is not reliable [I] [25]. Elevating the Electron GUI would also put Chromium's full attack surface at high integrity for the whole session, which contradicts ADR-0003 and SR-2 [C] [7].

### 3.2 Launch mechanics

- A manifest's `requestedExecutionLevel` is per executable: `asInvoker`, `requireAdministrator`, or `highestAvailable` [C] [20].
- An `asInvoker` executable can still be elevated when launched with the `runas` verb — Microsoft documents "Run as Administrator" as the elevation path for `asInvoker` apps [C] [20].
- `child_process.spawn` / `CreateProcess` cannot auto-elevate: starting a `requireAdministrator` image from a non-elevated process fails with **ERROR_ELEVATION_REQUIRED (740)**, so the broker must go through ShellExecuteEx [C] [41].
- `ShellExecuteEx` with `runas` is the documented Win32 path; if the user cancels the consent prompt, it fails and `GetLastError()` returns **ERROR_CANCELLED (1223)** [C] [21][22].
- `Start-Process -Verb RunAs` uses the ShellExecute path. In the PowerShell reference, `-Verb` exists only in the **UseShellExecute** parameter set, and that set has **no** `-RedirectStandardOutput` / `-RedirectStandardError` parameters [C] [23]. Redirecting the helper's output is therefore not an option; results must come back through a file, a named pipe, or an exit code [I].
- `Start-Process -Wait -PassThru` waits for the process tree and returns a process object whose exit code can be read [C] [23].
- Windows 11 `sudo` is 24H2+ and disabled by default, so it cannot be the only shipping path [C] [38].

### 3.3 Helper protocol

The strongest fit for this repo is the ADR-0003 pattern, refined:

1. Main process computes the apply plan, validates it with Zod, writes `plan.json` atomically to a private run directory, and computes SHA-256 over the exact bytes written [I].
2. Main launches the helper with `ShellExecuteEx`/`runas`, passing only `--plan <path> --hash <hex>`; no command string, no registry path, no user text [I].
3. Helper re-validates schema, allowlist, and hash **before** the first write; it reads the file once and hashes the same buffer it parses, to avoid a TOCTOU window [I].
4. Helper writes `result.json` atomically and exits with a small, documented exit-code set. Main maps a launch failure of `1223` to "user cancelled", not to an error [C] [22] + [I].
5. Helper sets its own watchdog timeout. A non-elevated parent cannot reliably terminate an elevated child, so the helper must self-terminate on deadline [I].

Do not pass the plan path through a shell. `ShellExecuteEx` takes `lpParameters` as one string, so even the path argument needs quoting [C] [21]. Create a fresh per-run directory (random name, `mkdir` non-recursive so it cannot be pre-created) with an explicit DACL for the invoking user and Administrators, and delete it after the run [I].

### 3.4 One binary or two?

`PLAN.md` §1 says "two process roles, one binary". That works **only** if the binary's manifest is `asInvoker` and the helper role is entered via `runas`: the manifest is per executable, so a `requireAdministrator` binary would prompt on every GUI launch, including the non-elevated shell [C] [20] + [I].

Two viable designs:

| Design | Pros | Cons |
|---|---|---|
| One `asInvoker` Electron exe, `--helper` dispatch | One build, one signature, matches PLAN | Helper carries all of Electron; helper mode must initialize before `app.whenReady()`; still a large privileged surface |
| Separate small helper exe (`requireAdministrator`) | Small auditable surface; UAC prompt names the helper; can be installed in `Program Files` | Second toolchain (C#/Rust/C++), second signature, packaging work |

**Recommendation:** v1 may ship the one-binary design for schedule reasons, but the helper must be a thin entry point that does not load the renderer, and the privileged path must be covered by tests. If the product owner wants the stronger security story, budget a separate helper for v1.1 [I].

### 3.5 Deferred: scheduled task

A scheduled task with `RunLevel = highestAvailable` can run without a per-apply UAC prompt, but registering it requires elevation once, and the Task Scheduler docs say `RunLevel` is **ignored** for `LocalSystem`, `LocalService`, and `Builtin\Administrator`, and must be `HighestAvailable` when the principal is the Administrators group [C] [24]. This is a reasonable v2 "quiet mode", not a v1 requirement; it also creates a persistent privileged entry point that must be ACL-protected [I].

A Windows service is the heaviest option: a SYSTEM service is a long-lived privileged endpoint and needs a tight service DACL [C] [37]. It is not justified for a short-lived apply [I].

---

## 4. Packaging

### 4.1 Targets

`electron-builder` **26.15.3** is the current stable line; v27 exists only as "next" documentation and should not be used for configuration decisions yet [C] [40] + [I].

- **Portable** is a self-extracting NSIS launcher. `requestExecutionLevel` defaults to `user` and accepts `user`, `highest`, or `admin` [C] [15].
- `unpackDirName` defaults to a per-build identifier under `TEMP`; setting it to `false` uses `$PLUGINSDIR`, unique per launch [C] [15]. Either way, the extracted app lives in a **user-writable** directory [I].
- The launcher exposes `PORTABLE_EXECUTABLE_FILE`, `PORTABLE_EXECUTABLE_DIR`, and `PORTABLE_EXECUTABLE_APP_FILENAME` [C] [16].
- Portable mode does **not** relocate app data: Electron still uses `%APPDATA%\<name>` unless `app.setPath('userData', …)` runs before `ready` [C] [9]. SPEC §9 already wants `%APPDATA%`, so the default is correct; do not "helpfully" move data next to the exe [I].
- NSIS supports `perMachine: true` (always all users), `oneClick: false` for an assisted installer, and `selectPerMachineByDefault` [C] [16].

### 4.2 Portable plus elevation is the core packaging conflict

A portable app extracts into a directory under the current user's `TEMP` [C] [15], which that user can write [I]. If that app then launches an elevated helper from the same directory, a standard user can plant or replace files in a path an administrator later executes. That is a privilege-escalation pattern, not a theoretical purity concern [I].

Options, in order of preference:

1. **Per-machine helper install.** Install the helper (and optionally the GUI) under `%ProgramFiles%` with an NSIS per-machine installer [C] [16]. The GUI can remain portable if it locates the installed helper by a fixed path. This preserves "no admin needed to launch" while making the privileged binary admin-writable only [I].
2. **Portable-only, signed helper, hash-pinned.** Verify the helper's SHA-256 and Authenticode signature immediately before launch, and show the publisher in the UAC prompt. This reduces but does not eliminate the TOCTOU risk [I].
3. **Portable-only, unsigned.** Accept the risk explicitly in release notes. Not recommended for a tool that edits HKLM [I].

### 4.3 Signing and SmartScreen

Unsigned or self-signed binaries trigger SmartScreen's "Windows protected your PC" flow [C] [26]. Signing establishes a publisher identity and starts reputation accumulation; reputation is per certificate/publisher and accrues over downloads, so early releases should still expect warnings [I].

- Budget for an OV or EV code-signing certificate, or Azure Trusted Signing, before a public release [I] [18].
- Sign **both** the GUI and the helper. An unsigned helper produces an "Unknown publisher" UAC prompt even if the GUI is signed [I].
- Keep the signing key off developer machines; use CI with a hardware token or cloud signing service [I].
- Do not promise "no SmartScreen warning" in v1 release notes [I].

### 4.4 ASAR and resources

ASAR archives are read-only, and executables/native modules generally need to live outside the archive; `electron-builder`'s smart-unpack detects `.node` files and executables automatically, and `asarUnpack` / `extraResources` cover the rest [C] [12][17].

- Put the helper under `extraResources` (outside `app.asar`) so it can be executed and signed independently [I].
- Keep `app.asar` enabled; disabling it makes the install larger and slightly easier to tamper with [I].
- If a native module ever appears, `asarUnpack: "**/*.node"` and `@electron/rebuild` are mandatory [C] [11][17].

---

## 5. Security

Electron's own checklist is the baseline [C] [7]:

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`; sandbox is the default since Electron 20 and context isolation since 12 [C] [7].
- No remote content. Load only local files from the packaged app; deny `will-navigate` and `setWindowOpenHandler` [C] [7].
- A strict CSP delivered via response headers (not only a `<meta>` tag), with no `unsafe-eval` and no remote script origins in production [C] [7].
- A narrow preload bridge: expose named functions, never `ipcRenderer` itself [C] [7].
- Validate the sender of every IPC message (`event.senderFrame`) against the app's own origin, and reject unknown frames [C] [7].
- Enable fuses: disable `RunAsNode`, `NODE_OPTIONS`, and CLI inspect; enable `OnlyLoadAppFromAsar` [C] [8].

Project-specific hardening:

- The helper must never accept a registry path, service name, or executable path from the renderer; it accepts only the validated plan and re-checks the allowlist [I].
- Compare the plan hash with `crypto.timingSafeEqual`; cap plan file size; reject non-canonical JSON and duplicate keys [I].
- Write the plan into a run directory with an ACL restricted to the current user and Administrators; delete it after the run [I].
- Do not use `safeStorage` for profile data — profiles are not secrets, and Electron 45 deprecates the sync API ahead of removal in 46 [C] [3][10].
- Redact settings values and full user paths from logs; log mod IDs, counts, and result codes only, per SR-8 [I].

**Threat notes.** A malicious profile is constrained by schema + allowlist. A tampered plan is constrained by the hash. The remaining high-value target is the helper binary itself, which is why §4.2 matters more than any renderer hardening [I].

---

## 6. Internationalization

- `app.getPreferredSystemLanguages()` returns the OS language list in preference order; use the first entry to choose `th` or `en`, and fall back to `en` for anything else [C] [9]. Persist an explicit user choice separately, as SPEC FR-13 requires [I].
- `i18next` delegates plural selection to `Intl.PluralRules`; since v24 there is no fallback when `Intl` is unavailable [C] [27].
- Thai has a single CLDR plural category, `other` [C] [28]. Thai locale files should therefore contain only `_other` forms; copying English `_one` keys is harmless but misleading, and a `_zero` key is an explicit override that should be used only when the Thai wording needs it [C] [27] + [I].
- `count` must be passed for any pluralized key; without it i18next does not fall back to the base key [C] [27].
- Format dates and numbers with `Intl` using the active locale. Thai locales can default to the Buddhist calendar; if the UI means Gregorian dates, pass `calendar: 'gregory'` explicitly and test it [I] [39].
- Thai text has no word spaces, so buttons and table headers need wrapping tests at 125% and 150% scaling; do not truncate with a fixed pixel width [I].
- Do not translate mod IDs, registry paths, service names, or file paths. They are domain identifiers, not UI copy [I].

**Structure:** one namespace per screen (`home`, `profiles`, `apply`, `snapshots`, `settings`, `errors`), typed keys, and a test that fails on missing keys in either locale [I]. Language changes should update `document.documentElement.lang` and re-render without a restart, matching acceptance criterion 10 [I].

---

## 7. Testing

| Layer | Tool | What it proves |
|---|---|---|
| Unit | Vitest 5 | Planner diffing, drift, Zod schemas, `.reg` codec, allowlist, retention |
| Integration | Vitest 5 + fake adapters | `ApplyExecutor` ordering, injected failures, rollback, journal recovery |
| Contract | Vitest 5 + real `.reg` fixtures | Export → parse → apply → export round-trip; value types preserved |
| E2E | Playwright `_electron` | First run, apply in test mode, reset, restore, language switch, error states |
| Manual | Checklist | Real UAC, kill mid-apply, USB path, 22H2/23H2/24H2, Thai locale |

- Vitest 5 requires Vite ≥ 6.4 and Node ≥ 22.12 [C] [30]. Keep a separate `vitest.config.ts`; do not overload `electron.vite.config.ts` with test-only settings [I].
- Playwright's Electron support is **experimental**, supports Electron v21+, and `chromiumSandbox` defaults to **false** [C] [29]. E2E therefore does not validate sandbox behavior; add a packaged smoke test that checks `process.sandboxed` in the renderer [I].
- Playwright does not intercept native Electron dialogs; stub `dialog.showOpenDialog` / `showSaveDialog` / `showMessageBox` through `electronApp.evaluate` [C] [29].
- E2E must run with `WPM_TEST_MODE=1` and fake adapters, never against the real `HKLM` subtree [I].
- Playwright's troubleshooting notes require the `nodeCliInspect` fuse not be disabled, which conflicts with the production fuse posture. Build a separate test artifact, or accept the fuse difference and document it [C] [29] + [I].
- Coverage target: `core/` ≥ 90% lines, plus a manual matrix that no automated test can replace [I].

---

## 8. Logging

- `electron-log` 5.x writes to `%APPDATA%\<app name>\logs\main.log` on Windows by default, rotates at **1 MB**, and renames the previous file to `main.old.log` [C] [31][32].
- `sync` defaults to `true`, so each write blocks; at low log volume that is acceptable, but do not log per-registry-value in a tight loop [C] [32] + [I].
- SPEC §12 wants 2 MB × 5 files. electron-log keeps only one `.old` file by default, so implement a custom `archiveLogFn` (or an external rotation step) that shifts `main.4.log` … `main.old.log` [C] [32] + [I].
- `resolvePathFn` pins the path; prefer an explicit path over `app.getPath('logs')`, which electron-log's own docs describe as not stable in the current version [C] [32].
- Use `log.errorHandler.startCatching()` and `log.eventLogger.startLogging()` to capture unhandled rejections and `render-process-gone` / `child-process-gone` events [C] [31].
- The renderer should log through the preload bridge or `electron-log/renderer`, never by writing files directly [C] [31] + [I].
- Add a redaction transform for settings values, user names, and full paths before the file transport sees the message [I].

---

## 9. Windows 11 gotchas

- **Build gate:** Mica exists from build 22000, but Electron's `backgroundMaterial` only works from 22H2/22621 [C] [5][19]. Detect with `os.release()` and fall back to an opaque theme below 22621.
- **No 32-bit:** Electron 45 publishes x64/arm64 only; remove `ia32` from any electron-builder target list [C] [3].
- **DPI:** Electron uses DIPs, but `titleBarOverlay.height` is an integer device-independent value; test 125%, 150%, and 200% and multi-monitor moves [I].
- **Snap layouts:** keeping the native frame via `titleBarStyle: 'hidden'` preserves the system snap behavior; `frame: false` gives it up unless reimplemented [I].
- **Taskbar identity:** call `app.setAppUserModelId(appId)` before creating windows so notifications and taskbar grouping use the app identity [C] [35].
- **Service control:** SCM control is asynchronous; `sc stop` can return before the service reaches `STOPPED`, so poll `sc query` until the state changes or the timeout expires [I].
- **Registry view:** a 64-bit process writes the 64-bit view of `HKLM\SOFTWARE`; Windhawk's keys are 64-bit. Do not run the helper as 32-bit [I].
- **`.reg` encoding:** `reg export` emits UTF-16LE with a BOM; preserve it on snapshot/restore rather than re-encoding through a JSON string [I].
- **Elevated drive mappings:** an elevated token does not see the user's per-logon mapped drives; a portable app on a network share may fail to resolve its own helper path [I].
- **Console flash:** a helper built as a console app flashes a window on every apply; build it as a GUI-subsystem binary or hide the window, and still write results to a file [I].
- **AV/EDR:** an unsigned self-extracting portable exe that touches HKLM and restarts Explorer is a plausible false-positive; Windhawk itself is a DLL injector, so the app may inherit scrutiny [I].
- **Energy Saver:** Windows 11 24H2 Energy Saver can affect backdrop material; issue #48031 documents an energy-saver caveat [C] [34].

---

## 10. Project structure

`electron-vite` defaults to three roots — `src/main`, `src/preload`, `src/renderer` — builds to `out/`, and `package.json` points at `./out/main/index.js` [C] [13]. Keep that convention and add the project's own layers:

```text
src/
  main/            Electron main, window, IPC registration, composition root
    helper/        --helper entry: validate plan, execute, write result, exit
  preload/         contextBridge surface (typed, no raw ipcRenderer)
  renderer/        React screens, components, i18n
  core/            pure domain: planner, drift, schemas, .reg codec (no Electron)
  infrastructure/  reg.exe, sc.exe, files, elevation broker, clock, ids
  shared/          IPC contract, Zod schemas, error codes, types
tests/
  unit/ integration/ e2e/ fixtures/
resources/
  theme-packs/ icons/ helper/ (if shipped as a separate binary)
build/             installer.nsh, icons, signing resources
```

Rules that keep the test story honest:

- `core/` must not import `electron`, `node:fs`, or any adapter; Vitest runs it in a plain Node environment [I].
- The preload bridge is generated from the `shared/` contract; a type error is a build error [I].
- `main/helper` must be reachable without constructing a `BrowserWindow`, so the privileged path has no renderer dependency [I].
- `resources/helper/` goes through `extraResources`, not `asar`, if it is a separate executable [C] [17].
- Path aliases (`@core`, `@shared`) must be declared in both `tsconfig.json` and `electron.vite.config.ts`, or the packaged build will fail where dev succeeded [I].

---

## 11. Recommended stack decisions

1. **Electron 45.0.0, x64 only, exact pin.** Chromium 156/Node 24.22 is current; 32-bit is gone. Soak on 44.9.3 if 45 shows early regressions [1][3].
2. **electron-vite 6 + Vite 7 + electron-builder 26.15.x.** One config for main/preload/renderer; stable builder line, not the unreleased v27 docs [13][14][15].
3. **Mica first, acrylic optional, opaque fallback mandatory.** `titleBarStyle: 'hidden'` + `titleBarOverlay`; no `frame: false` unless the maximize bug is fixed and retested [5][6][19].
4. **Never elevate the GUI.** Helper runs elevated for one apply, receives a validated plan file + hash, and writes a result file. No shell command strings, no registry paths from the renderer [20][21][23].
5. **Ship the helper from an admin-writable location.** Per-machine NSIS install for the helper is the secure default; portable-only needs an explicit risk acceptance [15][16].
6. **Security is a build property, not a code review checkbox.** `sandbox`, `contextIsolation`, CSP headers, narrow preload, fuses, and sender validation on every IPC handler [7][8].
7. **Thai and English from day one, with Thai `_other` plurals and explicit Gregorian dates.** `app.getPreferredSystemLanguages()` + i18next + `Intl` [9][27][28].
8. **Vitest for logic, Playwright for UI, manual for UAC.** Playwright's Electron support is experimental and sandbox-off by default; the manual matrix is not optional [29][30].
9. **electron-log with custom rotation and redaction.** 2 MB × 5 as SPEC requires; default 1 MB single `.old` is not enough [31][32].

---

## 12. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Portable helper is replaced in a user-writable path and elevated | Medium | High | Per-machine helper install; sign + hash-check; never elevate from `%TEMP%` |
| UAC prompt on every apply causes abandonment | High | Medium | Explain in first run; remember "apply" intent; offer a v2 scheduled-task mode |
| Mica/frameless visual regressions on maximize or display change | Medium | Medium | Native frame fallback; opaque mode; test matrix on 22H2/23H2/24H2 |
| Unsigned build triggers SmartScreen/AV and loses trust | High | Medium | Sign GUI + helper; publish checksums; document the prompt; build reputation |
| Electron major upgrade breaks preload or native deps | Medium | Medium | Exact pin; quarterly upgrade ticket; packaged smoke test |
| Playwright Electron changes or breaks | Medium | Low | Keep E2E thin; core coverage lives in Vitest; manual checklist |
| One-binary helper accidentally ships `requireAdministrator` | Low | High | Assert manifest at build time; packaged test that GUI launches without UAC |
| Thai layout/date/plural defects | Medium | Low | Native review; `_other`-only locale; Gregorian calendar test; 150% scaling test |
| Helper timeout or crash leaves journal `executing` | Low | High | Snapshot-first, journal, startup recovery, helper watchdog |
| `reg.exe` output parsing breaks on localized Windows | Medium | Medium | Parse exit codes and registry reads, not localized stdout; test on Thai Windows |

---

## 13. Decisions for the product owner

1. **Portable-only vs per-machine helper.** Security says per-machine; SPEC §13 says portable. This is the single largest unresolved conflict.
2. **Code-signing budget and timing.** OV/EV certificate or Azure Trusted Signing, for both GUI and helper. Without it, every apply starts with an unknown-publisher UAC prompt.
3. **UAC on every apply vs a one-time scheduled task.** The latter is quieter but adds a persistent privileged entry point; it is a v2 feature at the earliest.
4. **Frameless Mica vs native frame.** Frameless is the SPEC look; native frame is more robust. Decide after a one-day spike on Electron 45.
5. **One Electron binary with `--helper` vs a separate small helper.** Schedule vs attack surface.
6. **Thai calendar policy.** Buddhist or Gregorian dates in the UI; pick one and document it.
7. **Auto-update.** Out of scope for v1, but it changes packaging and signing requirements; decide before the first public release.

---

## 14. What still needs a spike

- [ ] Reproduce #46753 and #48031 on Electron 45 with `titleBarStyle: 'hidden'` + Mica; record the fallback behavior.
- [ ] Launch an `asInvoker` Electron app with `ShellExecuteEx` `runas`; confirm the UAC prompt, `--helper` argv, cancellation code 1223, and exit-code propagation.
- [ ] Measure `electron-log` sync writes during a 10-mod apply; confirm 2 MB × 5 rotation on Windows file locks.
- [ ] Run Playwright against a packaged build with the production fuse set; decide whether a test-only fuse variant is needed.
- [ ] Verify Thai `Intl` defaults (`th-TH` calendar, number system) on Windows 11 24H2.

---

## References

All URLs accessed **2026-10-22**.

1. Electron 45.0.0 release — https://releases.electronjs.org/release/v45.0.0
2. Electron releases (stable channels) — https://releases.electronjs.org/
3. Electron v45.0.0 release notes — https://github.com/electron/electron/releases/tag/v45.0.0
4. Electron release timelines / support policy — https://www.electronjs.org/docs/latest/tutorial/electron-timelines
5. `BrowserWindow` API (incl. `setBackgroundMaterial`) — https://www.electronjs.org/docs/latest/api/browser-window
6. Custom title bar tutorial — https://www.electronjs.org/docs/latest/tutorial/custom-title-bar
7. Electron security checklist — https://www.electronjs.org/docs/latest/tutorial/security
8. Electron fuses — https://www.electronjs.org/docs/latest/tutorial/fuses
9. `app` API (`getPreferredSystemLanguages`, `getPath`, `setPath`) — https://www.electronjs.org/docs/latest/api/app
10. `safeStorage` API — https://www.electronjs.org/docs/latest/api/safe-storage
11. Native Node modules — https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules
12. ASAR archives — https://www.electronjs.org/docs/latest/tutorial/asar-archives
13. electron-vite getting started — https://electron-vite.org/guide/
14. electron-vite package — https://www.npmjs.com/package/electron-vite
15. electron-builder v26 `PortableOptions` — https://www.electron.build/v26/docs/api/electron-builder.interface.portableoptions/
16. electron-builder v26 NSIS (portable env vars, `perMachine`) — https://www.electron.build/v26/docs/nsis/
17. electron-builder v26 application contents / ASAR unpacking — https://www.electron.build/v26/docs/contents/
18. electron-builder v26 Windows code signing — https://www.electron.build/v26/docs/features/code-signing/code-signing-win/
19. Microsoft Mica material (fallback conditions) — https://learn.microsoft.com/en-us/windows/apps/design/style/mica
20. Microsoft application manifests (`requestedExecutionLevel`) — https://learn.microsoft.com/en-us/windows/win32/sbscs/application-manifests
21. Microsoft `ShellExecuteExW` — https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shellexecuteexw
22. Microsoft system error codes 1000–1299 (`ERROR_CANCELLED` 1223) — https://learn.microsoft.com/en-us/windows/win32/debug/system-error-codes--1000-1299-
23. Microsoft `Start-Process` (UseShellExecute parameter set) — https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/start-process
24. Microsoft Task Scheduler `RunLevel` element — https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-runlevel-principaltype-element
25. Microsoft UAC: how it works — https://learn.microsoft.com/en-us/windows/security/application-security/application-control/user-account-control/how-it-works
26. Microsoft Defender SmartScreen — https://learn.microsoft.com/en-us/windows/security/operating-system-security/virus-and-threat-protection/microsoft-defender-smartscreen/
27. i18next plurals — https://www.i18next.com/translation-function/plurals
28. Unicode CLDR language plural rules — https://www.unicode.org/cldr/charts/47/supplemental/language_plural_rules.html
29. Playwright Electron (experimental) — https://playwright.dev/docs/api/class-electron
30. Vitest getting started (requirements) — https://vitest.dev/guide/
31. electron-log README (default paths, error/event logging) — https://github.com/megahertz/electron-log
32. electron-log file transport (1 MB default, `.old` rotation, sync) — https://github.com/megahertz/electron-log/blob/master/docs/transports/file.md
33. Electron issue #46753 — https://github.com/electron/electron/issues/46753
34. Electron issue #48031 — https://github.com/electron/electron/issues/48031
35. Electron Windows taskbar / AppUserModelID — https://www.electronjs.org/docs/latest/tutorial/windows-taskbar
36. Microsoft Acrylic material — https://learn.microsoft.com/en-us/windows/apps/design/style/acrylic
37. Microsoft service security and access rights — https://learn.microsoft.com/en-us/windows/win32/services/service-security-and-access-rights
38. Microsoft `sudo` for Windows — https://learn.microsoft.com/en-us/windows/sudo/
39. MDN `Intl.DateTimeFormat` (`calendar` option) — https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat/DateTimeFormat
40. electron-builder package (26.x stable line) — https://www.npmjs.com/package/electron-builder
41. Microsoft system error codes 500–999 (`ERROR_ELEVATION_REQUIRED` 740) — https://learn.microsoft.com/en-us/windows/win32/debug/system-error-codes--500-999-
