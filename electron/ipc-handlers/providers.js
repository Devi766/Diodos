module.exports = function registerProviderHandlers(context) {
  const { ipcMain, fetchMihomoAPI } = context;

  ipcMain.handle('get-proxy-providers', async () => {
    try {
      const response = await fetchMihomoAPI('/providers/proxies');
      const data = await response.json();
      return { success: true, data };
    } catch (error) {
      console.error('获取 Proxy Providers 失败:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('update-proxy-provider', async (event, providerName) => {
    try {
      await fetchMihomoAPI(`/providers/proxies/${encodeURIComponent(providerName)}`, {
        method: 'PUT'
      });
      return { success: true };
    } catch (error) {
      console.error(`更新 Proxy Provider ${providerName} 失败:`, error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('get-rule-providers', async () => {
    try {
      const response = await fetchMihomoAPI('/providers/rules');
      const data = await response.json();
      return { success: true, data };
    } catch (error) {
      console.error('获取 Rule Providers 失败:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('update-rule-provider', async (event, providerName) => {
    try {
      await fetchMihomoAPI(`/providers/rules/${encodeURIComponent(providerName)}`, {
        method: 'PUT'
      });
      return { success: true };
    } catch (error) {
      console.error(`更新 Rule Provider ${providerName} 失败:`, error);
      return { success: false, error: error.message };
    }
  });
};
