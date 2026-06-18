(function () {
  if (typeof window === "undefined" || window.electronAPI) return;

  const listeners = new Map();

  function tauriCore() {
    return window.__TAURI__ && window.__TAURI__.core;
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

    return {
      ...response,
      json: async () => response.data,
      text: async () => {
        if (typeof response.text === "string") return response.text;
        if (typeof response.data === "string") return response.data;
        return JSON.stringify(response.data ?? null);
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

  function listen(eventName, handler) {
    const event = tauriEvent();
    if (!event || typeof event.listen !== "function") {
      return noopUnsubscribe;
    }
    let unlisten = null;
    event.listen(eventName, (event) => handler(event.payload)).then((fn) => {
      unlisten = fn;
    }).catch(() => {});
    return function unsubscribe() {
      if (typeof unlisten === "function") unlisten();
    };
  }

  const api = new Proxy(
    {
      debugLog: (...args) => console.debug("[FlyClash Tauri]", ...args),
      saveSubscription: async (...args) => {
        const result = await call("saveSubscription", args);
        return result && result.success !== false ? result.filePath : null;
      },
      requestMihomoAPI: async (...args) => wrapResponse(await call("requestMihomoAPI", args)),
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
      onThemeChanged: () => noopUnsubscribe,
      removeThemeListener: noopUnsubscribe,
      onThemeColorChanged: () => noopUnsubscribe,
      onAppearanceModeChanged: () => noopUnsubscribe,
      onCustomBackgroundApply: () => noopUnsubscribe,
      onClearCustomBackground: () => noopUnsubscribe,
      onTunStatus: () => noopUnsubscribe,
      onCoreDownloadProgress: () => noopUnsubscribe,
      onImportSubscription: () => noopUnsubscribe,
      onBackupUploadProgress: () => noopUnsubscribe,
      onBackupDownloadProgress: () => noopUnsubscribe,
      onSpeedtestOutput: () => noopUnsubscribe,
      onWindowStateChanged: () => noopUnsubscribe,
      onMihomoAutostart: () => noopUnsubscribe,
      onConnectionsUpdate: (callback) => on("connections-update", callback),
      onNodeChanged: (callback) => on("node-changed", callback),
      removeAllListeners: (channel) => {
        if (channel) listeners.delete(channel);
      },
    },
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (typeof prop !== "string") return undefined;
        return (...args) => call(prop, args);
      },
    }
  );

  window.electronAPI = api;
})();
