# PLAN — Windhawk Profile Manager v1

**Status:** Ready for review (research integrated)
**Companion documents:** [`SPEC.md`](./SPEC.md), [`../CONTEXT.md`](../CONTEXT.md), [`adr/`](./adr/)

---

## 1. Architecture at a glance

```
┌──────────────────────────── Renderer (React) ────────────────────────────┐
│ Screens, i18n, presentation state. No Node, no registry access.          │
└───────────────────────────────┬───────────────────────────────────────────┘
                                │ typed contextBridge (zod-validated)
┌───────────────────────────────▼───────────────────────────────────────────┐
│ Main process (non-elevated)                                               │
│ ProfileStore · SnapshotStore · ApplyPlanner · EnvironmentProbe · IPC      │
│ ApplyCoordinator → ProcessController (Rainmeter, Explorer)                │
│                     │                                                     │
│                     ▼                                                     │
│              ElevationBroker ──► ShellExecuteEx (runas)                   │
└─────────────────────────────┬─────────────────────────────────────────────┘
                              │ plan.json + sha256
┌─────────────────────────────▼─────────────────────────────────────────────┐
│ Helper mode (same executable, --helper, elevated)                         │
│ ApplyExecutor → SnapshotStore → RegistryGateway → ServiceController       │
│              → JournalStore → result.json                                 │
└───────────────────────────────────────────────────────────────────────────┘
```

Two process roles, one binary:

- **Main** computes the plan, renders UI, calls the broker, runs Rainmeter/Explorer as the logged-in user, and finalizes the run. It never touches HKLM.
- **Helper** starts elevated from the same executable with `--helper --plan <path> --hash <sha256>`, validates the plan, executes the privileged registry phase, writes `result.json`, and exits. It uses `ServiceController` only to check or start a stopped service; it does not stop or restart the service on the happy path.

Rainmeter and Explorer are deliberately **not** started by the helper: an elevated process would create elevated user processes, and Explorer may refuse to start elevated.

The Windhawk engine watches `Engine\Mods` and reloads after a ~200 ms debounce. Apply writes typed values and stamps `SettingsChangeTime` last; it does not restart the service.

The renderer never sees a registry path, a shell command, or a privileged handle.

---

## 2. Deep modules

Each module is judged by leverage at its interface: a small surface hiding a large, testable implementation. Two adapters exist only where something actually varies (real vs. test).

| Module | Interface (small) | Hides | Adapters |
|--------|-------------------|-------|----------|
| **ApplyPlanner** | `buildPlan(profile, current, environment, options) → ApplyPlan` | diffing, typed sets/deletions, missing/unlisted classification, settings hashes, warnings, plan hash | pure |
| **RegistryGateway** | `read()`, `applyOps(ops)`, `exportReg(path)`, `reconcile(snapshot)` | `reg.exe` reads/exports, typed writes, `.reg` codec, value types, 64-bit view, allowlist, key-preservation rules | `WindowsRegistryGateway`, `FakeRegistryGateway` |
| **ServiceController** | `status()`, `ensureRunning()` | `sc.exe`/PowerShell, timeouts, exit codes; no stop/restart on the happy path | `WindowsServiceController`, `FakeServiceController` |
| **ProcessController** | `rainmeterStatus()`, `startRainmeter()`, `quitRainmeter()`, `restartExplorer()` | process APIs, Rainmeter `!Quit`, Explorer behavior | `WindowsProcessController`, `FakeProcessController` |
| **ProfileStore** | `list()`, `get(id)`, `create()`, `update()`, `delete()`, `duplicate()`, `import()`, `export()` | validation, migration, atomic writes, built-in seeding | file system |
| **SnapshotStore** | `capture(trigger, context)`, `list()`, `get(id)`, `delete(id)`, `export(id)`, `import(path)` | metadata, checksums, retention, parsed model, atomic writes | file system + gateway |
| **JournalStore** | `begin(run)`, `update(state)`, `complete(result)`, `read()`, `clear()` | atomic writes, recovery detection, cross-process lock | file system |
| **ElevationBroker** | `run(plan) → ApplyResult` | UAC, helper lifecycle, plan/result files, exit codes | `WindowsElevationBroker`, `FakeElevationBroker` |
| **ApplyCoordinator** | `run(plan) → ApplyResult` | broker call, finishing actions, journal finalization, active-profile update | main-process orchestration |
| **ApplyExecutor** | `execute(plan) → ApplyResult` | snapshot/journal ordering, disable-first/enable-last writes, marker stamping, settle, verification, rollback | deps injected; runs in helper |
| **EnvironmentProbe** | `probe() → Environment` | Windows build, Windhawk presence/version, mods, Rainmeter | deps injected |
| **DriftService** | `compare(profile, current) → Drift` | managed-vs-unlisted comparison | pure |
| **ThemePackRegistry** | `list()`, `get(id)` | bundled pack metadata, requirements | bundled JSON |
| **SettingsStore** | `get()`, `update(patch)` | app state, atomic writes, defaults | file system |
| **Logger** | `info/warn/error(event)` | rotation, redaction, structured fields | file system |

Rules:

- `ApplyPlanner`, `DriftService`, schema validation, and the `.reg` codec are **pure** and carry most of the unit tests.
- `ApplyExecutor` sequences the privileged side effects; `ApplyCoordinator` sequences the unprivileged finishing phase. Their dependencies are injected, so fakes can force a failure at any step.
- `RegistryGateway` is the only module that knows a registry path. Every write passes the allowlist there, and it never deletes `Engine\Mods` or a `<mod-id>` key.
- `ApplyExecutor` writes `SettingsChangeTime` last, only when settings changed; a `Disabled`-only transition does not bump it.
- The interface is the test surface: tests never reach past these interfaces.

---

## 3. Repository layout

```
.
├── CONTEXT.md
├── AGENTS.md
├── README.md
├── docs/
│   ├── SPEC.md
│   ├── PLAN.md
│   ├── adr/
│   └── research/
├── resources/
│   ├── theme-packs/mac-blur-glass/
│   │   ├── pack.json
│   │   └── profiles/*.json
│   ├── icons/
│   └── scripts/            # fixed helper scripts, if any
├── src/
│   ├── main/               # Electron main, IPC, composition root
│   │   ├── index.ts
│   │   ├── helper/         # helper-mode entry, executor composition
│   │   └── ipc/
│   ├── preload/            # contextBridge API
│   ├── renderer/           # React app
│   │   ├── screens/
│   │   ├── components/
│   │   └── i18n/
│   ├── core/               # pure domain logic, no Electron imports
│   │   ├── profiles/
│   │   ├── planner/
│   │   ├── snapshots/
│   │   ├── registry/       # interfaces + .reg codec
│   │   ├── apply/
│   │   ├── environment/
│   │   └── theme-packs/
│   ├── infrastructure/     # adapters: reg.exe, sc.exe, files, elevation
│   └── shared/             # types, zod schemas, IPC contract, errors
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── e2e/
│   └── fixtures/           # real .reg exports, malicious profiles
└── package.json
```

Dependency direction: `renderer → shared`, `main → core → shared`, `infrastructure → core → shared`. `core` never imports Electron, Node file APIs, or adapters.

---

## 4. Stack and tooling

| Concern | Choice | Why |
|---------|--------|-----|
| Runtime | Electron **45.0.0**, exact pin, x64 only | ADR-0001; Electron 45 ships Chromium 156 / Node 24.22 |
| Build | `electron-vite` 6.0.0 + Vite 7.3.7 | One config for main/preload/renderer |
| UI | React 19.3.1 + TypeScript 5.9.3 strict | Team familiarity, ecosystem |
| Styling | Tailwind CSS 4.3.3 + CSS variables | Theme tokens for light/dark/glass |
| Titlebar | `titleBarStyle: 'hidden'` + native overlay; `frame: false` custom fallback | ADR-0009; native snap layouts, menu, and Mica |
| Primitives | Radix UI | Accessible dialog, switch, tooltip, menu |
| State | Zustand | Small, no boilerplate |
| Validation | Zod | Shared schemas at IPC and file boundaries |
| i18n | `i18next` + `react-i18next` | Thai/English, interpolation, plural rules |
| Icons | `lucide-react` | Consistent, tree-shakeable |
| Dates | `Intl` with `calendar: 'gregory'` | No extra dependency; Thai date correctness |
| Tests | Vitest 5.0.5 + Playwright 1.64.1 `_electron` | Unit/integration and E2E |
| Packaging | `electron-builder` 26.15.3 NSIS per-machine installer | ADR-0001, ADR-0007, SPEC §13 |
| Lint/format | ESLint 10 + Prettier 3.9 | Consistent code |
| Logs | `electron-log` 5.4.4 + custom 2 MB × 5 rotation + redaction | No network, small surface |

Pin all versions in `package.json` and commit `package-lock.json`. No postinstall scripts from untrusted packages. Electron 45 no longer downloads its binary from the package's own postinstall; this repo's root `postinstall` runs `install-electron`.

---

## 5. Apply sequence

```
User            Main                          Helper (elevated)              System
 │  click Apply   │                                │                           │
 ├───────────────►│ build plan                     │                           │
 │  review plan   │                                │                           │
 ├───────────────►│ write plan.json + hash         │                           │
 │                ├─ ShellExecuteEx (runas) ──────►│                           │
 │   UAC prompt   │                                │ validate schema + hash    │
 │                │                                ├─ re-read hashes ────────►│ reg query
 │                │                                ├─ export snapshot ────────►│ reg export
 │                │                                ├─ snapshot == beforeHash?  │ abort if stale
 │                │                                ├─ write journal            │
 │                │                                ├─ typed ops: disable first │ reg add/delete
 │                │                                ├─ settings writes          │ reg add
 │                │                                ├─ markers last ───────────►│ reg add
 │                │                                ├─ settle 300–500 ms        │
 │                │                                ├─ verify read-back ───────►│ reg query
 │                │                                ├─ journal: privileged-complete
 │                │◄──────── result.json ──────────┤                           │
 │                │                                │ exit                      │
 │                ├─ Rainmeter action (main) ────►│ process                   │
 │                ├─ Explorer restart (main) ────►│ process                   │
 │                ├─ complete journal + state     │                           │
 │  result screen │                                │                           │
```

Failure paths:

- Any failure before verification → helper reconciles typed values from the snapshot, re-stamps changed markers, verifies, marks `rolled-back`. It never stops or restarts the service.
- Rollback failure → helper keeps journal + snapshot, marks `rollback-failed`, shows manual restore steps.
- Rainmeter or Explorer failure after the privileged phase → `succeeded-with-warning`; no registry rollback.
- App killed mid-run → journal remains; next launch offers recovery. Running mods keep their previous settings because markers are written last.
- UAC canceled → no plan file written, no snapshot, no changes.

---

## 6. Phases and tickets

Tickets are maintained in the private tracking workspace and are not part of the public repository.

| Phase | Ticket | Outcome | Blocked by |
|-------|--------|---------|------------|
| 0 Foundation | **0001** | Electron skeleton, scripts, CI-ready build | — |
| 1 Domain | **0002** | Shared schemas + migrations + errors | 0001 |
| 1 Domain | **0003** | ProfileStore + built-in seed | 0002 |
| 1 Domain | **0004** | RegistryGateway + `.reg` codec + allowlist | 0002 |
| 1 Domain | **0005** | SnapshotStore + retention | 0004 |
| 2 Engine | **0006** | ApplyPlanner + drift comparison | 0002, 0003, 0004 |
| 2 Engine | **0007** | Environment/Service/Process adapters | 0001, 0004 |
| 2 Engine | **0008** | ApplyExecutor + journal + rollback | 0005, 0006, 0007 |
| 2 Engine | **0009** | Elevated helper + broker + coordinator | 0001, 0002, 0007, 0008 |
| 3 UI | **0010** | Window shell, titlebar, navigation, i18n | 0001, 0002 |
| 3 UI | **0011** | Home: status, drift, quick actions | 0006, 0007, 0010 |
| 3 UI | **0012** | Apply flow: plan, progress, result | 0008, 0009, 0010, 0011 |
| 3 UI | **0013** | Profiles + editor + capture + JSON I/O | 0003, 0004, 0010 |
| 3 UI | **0014** | Snapshots + restore + `.reg` I/O | 0005, 0008, 0009, 0010, 0012 |
| 4 Content | **0015** | Mac theme pack data + converter + tests | 0003, 0004 |
| 4 UI | **0016** | Theme pack screen + checklist | 0007, 0010, 0015 |
| 5 Polish | **0017** | First run, recovery, settings, diagnostics | 0011–0014, 0016 |
| 6 Release | **0018** | Packaging, security review, release | 0017 |

Parallel lanes once 0002 lands: **A** storage (0003, 0005), **B** registry (0004), **C** UI shell (0010). After 0004: 0006, 0007, 0015 can start. 0009 follows 0008. UI screens can run in parallel once 0010 exists.

---

## 7. Testing strategy

| Layer | What | Tool |
|-------|------|------|
| Unit | Planner diffing, drift, schema validation, `.reg` codec, allowlist, profile/snapshot stores (temp dirs), journal recovery | Vitest |
| Integration | `ApplyExecutor` with fake gateway/service/process; failure injected at every step; rollback and verification | Vitest |
| Contract | Real `.reg` fixtures from the original kit; export → parse → apply → export round-trip; typed values preserved | Vitest |
| E2E | First run, apply (test mode fakes), reset, snapshot restore, profile capture, language switch, error states | Playwright + Electron |
| Manual | Real apply/reset on the owner's machine; UAC cancel; kill mid-apply; restore; install/uninstall and launch without admin | Checklist in ticket 0018 |
| VM | `<mod-id>` key deletion and watch behavior; `reg import` merge-only confirmation; settings write while the service is stopped | Disposable Windows 11 VM |
| Security | Malicious profiles (path traversal, wrong hive, huge values, disallowed types, dangerous JSON keys), tampered plan, IPC fuzzing | Vitest fixtures |

Test mode: `WPM_TEST_MODE=1` swaps all infrastructure adapters for fakes and disables elevation. The flag is compiled out of production behavior by checking `app.isPackaged` and an explicit env var.

Coverage targets: `core/` ≥ 90% lines; critical UI flows covered by E2E. Coverage is a signal, not a gate on its own.

---

## 8. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Windhawk registry schema changes | Medium | High | Single `RegistryGateway` seam; startup compatibility check; research-backed field list; graceful read-only mode |
| Engine reload watch stops or misses a change | Low | High | Keep `ServiceController` for status/repair; verify read-back after a 300–500 ms settle; VM-test key deletion before relying on it |
| UAC/ShellExecuteEx quoting or policy blocks the helper | Medium | High | Fixed executable path under `%ProgramFiles%`, plan file + hash, no shell interpolation, manual matrix on Windows 11 22H2/23H2/24H2 |
| Helper is replaced in a user-writable path and elevated | Low | High | Per-machine install under `%ProgramFiles%` (ADR-0007); no portable helper |
| Mica/frameless visual regressions on maximize or display change | Medium | Medium | Native overlay chosen in ADR-0009; opaque fallback; custom mode retained behind `WPM_TITLEBAR` |
| Unsigned build triggers SmartScreen and shows "Unknown publisher" at UAC | High | Medium | Document it for v1; sign GUI and helper before public release (ADR-0010) |
| Smart App Control blocks the unsigned executable before startup and the NSIS intermediate uninstaller during packaging | High | High | Treat unsigned as developer-only; verify contents with `smoke:asar`; use `package:dir` locally; build/test the installer on a signed build or SAC-off VM; never recommend disabling SAC |
| Thai layout, plural, or calendar defects | Medium | Low | `_other`-only Thai locale, Gregorian dates, 150% scaling tests |
| Playwright's Electron sandbox is off by default | Medium | Low | Treat E2E as UI coverage; add a packaged smoke test for `process.sandboxed` |
| Antivirus flags unsigned installer | High | Medium | No obfuscation, open source, publish checksums, document SmartScreen; code signing later |
| Absolute icon-theme paths in a user capture are machine-specific | Medium | Low | The built-in Mac `iconTheme` option is portable; flag `themePaths`/`themeFolder` in captures and never bundle third-party assets |
| Explorer restart disrupts work or races a mod's own prompt | Medium | Medium | Ask by default; restart only when chosen; document the Taskbar Styler prompt |
| Partial write leaves a broken shell | Low | High | Snapshot-first + journal + typed rollback + startup recovery; markers written last |
| Mod update changes settings schema | Medium | Low | Warn on version mismatch; write only keys the profile captured; never write `Version`/`LibraryFileName` |
| Per-user Windhawk 2.0 config shadows global state | Medium | Medium | Detect `Users\<SID>` with `UserScoped=1`; block writes and explain |
| Snapshot scope excludes DLLs and `ModsWritable` | Certain | Low | Document the limit; restore reports missing DLLs and leaves mod-owned storage alone |
| Electron bundle size | Certain | Low | Accepted in ADR-0001; per-machine installer |

---

## 9. Definition of done (v1)

- Every acceptance criterion in `SPEC.md` §14 passes.
- All 18 tickets closed with tests.
- Manual matrix passes on at least Windows 11 22H2 or newer, x64, with Windhawk and all 10 mods.
- A real apply → reset → apply round-trip preserves the Mac settings, and no apply restarts the Windhawk service.
- `SettingsChangeTime` changes only when settings change; a `Disabled`-only transition leaves it untouched.
- A forced failure rolls back typed values and removes values the run added; a killed run recovers on next launch.
- Malicious profile, snapshot, and tampered-plan fixtures are rejected.
- `npm run lint`, `npm run typecheck`, `npm test`, and `npm run package` pass from a clean clone.
- The per-machine installer installs and uninstalls cleanly; the GUI launches without admin; the helper lives under `%ProgramFiles%`.
- No outbound network requests during a full session (verified with a local proxy or firewall log).
- README, SPEC, PLAN, and release notes match the shipped behavior.

---

## 10. Research dependencies

| Decision | Research doc | Applied in |
|----------|--------------|------------|
| Service restart not required; engine watches registry | `windhawk-internals.md` | SPEC FR-06, PLAN §5, 0008 |
| `SettingsChangeTime` algorithm and marker-last order | `windhawk-internals.md` | SPEC FR-06, 0004, 0008 |
| `Include`/`Exclude`/`Architecture` stay out of profiles | `windhawk-internals.md` | SPEC §9.5, 0002, 0015 |
| Mod IDs, versions, and official pages | `windhawk-internals.md` | 0015, 0016 |
| Install detection and `windhawk.ini` root | `windhawk-internals.md` | 0007 |
| Per-user 2.0 config detection | `windhawk-internals.md` | 0007, 0011 |
| Icon theme portability | both | 0015 |
| Electron 45 and titlebar/Mica API | `electron-windows.md` | 0001, 0010 |
| Elevation pattern details | `electron-windows.md` | 0009 |
| `.reg` codec edge cases and typed restore | `registry-and-prior-art.md` | 0004, 0005, 0014 |
| Rainmeter quit semantics | `registry-and-prior-art.md` | 0007 |
| Windows 10/ARM64 support | both | Deferred; v1 is Windows 11 x64 (SPEC §3) |

Remaining unknowns are validation tasks, not design blockers: `<mod-id>` key deletion vs. the engine watch, `reg import` merge behavior, and settings writes while the service is stopped. v1 avoids key deletion and service stops, so these can be verified in a VM before or during 0008.
