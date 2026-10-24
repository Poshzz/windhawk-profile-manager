# Keep the native titlebar overlay

The default window uses `titleBarStyle: 'hidden'` plus Electron's native `titleBarOverlay`, with a 48 DIP overlay and transparent colors over Mica. The renderer reserves the native control area. `WPM_TITLEBAR=custom` switches to a `frame: false` window with custom traffic lights for comparison; it is not the shipped default.

## Spike results

Environment: Windows 11 build 26300, 1707 × 1067 desktop, Electron 45.0.0, packaged x64, unsigned. Mica was reported by DWM as `DWMWA_SYSTEMBACKDROP_TYPE = 2`.

| Check | Native overlay | Custom traffic lights |
|---|---|---|
| Drag from the titlebar | Pass — moved 110 × 33 DIP | Pass — same movement |
| Double-click maximize | Pass — `IsZoomed = true` | Pass — React double-click handler |
| Restore | Pass | Pass |
| Snap left (`Win+Left`) | Pass — 914 × 1011 half-screen region | Pass |
| Mica after drag, maximize, snap, restore | Pass — DWM backdrop stayed `2` | Pass — stayed `2` |
| Native Snap Layouts hover flyout | Inherited from the system maximize button | Not available without reimplementing it |
| System menu and native control accessibility | Inherited | Not available |

Screenshots: [`docs/spikes/titlebar-overlay.png`](../spikes/titlebar-overlay.png) and [`docs/spikes/titlebar-custom.png`](../spikes/titlebar-custom.png). A web-content screenshot does not include the native caption buttons in overlay mode.

## Decision

Keep the native overlay. It preserves Windows 11 snap layouts, the system menu, maximize/restore behavior, RTL adaptation, and accessibility without custom Win32 work. The macOS look comes from the glass surfaces, typography, and spacing rather than reimplementing the window frame.

The custom mode stays behind `WPM_TITLEBAR=custom` for design comparisons. Both modes passed the core interaction and Mica checks on this build, so custom remains a viable fallback if the native overlay becomes unacceptable or breaks on a future Electron release.

## Fallback

- **Titlebar:** `frame: false` plus the custom traffic lights already in `src/renderer/components/Titlebar.tsx`, if the overlay ever fails on a supported build. This gives up the native Snap Layouts flyout and system menu, so it needs a product decision first.
- **Material:** below Windows 11 22H2, or if `setBackgroundMaterial('mica')` throws, use the opaque `#0b0b0f` background. The renderer never paints over the material with an opaque shell.

## Consequences

- Ticket 0010 keeps the overlay's `env(titlebar-area-*)` safe area and updates overlay colors with `nativeTheme`; it must not cover the native caption buttons.
- High-DPI, multi-monitor, and RTL checks remain part of the release checklist.
- The custom titlebar is not removed: it is the visual fallback and a useful comparison harness.
