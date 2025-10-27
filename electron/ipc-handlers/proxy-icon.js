const { ipcMain } = require('electron');
const { getInstance: getProxyIconManager } = require('../proxy-icon/proxy-icon-manager');

/**
 * 注册代理图标相关的IPC处理器
 */
function registerProxyIconHandlers() {
  // 获取代理图标配置
  ipcMain.handle('proxy-icon:get-config', async () => {
    try {
      const iconManager = getProxyIconManager();
      const config = iconManager.getConfig();
      return { success: true, config };
    } catch (error) {
      console.error('[IPC] 获取代理图标配置失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 保存代理图标配置
  ipcMain.handle('proxy-icon:save-config', async (event, config) => {
    try {
      const iconManager = getProxyIconManager();
      const result = iconManager.saveConfig(config);
      return result;
    } catch (error) {
      console.error('[IPC] 保存代理图标配置失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 添加规则
  ipcMain.handle('proxy-icon:add-rule', async (event, rule) => {
    try {
      const iconManager = getProxyIconManager();
      const result = iconManager.addRule(rule);
      return result;
    } catch (error) {
      console.error('[IPC] 添加代理图标规则失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 更新规则
  ipcMain.handle('proxy-icon:update-rule', async (event, ruleId, updates) => {
    try {
      const iconManager = getProxyIconManager();
      const result = iconManager.updateRule(ruleId, updates);
      return result;
    } catch (error) {
      console.error('[IPC] 更新代理图标规则失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 删除规则
  ipcMain.handle('proxy-icon:delete-rule', async (event, ruleId) => {
    try {
      const iconManager = getProxyIconManager();
      const result = iconManager.deleteRule(ruleId);
      return result;
    } catch (error) {
      console.error('[IPC] 删除代理图标规则失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 切换规则启用状态
  ipcMain.handle('proxy-icon:toggle-rule', async (event, ruleId, enabled) => {
    try {
      const iconManager = getProxyIconManager();
      const result = iconManager.toggleRule(ruleId, enabled);
      return result;
    } catch (error) {
      console.error('[IPC] 切换代理图标规则状态失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 获取代理组图标
  ipcMain.handle('proxy-icon:get-group-icon', async (event, groupName, configIcon) => {
    try {
      const iconManager = getProxyIconManager();
      const iconPath = iconManager.getProxyGroupIcon(groupName, configIcon);
      return { success: true, iconPath };
    } catch (error) {
      console.error('[IPC] 获取代理组图标失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 清除图标缓存
  ipcMain.handle('proxy-icon:clear-cache', async () => {
    try {
      const iconManager = getProxyIconManager();
      const result = iconManager.clearCache();
      return result;
    } catch (error) {
      console.error('[IPC] 清除图标缓存失败:', error);
      return { success: false, error: error.message };
    }
  });

  console.log('[IPC] 代理图标处理器已注册');
}

module.exports = { registerProxyIconHandlers };

