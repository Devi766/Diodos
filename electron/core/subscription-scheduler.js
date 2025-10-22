/**
 * 订阅自动更新调度器
 * 参考 Mihomo Party 的实现，管理订阅的定时更新任务
 */

class SubscriptionScheduler {
  constructor(context) {
    this.context = context;
    this.dbManager = context.get('dbManager');
    this.timers = new Map(); // taskId -> intervalId
    this.isRunning = false;

    console.log('[SubscriptionScheduler] 初始化');
  }

  /**
   * 启动调度器
   */
  start() {
    if (this.isRunning) {
      console.log('[SubscriptionScheduler] 调度器已在运行');
      return;
    }

    console.log('[SubscriptionScheduler] 启动调度器');
    this.isRunning = true;

    // 初始化时检查需要立即更新的订阅
    this.checkAndUpdateExpired();

    // 刷新所有定时任务
    this.refresh();
  }

  /**
   * 停止调度器
   */
  stop() {
    console.log('[SubscriptionScheduler] 停止调度器');
    this.isRunning = false;

    // 清除所有定时器
    for (const [taskId, intervalId] of this.timers.entries()) {
      clearInterval(intervalId);
      console.log(`[SubscriptionScheduler] 清除任务: ${taskId}`);
    }
    this.timers.clear();
  }

  /**
   * 刷新所有定时任务
   */
  refresh() {
    if (!this.isRunning) {
      return;
    }

    console.log('[SubscriptionScheduler] 刷新定时任务');

    try {
      // 获取所有需要自动更新的订阅
      const subscriptions = this.dbManager.getAutoUpdateSubscriptions();
      console.log(`[SubscriptionScheduler] 找到 ${subscriptions.length} 个自动更新订阅`);

      // 生成差异
      const currentTasks = new Map();
      for (const sub of subscriptions) {
        const taskId = this.getTaskId(sub.file_path);
        currentTasks.set(taskId, {
          filePath: sub.file_path,
          interval: sub.update_interval
        });
      }

      // 找出需要删除的任务
      for (const [taskId, intervalId] of this.timers.entries()) {
        if (!currentTasks.has(taskId)) {
          // 删除任务
          clearInterval(intervalId);
          this.timers.delete(taskId);
          console.log(`[SubscriptionScheduler] 删除任务: ${taskId}`);
        }
      }

      // 找出需要添加或更新的任务
      for (const [taskId, taskInfo] of currentTasks.entries()) {
        const existingIntervalId = this.timers.get(taskId);

        if (existingIntervalId) {
          // 任务已存在，检查间隔是否变化
          // 为了简化，我们直接重建任务
          clearInterval(existingIntervalId);
          console.log(`[SubscriptionScheduler] 更新任务: ${taskId}`);
        } else {
          console.log(`[SubscriptionScheduler] 添加任务: ${taskId}`);
        }

        // 创建新的定时器
        const intervalMs = taskInfo.interval * 60 * 1000; // 分钟转毫秒
        const intervalId = setInterval(() => {
          this.executeUpdate(taskInfo.filePath);
        }, intervalMs);

        this.timers.set(taskId, intervalId);
        console.log(`[SubscriptionScheduler] 任务 ${taskId} 设置为每 ${taskInfo.interval} 分钟更新一次`);
      }

    } catch (error) {
      console.error('[SubscriptionScheduler] 刷新任务失败:', error);
    }
  }

  /**
   * 检查并更新过期的订阅
   */
  checkAndUpdateExpired() {
    try {
      const subscriptions = this.dbManager.getAutoUpdateSubscriptions();
      const now = Date.now();

      console.log(`[SubscriptionScheduler] 检查 ${subscriptions.length} 个订阅是否需要更新`);

      for (const sub of subscriptions) {
        const intervalMs = sub.update_interval * 60 * 1000;
        const timeSinceUpdate = now - sub.updated_at;

        if (timeSinceUpdate >= intervalMs) {
          console.log(`[SubscriptionScheduler] 订阅 ${sub.name} 已过期，立即更新`);
          this.executeUpdate(sub.file_path);
        }
      }
    } catch (error) {
      console.error('[SubscriptionScheduler] 检查过期订阅失败:', error);
    }
  }

  /**
   * 执行订阅更新
   */
  async executeUpdate(filePath) {
    try {
      console.log(`[SubscriptionScheduler] 执行更新: ${filePath}`);

      const subscription = this.dbManager.getSubscriptionByPath(filePath);
      if (!subscription) {
        console.error(`[SubscriptionScheduler] 找不到订阅: ${filePath}`);
        return;
      }

      if (!subscription.url) {
        console.error(`[SubscriptionScheduler] 订阅没有URL: ${filePath}`);
        return;
      }

      // 调用更新函数
      const refreshSubscription = this.context.get('refreshSubscription');
      if (!refreshSubscription) {
        console.error('[SubscriptionScheduler] refreshSubscription 函数不可用');
        return;
      }

      const result = await refreshSubscription(filePath);

      if (result && result.success) {
        console.log(`[SubscriptionScheduler] 更新成功: ${subscription.name}`);

        // 发送通知给前端（可选）
        if (this.context.state?.mainWindow && !this.context.state.mainWindow.isDestroyed()) {
          this.context.state.mainWindow.webContents.send('subscription-auto-updated', {
            name: subscription.name,
            filePath: filePath
          });
        }
      } else {
        console.error(`[SubscriptionScheduler] 更新失败: ${subscription.name}`, result?.error);
      }

    } catch (error) {
      console.error(`[SubscriptionScheduler] 执行更新失败: ${filePath}`, error);
    }
  }

  /**
   * 生成任务ID
   */
  getTaskId(filePath) {
    return `subscription-updater-${filePath}`;
  }
}

module.exports = SubscriptionScheduler;
