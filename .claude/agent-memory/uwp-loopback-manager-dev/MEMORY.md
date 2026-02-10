# UWP Loopback Manager - Project Knowledge

## Project Stack
- Electron 35 + Next.js 14 + React 18 + TypeScript + Tailwind CSS
- UI components: Radix UI primitives (dialog, checkbox, switch, scroll-area, etc.) in `src/components/ui/`
- i18n: react-i18next, locales in `src/i18n/locales/{zh-CN,en-US}.json`

## Key File Paths
- `electron/main.js` - Main process, IPC handlers (inline + modular in `electron/ipc-handlers/`)
- `electron/preload.js` - contextBridge exposes `window.electronAPI`
- `src/types/electron.d.ts` - TypeScript type definitions for ElectronAPI
- `app/tools/page.tsx` - Tools page with loopback manager card + dialog

## IPC Handler Pattern
- Modular: `module.exports = function registerXxxHandlers(context) { ... }`
- Inline in main.js: `ipcMain.handle('channel', async (_, args) => { ... })`
- Registered around line 625-690 in main.js

## Preload Pattern
- `ipcRenderer.invoke('channel-name', ...args)` for async calls
- Nested objects for feature groups (e.g., `loopback: { getApps, saveConfig, ... }`)
- Event listeners return unsubscribe functions

## UWP Loopback Manager Implementation
- Backend: `electron/loopback-manager.js` - PowerShell Add-Type + NetworkIsolation API (Firewallapi.dll)
- C# helper: `electron/loopback-helper.cs` - P/Invoke declarations for NetworkIsolation API
- Frontend: `src/components/LoopbackManager.tsx` - React component in Dialog
- `execPowerShell`: uses `-EncodedCommand` (Base64 UTF-16LE), no encoding issues but has 8191 char limit
- `execPowerShellFile`: writes .ps1 temp file with **UTF-8 BOM** + `[Console]::OutputEncoding = UTF-8` prefix
  - BOM is required: PowerShell 5.x reads non-BOM files as system default encoding (GBK on Chinese Windows)
  - OutputEncoding is required: PowerShell stdout defaults to system encoding, Node.js expects UTF-8
- Uses PowerShell here-string (@'...'@) to pass C# code without escaping
- **No admin rights required** - uses NetworkIsolationSetAppContainerConfig instead of CheckNetIsolation
- IPC channels: `loopback:get-apps`, `loopback:save-config`, `loopback:add-exemption`, `loopback:remove-exemption`
- Types: `LoopbackApp`, `LoopbackAppsResult` in electron.d.ts
- i18n keys: `tools.loopback.*`
- Save button uses themeColor (from useThemeColor hook) with dynamic boxShadow, matching ConfirmDialog pattern
- List area uses `custom-scrollbar` class (defined in globals.css) instead of border
- `isAdmin` field always returns true since NetworkIsolation API doesn't need elevation
- **SHLoadIndirectString** (shlwapi.dll) used to resolve `@{PackageName?ms-resource://...}` display names to localized text
- **PackageFamilyName extraction**: `INET_FIREWALL_APP_CONTAINER.packageFullName` contains the full name (e.g., `Name_Version_Arch_ResId_PubId`); extract PFN as `Name_PublisherId` (first + last `_`-separated parts)
- **Display name matching**: JS side uses case-insensitive lookup table; match order: PFN exact -> containerName exact -> PFN prefix (Name part) -> fuzzy startsWith
- `appContainerName` is always lowercase; `PackageFamilyName` from Get-StartApps preserves original casing
- List separators: use `border-b border-border/20` with `mx-3` instead of `divide-y divide-border/40` (softer look)
- App name font: `text-[13px]` instead of `text-sm` for better readability; package name uses `text-muted-foreground/70`

## UI Style Conventions
- Dialog: `glass-panel card-surface rounded-[28px]` (defined in dialog.tsx)
- Colors: use CSS variables (`text-foreground`, `text-muted-foreground`, `bg-accent`, `text-primary`, `border-border`) not hardcoded gray/blue
- Borders: `border-border/60`, `divide-border/40` for subtle separators
- Rounded corners: `rounded-xl` for inner elements, `rounded-[28px]` for dialog shell
- Buttons: use variant system (`default`, `ghost`, `outline`, `secondary`) not hardcoded `bg-blue-500`
- Error states: `border-destructive/30 bg-destructive/5 text-destructive` pattern
- Warning states: `border-amber-400/30 bg-amber-500/8 text-amber-500` pattern
- Hover: `hover:bg-accent/40` for list items
- Changed/modified items: `bg-primary/5` background, `bg-primary/10` badge
- Input component has built-in glass style (rounded-xl, backdrop-blur-md)
- ScrollArea needs explicit height (e.g., `h-[380px]`) to work properly
- Dialog for loopback: `sm:max-w-[680px] max-h-[85vh]` with `p-0` and manual padding on header/body
