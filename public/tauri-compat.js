(function () {
  if (typeof window === "undefined") return;

  const existingElectronAPI = window.electronAPI;
  const patchableNamespaces = ["configIcon", "proxyIcon", "loopback", "converter"];

  function hasPatchableCompatNamespace(api) {
    if (!api) return false;
    return patchableNamespaces.some((namespace) => {
      try {
        return typeof api[namespace] === "function";
      } catch (_) {
        return false;
      }
    });
  }

  if (existingElectronAPI && !hasPatchableCompatNamespace(existingElectronAPI)) return;

  const listeners = new Map();
  const tauriListeners = new Map();
  const compatWarningTimestamps = new Map();
  let pendingImportSubscription = null;
  let importBridgeStarted = false;
  let profileUpdateBridgeStarted = false;
  let navigationBridgeStarted = false;
  const COMPAT_WARNING_THROTTLE_MS = 15000;

  function tauriCore() {
    return window.__TAURI__ && window.__TAURI__.core;
  }

  function hasTauriRuntime() {
    const core = tauriCore();
    return !!core && typeof core.invoke === "function";
  }

  function tauriEvent() {
    return window.__TAURI__ && window.__TAURI__.event;
  }

  async function call(method, args) {
    const core = tauriCore();
    if (!core || typeof core.invoke !== "function") {
      return { success: false, error: "Tauri runtime is not available" };
    }
    return core.invoke("tauri_compat_call", {
      request: {
        method,
        args: Array.from(args || []),
      },
    });
  }

  function wrapResponse(response) {
    if (!response || typeof response !== "object") return response;
    if (typeof response.json === "function") return response;
    const normalized = { ...response };
    if (normalized.success === false && typeof normalized.ok !== "boolean") {
      const error = normalized.error || normalized.message || "Request failed";
      normalized.ok = false;
      normalized.status = normalized.status || 500;
      normalized.statusText = normalized.statusText || String(error);
      normalized.data = normalized.data ?? { message: String(error) };
      normalized.text = normalized.text ?? String(error);
    }

    return {
      ...normalized,
      json: async () => normalized.data,
      text: async () => {
        if (typeof normalized.text === "string") return normalized.text;
        if (typeof normalized.data === "string") return normalized.data;
        return JSON.stringify(normalized.data ?? null);
      },
    };
  }

  function on(channel, callback) {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(callback);
    return function unsubscribe() {
      const set = listeners.get(channel);
      if (set) set.delete(callback);
    };
  }

  function noopUnsubscribe() {}

  function noopListener() {
    return noopUnsubscribe;
  }

  function trackTauriListener(channel, unsubscribe) {
    if (!tauriListeners.has(channel)) tauriListeners.set(channel, new Set());
    tauriListeners.get(channel).add(unsubscribe);
  }

  function untrackTauriListener(channel, unsubscribe) {
    const set = tauriListeners.get(channel);
    if (!set) return;
    set.delete(unsubscribe);
    if (set.size === 0) tauriListeners.delete(channel);
  }

  function removeTauriListeners(channel) {
    if (channel) {
      const set = tauriListeners.get(channel);
      if (!set) return;
      Array.from(set).forEach((unsubscribe) => unsubscribe());
      tauriListeners.delete(channel);
      return;
    }

    Array.from(tauriListeners.keys()).forEach((key) => removeTauriListeners(key));
  }

  function isRuntimeUnavailable(result) {
    return result && result.success === false && result.error === "Tauri runtime is not available";
  }

  function compatErrorMessage(result, fallback) {
    if (!result || typeof result !== "object") return fallback;
    return result.error || result.message || result.statusText || fallback;
  }

  function emitCompatWarning(method, reason, result, fallbackUsed) {
    const error = compatErrorMessage(result, reason);
    const key = `${method}:${reason}:${error}`;
    const now = Date.now();
    const last = compatWarningTimestamps.get(key) || 0;
    if (now - last < COMPAT_WARNING_THROTTLE_MS) return;
    compatWarningTimestamps.set(key, now);

    const detail = {
      method,
      reason,
      error,
      fallbackUsed: !!fallbackUsed,
      runtimeAvailable: hasTauriRuntime(),
      result,
    };

    console.warn("[FlyClash Tauri]", `${method} ${reason}: ${error}`, result);
    try {
      if (!Array.isArray(window.__flyclashCompatWarnings)) {
        window.__flyclashCompatWarnings = [];
      }
      window.__flyclashCompatWarnings.push(detail);
      window.dispatchEvent(new CustomEvent("tauri-compat-warning", { detail }));
    } catch (_) {}
  }

  function browserPlatform() {
    if (typeof process !== "undefined" && process && typeof process.platform === "string") {
      return process.platform;
    }
    const platform = (
      (navigator.userAgentData && navigator.userAgentData.platform) ||
      navigator.platform ||
      navigator.userAgent ||
      ""
    ).toLowerCase();
    if (platform.includes("win")) return "win32";
    if (platform.includes("mac")) return "darwin";
    if (platform.includes("linux")) return "linux";
    return "browser";
  }

  async function callWithDefault(method, args, fallback, accept) {
    const runtimeAvailable = hasTauriRuntime();
    const result = await call(method, args);
    if (isRuntimeUnavailable(result)) {
      const fallbackAllowed = !runtimeAvailable;
      emitCompatWarning(method, "runtime-unavailable", result, fallbackAllowed);
      return fallbackAllowed ? fallback : result;
    }
    if (result && typeof result === "object" && result.success === false) {
      emitCompatWarning(method, "backend-error", result, false);
      return result;
    }
    if (typeof accept === "function" && !accept(result)) {
      if (!runtimeAvailable) return fallback;
      const error = `${method} returned an unexpected Tauri result shape`;
      emitCompatWarning(method, "unexpected-result", { success: false, error, data: result }, false);
      return { success: false, error, data: result };
    }
    return result;
  }

  function listen(eventName, handler) {
    const event = tauriEvent();
    if (!event || typeof event.listen !== "function") {
      return noopUnsubscribe;
    }
    let unlisten = null;
    let cancelled = false;
    const unsubscribe = function unsubscribe() {
      cancelled = true;
      if (typeof unlisten === "function") unlisten();
      untrackTauriListener(eventName, unsubscribe);
    };

    trackTauriListener(eventName, unsubscribe);

    event.listen(eventName, (event) => handler(event.payload)).then((fn) => {
      if (cancelled) {
        if (typeof fn === "function") fn();
        return;
      }
      unlisten = fn;
    }).catch(() => {});
    return unsubscribe;
  }

  function callbackWithOptionalEvent(callback, payload) {
    if (typeof callback !== "function") return;
    if (callback.length >= 2) {
      callback(null, payload);
    } else {
      callback(payload);
    }
  }

  function rememberImportSubscription(url) {
    if (typeof url !== "string" || !url.trim()) return;
    pendingImportSubscription = url.trim();
    try {
      window.dispatchEvent(new CustomEvent("flyclash-import-subscription", {
        detail: pendingImportSubscription,
      }));
    } catch (_) {}
  }

  function startImportSubscriptionBridge() {
    if (importBridgeStarted) return;
    const event = tauriEvent();
    if (!event || typeof event.listen !== "function") return;
    importBridgeStarted = true;
    event.listen("import-subscription", (event) => {
      rememberImportSubscription(event.payload);
    }).catch(() => {
      importBridgeStarted = false;
    });
  }

  function dispatchProfileUpdated(detail) {
    try {
      window.dispatchEvent(new CustomEvent("profile-updated", { detail }));
    } catch (_) {
      try {
        window.dispatchEvent(new Event("profile-updated"));
      } catch (_) {}
    }
  }

  function dispatchDomEvent(eventName, detail) {
    try {
      window.dispatchEvent(new CustomEvent(eventName, { detail }));
    } catch (_) {
      try {
        window.dispatchEvent(new Event(eventName));
      } catch (_) {}
    }
  }

  function startProfileUpdateBridge() {
    if (profileUpdateBridgeStarted) return;
    const event = tauriEvent();
    if (!event || typeof event.listen !== "function") return;
    profileUpdateBridgeStarted = true;

    const bridgeEvents = [
      ["active-config-changed", (payload) => ({ activeConfig: payload }), false],
      ["subscription-auto-updated", (payload) => ({ subscription: payload }), true],
      ["subscription-auto-update-failed", (payload) => ({ subscription: payload, failed: true }), true],
    ];

    Promise.all(
      bridgeEvents.map(([eventName, toDetail, dispatchOriginal]) =>
        event.listen(eventName, (event) => {
          const detail = toDetail(event.payload);
          if (dispatchOriginal) {
            dispatchDomEvent(eventName, event.payload);
          }
          dispatchProfileUpdated(detail);
        })
      )
    ).catch(() => {
      profileUpdateBridgeStarted = false;
    });
  }

  function routeForPageName(pageName) {
    const page = typeof pageName === "string" ? pageName.trim() : "";
    if (!page || page === "index" || page === "home") return "/";
    if (page.startsWith("/")) return page;
    const clean = page.replace(/^#+/, "").replace(/^\/+/, "").replace(/\.html?$/i, "");
    return `/${clean}`;
  }

  function navigateWithinApp(target) {
    const route = routeForPageName(target);
    try {
      if (window.location.pathname === route) {
        return { success: true, path: route, skipped: true };
      }
      window.history.pushState({}, "", route);
      window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
      return { success: true, path: route };
    } catch (error) {
      try {
        window.location.assign(route);
        return { success: true, path: route, reloaded: true };
      } catch (_) {
        return {
          success: false,
          path: route,
          error: error && error.message ? error.message : String(error || "Navigation failed"),
        };
      }
    }
  }

  function startNavigationBridge() {
    if (navigationBridgeStarted) return;
    const event = tauriEvent();
    if (!event || typeof event.listen !== "function") return;
    navigationBridgeStarted = true;
    event.listen("navigate-to", (event) => {
      navigateWithinApp(event.payload);
    }).catch(() => {
      navigationBridgeStarted = false;
    });
  }

  const api = new Proxy(
    {
      debugLog: (...args) => console.debug("[FlyClash Tauri]", ...args),
      getAuthToken: null,
      getAppVersion: async (...args) =>
        callWithDefault("getAppVersion", args, "0.2.9", (result) => typeof result === "string"),
      getPlatform: async (...args) =>
        callWithDefault("getPlatform", args, browserPlatform(), (result) => typeof result === "string"),
      getSubscriptions: async (...args) =>
        callWithDefault("getSubscriptions", args, [], Array.isArray),
      getOverrides: async (...args) =>
        callWithDefault("getOverrides", args, [], Array.isArray),
      getActiveConfig: async (...args) =>
        callWithDefault("getActiveConfig", args, null, (result) => typeof result === "string" || result === null),
      getProxyStatus: async (...args) =>
        callWithDefault("getProxyStatus", args, false, (result) => typeof result === "boolean"),
      getTunStatus: async (...args) =>
        callWithDefault("getTunStatus", args, false, (result) => typeof result === "boolean"),
      isMihomoRunning: async (...args) =>
        callWithDefault("isMihomoRunning", args, false, (result) => typeof result === "boolean"),
      startMihomo: async (...args) => call("startMihomo", args),
      stopMihomo: async (...args) => call("stopMihomo", args),
      toggleSystemProxy: async (...args) => call("toggleSystemProxy", args),
      toggleTunMode: async (...args) => call("toggleTunMode", args),
      restartService: async (...args) => call("restartService", args),
      reloadMihomoConfig: async (...args) => call("reloadMihomoConfig", args),
      setPreferredConfig: async (...args) => call("setPreferredConfig", args),
      saveLastConfig: async (...args) => call("saveLastConfig", args),
      getTrafficStats: async (...args) => call("getTrafficStats", args),
      getTrafficToday: async (...args) => call("getTrafficToday", args),
      getTrafficMonth: async (...args) => call("getTrafficMonth", args),
      getTrafficYear: async (...args) => call("getTrafficYear", args),
      getTrafficByDate: async (...args) => call("getTrafficByDate", args),
      getProxies: async (...args) => call("getProxies", args),
      closeConnection: async (...args) => call("closeConnection", args),
      closeAllConnections: async (...args) => call("closeAllConnections", args),
      notifyNodeChanged: async (...args) => call("notifyNodeChanged", args),
      testAllNodes: async (...args) => call("testAllNodes", args),
      getTheme: async (...args) => call("getTheme", args),
      setTheme: async (...args) => call("setTheme", args),
      getThemeColor: async (...args) => call("getThemeColor", args),
      setThemeColor: async (...args) => call("setThemeColor", args),
      getSetting: async (...args) => call("getSetting", args),
      setSetting: async (...args) => call("setSetting", args),
      getFavoriteNodes: async (...args) => call("getFavoriteNodes", args),
      saveFavoriteNodes: async (...args) => call("saveFavoriteNodes", args),
      getCollapsedGroups: async (...args) => call("getCollapsedGroups", args),
      saveCollapsedGroups: async (...args) => call("saveCollapsedGroups", args),
      getLogs: async (...args) => callWithDefault("getLogs", args, [], Array.isArray),
      saveLogs: async (...args) => call("saveLogs", args),
      clearLogs: async (...args) => call("clearLogs", args),
      getApiConfig: async (...args) =>
        callWithDefault(
          "getApiConfig",
          args,
          {
            success: true,
            controllerHost: null,
            controllerPort: null,
            secret: "",
            controllerMode: "ipc",
            socketPath: null,
            socketArg: null,
            httpFallback: false,
            "external-controller": null,
          },
          (result) => result && typeof result === "object" && result.success !== false
        ),
      getConfigOrder: async (...args) =>
        callWithDefault(
          "getConfigOrder",
          args,
          { success: true, data: { proxyGroups: [] } },
          (result) => result && typeof result === "object" && result.success !== false
        ),
      fetchConnectionsInfo: async (...args) =>
        callWithDefault(
          "fetchConnectionsInfo",
          args,
          {
            activeConnections: 0,
            currentNode: "",
            downloadTotal: 0,
            uploadTotal: 0,
          },
          (result) => result && typeof result === "object" && result.success !== false
        ),
      getIconDataURL: async (...args) =>
        callWithDefault("getIconDataURL", args, null, (result) => typeof result === "string" || result === null),
      loadPage: async (pageName) => navigateWithinApp(pageName),
      navigateTo: async (href) => navigateWithinApp(href),
      getWindowState: async (...args) => call("getWindowState", args),
      minimizeWindow: async (...args) => call("minimizeWindow", args),
      maximizeWindow: async (...args) => call("maximizeWindow", args),
      closeWindow: async (...args) => call("closeWindow", args),
      showWindow: async (...args) => call("showWindow", args),
      hideWindow: async (...args) => call("hideWindow", args),
      quitApp: async (...args) => call("quitApp", args),
      openExternal: async (...args) => call("openExternal", args),
      openToolsApp: async (...args) => call("openToolsApp", args),
      setAsDefaultProtocolClient: async (...args) => call("setAsDefaultProtocolClient", args),
      isDefaultProtocolClient: async (...args) => call("isDefaultProtocolClient", args),
      removeAsDefaultProtocolClient: async (...args) => call("removeAsDefaultProtocolClient", args),
      registerProtocol: async (...args) => call("registerProtocol", args),
      isProtocolRegistered: async (...args) => call("isProtocolRegistered", args),
      unregisterProtocol: async (...args) => call("unregisterProtocol", args),
      supportsAdvancedBackdrop: async (...args) => call("supportsAdvancedBackdrop", args),
      getAppearanceMode: async (...args) => call("getAppearanceMode", args),
      setAppearanceMode: async (...args) => call("setAppearanceMode", args),
      selectBackgroundImage: async (...args) => call("selectBackgroundImage", args),
      setCustomBackground: async (...args) => call("setCustomBackground", args),
      getCustomBackground: async (...args) => call("getCustomBackground", args),
      clearCustomBackground: async (...args) => call("clearCustomBackground", args),
      getProxySettings: async (...args) => call("getProxySettings", args),
      saveProxySettings: async (...args) => call("saveProxySettings", args),
      saveUASettings: async (...args) => call("saveUASettings", args),
      getSystemProxyStatus: async (...args) => call("getSystemProxyStatus", args),
      getKernelPath: async (...args) => call("getKernelPath", args),
      selectKernelExecutable: async (...args) => call("selectKernelExecutable", args),
      resetKernelPath: async (...args) => call("resetKernelPath", args),
      setAutoLaunch: async (...args) => call("setAutoLaunch", args),
      getAutoLaunchState: async (...args) =>
        callWithDefault("getAutoLaunchState", args, false, (result) => typeof result === "boolean"),
      setAutoStart: async (...args) => call("setAutoStart", args),
      getAutoStart: async (...args) =>
        callWithDefault("getAutoStart", args, false, (result) => typeof result === "boolean"),
      getSilentStart: async (...args) => call("getSilentStart", args),
      setSilentStart: async (...args) => call("setSilentStart", args),
      getLightweightModeSettings: async (...args) => call("getLightweightModeSettings", args),
      setLightweightModeSettings: async (...args) => call("setLightweightModeSettings", args),
      enterLightweightMode: async (...args) => call("enterLightweightMode", args),
      coreGetCurrentConfig: async (...args) => call("coreGetCurrentConfig", args),
      coreGetRuntimeState: async (...args) => call("coreGetRuntimeState", args),
      coreGetInstalledCores: async (...args) => call("coreGetInstalledCores", args),
      coreCheckUpdate: async (...args) => call("coreCheckUpdate", args),
      coreDownloadCore: async (...args) => call("coreDownloadCore", args),
      coreGetAvailableVersions: async (...args) => call("coreGetAvailableVersions", args),
      coreClearVersionCache: async (...args) => call("coreClearVersionCache", args),
      coreDownloadSpecificVersion: async (...args) => call("coreDownloadSpecificVersion", args),
      coreSwitchCore: async (...args) => call("coreSwitchCore", args),
      coreDeleteCore: async (...args) => call("coreDeleteCore", args),
      coreSetCustomPath: async (...args) => call("coreSetCustomPath", args),
      getKernelConfig: async (...args) => call("getKernelConfig", args),
      saveKernelConfig: async (...args) => call("saveKernelConfig", args),
      getDnsConfig: async (...args) => call("getDnsConfig", args),
      saveDnsConfig: async (...args) => call("saveDnsConfig", args),
      saveHostsConfig: async (...args) => call("saveHostsConfig", args),
      getSnifferConfig: async (...args) => call("getSnifferConfig", args),
      saveSnifferConfig: async (...args) => call("saveSnifferConfig", args),
      getProxyGroupsConfig: async (...args) => call("getProxyGroupsConfig", args),
      saveProxyGroupsConfig: async (...args) => call("saveProxyGroupsConfig", args),
      getRulesConfig: async (...args) => call("getRulesConfig", args),
      saveRulesConfig: async (...args) => call("saveRulesConfig", args),
      getProvidersConfig: async (...args) => call("getProvidersConfig", args),
      saveProvidersConfig: async (...args) => call("saveProvidersConfig", args),
      getProxiesConfig: async (...args) => call("getProxiesConfig", args),
      saveProxiesConfig: async (...args) => call("saveProxiesConfig", args),
      writeConfigFile: async (...args) => call("writeConfigFile", args),
      getProxyNodes: async (...args) => call("getProxyNodes", args),
      selectNode: async (...args) => call("selectNode", args),
      selectGroupNode: async (...args) => call("selectGroupNode", args),
      switchNode: async (...args) => call("switchNode", args),
      testNodeDelay: async (...args) => call("testNodeDelay", args),
      getRuntimeConfig: async (...args) => call("getRuntimeConfig", args),
      getProxyConfig: async (...args) => call("getProxyConfig", args),
      getCurrentConfigName: async (...args) => call("getCurrentConfigName", args),
      deleteElevateTask: async (...args) => call("deleteElevateTask", args),
      checkElevateTask: async (...args) => callWithDefault("checkElevateTask", args, false, (result) => typeof result === "boolean"),
      grantTunPermissions: async (...args) => call("grantTunPermissions", args),
      checkCorePermission: async (...args) => call("checkCorePermission", args),
      revokeCorePermission: async (...args) => call("revokeCorePermission", args),
      serviceIsRunning: async (...args) => call("serviceIsRunning", args),
      serviceInstall: async (...args) => call("serviceInstall", args),
      serviceUninstall: async (...args) => call("serviceUninstall", args),
      getTunConfig: async (...args) => call("getTunConfig", args),
      saveTunConfig: async (...args) => call("saveTunConfig", args),
      getTunElevationMode: async (...args) => call("getTunElevationMode", args),
      setTunElevationMode: async (...args) => call("setTunElevationMode", args),
      getTunServiceStatus: async (...args) => call("getTunServiceStatus", args),
      installTunService: async (...args) => call("installTunService", args),
      uninstallTunService: async (...args) => call("uninstallTunService", args),
      startTunService: async (...args) => call("startTunService", args),
      stopTunService: async (...args) => call("stopTunService", args),
      fetchSubscription: async (...args) => call("fetchSubscription", args),
      saveSubscription: async (...args) => call("saveSubscription", args),
      updateSubscription: async (...args) => call("updateSubscription", args),
      deleteSubscription: async (...args) => call("deleteSubscription", args),
      refreshSubscription: async (...args) => call("refreshSubscription", args),
      getSubscriptionUrl: async (...args) => call("getSubscriptionUrl", args),
      editSubscription: async (...args) => call("editSubscription", args),
      saveSubscriptionOrder: async (...args) => call("saveSubscriptionOrder", args),
      getSubscriptionOverrides: async (...args) => call("getSubscriptionOverrides", args),
      setSubscriptionOverrides: async (...args) => call("setSubscriptionOverrides", args),
      getSubscriptionUpdateInterval: async (...args) => call("getSubscriptionUpdateInterval", args),
      setSubscriptionUpdateInterval: async (...args) => call("setSubscriptionUpdateInterval", args),
      getProxyProviders: async (...args) => call("getProxyProviders", args),
      updateProxyProvider: async (...args) => call("updateProxyProvider", args),
      getRuleProviders: async (...args) => call("getRuleProviders", args),
      updateRuleProvider: async (...args) => call("updateRuleProvider", args),
      addOverride: async (...args) => call("addOverride", args),
      updateOverride: async (...args) => call("updateOverride", args),
      deleteOverride: async (...args) => call("deleteOverride", args),
      getOverrideFileContent: async (...args) => call("getOverrideFileContent", args),
      updateOverrideFileContent: async (...args) => call("updateOverrideFileContent", args),
      updateRemoteOverride: async (...args) => call("updateRemoteOverride", args),
      reorderOverrides: async (...args) => call("reorderOverrides", args),
      readConfigFile: async (...args) => call("readConfigFile", args),
      validateConfig: async (...args) => call("validateConfig", args),
      editConfigAtomic: async (...args) => call("editConfigAtomic", args),
      aiProxyFetch: async (...args) => call("aiProxyFetch", args),
      aiProxyStreamStart: async (...args) => call("aiProxyStreamStart", args),
      aiProxyStreamAbort: async (...args) => call("aiProxyStreamAbort", args),
      testMediaStreaming: async (...args) => call("testMediaStreaming", args),
      runSpeedtest: async (...args) => call("runSpeedtest", args),
      runSpeedtestDirect: async (...args) => call("runSpeedtestDirect", args),
      runProxySpeedtest: async (...args) => call("runProxySpeedtest", args),
      testUdpConnectivity: async (...args) => call("testUdpConnectivity", args),
      openFile: async (...args) => call("openFile", args),
      openFileLocation: async (...args) => call("openFileLocation", args),
      openFileInDefaultApp: async (...args) => call("openFileInDefaultApp", args),
      requestMihomoAPI: async (...args) => {
        const result = await call("requestMihomoAPI", args);
        if (result && result.success === false && result.error === "Tauri runtime is not available") {
          return wrapResponse({
            ok: false,
            status: 503,
            statusText: "Mihomo service unavailable",
            data: { message: "Mihomo service unavailable" },
          });
        }
        return wrapResponse(result);
      },
      proxyFetch: async (...args) => wrapResponse(await call("proxyFetch", args)),
      fetchWithProxy: async (...args) => wrapResponse(await call("fetchWithProxy", args)),
      configIcon: {
        getIcon: async (...args) => call("configIcon.getIcon", args),
        clearCache: async (...args) => call("configIcon.clearCache", args),
        getCacheSize: async (...args) => call("configIcon.getCacheSize", args),
      },
      proxyIcon: {
        getConfig: async (...args) => call("proxyIcon.getConfig", args),
        saveConfig: async (...args) => call("proxyIcon.saveConfig", args),
        addRule: async (...args) => call("proxyIcon.addRule", args),
        updateRule: async (...args) => call("proxyIcon.updateRule", args),
        deleteRule: async (...args) => call("proxyIcon.deleteRule", args),
        toggleRule: async (...args) => call("proxyIcon.toggleRule", args),
        clearCache: async (...args) => call("proxyIcon.clearCache", args),
        getGroupIcon: async (...args) => call("proxyIcon.getGroupIcon", args),
      },
      loopback: {
        getApps: async (...args) => call("loopback.getApps", args),
        saveConfig: async (...args) => call("loopback.saveConfig", args),
        addExemption: async (...args) => call("loopback.addExemption", args),
        removeExemption: async (...args) => call("loopback.removeExemption", args),
        openTool: async (...args) => call("loopback.openTool", args),
        toolAvailable: async (...args) => call("loopback.toolAvailable", args),
        launchEnableLoopback: async (...args) => call("loopback.openTool", args),
      },
      converter: {
        startServer: async (...args) => call("converter.startServer", args),
        stopServer: async (...args) => call("converter.stopServer", args),
        serverStatus: async (...args) => call("converter.serverStatus", args),
        getTemplates: async (...args) => call("converter.getTemplates", args),
        parseProxies: async (...args) => call("converter.parseProxies", args),
        fetchUrl: async (...args) => call("converter.fetchUrl", args),
        convertWithTemplate: async (...args) => call("converter.convertWithTemplate", args),
        convert: async (...args) => call("converter.convert", args),
        createSubscription: async (...args) => call("converter.createSubscription", args),
        deleteSubscription: async (...args) => call("converter.deleteSubscription", args),
        listSubscriptions: async (...args) => call("converter.listSubscriptions", args),
        addToConfig: async (...args) => call("converter.addToConfig", args),
        getTemplate: async (...args) => call("converter.getTemplate", args),
        getSettings: async (...args) => call("converter.getSettings", args),
        saveSettings: async (...args) => call("converter.saveSettings", args),
      },
      backupCreateLocal: async (...args) => call("backupCreateLocal", args),
      backupRestoreLocal: async (...args) => call("backupRestoreLocal", args),
      backupWebDAVTest: async (...args) => call("backupWebDAVTest", args),
      backupWebDAVUpload: async (...args) => call("backupWebDAVUpload", args),
      backupWebDAVDownload: async (...args) => call("backupWebDAVDownload", args),
      backupWebDAVList: async (...args) => call("backupWebDAVList", args),
      backupWebDAVDelete: async (...args) => call("backupWebDAVDelete", args),
      backupWebDAVSaveConfig: async (...args) => call("backupWebDAVSaveConfig", args),
      backupWebDAVGetConfig: async (...args) => call("backupWebDAVGetConfig", args),
      onAiProxyStreamChunk: (callback) => listen("ai-proxy-stream-chunk", (payload) => {
        callback(payload.requestId, new Uint8Array(payload.chunk || []));
      }),
      onAiProxyStreamEnd: (callback) => listen("ai-proxy-stream-end", (payload) => {
        callback(payload.requestId);
      }),
      onAiProxyStreamError: (callback) => listen("ai-proxy-stream-error", (payload) => {
        callback(payload.requestId, payload.error || "");
      }),
      onMessage: on,
      onThemeChanged: (callback) => listen("theme-changed", (payload) => {
        callbackWithOptionalEvent(callback, payload);
      }),
      removeThemeListener: () => removeTauriListeners("theme-changed"),
      onThemeColorChanged: (callback) => listen("theme-color-changed", (payload) => {
        callbackWithOptionalEvent(callback, payload);
      }),
      onAppearanceModeChanged: (callback) => listen("appearance-mode-changed", callback),
      onCustomBackgroundApply: (callback) => listen("apply-custom-background", callback),
      onClearCustomBackground: (callback) => listen("clear-custom-background", callback),
      onTrayAction: (callback) => listen("tray-action", callback),
      onTunStatus: (callback) => listen("tun-status", callback),
      onCoreDownloadProgress: (callback) => listen("core:download-progress", callback),
      onImportSubscription: (callback) => {
        startImportSubscriptionBridge();
        const customHandler = (event) => callback(event.detail);
        window.addEventListener("flyclash-import-subscription", customHandler);
        if (pendingImportSubscription) {
          setTimeout(() => callback(pendingImportSubscription), 0);
        }
        return () => {
          window.removeEventListener("flyclash-import-subscription", customHandler);
        };
      },
      onActiveConfigChanged: (callback) => listen("active-config-changed", callback),
      onBackupUploadProgress: (callback) => listen("backup-upload-progress", callback),
      onBackupDownloadProgress: (callback) => listen("backup-download-progress", callback),
      onSpeedtestProgress: (callback) => listen("speedtest-progress", callback),
      onSpeedtestOutput: (callback) => listen("speedtest-output", callback),
      onWindowStateChanged: (callback) => listen("window-state-changed", callback),
      onMihomoLog: (callback) => listen("mihomo-log", callback),
      onMihomoLogs: (callback) => listen("mihomo-logs", callback),
      offMihomoLogs: () => removeTauriListeners("mihomo-logs"),
      onMihomoError: (callback) => listen("mihomo-error", callback),
      onMihomoStartFailed: (callback) => listen("mihomo-start-failed", callback),
      onMihomoStopped: (callback) => listen("mihomo-stopped", callback),
      onProxyStatus: (callback) => listen("proxy-status", callback),
      onTrafficUpdate: (callback) => listen("traffic-update", callback),
      onMihomoAutostart: (callback) => listen("mihomo-autostart", callback),
      onSubscriptionAutoUpdated: (callback) => listen("subscription-auto-updated", callback),
      onSubscriptionAutoUpdateFailed: (callback) => listen("subscription-auto-update-failed", callback),
      onServiceRestarted: (callback) => listen("service-restarted", callback),
      onTestAllNodes: (callback) => listen("test-all-nodes", callback),
      onConnectionsClosed: (callback) => listen("connections-closed", callback),
      onConnectionsUpdate: (callback) => listen("connections-update", callback),
      onNodeChanged: (callback) => listen("node-changed", callback),
      removeTrafficListeners: () => {
        removeTauriListeners("traffic-update");
        removeTauriListeners("connections-update");
      },
      removeAllListeners: (channel) => {
        if (channel) {
          listeners.delete(channel);
          removeTauriListeners(channel);
        } else {
          listeners.clear();
          removeTauriListeners();
        }
      },
    },
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (typeof prop !== "string") return undefined;
        return undefined;
      },
    }
  );

  if (existingElectronAPI) {
    Object.keys(api).forEach((method) => {
      if (patchableNamespaces.includes(method)) return;
      try {
        if (!Object.prototype.hasOwnProperty.call(existingElectronAPI, method)
          || typeof existingElectronAPI[method] !== "function") {
          existingElectronAPI[method] = api[method];
        }
      } catch (_) {}
    });

    patchableNamespaces.forEach((namespace) => {
      try {
        const compatNamespace = api[namespace];
        const currentNamespace = existingElectronAPI[namespace];
        if (!currentNamespace || typeof currentNamespace === "function") {
          existingElectronAPI[namespace] = compatNamespace;
          return;
        }
        if (typeof currentNamespace === "object") {
          Object.keys(compatNamespace).forEach((method) => {
            if (typeof currentNamespace[method] !== "function") {
              currentNamespace[method] = compatNamespace[method];
            }
          });
        }
      } catch (_) {}
    });
  } else {
    window.electronAPI = api;
  }
  startImportSubscriptionBridge();
  startProfileUpdateBridge();
  startNavigationBridge();
})();
