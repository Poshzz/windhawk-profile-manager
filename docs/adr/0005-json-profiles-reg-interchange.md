# JSON profiles are the source of truth; `.reg` is evidence and interchange

Profiles are versioned JSON under `%APPDATA%\WindhawkProfileManager\profiles`, written atomically. Snapshots are JSON metadata plus a raw `.reg` evidence file under `%LOCALAPPDATA%\WindhawkProfileManager\snapshots`. The legacy `.reg` files seed the built-in theme pack once and remain available for import/export.

JSON carries metadata, typed settings overrides, validation rules, and app actions that `.reg` cannot express. A raw `.reg` snapshot is evidence and an export format; restore parses it into typed values and reconciles them. `reg import` is never the apply or restore mechanism because it cannot delete values (ADR-0008).
