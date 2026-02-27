const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');

class OverrideManager {
  constructor(context) {
    this.context = context;
    this.configDir = context.get('configDir');
    this.overridesDir = path.join(this.configDir, 'overrides');
    this.configFile = path.join(this.overridesDir, 'config.json');
    this.filesDir = path.join(this.overridesDir, 'files');

    console.log('[OverrideManager] 初始化');
    console.log('[OverrideManager] configDir:', this.configDir);
    console.log('[OverrideManager] overridesDir:', this.overridesDir);

    // 同步创建目录
    const fsSync = require('fs');
    if (!fsSync.existsSync(this.overridesDir)) {
      fsSync.mkdirSync(this.overridesDir, { recursive: true });
    }
    if (!fsSync.existsSync(this.filesDir)) {
      fsSync.mkdirSync(this.filesDir, { recursive: true });
    }
  }

  async ensureDirectories() {
    try {
      await fs.mkdir(this.overridesDir, { recursive: true });
      await fs.mkdir(this.filesDir, { recursive: true });
    } catch (error) {
      console.error('创建覆写目录失败:', error);
    }
  }

  async refreshRuntimeConfig() {
    try {
      const service = this.context?.mihomoService;

      // 使用重启 Mihomo 服务而不是热重载配置
      // 因为 Mihomo 的配置重载 API 有路径限制
      if (service && typeof service.restartMihomoService === 'function') {
        console.log('[refreshRuntimeConfig] 重启 Mihomo 服务以应用覆写变更');
        const result = service.restartMihomoService();
        if (result && typeof result.then === 'function') {
          await result;
        }
        console.log('[refreshRuntimeConfig] Mihomo 服务重启完成');
        return true;
      }

      console.warn('[refreshRuntimeConfig] 未找到 restartMihomoService 方法');
      return false;
    } catch (error) {
      console.error('刷新覆写后的配置失败:', error);
      return false;
    }
  }

  async loadConfig() {
    try {
      const data = await fs.readFile(this.configFile, 'utf-8');
      return JSON.parse(data);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { items: [] };
      }
      throw error;
    }
  }

  async saveConfig(config) {
    await fs.writeFile(this.configFile, JSON.stringify(config, null, 2), 'utf-8');
  }

  generateId() {
    return crypto.randomBytes(16).toString('hex');
  }

  async getItems() {
    const config = await this.loadConfig();
    return config.items || [];
  }

  async addItem(item) {
    const config = await this.loadConfig();
    const id = this.generateId();
    const now = new Date().toISOString();

    const newItem = {
      id,
      name: item.name || 'Untitled',
      type: item.type || 'local',
      ext: item.ext || 'yaml',
      enabled: item.enabled === true, // 默认禁用，除非明确指定为 true
      global: item.global || false,
      createdAt: now,
      updatedAt: now,
    };

    if (item.type === 'remote') {
      newItem.url = item.url;
    }

    if (item.type === 'local' && item.file) {
      const fileName = `${id}.${item.ext}`;
      const filePath = path.join(this.filesDir, fileName);
      await fs.writeFile(filePath, item.file, 'utf-8');
      newItem.fileName = fileName;
    }

    config.items = config.items || [];
    config.items.push(newItem);
    await this.saveConfig(config);

    // 只有在启用状态时才重启内核
    if (newItem.enabled) {
      try {
        await this.refreshRuntimeConfig();
      } catch (error) {
        console.error('新增覆写后刷新配置失败:', error);
      }
    }

    return newItem;
  }

  async updateItem(id, updates) {
    const config = await this.loadConfig();
    const index = config.items.findIndex(item => item.id === id);
    
    if (index === -1) {
      throw new Error('覆写项不存在');
    }

    const item = config.items[index];
    
    if (updates.name !== undefined) item.name = updates.name;
    if (updates.url !== undefined) item.url = updates.url;
    if (updates.enabled !== undefined) item.enabled = updates.enabled;
    if (updates.global !== undefined) item.global = updates.global;
    
    item.updatedAt = new Date().toISOString();
    
    config.items[index] = item;
    await this.saveConfig(config);

    try {
      await this.refreshRuntimeConfig();
    } catch (error) {
      console.error('更新覆写后刷新配置失败:', error);
    }

    return item;
  }

  async deleteItem(id) {
    const config = await this.loadConfig();
    const index = config.items.findIndex(item => item.id === id);
    
    if (index === -1) {
      throw new Error('覆写项不存在');
    }

    const item = config.items[index];
    
    if (item.type === 'local' && item.fileName) {
      const filePath = path.join(this.filesDir, item.fileName);
      try {
        await fs.unlink(filePath);
      } catch (error) {
        console.error('删除文件失败:', error);
      }
    }

    config.items.splice(index, 1);
    await this.saveConfig(config);

    try {
      await this.refreshRuntimeConfig();
    } catch (error) {
      console.error('删除覆写后刷新配置失败:', error);
    }
  }

  async getFileContent(id) {
    const config = await this.loadConfig();
    const item = config.items.find(item => item.id === id);
    
    if (!item) {
      throw new Error('覆写项不存在');
    }

    // If a local file exists (either local type or remotely-added but locally edited), read it
    if (item.fileName) {
      const filePath = path.join(this.filesDir, item.fileName);
      try {
        return await fs.readFile(filePath, 'utf-8');
      } catch {
        // Local file missing – fall through to remote fetch if applicable
      }
    }

    if (item.type === 'remote') {
      const fetchFn = await this.context.get('resolveFetchFn')();
      const response = await fetchFn(item.url);
      if (!response.ok) {
        throw new Error(`获取远程文件失败: ${response.statusText}`);
      }
      return await response.text();
    }

    return '';
  }

  async updateFileContent(id, content) {
    const config = await this.loadConfig();
    const item = config.items.find(item => item.id === id);
    
    if (!item) {
      throw new Error('覆写项不存在');
    }

    if (!item.fileName) {
      const fileName = `${id}.${item.ext}`;
      item.fileName = fileName;
    }

    const filePath = path.join(this.filesDir, item.fileName);
    await fs.writeFile(filePath, content, 'utf-8');
    
    item.updatedAt = new Date().toISOString();
    await this.saveConfig(config);

    if (item.enabled) {
      try {
        await this.refreshRuntimeConfig();
      } catch (error) {
        console.error('更新覆写内容后刷新配置失败:', error);
      }
    }
  }

  async updateRemoteItem(id) {
    const config = await this.loadConfig();
    const item = config.items.find(item => item.id === id);
    
    if (!item) {
      throw new Error('覆写项不存在');
    }

    if (item.type !== 'remote') {
      throw new Error('只能更新远程文件');
    }

    const fetchFn = await this.context.get('resolveFetchFn')();
    const response = await fetchFn(item.url);
    
    if (!response.ok) {
      throw new Error(`更新失败: ${response.statusText}`);
    }

    item.updatedAt = new Date().toISOString();
    await this.saveConfig(config);

    if (item.enabled) {
      try {
        await this.refreshRuntimeConfig();
      } catch (error) {
        console.error('更新远程覆写后刷新配置失败:', error);
      }
    }

    return item;
  }

  async reorderItems(itemIds) {
    const config = await this.loadConfig();
    const itemsMap = new Map(config.items.map(item => [item.id, item]));
    
    const seen = new Set();
    const newItems = [];
    for (const id of itemIds) {
      if (seen.has(id)) continue;
      const item = itemsMap.get(id);
      if (!item) continue;
      seen.add(id);
      newItems.push(item);
    }

    const providedIds = new Set(itemIds);
    const remaining = config.items.filter(item => !providedIds.has(item.id));
    config.items = [...newItems, ...remaining];
    await this.saveConfig(config);

    try {
      await this.refreshRuntimeConfig();
    } catch (error) {
      console.error('重排覆写后刷新配置失败:', error);
    }
  }
}

function registerOverrideHandlers(context) {
  console.log('[registerOverrideHandlers] 开始注册覆写处理器');
  const { ipcMain } = context;
  console.log('[registerOverrideHandlers] ipcMain:', !!ipcMain);
  const manager = new OverrideManager(context);
  console.log('[registerOverrideHandlers] OverrideManager已创建');

  context.set('resolveFetchFn', async () => {
    if (typeof globalThis.fetch === 'function') {
      return globalThis.fetch.bind(globalThis);
    }
    const { default: fetchFn } = await import('node-fetch');
    return fetchFn;
  });

  ipcMain.handle('override:getItems', async () => {
    try {
      return await manager.getItems();
    } catch (error) {
      console.error('获取覆写列表失败:', error);
      throw error;
    }
  });

  ipcMain.handle('override:addItem', async (event, item) => {
    try {
      return await manager.addItem(item);
    } catch (error) {
      console.error('添加覆写失败:', error);
      throw error;
    }
  });

  ipcMain.handle('override:updateItem', async (event, id, updates) => {
    try {
      return await manager.updateItem(id, updates);
    } catch (error) {
      console.error('更新覆写失败:', error);
      throw error;
    }
  });

  ipcMain.handle('override:deleteItem', async (event, id) => {
    try {
      await manager.deleteItem(id);
    } catch (error) {
      console.error('删除覆写失败:', error);
      throw error;
    }
  });

  ipcMain.handle('override:getFileContent', async (event, id) => {
    try {
      return await manager.getFileContent(id);
    } catch (error) {
      console.error('获取文件内容失败:', error);
      throw error;
    }
  });

  ipcMain.handle('override:updateFileContent', async (event, id, content) => {
    try {
      await manager.updateFileContent(id, content);
    } catch (error) {
      console.error('更新文件内容失败:', error);
      throw error;
    }
  });

  ipcMain.handle('override:updateRemoteItem', async (event, id) => {
    try {
      return await manager.updateRemoteItem(id);
    } catch (error) {
      console.error('更新远程文件失败:', error);
      throw error;
    }
  });

  ipcMain.handle('override:reorderItems', async (event, itemIds) => {
    try {
      await manager.reorderItems(itemIds);
    } catch (error) {
      console.error('重新排序失败:', error);
      throw error;
    }
  });
}

module.exports = {
  registerOverrideHandlers,
  applyOverrides: async (context, config, configFilePath) => {
    console.log('[applyOverrides导出函数] 被调用，参数:', { configFilePath, hasConfig: !!config });
    const manager = new OverrideManager(context);
    return await applyOverrides(manager, config, configFilePath);
  }
};

async function applyOverrides(manager, config, configFilePath) {
  console.log('=== 开始应用覆写 ===');
  console.log('配置文件路径:', configFilePath);
  console.log('原始配置proxies数量:', config.proxies ? config.proxies.length : 0);
  console.log('原始配置proxy-groups数量:', config['proxy-groups'] ? config['proxy-groups'].length : 0);
  console.log('[applyOverrides] 传入的config的proxy-groups前5个:',
    config['proxy-groups'] ? config['proxy-groups'].slice(0, 5).map(g => g.name) : []);

  try {
    const configData = await manager.loadConfig();
    const items = configData.items || [];

    console.log(`总共有 ${items.length} 个覆写项`);

    const enabledItems = items.filter(item => item.enabled);
    const itemMap = new Map(enabledItems.map(item => [item.id, item]));
    const globalQueue = enabledItems.filter(item => item.global).map(item => item.id);

    console.log(`找到 ${globalQueue.length} 个已启用的全局覆写:`, globalQueue.map(id => itemMap.get(id)?.name));

    const profileQueue = [];

    if (configFilePath) {
      console.log('[applyOverrides] 尝试获取dbManager');
      const dbManager = manager.context.get('dbManager');
      console.log('[applyOverrides] dbManager:', dbManager ? '已获取' : '未获取');

      if (dbManager) {
        try {
          console.log('[applyOverrides] 调用getSubscriptionOverrides，参数:', configFilePath);
          const overrideIds = dbManager.getSubscriptionOverrides(configFilePath);
          console.log(`[applyOverrides] 配置文件的覆写ID列表:`, overrideIds);

          if (overrideIds && Array.isArray(overrideIds) && overrideIds.length > 0) {
            console.log('[applyOverrides] 开始过滤配置文件特定覆写');
            for (const id of overrideIds) {
              if (!itemMap.has(id)) continue;
              profileQueue.push(id);
            }
            console.log(`[applyOverrides] 找到 ${profileQueue.length} 个配置文件特定覆写:`, profileQueue.map(id => itemMap.get(id)?.name));
          } else {
            console.log('[applyOverrides] 配置文件没有设置覆写或覆写列表为空');
          }
        } catch (error) {
          console.error('[applyOverrides] 获取配置文件的覆写设置失败:', error);
        }
      } else {
        console.log('[applyOverrides] dbManager不可用');
      }
    } else {
      console.log('[applyOverrides] 未提供配置文件路径');
    }

    const orderedIds = Array.from(new Set([...globalQueue, ...profileQueue])).filter(id => itemMap.has(id));
    const allOverrides = orderedIds.map(id => itemMap.get(id));

    if (allOverrides.length === 0) {
      console.log('没有需要应用的覆写');
      return config;
    }

    console.log(`准备应用 ${allOverrides.length} 个覆写:`, allOverrides.map(o => `${o.name}(${o.ext})`).join(', '));

    let resultConfig = config;

    for (const item of allOverrides) {
      try {
        console.log(`正在加载覆写文件内容: ${item.name}`);
        const content = await manager.getFileContent(item.id);
        console.log(`文件内容长度: ${content.length} 字符`);

        if (item.ext === 'js') {
          console.log(`执行JS覆写: ${item.name}`);
          resultConfig = runJSOverride(resultConfig, content, item);
          console.log(`JS覆写执行完成: ${item.name}`);
          console.log(`覆写后proxies数量:`, resultConfig.proxies ? resultConfig.proxies.length : 0);
          console.log(`覆写后proxy-groups数量:`, resultConfig['proxy-groups'] ? resultConfig['proxy-groups'].length : 0);
        } else if (item.ext === 'yaml') {
          console.log(`应用YAML覆写: ${item.name}`);
          resultConfig = applyYAMLOverride(resultConfig, content);
          console.log(`YAML覆写应用完成: ${item.name}`);
        }
      } catch (error) {
        console.error(`应用覆写失败 [${item.name}]:`, error);
      }
    }

    console.log('=== 覆写应用完成 ===');
    return resultConfig;
  } catch (error) {
    console.error('应用覆写失败:', error);
    return config;
  }
}

function runJSOverride(config, scriptContent, item) {
  const vm = require('vm');

  try {
    console.log(`[JS覆写 ${item.name}] 开始执行`);
    console.log(`[JS覆写 ${item.name}] 脚本内容前100字符:`, scriptContent.substring(0, 100));

    const sandbox = {
      console: {
        log: (...args) => console.log(`[覆写 ${item.name}]`, ...args),
        error: (...args) => console.error(`[覆写 ${item.name}]`, ...args),
        warn: (...args) => console.warn(`[覆写 ${item.name}]`, ...args),
      }
    };

    // 先运行覆写脚本，再执行 main 函数获取结果
    const code = `${scriptContent}\nmain(${JSON.stringify(config)})`;

    const context = vm.createContext(sandbox);
    const result = vm.runInContext(code, context, { timeout: 5000 });

    console.log(`[JS覆写 ${item.name}] 执行成功，返回结果类型:`, typeof result);

    // 检查是否有重复的proxy名称
    if (result && result.proxies && Array.isArray(result.proxies)) {
      const proxyNames = result.proxies.map(p => p.name);
      const duplicates = proxyNames.filter((name, index) => proxyNames.indexOf(name) !== index);
      if (duplicates.length > 0) {
        console.error(`[JS覆写 ${item.name}] 发现重复的proxy名称:`, [...new Set(duplicates)]);
      }
    }

    return result || config;
  } catch (error) {
    console.error(`执行JS覆写失败 [${item.name}]:`, error);
    return config;
  }
}

function applyYAMLOverride(config, yamlContent) {
  const yaml = require('js-yaml');

  try {
    console.log('[YAML覆写] 开始解析YAML内容');
    console.log('[YAML覆写] YAML内容前100字符:', yamlContent.substring(0, 100));

    const patch = yaml.load(yamlContent);

    console.log('[YAML覆写] 解析成功，patch类型:', typeof patch);
    console.log('[YAML覆写] patch键:', patch ? Object.keys(patch).join(', ') : 'null');

    if (typeof patch !== 'object' || patch === null) {
      console.log('[YAML覆写] patch不是有效对象，跳过');
      return config;
    }

    const result = mergeConfigs(config, patch);
    console.log('[YAML覆写] 合并完成');
    return result;
  } catch (error) {
    console.error('解析YAML覆写失败:', error);
    return config;
  }
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function unwrapKey(key) {
  if (key.startsWith('<') && key.endsWith('>')) {
    return key.slice(1, -1);
  }
  return key;
}

function mergeConfigs(target = {}, patch = {}) {
  const result = { ...target };

  for (const rawKey of Object.keys(patch)) {
    const value = patch[rawKey];

    if (isPlainObject(value)) {
      if (rawKey.endsWith('!')) {
        const key = unwrapKey(rawKey.slice(0, -1));
        result[key] = value;
        continue;
      }

      const key = unwrapKey(rawKey);
      const base = isPlainObject(result[key]) ? result[key] : {};
      result[key] = mergeConfigs(base, value);
      continue;
    }

    if (Array.isArray(value)) {
      if (rawKey.startsWith('+')) {
        const key = unwrapKey(rawKey.slice(1));
        const current = Array.isArray(result[key]) ? result[key] : [];
        result[key] = [...value, ...current];
        continue;
      }

      if (rawKey.endsWith('+')) {
        const key = unwrapKey(rawKey.slice(0, -1));
        const current = Array.isArray(result[key]) ? result[key] : [];
        result[key] = [...current, ...value];
        continue;
      }

      const key = unwrapKey(rawKey);
      result[key] = value;
      continue;
    }

    result[rawKey] = value;
  }

  return result;
}
