# Windhawk Profile Manager

<p align="center">
  <img src="resources/icon.png" alt="Windhawk Profile Manager Logo" width="80" height="80" />
</p>

<p align="center">
  <strong>Safe, reversible mod profile management and desktop theming for Windhawk on Windows 11.</strong>
</p>

<p align="center">
  <a href="https://github.com/Poshzz/windhawk-profile-manager/releases"><img src="https://img.shields.io/github/v/release/Poshzz/windhawk-profile-manager?include_prereleases&style=flat-square&color=0969da" alt="Release Status" /></a>
  <img src="https://img.shields.io/badge/Platform-Windows%2011%20x64-0078d4?style=flat-square" alt="Platform: Windows 11 x64" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-2da44e?style=flat-square" alt="License: MIT" /></a>
  <img src="https://img.shields.io/badge/Node.js-%3E%3D24.0.0-339933?style=flat-square" alt="Node Version" />
  <img src="https://img.shields.io/badge/Privacy-100%25%20Offline-57606a?style=flat-square" alt="Privacy: Offline" />
</p>

---

## Table of Contents

- [Overview](#overview)
- [Visual Preview](#visual-preview)
- [Key Features](#key-features)
- [Bundled Profiles and Themes](#bundled-profiles-and-themes)
- [Safety and Architecture](#safety-and-architecture)
- [System Requirements](#system-requirements)
- [Installation Guide](#installation-guide)
- [Data Storage and Uninstall](#data-storage-and-uninstall)
- [Crash Recovery Mechanism](#crash-recovery-mechanism)
- [Security Model](#security-model)
- [Development and Testing](#development-and-testing)
- [Repository Documentation](#repository-documentation)
- [Frequently Asked Questions](#frequently-asked-questions)
- [License and Disclaimers](#license-and-disclaimers)

---

## Overview

**Windhawk Profile Manager** is an offline Windows 11 utility designed to simplify switching between complex configurations and theme packs on the [Windhawk](https://windhawk.net/) modding platform.

Configuring Windhawk mods manually can be tedious and prone to registry misalignment. This manager provides an automated, transactional layer that captures machine states, verifies execution plans, coordinates an isolated elevated helper, and ensures zero runtime downtime for the core Windhawk engine.

> [!WARNING]
> **Developer Build Notice:** Release `v0.1.0-dev.1` is an unsigned test build. Because binaries do not yet have an Authenticode certificate, Windows SmartScreen and Smart App Control will flag or block installation. Refer to [`docs/UNSIGNED-BUILD.md`](./docs/UNSIGNED-BUILD.md) for verification checksums and test-VM instructions.

---

## Visual Preview

| Application Management Interface | Translucent Desktop Result |
| :---: | :---: |
| ![Manager Dashboard Preview](docs/images/app-preview.png) | ![Desktop Theme Result](docs/images/desktop-preview.png) |

*(Screenshots can be added under `docs/images/` to illustrate interface workflows and theme results.)*

---

## Key Features

- **Transactional Profile Switching:** Every profile apply generates a pre-run registry snapshot, executes verified modification plans, and initiates an automatic rollback if any validation step fails.
- **Zero Engine Interruption:** Modifications write strictly to mod setting keys and flag `SettingsChangeTime`. The background Windhawk service is never forcefully terminated or restarted.
- **Profile Capture Engine:** Snapshot the current enabled mods and active options from your machine into a clean, portable JSON package.
- **Pre-execution Review:** Inspect the exact registry keys, missing mod warnings, and targeting criteria before consenting to the Windows User Account Control (UAC) prompt.
- **Offline and Privacy-Preserving:** The application performs no background telemetry, network checks, or remote synchronization. All snapshots, profiles, and operational logs reside strictly on your local disk.

---

## Bundled Profiles and Themes

The application includes curated configuration profiles out of the box:

### 1. Mac Blur Glass Theme Pack
Transforms the Windows 11 desktop into a clean, macOS-inspired translucent interface by orchestrating 10 compatible Windhawk mods:
- Translucent Windows (`translucent-windows`)
- Taskbar Dock Animation (`taskbar-dock-animation`)
- macOS Minimize Animation (`macos-minimize-animation`)
- Windows 11 Taskbar, Start Menu, Settings, and Notification Center Stylers
- Windows 11 File Explorer Styler
- Icon Resource Redirect and UXTheme Hook

### 2. Default Windows Reset Profile
Provides an instant reset path that disables theme-specific mods while preserving custom user values, returning your desktop cleanly to the native Windows 11 experience.

---

## Safety and Architecture

The manager operates through a dual-process security model:

```
+-------------------------------------------------------------------+
|  Renderer UI (Non-Elevated / Sandboxed)                           |
|  - Renders dashboard, inspects diffs, validates inputs            |
+---------------------------------+---------------------------------+
                                  | Preload IPC Bridge (Typed)
+---------------------------------v---------------------------------+
|  Node.js Main Process (Non-Elevated / asInvoker)                  |
|  - Prepares execution plan, hashes snapshot, manages journal      |
+---------------------------------+---------------------------------+
                                  | Elevated IPC Protocol (UAC)
+---------------------------------v---------------------------------+
|  Elevated Helper (Protected Location: %ProgramFiles%)             |
|  - Re-verifies plan hash, writes registry settings, signs journal |
+-------------------------------------------------------------------+
```

### Registry Write Boundary
The elevated helper enforces a strict write sandbox:
- Target keys are restricted strictly to `HKLM\SOFTWARE\Windhawk\Engine\Mods`.
- Only `Disabled`, `Settings\*`, and `SettingsChangeTime` values can be modified.
- Critical system paths, engine binary paths (`LibraryFileName`), and mod versions cannot be written or altered.
- Missing mod keys are never created arbitrarily.

---

## System Requirements

- **Operating System:** Windows 11 x64 (Version 22H2 or newer recommended).
- **Prerequisites:** Windhawk installed system-wide with standard directory paths.
- **Disk Layout:** Standard Windows partition layout (`C:\Windows`, `C:\ProgramData`, and `C:\Users\<Name>\AppData\Local`). Relocated system roots are rejected to prevent elevation bypasses.
- **Privileges:** Standard user account for interface operation; local administrator rights for UAC plan execution.

---

## Installation Guide

### For End Users

1. Navigate to the [Releases](https://github.com/Poshzz/windhawk-profile-manager/releases) page.
2. Download the latest installer executable: `Windhawk-Profile-Manager-<version>-x64.exe`.
3. Run the setup package. It installs per-machine into `%ProgramFiles%\WindhawkProfileManager` to ensure the elevated helper resides within protected storage.
4. Launch **Windhawk Profile Manager** from the Windows Start menu.
5. Review the first-run overview, choose a profile, inspect the changes, and approve the UAC prompt.

### Handling SmartScreen on Test Builds

Because development builds are currently unsigned:
1. When prompted with *Windows protected your PC*, click **More info**.
2. Compare the SHA-256 checksum with the manifest listed in [`docs/UNSIGNED-BUILD.md`](./docs/UNSIGNED-BUILD.md).
3. Select **Run anyway** once verified.

---

## Data Storage and Uninstall

All user files and configuration records are separated across predictable, standard paths:

| Data Type | Disk Location | Description |
| :--- | :--- | :--- |
| **Application State** | `%LOCALAPPDATA%\WindhawkProfileManager\state.json` | Window bounds, UI preferences, and view settings |
| **User Profiles** | `%APPDATA%\WindhawkProfileManager\profiles\` | Custom exported profiles and user JSON packs |
| **Snapshots** | `%LOCALAPPDATA%\WindhawkProfileManager\snapshots\` | Compressed pre-run states captured prior to changes |
| **Recovery Journal** | `%LOCALAPPDATA%\WindhawkProfileManager\journal.json` | Transaction log tracking active execution plans |
| **Application Logs** | `%LOCALAPPDATA%\WindhawkProfileManager\logs\` | Sanitized application and helper operational logs |
| **Helper Runs** | `%ProgramData%\WindhawkProfileManager\runs\` | Secure, short-lived elevated execution records |

### Clean Uninstall
Running the uninstaller via *Windows Settings > Installed apps* removes the application binaries and helper. User-created profiles, snapshots, and diagnostic logs are preserved intentionally. To perform a complete purge, delete the corresponding folders listed above.

---

## Crash Recovery Mechanism

If a system reboot, power outage, or crash occurs mid-execution:
1. Upon the next application startup, the journal file detects an unfinalized operation.
2. An automatic **Recovery Dialog** prompts the user with two safe paths:
   - **Roll Back:** Restore the recorded pre-run snapshot using the typed registry restore path.
   - **Acknowledge and Retain:** Retain current system modifications and safely close out the transaction ledger.
3. Pre-run snapshots are never automatically removed until explicitly purged by the user.

---

## Security Model

- **Renderer Sandboxing:** The user interface runs within a sandboxed context without direct Node.js integration, utilizing a typed preload bridge.
- **Electron Fuses:** Hardened runtime settings disable inspection overrides, Node integration in sub-workers, and arbitrary script arguments.
- **Payload Validation:** Imported JSON and `.reg` definitions are validated against strict Zod schemas that reject reparse points, key deletions, and unknown properties.
- **Path Sanitization:** User paths, usernames, and registry values are systematically redacted from log outputs to eliminate personal data leakage.

---

## Development and Testing

### Prerequisites
- Windows 11 x64
- Node.js 24 LTS or later
- npm 11 or later

### Setup and Development

Clone the repository and install dependencies:

```powershell
git clone https://github.com/Poshzz/windhawk-profile-manager.git
cd windhawk-profile-manager
npm ci
```

Start the application in development mode with hot reload:

```powershell
npm run dev
```

### Verification and Quality Gates

Run formatting, static typing, and test suites:

```powershell
# Type checking
npm run typecheck

# Code linting
npm run lint

# Style formatting check
npm run format:check

# Unit and integration tests
npm run test

# End-to-end tests (via Playwright)
npm run test:e2e
```

### Packaging and Artifact Verification

```powershell
# Build application bundles
npm run build

# Smoke test ASAR integrity and runtime fuses
npm run smoke:asar
npm run smoke:fuses
npm run smoke:packaged

# Compile unpackaged directory or NSIS installer
npm run package:dir
npm run package

# Generate cryptographic release hashes
npm run release:checksums
```

---

## Repository Documentation

For in-depth architectural reasoning and engineering standards, consult:

- [`CONTEXT.md`](./CONTEXT.md) - Domain glossary and conceptual architecture.
- [`docs/SPEC.md`](./docs/SPEC.md) - Complete functional specifications and acceptance requirements.
- [`docs/PLAN.md`](./docs/PLAN.md) - Engineering phases, technical milestones, and risk registers.
- [`docs/adr/`](./docs/adr/) - Architecture Decision Records detailing critical technical choices.
- [`docs/UNSIGNED-BUILD.md`](./docs/UNSIGNED-BUILD.md) - Checksums, security verifications, and test environments.

---

## Frequently Asked Questions

#### Does this tool install Windhawk mods automatically?
No. The application manages configuration settings, values, and enabled/disabled states for mods. You must have Windhawk installed and download the relevant mods through the Windhawk catalog. Missing mods are reported prior to applying a profile.

#### Why does the tool require administrator rights?
Mod configuration states in Windhawk are stored under the local machine registry hive (`HKLM`). Modifying these values requires an elevated helper. The manager limits elevation solely to the plan execution phase.

#### Can I revert changes made by a theme pack?
Yes. You can either apply the bundled **Default Windows** profile or select any automatically captured snapshot to restore your exact prior state.

---

## License and Disclaimers

This project is licensed under the **[MIT License](LICENSE)**.

### Third-Party Attribution
Windhawk is developed by its respective authors. This project is an independent utility and is not affiliated with, maintained by, or endorsed by the upstream Windhawk development team.
