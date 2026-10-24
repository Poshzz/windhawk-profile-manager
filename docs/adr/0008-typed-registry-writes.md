# Apply with typed registry writes, not `reg.exe import`

Profiles are applied by the helper as per-value typed writes, plus explicit deletions when a mod is in `replace` mode. The helper never replaces the whole `Settings` key: it reads the current map and writes only the intended values. After writing, it stamps `SettingsChangeTime` last and verifies every touched value by read-back. `reg.exe import` is merge-only, has no multi-key transaction, and can partially apply; `reg export` captures raw snapshot evidence, but `reg import` is not used for apply or restore.

Restore reconciles the snapshot's typed values and deletes values added after the snapshot inside captured keys. Importing a `.reg` cannot remove those values and would leave a misleading "restored" state. Restore never deletes `Engine\Mods` or a `<mod-id>` key; key deletion needs a VM test and is not required for v1.

Cost: a strict parser and a larger helper. Benefit: deterministic apply and a rollback that can actually remove what it added.
