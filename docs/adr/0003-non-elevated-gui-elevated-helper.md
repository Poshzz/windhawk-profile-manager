# Keep the GUI non-elevated and elevate a helper per apply

The GUI runs as the logged-in user. Apply spawns a short-lived elevated helper through a UAC prompt; the helper executes a validated apply plan and exits. This keeps the large Electron attack surface unprivileged and avoids both a permanently elevated app and a SYSTEM service.

Cost: one UAC prompt per apply. A silent scheduled-task mode is deferred past v1.
