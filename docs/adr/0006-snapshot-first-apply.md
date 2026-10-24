# Every apply is snapshot-first and journaled

Before the first registry write, Apply captures a snapshot of the Windhawk mods configuration and writes a durable journal naming the snapshot, the plan, and the pre-write hash. The Windhawk service stays running: the engine watches `Engine\Mods` with `RegNotifyChangeKeyValue` and reloads after a ~200 ms debounce, so a stop/start would only add downtime and failure modes. The service is checked, and started only if it is stopped.

A failed apply reconciles typed values from the snapshot, deletes values the apply added inside captured keys, re-stamps changed reload markers, and verifies. It never deletes the `Engine\Mods` root or a `<mod-id>` subkey, because the engine holds a notify handle on the root and key deletion has not been VM-tested. An interrupted apply is detected on the next launch and offered for recovery.

The snapshot is rollback evidence, not a `reg import` payload. `reg import` is merge-only and cannot delete values or express a typed diff; restore parses the `.reg` file and writes allowlisted values with their recorded types.

**Consequences:** apply costs one registry export and a small journal file, not a service restart. A concurrent Windhawk write is caught by `beforeHash` and aborts the run before writing. Snapshot scope is mod configuration only: mod DLLs and `ModsWritable` are not covered.
