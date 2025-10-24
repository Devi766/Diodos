const { ipcMain } = require('electron');

/**
 * 注册流量历史相关的 IPC 处理器
 * @param {Object} context - 应用上下文
 */
function registerTrafficHistoryHandlers(context) {
  const { dbManager } = context;

  /**
   * 获取今日流量数据
   */
  ipcMain.handle('traffic-history:get-today', async () => {
    try {
      const data = dbManager.getTodayTraffic();
      return { success: true, data };
    } catch (error) {
      console.error('[IPC] 获取今日流量失败:', error);
      return { success: false, error: error.message };
    }
  });

  /**
   * 获取本月流量数据
   */
  ipcMain.handle('traffic-history:get-month', async (event, yearMonth) => {
    try {
      const data = yearMonth
        ? dbManager.getTrafficByMonth(yearMonth)
        : dbManager.getThisMonthTraffic();
      return { success: true, data };
    } catch (error) {
      console.error('[IPC] 获取本月流量失败:', error);
      return { success: false, error: error.message };
    }
  });

  /**
   * 获取本年流量数据
   */
  ipcMain.handle('traffic-history:get-year', async (event, year) => {
    try {
      const data = year
        ? dbManager.getTrafficByYear(year)
        : dbManager.getThisYearTraffic();
      return { success: true, data };
    } catch (error) {
      console.error('[IPC] 获取本年流量失败:', error);
      return { success: false, error: error.message };
    }
  });

  /**
   * 获取指定日期的流量数据
   */
  ipcMain.handle('traffic-history:get-by-date', async (event, date) => {
    try {
      const data = dbManager.getTrafficByDate(date);
      return { success: true, data };
    } catch (error) {
      console.error('[IPC] 获取指定日期流量失败:', error);
      return { success: false, error: error.message };
    }
  });

  console.log('[IPC] 流量历史处理器已注册');
}

module.exports = { registerTrafficHistoryHandlers };

