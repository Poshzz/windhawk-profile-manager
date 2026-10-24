# Windhawk Profile Manager

Desktop app that switches Windows 11 between named Windhawk configurations.

## Language

### Profiles and state

**Profile**:
A named declaration of desired Windhawk state: which mods are enabled, optional settings overrides, and app actions such as Rainmeter.
_Avoid_: theme, preset, config

**Theme pack**:
A bundled set of profiles plus the mod metadata and install links needed to reproduce a look.
_Avoid_: skin pack, bundle

**Snapshot**:
A capture of the Windhawk `Engine\Mods` configuration at one moment, used for rollback. It includes targeting values and machine-specific metadata but excludes mod DLLs and `ModsWritable` storage.
_Avoid_: backup (a backup is a collection of snapshots)

**Apply**:
The act of transitioning the machine to a profile's desired state.
_Avoid_: install, load

**Reset**:
Applying the built-in Default Windows profile: disable the theme's managed mods, keep their settings, and stop Rainmeter.
_Avoid_: restore (restore means returning to a snapshot)

**Restore**:
Returning the machine to a snapshot's captured state.
_Avoid_: rollback (rollback is the automatic restore after a failed apply)

**Active profile**:
The profile most recently applied successfully, as recorded by the app.

**Drift**:
Any difference between current machine state and the active profile's desired state.

### Environment

**Environment**:
A read-only description of the machine at one moment: Windows build, Windhawk installation and storage mode, registry root, service state, installed mods, per-user configuration, Rainmeter, and compatibility.
_Avoid_: system info, status

**Compatibility mode**:
The environment's write capability: `writable`, `read-only` (for example portable mode, a non-default registry root, or an active per-user configuration), or `unsupported` (missing Windhawk or an unsupported Windows build or architecture).
_Avoid_: health, readiness

**Per-user configuration**:
A Windhawk 2.0+ `Users\<SID>` subtree. When its `UserScoped` value is non-zero, it overrides the global mod state and v1 blocks apply.
_Avoid_: user profile (a profile is a named desired state)

### Mods

**Mod**:
A Windhawk mod: a DLL injected by the Windhawk engine to alter Windows behavior.
_Avoid_: plugin, addon, extension

**Managed mod**:
A mod listed in the profile being applied; the app may write its registry keys.
_Avoid_: included mod

**Unlisted mod**:
An installed mod that the profile does not list. Left untouched by default.
_Avoid_: unknown mod, extra mod

**Missing mod**:
A mod listed in a profile but not installed on this machine. Skipped with a warning.
_Avoid_: absent mod

**Settings override**:
A typed `REG_SZ` or `REG_DWORD` value the profile writes under a managed mod's `Settings` key. In `replace` mode the profile's map is authoritative and omitted values are deleted; an empty `replace` map means delete all settings and requires explicit confirmation. In `merge` mode omitted values are left as-is.
_Avoid_: config, tweak

**Reload marker**:
The `SettingsChangeTime` DWORD that tells the Windhawk engine to reload a mod's settings. It is written last and only when settings changed.
_Avoid_: timestamp, version

### Apply mechanics

**Apply plan**:
The computed, reviewable set of typed registry operations, reload-marker changes, optional service start, and process actions for one apply.
_Avoid_: diff, changeset

**Execution plan**:
The shared envelope for one privileged run: `apply` or `restore`, its run id, `profileRevision`, `beforeHash`/`settingsHash`, absolute paths, finishing actions, and plan hash.
_Avoid_: job, task

**Apply run**:
One execution of an apply plan, including its snapshot, journal, result, and rollback outcome.

**Journal**:
A durable record written before an apply run so an interrupted run can be detected and recovered.

**Elevated helper**:
The short-lived privileged process that executes an apply plan on behalf of the non-elevated GUI.
_Avoid_: admin service, daemon

## Relationships

- A **theme pack** contains one or more **profiles**.
- A **profile** manages zero or more **mods**.
- An **apply** produces an **apply plan**, then an **apply run**.
- An **apply run** creates exactly one **snapshot** and exactly one **journal**.
- A **restore** creates a pre-restore **snapshot** before changing anything.
- A **restore** reconciles typed values; it never deletes the `Engine\Mods` root or a `<mod-id>` key.
- **Drift** compares current machine state with the **active profile**.
- A **profile** is portable user intent; a **snapshot** is machine-specific rollback evidence.
