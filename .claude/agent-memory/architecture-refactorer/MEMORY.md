# FlyClash-UI Architecture Memory

## Tech Stack
- Electron + Next.js + React (TypeScript frontend, JavaScript backend)
- Tailwind CSS for styling
- i18next for internationalization
- SQLite (via db-manager) for settings persistence
- UI library: mix of shadcn/ui components (`src/components/ui/`) and raw Tailwind

## Key Architecture Patterns
- IPC communication: `preload.js` exposes `window.electronAPI` via `contextBridge`
- All IPC handlers now modular in `ipc-handlers/*.js` files with `registerXxxHandlers(deps)` pattern
- Backend modules in `electron/main-process/` use a shared `context` object
- Window management extracted to `electron/window/` (window-manager.js, backdrop.js, static-server.js)
- Dependency injection via function parameters (not global context) for all extracted modules
- `main.js` was 5540 lines - reduced to 704 after Phase 1+2+3 refactoring

## Identified Issues (2026-02-10 audit)
- See `audit-2026-02-10.md` for full report
- `formatBytes` duplicated 6+ times across codebase
- 3 different Toast systems coexist (sonner, ui/toast.tsx, Toast.tsx, inline in CoreManager)
- CoreManager IPC handlers inline in main.js instead of ipc-handlers/ directory
- LoopbackManager has duplicated PowerShell response parsing code
- CoreManager.tsx (595 lines) mixes business logic, state, and UI

## Completed Fixes (2026-02-10)
- preload.js: removed subscription URL leak logs (lines 190-194, 213), dead code, stale comments, duplicate `getProxies`/`getConfigOrder` definitions
- tools/page.tsx: hardcoded Chinese replaced with i18n keys (`tools.unknownNode`, `tools.converter.detail`, `tools.converter.open`)
- ConfirmDialog.tsx: default params changed from Chinese to English, removed duplicate `transition-all`
- CoreManager.tsx: `useState<any>` replaced with `UpdateInfo` interface, removed redundant `filteredVersions` alias, Chinese fallbacks in t() changed to English
- loopback-manager.js: extracted `parsePowerShellAppList()` and `execCheckNetIsolation()` helpers to eliminate duplicated code
- LoopbackManager.tsx: `catch (err: any)` changed to `catch (err: unknown)` with proper type narrowing, Chinese console.error changed to English
- i18n: added `tools.converter.detail`, `tools.converter.open`, `tools.unknownNode` keys to both zh-CN and en-US

## File Locations
- Main process entry: `electron/main.js` (704 lines after Phase 3 refactoring)
- Preload bridge: `electron/preload.js`
- IPC handlers: `electron/ipc-handlers/`
- Backend modules: `electron/main-process/`
- Frontend components: `src/components/`
- UI primitives: `src/components/ui/`
- Shared utils: `src/utils/`, `src/lib/utils.ts`

## main.js Refactoring (2026-02-10)

### Phase 1: Initial extraction (5540 -> ~4074 lines, -1466 lines)
Extracted 4 modules from main.js:
1. `electron/ipc-handlers/tun-service.js` (532 lines) - TUN mode toggle, permissions, service install/uninstall/start/stop, TUN config
2. `electron/ipc-handlers/speedtest.js` (324 lines) - run-speedtest + run-speedtest-direct with shared findSpeedtestExe()
3. `electron/window/backdrop.js` (271 lines) - macOS/Windows backdrop effects, custom background
4. `electron/startup/app-initializer.js` (309 lines) - app.whenReady() initialization logic

### Phase 2: Integration of pre-created modules (~4074 -> 2747 lines, -1327 lines)
Integrated 11 pre-created modules into main.js:
1. `electron/websocket/traffic-ws.js` - createTrafficWsManager({state, context, WebSocket, formatTraffic, fetchConnectionsInfo, MAX_TRAFFIC_HISTORY})
2. `electron/websocket/logs-ws.js` - createLogsWsManager({state, WebSocket})
3. `electron/websocket/connections-ws.js` - createConnectionsWsManager({state})
4. `electron/ipc-handlers/window-control.js` - registerWindowControlHandlers({state})
5. `electron/ipc-handlers/file-ops.js` - registerFileOpsHandlers({verifyAuthToken})
6. `electron/ipc-handlers/kernel-path-ipc.js` - registerKernelPathHandlers({state, context, isWindows, loadKernelPreference, resolveDefaultKernelPath, saveKernelPreference, clearKernelPreference})
7. `electron/ipc-handlers/core-manager-ipc.js` - registerCoreManagerIpcHandlers({state, context, dbManager})
8. `electron/ipc-handlers/auto-launch.js` - exports {setAutoLaunch, getAutoLaunchState}
9. `electron/protocol/protocol-handler.js` - createProtocolHandler({state, app})
10. `electron/lifecycle/app-lifecycle.js` - registerAppLifecycle({app, state, dbManager, subscriptionScheduler, stopConnectionsWebSocket, stopMihomoLogs, cleanupWebSockets})
11. `electron/monitoring/memory-monitor.js` - createMemoryMonitor({state, formatTraffic})

Total reduction: 5540 -> 2747 lines (-2793 lines, ~50% reduction)

### Phase 3: Final IPC extraction + window manager (2747 -> 669 lines, -2078 lines)
Extracted 8 modules from main.js:
1. `electron/ipc-handlers/settings-ipc.js` (209 lines) - registerSettingsIpcHandlers({state, dbManager, security, verifyAuthToken, updateUserSettingsRaw, getUserSettings, APP_VERSION, app, shell})
2. `electron/ipc-handlers/appearance-ipc.js` (218 lines) - registerAppearanceIpcHandlers({state, dbManager, isWindows, isMac, applyMacOSBackdrop, applyWindowsBackdrop, refreshWindowsBackdrop, applyCustomBackground})
3. `electron/ipc-handlers/proxy-node-ipc.js` (311 lines) - registerProxyNodeIpcHandlers({state, context, fetchMihomoAPI, checkMihomoService, parseConfigFile, userDataPath})
4. `electron/ipc-handlers/config-ipc.js` (262 lines) - registerConfigIpcHandlers({context, userDataPath})
5. `electron/ipc-handlers/misc-ipc.js` (476 lines) - registerMiscIpcHandlers({state, context, dbManager, security, verifyAuthToken, userDataPath, isDev, fetchMihomoAPI, ...})
6. `electron/ipc-handlers/loopback-ipc.js` (50 lines) - registerLoopbackIpcHandlers()
7. `electron/window/window-manager.js` (322 lines) - createWindowManager({state, context, dbManager, configDir, isWindows, isMac, isDev, ...})
8. `electron/window/static-server.js` (81 lines) - createStaticServer({state})

Total reduction across all phases: 5540 -> 669 lines (-4871 lines, ~88% reduction)

Also removed dead code: `switchNode()` function (defined but never called in main.js)

Pattern used: dependency injection via function parameters (not global context)
- `registerTunServiceHandlers(deps)` - called inside app.whenReady()
- `registerSpeedtestHandlers(deps)` - called at module level
- `createBackdropManager(deps)` - returns object with backdrop functions
- `initializeApp(deps)` - async, called inside app.whenReady()
