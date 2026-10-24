# Treat the unsigned v1 build as developer-only

v0.1.0 is unsigned by product decision. Unsigned executables trigger SmartScreen, and Windows Smart App Control can block them outright when it is enforcing reputation. The owner's machine has `VerifiedAndReputablePolicyState = 1`; the final unsigned package was blocked before app startup with **"An Application Control policy has blocked this file."** The first packaged build happened to launch before the policy rejected a later rebuild, so a successful launch on one hash is not evidence that the next unsigned build will run.

## Decision

- Keep the product scope at unsigned v1, but treat the unsigned installer and executable as **developer/test artifacts**, not a public release.
- Do not instruct users to disable Smart App Control. Turning it off weakens a system-wide protection and may require a Windows reset to restore; it is not a reasonable installation step for a profile manager.
- Sign both the GUI and the elevated helper before public release. Signing is a release gate in ticket 0018, not a post-release improvement.
- Verify unsigned package contents with `npm run smoke:asar`, which loads the final `app.asar` in the development Electron binary and checks the typed bridge, version, and renderer isolation without executing the unsigned launcher.
- Run the manual install/apply matrix on a signed build, or on a dedicated VM where Smart App Control is off. Record which environment was used.
- Build the NSIS installer on a signed/SAC-off machine. On a SAC-enforcing machine, electron-builder's NSIS target fails after creating the app payload because it executes an unsigned intermediate installer to generate the uninstaller (`spawn UNKNOWN`). `npm run package:dir` still produces the runnable app directory for local content checks.

## Consequences

- The owner cannot complete the physical install/launch check or the NSIS build on the primary machine while Smart App Control is enforcing and the build is unsigned.
- The release notes must distinguish SmartScreen ("More info" can continue) from Smart App Control (the process does not start).
- A future decision to ship unsigned to the public would need an explicit support statement that SAC-enabled machines may be unable to run the app. That is not the current decision.
- Signing also fixes the packaging path: a signed intermediate uninstaller can be executed and signed by electron-builder without tripping the reputation policy.
