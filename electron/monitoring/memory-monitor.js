'use strict';

/**
 * Memory monitor module
 * Periodically logs memory usage and triggers GC when heap exceeds threshold.
 */

/**
 * Create a memory monitor.
 * @param {object} deps
 * @param {object} deps.state - Shared application state
 * @param {Function} deps.formatTraffic - Byte formatting function
 */
function createMemoryMonitor({ state, formatTraffic }) {

  function startMemoryMonitor() {
    if (state.memoryMonitorInterval) clearInterval(state.memoryMonitorInterval);

    state.memoryMonitorInterval = setInterval(() => {
      const memoryUsage = process.memoryUsage();
      console.log(`内存使用: RSS ${formatTraffic(memoryUsage.rss)}, Heap ${formatTraffic(memoryUsage.heapUsed)}/${formatTraffic(memoryUsage.heapTotal)}`);

      // 如果堆内存使用超过阈值，建议进行垃圾回收
      if (memoryUsage.heapUsed > 300 * 1024 * 1024) { // 300MB
        try {
          if (global.gc) {
            global.gc();
            console.log('[调试] 手动触发垃圾回收');
          }
        } catch (e) {
          console.log('[调试] 无法手动触发垃圾回收，请使用 --expose-gc 启动参数');
        }
      }
    }, 60000); // 每分钟检查一次
  }

  return { startMemoryMonitor };
}

module.exports = { createMemoryMonitor };
