(function () {
  if (typeof window === "undefined" || window.electronAPI) return;

  const listeners = new Map();

  function tauriCore() {
    return window.__TAURI__ && window.__TAURI__.core;
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

  const api = new Proxy(
    {
      debugLog: (...args) => console.debug("[FlyClash Tauri]", ...args),
      requestMihomoAPI: async (...args) => wrapResponse(await call("requestMihomoAPI", args)),
      proxyFetch: async (...args) => wrapResponse(await call("proxyFetch", args)),
      fetchWithProxy: async (...args) => wrapResponse(await call("fetchWithProxy", args)),
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
