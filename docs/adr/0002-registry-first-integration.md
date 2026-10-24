# Integrate through Windhawk's registry state

Windhawk exposes no supported API for enabling mods or changing settings, so the app reads and writes `HKLM\SOFTWARE\Windhawk\Engine\Mods` directly, as the original `.bat` kit does. A profile writes only `Disabled` and values under `<mod-id>\Settings`; targeting fields (`Include`, `Exclude`, `Architecture`) and install metadata (`LibraryFileName`, `Version`, `SettingsChangeTime`) stay with Windhawk. Snapshots capture all of them. A restore may reconcile captured targeting values on the same machine, but never writes `LibraryFileName` or `Version`.

Profiles are applied with typed per-value writes, not `reg.exe import` (ADR-0008). This couples the app to an undocumented schema. `RegistryGateway` is the single seam that isolates that risk, and a compatibility check at startup reports when the expected keys are missing.
