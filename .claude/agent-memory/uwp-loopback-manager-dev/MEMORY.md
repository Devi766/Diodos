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
- Backend: `electron/loopback-manager.js` - PowerShell + CheckNetIsolation
- Frontend: `src/components/LoopbackManager.tsx` - React component in Dialog
- Uses `-EncodedCommand` (Base64 UTF-16LE) for reliable PowerShell execution
- Fallback: registry-only enumeration when Get-AppxPackage fails
- IPC channels: `loopback:get-apps`, `loopback:save-config`, `loopback:add-exemption`, `loopback:remove-exemption`
- Types: `LoopbackApp`, `LoopbackAppsResult` in electron.d.ts
- i18n keys: `tools.loopback.*`
