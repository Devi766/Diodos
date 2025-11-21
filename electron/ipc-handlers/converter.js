/**
 * 订阅转换器 IPC 处理器
 */

const { ipcMain, app } = require('electron');
const { SubscriptionConverter, ConversionOptions } = require('../converter/subscription-converter');
const { SubscriptionServer } = require('../converter/subscription-server');
const { OutputFormat } = require('../converter/proxy-models');
const TemplateManager = require('../converter/template-manager');
const ConfigGenerator = require('../converter/config-generator');
const path = require('path');
const fs = require('fs');
const { fetchWithOptions, DEFAULT_UA } = require('../converter/request-helper');

// 全局实例
let converter = null;
let server = null;

/**
 * 获取转换器实例
 */
function getConverter() {
  if (!converter) {
    converter = new SubscriptionConverter();
  }
  return converter;
}

/**
 * 读取设置
 */
function loadSettings(app) {
  try {
    const fs = require('fs');
    const settingsFile = path.join(app.getPath('userData'), 'converter-settings.json');

    if (fs.existsSync(settingsFile)) {
      const data = fs.readFileSync(settingsFile, 'utf-8');
      const parsed = JSON.parse(data);
      return {
        port: parsed.port || 59999,
        autoStart: parsed.autoStart || false,
        userAgent: parsed.userAgent || DEFAULT_UA
      };
    }
  } catch (e) {
    console.error('[Converter] Failed to load settings:', e);
  }

  return { port: 59999, autoStart: false, userAgent: DEFAULT_UA };
}

/**
 * 获取服务器实例
 */
function getServer(app) {
  if (!server) {
    const settings = loadSettings(app);
    const configDir = path.join(app.getPath('userData'), 'converter-subscriptions');
    server = new SubscriptionServer(settings.port, configDir, {
      userAgent: settings.userAgent
    });
  }
  return server;
}

/**
 * 注册 IPC 处理器
 */
function registerConverterHandlers(app, dbManager) {
  /**
   * 转换订阅内容
   */
  ipcMain.handle('converter:convert', async (event, params) => {
    try {
      const { input, targetFormat, filterRegex, options, processors } = params;

      console.log('[IPC] converter:convert - 原始输入长度:', input.length);
      console.log('[IPC] converter:convert - 原始输入预览:', input.substring(0, 200));

      const converter = getConverter();
      const conversionOptions = new ConversionOptions(options || {});

      const result = converter.convert(
        input,
        targetFormat,
        filterRegex,
        conversionOptions,
        null,
        processors
      );

      console.log('[IPC] converter:convert - 转换结果:', {
        success: result.success,
        inputProxyCount: result.inputProxyCount,
        outputProxyCount: result.outputProxyCount,
        errorMessage: result.errorMessage
      });

      return {
        success: result.success,
        output: result.output,
        inputProxyCount: result.inputProxyCount,
        outputProxyCount: result.outputProxyCount,
        errorMessage: result.errorMessage
      };
    } catch (error) {
      console.error('[IPC] converter:convert error:', error);
      return {
        success: false,
        output: '',
        inputProxyCount: 0,
        outputProxyCount: 0,
        errorMessage: error.message
      };
    }
  });

  /**
   * 从 URL 获取订阅内容
   */
  ipcMain.handle('converter:fetch-url', async (event, url) => {
    try {
      const settings = loadSettings(app);
      const { data } = await fetchWithOptions(url, { userAgent: settings.userAgent });
      const content = typeof data === 'string' ? data : JSON.stringify(data);
      return {
        success: true,
        content
      };
    } catch (error) {
      console.error('[IPC] converter:fetch-url error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  });

  /**
   * 启动订阅服务器
   */
  ipcMain.handle('converter:start-server', async (event) => {
    try {
      const srv = getServer(app);
      await srv.start();
      return {
        success: true,
        port: srv.port
      };
    } catch (error) {
      console.error('[IPC] converter:start-server error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  });

  /**
   * 停止订阅服务器
   */
  ipcMain.handle('converter:stop-server', async (event) => {
    try {
      if (server) {
        await server.stop();
      }
      return { success: true };
    } catch (error) {
      console.error('[IPC] converter:stop-server error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  });

  /**
   * 创建订阅
   */
  ipcMain.handle('converter:create-subscription', async (event, params) => {
    try {
      const srv = getServer(app);
      
      // 确保服务器已启动
      if (!srv.server || !srv.server.listening) {
        await srv.start();
      }

      const id = srv.createSubscription(params);
      const url = srv.getSubscriptionUrl(id);

      return {
        success: true,
        id,
        url
      };
    } catch (error) {
      console.error('[IPC] converter:create-subscription error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  });

  /**
   * 删除订阅
   */
  ipcMain.handle('converter:delete-subscription', async (event, id) => {
    try {
      const srv = getServer(app);
      const deleted = srv.deleteSubscription(id);
      
      return {
        success: deleted,
        error: deleted ? null : 'Subscription not found'
      };
    } catch (error) {
      console.error('[IPC] converter:delete-subscription error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  });

  /**
   * 获取所有订阅列表
   */
  ipcMain.handle('converter:list-subscriptions', async (event) => {
    try {
      const srv = getServer(app);
      
      const list = Array.from(srv.subscriptions.values()).map(sub => ({
        id: sub.id,
        name: sub.name,
        targetFormat: sub.targetFormat,
        lastUpdate: sub.lastUpdate,
        url: srv.getSubscriptionUrl(sub.id)
      }));

      return {
        success: true,
        subscriptions: list
      };
    } catch (error) {
      console.error('[IPC] converter:list-subscriptions error:', error);
      return {
        success: false,
        error: error.message,
        subscriptions: []
      };
    }
  });

  /**
   * 获取服务器状态
   */
  ipcMain.handle('converter:server-status', async (event) => {
    try {
      const srv = getServer(app);
      const isRunning = srv.server && srv.server.listening;
      
      return {
        success: true,
        isRunning,
        port: srv.port,
        subscriptionCount: srv.subscriptions.size
      };
    } catch (error) {
      console.error('[IPC] converter:server-status error:', error);
      return {
        success: false,
        isRunning: false,
        port: 0,
        subscriptionCount: 0
      };
    }
  });

  /**
   * 解析订阅内容并返回代理列表
   */
  ipcMain.handle('converter:parse-proxies', async (event, input) => {
    try {
      console.log(
        '[IPC] converter:parse-proxies - 原始输入长度:',
        input?.length ?? 0
      );
      console.log(
        '[IPC] converter:parse-proxies - 原始输入预览:',
        typeof input === 'string' ? input.substring(0, 200) : ''
      );

      const converter = getConverter();
      const proxies = converter.parseInput(input);

      console.log(
        '[IPC] converter:parse-proxies - 解析到代理数量:',
        proxies.length
      );
      
      return {
        success: true,
        proxies: proxies.map(proxy => ({
          name: proxy.name,
          type: proxy.type,
          server: proxy.server,
          port: proxy.port
        })),
        count: proxies.length
      };
    } catch (error) {
      console.error('[IPC] converter:parse-proxies error:', error);
      return {
        success: false,
        error: error.message,
        proxies: [],
        count: 0
      };
    }
  });

  // 获取所有模板
  ipcMain.handle('converter:get-templates', async () => {
    try {
      const templates = TemplateManager.getAllTemplates();
      return {
        success: true,
        templates: templates.map(t => ({
          id: t.id,
          name: t.name,
          description: t.description,
          category: t.category
        }))
      };
    } catch (error) {
      console.error('[IPC] converter:get-templates error:', error);
      return {
        success: false,
        templates: [],
        errorMessage: error.message
      };
    }
  });

  // 根据ID获取模板
  ipcMain.handle('converter:get-template', async (event, templateId) => {
    try {
      const template = TemplateManager.getTemplateById(templateId);
      if (!template) {
        return {
          success: false,
          errorMessage: '模板不存在'
        };
      }
      return {
        success: true,
        template: template
      };
    } catch (error) {
      console.error('[IPC] converter:get-template error:', error);
      return {
        success: false,
        errorMessage: error.message
      };
    }
  });

  // 使用模板转换
  ipcMain.handle('converter:convert-with-template', async (event, params) => {
    try {
      const { input, targetFormat, templateId, filterRegex, options } = params;

      console.log('[IPC] converter:convert-with-template - 原始输入长度:', input.length);
      console.log('[IPC] converter:convert-with-template - 模板ID:', templateId);
      console.log('[IPC] converter:convert-with-template - 目标格式:', targetFormat);
      console.log('[IPC] converter:convert-with-template - 转换选项:', options);

      // 解析代理节点
      const { ProxyParsers } = require('../converter/proxy-parser');
      const parser = new ProxyParsers();
      const proxies = parser.parseLines(input);

      console.log('[IPC] converter:convert-with-template - 解析到代理数量:', proxies.length);

      if (proxies.length === 0) {
        return {
          success: false,
          output: '',
          inputProxyCount: 0,
          outputProxyCount: 0,
          errorMessage: '未检测到有效的代理节点'
        };
      }

      // 应用过滤器
      let filteredProxies = proxies;
      if (filterRegex) {
        try {
          const regex = new RegExp(filterRegex, 'i');
          filteredProxies = proxies.filter(p => regex.test(p.name));
        } catch (e) {
          console.error('[IPC] 过滤正则表达式错误:', e);
        }
      }

      console.log('[IPC] converter:convert-with-template - 过滤后代理数量:', filteredProxies.length);

      // 应用转换选项
      if (options) {
        const { SubscriptionConverter, ConversionOptions } = require('../converter/subscription-converter');
        const converter = new SubscriptionConverter();
        const conversionOptions = new ConversionOptions(options);
        filteredProxies = converter.applyOptions(filteredProxies, conversionOptions);
        console.log('[IPC] converter:convert-with-template - 应用选项后代理数量:', filteredProxies.length);
      }

      // 获取模板
      const template = TemplateManager.getTemplateById(templateId);
      if (!template) {
        return {
          success: false,
          output: '',
          inputProxyCount: proxies.length,
          outputProxyCount: 0,
          errorMessage: '模板不存在'
        };
      }

      // 根据目标格式生成配置
      let output = '';
      switch (targetFormat) {
        case 'clash':
          output = ConfigGenerator.generateClashConfig(filteredProxies, template);
          break;
        case 'clash-meta':
          output = ConfigGenerator.generateClashMetaConfig(filteredProxies, template);
          break;
        case 'sing-box':
          output = ConfigGenerator.generateSingboxConfig(filteredProxies, template);
          break;
        case 'surge':
          output = ConfigGenerator.generateSurgeConfig(filteredProxies, template);
          break;
        case 'quantumult-x':
          output = ConfigGenerator.generateQuantumultXConfig(filteredProxies, template);
          break;
        case 'shadowrocket':
          output = ConfigGenerator.generateShadowrocketConfig(filteredProxies, template);
          break;
        default:
          return {
            success: false,
            output: '',
            inputProxyCount: proxies.length,
            outputProxyCount: 0,
            errorMessage: `不支持的目标格式: ${targetFormat}`
          };
      }

      console.log('[IPC] converter:convert-with-template - 生成配置长度:', output.length);

      return {
        success: true,
        output: output,
        inputProxyCount: proxies.length,
        outputProxyCount: filteredProxies.length,
        errorMessage: null
      };
    } catch (error) {
      console.error('[IPC] converter:convert-with-template error:', error);
      return {
        success: false,
        output: '',
        inputProxyCount: 0,
        outputProxyCount: 0,
        errorMessage: error.message
      };
    }
  });

  /**
   * 添加到配置列表
   */
  ipcMain.handle('converter:add-to-config', async (event, params) => {
    try {
      const { name, url } = params;

      console.log('[IPC] converter:add-to-config - 开始下载配置:', name, 'URL:', url);

      // 从URL下载配置文件
      const settings = loadSettings(app);
      const { data } = await fetchWithOptions(url, settings);
      const configData = typeof data === 'string' ? data : JSON.stringify(data);
      console.log('[IPC] converter:add-to-config - 配置下载成功,大小:', configData.length);

      // 保存为本地文件
      const configDir = path.join(app.getPath('userData'), 'configs');
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      // 生成文件名
      const timestamp = Date.now();
      const fileName = `${name.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, '_')}_${timestamp}.yaml`;
      const filePath = path.join(configDir, fileName);

      // 保存配置文件
      fs.writeFileSync(filePath, configData, 'utf8');
      console.log('[IPC] converter:add-to-config - 配置文件已保存:', filePath);

      // 添加到数据库(file_path和url都有值)
      const subscriptionId = dbManager.addSubscription(name, filePath, url);
      console.log('[IPC] converter:add-to-config - 配置已添加到数据库, ID:', subscriptionId);

      return {
        success: true,
        id: subscriptionId.toString(),
        filePath
      };
    } catch (error) {
      console.error('[IPC] converter:add-to-config error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  });

  /**
   * 获取转换器设置
   */
  ipcMain.handle('converter:get-settings', async (event) => {
    try {
      const settings = loadSettings(app);
      return {
        success: true,
        settings: settings
      };
    } catch (error) {
      console.error('[IPC] converter:get-settings error:', error);
      return {
        success: false,
        error: error.message,
        settings: { port: 59999, autoStart: false, userAgent: DEFAULT_UA }
      };
    }
  });

  /**
   * 保存转换器设置
   */
  ipcMain.handle('converter:save-settings', async (event, settings) => {
    try {
      const fs = require('fs');
      const settingsFile = path.join(app.getPath('userData'), 'converter-settings.json');

      // 读取旧设置
      const oldSettings = loadSettings(app);

      const normalized = {
        port: settings.port || 59999,
        autoStart: !!settings.autoStart,
        userAgent: settings.userAgent || DEFAULT_UA
      };

      // 保存新设置
      fs.writeFileSync(settingsFile, JSON.stringify(normalized, null, 2), 'utf-8');

      console.log('[IPC] converter:save-settings - 设置已保存:', normalized);

      const settingsChanged =
        oldSettings.port !== normalized.port ||
        oldSettings.autoStart !== normalized.autoStart ||
        oldSettings.userAgent !== normalized.userAgent;

      // 如果设置改变且服务器正在运行,需要重启服务器
      if (server && server.server && server.server.listening && settingsChanged) {
        console.log('[IPC] Settings changed, restarting converter server...');
        await server.stop();
        server = null; // 清除旧实例
        const newServer = getServer(app);
        await newServer.start();
      } else if (settingsChanged) {
        // 如果未运行但设置改变,清理实例以便下次启动使用新配置
        server = null;
      }

      return {
        success: true
      };
    } catch (error) {
      console.error('[IPC] converter:save-settings error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  });

  console.log('[IPC] Converter handlers registered');
}

/**
 * 从 URL 获取内容
 */
module.exports = {
  registerConverterHandlers,
  getServer
};

