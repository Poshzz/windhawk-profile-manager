# Use Electron + React + TypeScript

The app is a Windows-only desktop utility whose UI is mostly state display and a few multi-step flows. Electron gives the fastest path to a polished, themeable interface and a per-machine installer. The machine already has Node 24; Tauri would require installing Visual Studio Build Tools (no MSVC linker is present), and C# would require the .NET SDK. Accepted cost: a roughly 100 MB installed bundle.

Considered: Tauri 2 (rejected for the missing linker toolchain), C# WinUI 3 (rejected for the missing .NET SDK), Python + CustomTkinter (rejected for weaker UI and packaging).
