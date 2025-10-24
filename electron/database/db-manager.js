const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

class DatabaseManager {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
  }

  /**
   * 初始化数据库连接和表结构
   */
  initialize() {
    try {
      // 确保数据库目录存在
      const dbDir = path.dirname(this.dbPath);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }

      // 初始化 better-sqlite3
      this.db = new Database(this.dbPath);

      // 启用外键约束
      this.db.pragma('foreign_keys = ON');

      // 创建表
      this.createTables();

      console.log('[数据库] 初始化成功:', this.dbPath);
      return true;
    } catch (error) {
      console.error('[数据库] 初始化失败:', error);
      throw error;
    }
  }

  /**
   * 创建数据库表
   */
  createTables() {
    // 订阅表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        file_path TEXT NOT NULL UNIQUE,
        url TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        update_interval INTEGER DEFAULT 0
      )
    `);

    // 订阅流量信息表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS subscription_info (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subscription_id INTEGER NOT NULL,
        used_traffic INTEGER,
        total_traffic INTEGER,
        expiry_timestamp INTEGER,
        FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE
      )
    `);

    // 设置表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        type TEXT NOT NULL
      )
    `);

    // 流量历史表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS traffic_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL UNIQUE,
        upload INTEGER NOT NULL DEFAULT 0,
        download INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // 创建索引
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_subscriptions_file_path ON subscriptions(file_path)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_subscription_info_subscription_id ON subscription_info(subscription_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_traffic_history_date ON traffic_history(date)`);

    // 添加 overrides 列（兼容已有数据库）
    try {
      this.db.exec(`ALTER TABLE subscriptions ADD COLUMN overrides TEXT DEFAULT '[]'`);
    } catch (error) {
      if (!error.message.includes('duplicate column name')) {
        console.error('添加overrides列失败:', error);
      }
    }

    // 添加 update_interval 列（兼容已有数据库）
    try {
      this.db.exec(`ALTER TABLE subscriptions ADD COLUMN update_interval INTEGER DEFAULT 0`);
    } catch (error) {
      if (!error.message.includes('duplicate column name')) {
        console.error('添加update_interval列失败:', error);
      }
    }
  }

  /**
   * 关闭数据库连接
   */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
      console.log('[数据库] 连接已关闭');
    }
  }

  // ==================== 订阅管理 ====================

  /**
   * 添加订阅
   */
  addSubscription(name, filePath, url = null) {
    const now = Date.now();
    const stmt = this.db.prepare(
      `INSERT INTO subscriptions (name, file_path, url, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    );
    const info = stmt.run(name, filePath, url, now, now);
    return info.lastInsertRowid;
  }

  /**
   * 更新订阅
   */
  updateSubscription(id, updates) {
    const fields = [];
    const values = [];

    if (updates.name !== undefined) {
      fields.push('name = ?');
      values.push(updates.name);
    }
    if (updates.file_path !== undefined) {
      fields.push('file_path = ?');
      values.push(updates.file_path);
    }
    if (updates.url !== undefined) {
      fields.push('url = ?');
      values.push(updates.url);
    }

    fields.push('updated_at = ?');
    values.push(Date.now());

    values.push(id);

    const stmt = this.db.prepare(
      `UPDATE subscriptions SET ${fields.join(', ')} WHERE id = ?`
    );
    stmt.run(...values);
  }

  /**
   * 根据文件路径更新订阅
   */
  updateSubscriptionByPath(filePath, updates) {
    const fields = [];
    const values = [];

    if (updates.name !== undefined) {
      fields.push('name = ?');
      values.push(updates.name);
    }
    if (updates.url !== undefined) {
      fields.push('url = ?');
      values.push(updates.url);
    }

    fields.push('updated_at = ?');
    values.push(Date.now());

    values.push(filePath);

    const stmt = this.db.prepare(
      `UPDATE subscriptions SET ${fields.join(', ')} WHERE file_path = ?`
    );
    stmt.run(...values);
  }

  /**
   * 删除订阅
   */
  deleteSubscription(id) {
    const stmt = this.db.prepare('DELETE FROM subscriptions WHERE id = ?');
    return stmt.run(id);
  }

  /**
   * 根据文件路径删除订阅
   */
  deleteSubscriptionByPath(filePath) {
    const stmt = this.db.prepare('DELETE FROM subscriptions WHERE file_path = ?');
    return stmt.run(filePath);
  }

  /**
   * 获取所有订阅
   */
  getAllSubscriptions() {
    const stmt = this.db.prepare(`
      SELECT s.*, si.used_traffic, si.total_traffic, si.expiry_timestamp
      FROM subscriptions s
      LEFT JOIN subscription_info si ON s.id = si.subscription_id
      ORDER BY s.created_at DESC
    `);

    return stmt.all();
  }

  /**
   * 根据文件路径获取订阅
   */
  getSubscriptionByPath(filePath) {
    const stmt = this.db.prepare(`
      SELECT s.*, si.used_traffic, si.total_traffic, si.expiry_timestamp
      FROM subscriptions s
      LEFT JOIN subscription_info si ON s.id = si.subscription_id
      WHERE s.file_path = ?
    `);

    return stmt.get(filePath);
  }

  /**
   * 根据ID获取订阅
   */
  getSubscriptionById(id) {
    const stmt = this.db.prepare(`
      SELECT s.*, si.used_traffic, si.total_traffic, si.expiry_timestamp
      FROM subscriptions s
      LEFT JOIN subscription_info si ON s.id = si.subscription_id
      WHERE s.id = ?
    `);

    return stmt.get(id);
  }

  // ==================== 订阅信息管理 ====================

  /**
   * 设置订阅流量信息
   */
  setSubscriptionInfo(subscriptionId, usedTraffic, totalTraffic, expiryTimestamp) {
    // 先删除旧记录
    this.db.prepare('DELETE FROM subscription_info WHERE subscription_id = ?').run(subscriptionId);
    
    // 插入新记录
    const stmt = this.db.prepare(`
      INSERT INTO subscription_info (subscription_id, used_traffic, total_traffic, expiry_timestamp)
      VALUES (?, ?, ?, ?)
    `);
    
    return stmt.run(subscriptionId, usedTraffic, totalTraffic, expiryTimestamp);
  }

  /**
   * 根据文件路径设置订阅流量信息
   */
  setSubscriptionInfoByPath(filePath, usedTraffic, totalTraffic, expiryTimestamp) {
    const sub = this.getSubscriptionByPath(filePath);
    if (!sub) {
      throw new Error('订阅不存在');
    }
    
    return this.setSubscriptionInfo(sub.id, usedTraffic, totalTraffic, expiryTimestamp);
  }

  // ==================== 设置管理 ====================

  /**
   * 获取设置值
   */
  getSetting(key, defaultValue = null) {
    const stmt = this.db.prepare('SELECT value, type FROM settings WHERE key = ?');
    const row = stmt.get(key);
    
    if (!row) {
      return defaultValue;
    }
    
    return this.deserializeValue(row.value, row.type);
  }

  /**
   * 设置值
   */
  setSetting(key, value) {
    const { serialized, type } = this.serializeValue(value);
    
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO settings (key, value, type)
      VALUES (?, ?, ?)
    `);
    
    return stmt.run(key, serialized, type);
  }

  /**
   * 获取所有设置
   */
  getAllSettings() {
    const stmt = this.db.prepare('SELECT key, value, type FROM settings');
    const rows = stmt.all();

    const settings = {};
    for (const row of rows) {
      settings[row.key] = this.deserializeValue(row.value, row.type);
    }

    return settings;
  }

  /**
   * 删除设置
   */
  deleteSetting(key) {
    const stmt = this.db.prepare('DELETE FROM settings WHERE key = ?');
    return stmt.run(key);
  }

  // ==================== 辅助方法 ====================

  /**
   * 序列化值
   */
  serializeValue(value) {
    if (typeof value === 'string') {
      return { serialized: value, type: 'string' };
    } else if (typeof value === 'number') {
      return { serialized: String(value), type: 'number' };
    } else if (typeof value === 'boolean') {
      return { serialized: String(value), type: 'boolean' };
    } else {
      return { serialized: JSON.stringify(value), type: 'json' };
    }
  }

  /**
   * 获取订阅的覆写列表
   */
  getSubscriptionOverrides(filePath) {
    const stmt = this.db.prepare(`
      SELECT overrides FROM subscriptions WHERE file_path = ?
    `);
    const row = stmt.get(filePath);
    if (row && row.overrides) {
      try {
        return JSON.parse(row.overrides);
      } catch (error) {
        console.error('解析覆写列表失败:', error);
        return [];
      }
    }
    return [];
  }

  /**
   * 设置订阅的覆写列表
   */
  setSubscriptionOverrides(filePath, overrides) {
    const stmt = this.db.prepare(`
      UPDATE subscriptions SET overrides = ? WHERE file_path = ?
    `);
    stmt.run(JSON.stringify(overrides), filePath);
  }

  /**
   * 设置订阅更新间隔（分钟）
   */
  setSubscriptionUpdateInterval(filePath, intervalMinutes) {
    const stmt = this.db.prepare(`
      UPDATE subscriptions SET update_interval = ? WHERE file_path = ?
    `);
    stmt.run(intervalMinutes, filePath);
  }

  /**
   * 获取订阅更新间隔（分钟）
   */
  getSubscriptionUpdateInterval(filePath) {
    const stmt = this.db.prepare(`
      SELECT update_interval FROM subscriptions WHERE file_path = ?
    `);
    const row = stmt.get(filePath);
    return row ? row.update_interval : 0;
  }

  /**
   * 获取所有需要自动更新的订阅
   */
  getAutoUpdateSubscriptions() {
    const stmt = this.db.prepare(`
      SELECT * FROM subscriptions
      WHERE url IS NOT NULL AND update_interval > 0
      ORDER BY updated_at ASC
    `);
    return stmt.all();
  }

  /**
   * 反序列化值
   */
  deserializeValue(serialized, type) {
    switch (type) {
      case 'string':
        return serialized;
      case 'number':
        return Number(serialized);
      case 'boolean':
        return serialized === 'true';
      case 'json':
        return JSON.parse(serialized);
      default:
        return serialized;
    }
  }

  /**
   * 更新今日流量数据
   * @param {number} upload - 上传流量(字节)
   * @param {number} download - 下载流量(字节)
   */
  updateTodayTraffic(upload, download) {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const now = Date.now();

    const stmt = this.db.prepare(`
      INSERT INTO traffic_history (date, upload, download, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        upload = upload + excluded.upload,
        download = download + excluded.download,
        updated_at = excluded.updated_at
    `);

    stmt.run(today, upload, download, now, now);
  }

  /**
   * 获取指定日期的流量数据
   * @param {string} date - 日期 (YYYY-MM-DD)
   */
  getTrafficByDate(date) {
    const stmt = this.db.prepare(`
      SELECT * FROM traffic_history WHERE date = ?
    `);
    return stmt.get(date);
  }

  /**
   * 获取指定月份的流量数据
   * @param {string} yearMonth - 年月 (YYYY-MM)
   */
  getTrafficByMonth(yearMonth) {
    const stmt = this.db.prepare(`
      SELECT * FROM traffic_history
      WHERE date LIKE ?
      ORDER BY date ASC
    `);
    return stmt.all(`${yearMonth}%`);
  }

  /**
   * 获取指定年份的流量数据(按月汇总)
   * @param {string} year - 年份 (YYYY)
   */
  getTrafficByYear(year) {
    const stmt = this.db.prepare(`
      SELECT
        substr(date, 1, 7) as month,
        SUM(upload) as upload,
        SUM(download) as download
      FROM traffic_history
      WHERE date LIKE ?
      GROUP BY month
      ORDER BY month ASC
    `);
    return stmt.all(`${year}%`);
  }

  /**
   * 获取今日流量数据
   */
  getTodayTraffic() {
    const today = new Date().toISOString().split('T')[0];
    return this.getTrafficByDate(today) || { upload: 0, download: 0 };
  }

  /**
   * 获取本月流量数据
   */
  getThisMonthTraffic() {
    const yearMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
    return this.getTrafficByMonth(yearMonth);
  }

  /**
   * 获取本年流量数据
   */
  getThisYearTraffic() {
    const year = new Date().getFullYear().toString();
    return this.getTrafficByYear(year);
  }
}

module.exports = DatabaseManager;

