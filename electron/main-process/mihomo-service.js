module.exports = function initMihomoService(context) {
  const {
    app,
    fs,
    path,
    yaml,
    spawn,
    dialog,
    http,
    state,
    isDev,
    getUserSettings,
    userDataPath,
    dbManager
  } = context;

  const { applyOverrides } = require('../ipc-handlers/overrides');
  const { getMihomoSocketPath, getMihomoControllerArg, getMihomoControllerParam, cleanupSocketFile } = require('../utils/socket-path');
  console.log('[mihomo-service] applyOverrides函数已导入:', typeof applyOverrides);

  const fetchWithFallback = (...args) => {
    if (typeof fetch === 'function') {
      return fetch(...args);
    }
    return import('node-fetch').then(({ default: fetchFn }) => fetchFn(...args));
  };

  function findMihomoExecutable() {
    let binPath = null;

    const preferredPath = context.getKernelExecutablePath ? context.getKernelExecutablePath() : null;
    if (preferredPath && fs.existsSync(preferredPath)) {
      return preferredPath;
    }

    const resolvedDefault = context.resolveDefaultKernelPath ? context.resolveDefaultKernelPath() : null;
    if (resolvedDefault && fs.existsSync(resolvedDefault)) {
      return resolvedDefault;
    }

    const isWin = process.platform === 'win32';
    const isMac = process.platform === 'darwin';
    const isLinux = process.platform === 'linux';

    if (isDev) {
      const devDirPath = process.cwd();
      const coresDir = path.join(devDirPath, 'cores');

      try {
        if (fs.existsSync(coresDir)) {
          const files = fs.readdirSync(coresDir);

          // 根据平台过滤文件
          let mihomoFiles = files.filter((file) => {
            const lower = file.toLowerCase();
            if (!lower.includes('mihomo')) return false;

            if (isWin) return file.endsWith('.exe');
            if (isMac) return lower.includes('darwin');
            if (isLinux) return lower.includes('linux');
            return false;
          });

          // 进一步根据架构过滤
          if (mihomoFiles.length > 1) {
            const arch = process.arch;
            const archFiles = mihomoFiles.filter((file) => {
              const lower = file.toLowerCase();
              if (arch === 'x64' || arch === 'amd64') {
                return lower.includes('amd64') || lower.includes('x64');
              }
              if (arch === 'arm64') {
                return lower.includes('arm64');
              }
              if (arch === 'ia32' || arch === 'x86') {
                return lower.includes('386') || lower.includes('ia32') || lower.includes('x86');
              }
              return false;
            });

            if (archFiles.length > 0) {
              mihomoFiles = archFiles;
            }
          }

          if (mihomoFiles.length > 0) {
            binPath = path.join(coresDir, mihomoFiles[0]);
            console.log('开发环境找到mihomo内核:', binPath);
          }
        }
      } catch (error) {
        console.error('搜索开发环境内核文件失败:', error);
      }

      if (!binPath) {
        // 默认路径
        if (isWin) {
          binPath = path.join(coresDir, 'mihomo.exe');
        } else if (isMac) {
          const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
          binPath = path.join(coresDir, `mihomo-darwin-${arch}`);
        } else if (isLinux) {
          const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
          binPath = path.join(coresDir, `mihomo-linux-${arch}`);
        }
      }
    } else {
      const coresDir = path.join(process.resourcesPath, 'cores');

      try {
        if (fs.existsSync(coresDir)) {
          const files = fs.readdirSync(coresDir);

          // 根据平台过滤文件
          let mihomoFiles = files.filter((file) => {
            const lower = file.toLowerCase();
            if (!lower.includes('mihomo')) return false;

            if (isWin) return file.endsWith('.exe');
            if (isMac) return lower.includes('darwin');
            if (isLinux) return lower.includes('linux');
            return false;
          });

          // 进一步根据架构过滤
          if (mihomoFiles.length > 1) {
            const arch = process.arch;
            const archFiles = mihomoFiles.filter((file) => {
              const lower = file.toLowerCase();
              if (arch === 'x64' || arch === 'amd64') {
                return lower.includes('amd64') || lower.includes('x64');
              }
              if (arch === 'arm64') {
                return lower.includes('arm64');
              }
              if (arch === 'ia32' || arch === 'x86') {
                return lower.includes('386') || lower.includes('ia32') || lower.includes('x86');
              }
              return false;
            });

            if (archFiles.length > 0) {
              mihomoFiles = archFiles;
            }
          }

          if (mihomoFiles.length > 0) {
            binPath = path.join(coresDir, mihomoFiles[0]);
            console.log('发现mihomo内核:', binPath);
          }
        }
      } catch (error) {
        console.error('搜索内核文件失败:', error);
      }

      if (!binPath) {
        // 默认路径
        if (isWin) {
          binPath = path.join(process.resourcesPath, 'cores/mihomo.exe');
        } else if (isMac) {
          const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
          binPath = path.join(process.resourcesPath, `cores/mihomo-darwin-${arch}`);
        } else if (isLinux) {
          const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
          binPath = path.join(process.resourcesPath, `cores/mihomo-linux-${arch}`);
        }
      }
    }

    if (!binPath) {
      const fallbackResolved = context.resolveDefaultKernelPath ? context.resolveDefaultKernelPath() : null;
      if (fallbackResolved && fs.existsSync(fallbackResolved)) {
        binPath = fallbackResolved;
      }
    }

    return binPath;
  }

  async function ensureMihomoDataFiles() {
    try {
      const homeDir = process.env.USERPROFILE || process.env.HOME;
      const mihomoConfigDir = path.join(homeDir, '.config', 'mihomo');

      console.log(`检查mihomo配置目录: ${mihomoConfigDir}`);

      if (!fs.existsSync(mihomoConfigDir)) {
        console.log(`创建mihomo配置目录: ${mihomoConfigDir}`);
        fs.mkdirSync(mihomoConfigDir, { recursive: true });
      }

      let dataSourceDir;
      if (isDev) {
        dataSourceDir = path.join(process.cwd(), 'tools', 'data');
        console.log(`开发环境数据源目录: ${dataSourceDir}`);
      } else {
        dataSourceDir = path.join(process.resourcesPath, 'tools', 'data');
        console.log(`生产环境数据源目录: ${dataSourceDir}`);
      }

      if (!fs.existsSync(dataSourceDir)) {
        console.warn(`数据源目录不存在: ${dataSourceDir}`);
        if (isDev) {
          dataSourceDir = path.join(process.cwd(), 'flycast-ui', 'tools', 'data');
        } else {
          dataSourceDir = path.join(app.getAppPath(), 'tools', 'data');
        }
        console.log(`尝试备用数据源目录: ${dataSourceDir}`);

        if (!fs.existsSync(dataSourceDir)) {
          console.error(`备用数据源目录也不存在: ${dataSourceDir}`);
          return;
        }
      }

      console.log(`从 ${dataSourceDir} 复制数据文件到 ${mihomoConfigDir}`);

      const dataFiles = ['geoip.metadb', 'geosite.dat', 'country.mmdb', 'geoip.dat', 'ASN.mmdb'];

      for (const fileName of dataFiles) {
        const sourceFile = path.join(dataSourceDir, fileName);
        const targetFile = path.join(mihomoConfigDir, fileName);

        if (!fs.existsSync(sourceFile)) {
          console.warn(`源文件不存在: ${sourceFile}`);
          continue;
        }

        if (!fs.existsSync(targetFile)) {
          console.log(
            `复制文件: ${fileName} (${(fs.statSync(sourceFile).size / 1024 / 1024).toFixed(2)} MB)`
          );
          fs.copyFileSync(sourceFile, targetFile);
          console.log(`文件复制成功: ${targetFile}`);
        } else {
          console.log(`目标文件已存在，跳过: ${targetFile}`);
        }
      }

      console.log('mihomo数据文件检查和复制完成');
    } catch (error) {
      console.error('准备mihomo数据文件时出错:', error);
      throw error;
    }
  }

  function getSubscriptionList(configDirParam) {
    const resolvedConfigDir = configDirParam || context.get('configDir');
    return new Promise((resolve) => {
      if (!resolvedConfigDir || !fs.existsSync(resolvedConfigDir)) {
        resolve([]);
        return;
      }

      const subscriptions = fs
        .readdirSync(resolvedConfigDir)
        .filter((file) => file.endsWith('.yaml'))
        .map((file) => ({
          name: file.replace('.yaml', ''),
          path: path.join(resolvedConfigDir, file)
        }));

      resolve(subscriptions);
    });
  }

  function parseConfigFile(filePath) {
    try {
      const fileContent = fs.readFileSync(filePath, 'utf8');
      const config = yaml.load(fileContent);
      if (!config) {
        return null;
      }

      const proxyGroups = [];

      if (config['proxy-groups'] && Array.isArray(config['proxy-groups'])) {
        for (const group of config['proxy-groups']) {
          if (
            group.name &&
            (group.type === 'select' || group.type === 'url-test' || group.type === 'fallback')
          ) {
            proxyGroups.push({
              name: group.name,
              type: group.type,
              proxies: group.proxies || []
            });
          }
        }
      }

      const proxies = [];
      if (config.proxies && Array.isArray(config.proxies)) {
        for (const proxy of config.proxies) {
          if (proxy.name) {
            proxies.push({
              name: proxy.name,
              type: proxy.type,
              server: proxy.server || '',
              port: proxy.port || 0
            });
          }
        }
      }

      const apiConfig = {
        'external-controller': '0.0.0.0:9090',
        secret: ''
      };

      apiConfig.controllerHost = '127.0.0.1';
      apiConfig.controllerPort = '9090';

      return {
        proxyGroups,
        proxies,
        apiConfig
      };
    } catch (error) {
      console.error('解析配置文件失败:', error);
      return null;
    }
  }

  function isObject(item) {
    return item && typeof item === 'object' && !Array.isArray(item);
  }

  function deepMergeConfig(target, source) {
    if (!isObject(target) || !isObject(source)) {
      return source;
    }

    const result = { ...target };

    for (const key in source) {
      const mustOverrideFields = ['mixed-port', 'allow-lan', 'ipv6', 'log-level'];

      // external-controller 和 secret 特殊处理:
      // - 如果用户设置中有值(非空字符串),则覆盖
      // - 如果用户设置中是空字符串或 undefined,则删除该字段(不启动外部控制器)
      if (key === 'external-controller' || key === 'secret') {
        if (source[key] && source[key] !== '') {
          result[key] = source[key];
        } else {
          // 删除该字段,不启动外部控制器
          delete result[key];
        }
      } else if (mustOverrideFields.includes(key)) {
        result[key] = source[key];
      } else if (isObject(source[key])) {
        if (key in result) {
          result[key] = deepMergeConfig(result[key], source[key]);
        } else {
          result[key] = source[key];
        }
      } else if (Array.isArray(source[key])) {
        const preserveArrayFields = ['proxies', 'proxy-groups', 'rules'];
        if (preserveArrayFields.includes(key) && Array.isArray(result[key])) {
          // keep original
        } else {
          result[key] = source[key];
        }
      } else {
        result[key] = source[key];
      }
    }

    return result;
  }

  function validateMergedConfig(config) {
    const validatedConfig = { ...config };

    if (
      !validatedConfig['mixed-port'] ||
      typeof validatedConfig['mixed-port'] !== 'number' ||
      validatedConfig['mixed-port'] < 1 ||
      validatedConfig['mixed-port'] > 65535
    ) {
      validatedConfig['mixed-port'] = 7890;
      console.log('端口号无效，使用默认端口7890');
    }

    const booleanFields = ['allow-lan', 'ipv6'];
    for (const field of booleanFields) {
      if (field in validatedConfig && typeof validatedConfig[field] !== 'boolean') {
        validatedConfig[field] = Boolean(validatedConfig[field]);
        console.log(`将字段 ${field} 转换为布尔值: ${validatedConfig[field]}`);
      }
    }

    if (typeof validatedConfig.tun === 'boolean') {
      validatedConfig.tun = validatedConfig.tun
        ? {
            enable: true,
            stack: 'system',
            'auto-route': true,
            'auto-detect-interface': true,
            'dns-hijack': ['any:53']
          }
        : { enable: false };
      console.log('将布尔类型的tun字段转换为对象配置');
    } else if (!validatedConfig.tun || typeof validatedConfig.tun !== 'object') {
      validatedConfig.tun = { enable: false };
    }

    // 不再强制设置 external-controller 和 secret
    // 使用用户设置或配置文件中的值

    // 不再强制要求 proxies 和 proxy-groups 必须存在
    // Mihomo 内核会自行验证配置文件的有效性
    // 如果配置无效,内核启动时会报错

    return validatedConfig;
  }

  function reloadMihomoConfig(configPath) {
    try {
      if (!configPath || !fs.existsSync(configPath)) {
        console.error('配置文件路径无效，无法重新加载配置');
        return false;
      }

      if (!state.mihomoProcess || !state.mihomoProcess.pid) {
        console.error('Mihomo进程不在运行状态，无法重新加载配置');
        return false;
      }

      const port = 9090;
      try {
        const testReq = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/version',
            method: 'GET',
            timeout: 1000
          },
          (res) => {
            if (res.statusCode !== 200) {
              console.warn(`版本API返回非200状态码: ${res.statusCode}`);
            }
            sendReloadRequest(configPath, port);
          }
        );

        testReq.on('error', (err) => {
          console.error('测试Mihomo API连接失败:', err);
        });

        testReq.on('timeout', () => {
          testReq.destroy();
          console.error('测试Mihomo API连接超时');
        });

        testReq.end();
        return true;
      } catch (error) {
        console.error('尝试连接Mihomo API时出错:', error);
        return false;
      }
    } catch (error) {
      console.error('配置热重载失败:', error);
      return false;
    }
  }

  function sendReloadRequest(configPath, port) {
    try {
      // Mihomo API 要求使用绝对路径
      const mihomoDir = path.join(userDataPath, 'mihomo');
      let absolutePath = configPath;

      // 如果不是绝对路径，转换为绝对路径
      if (!path.isAbsolute(configPath)) {
        // 相对于 mihomoDir 的相对路径，转换为绝对路径
        absolutePath = path.join(mihomoDir, configPath);
        console.log(`[sendReloadRequest] 将相对路径 ${configPath} 转换为绝对路径: ${absolutePath}`);
      } else {
        // 已经是绝对路径，检查文件是否在 mihomoDir 内
        const normalizedConfigPath = path.normalize(configPath);
        const normalizedMihomoDir = path.normalize(mihomoDir);

        if (!normalizedConfigPath.startsWith(normalizedMihomoDir)) {
          console.error(`[sendReloadRequest] 配置文件不在 mihomo 工作目录内: ${configPath}`);
          console.error(`[sendReloadRequest] mihomo 工作目录: ${mihomoDir}`);
          return false;
        }
        console.log(`[sendReloadRequest] 使用绝对路径重载配置: ${absolutePath}`);
      }

      const configData = JSON.stringify({ path: absolutePath });
      const options = {
        path: '/configs',
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(configData)
        },
        timeout: 5000,
        hostname: '127.0.0.1',
        port
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode === 200 || res.statusCode === 204) {
            console.log('配置重载成功:', data);
          } else {
            console.error(`配置重载失败，状态码: ${res.statusCode}，响应: ${data}`);
          }
        });
      });

      req.on('error', (err) => {
        console.error('配置重载请求失败:', err);
      });

      req.on('timeout', () => {
        req.destroy();
        console.error('配置重载请求超时');
      });

      req.write(configData);
      req.end();

      console.log('已请求Mihomo重新加载配置（绝对路径）:', absolutePath);
      return true;
    } catch (error) {
      console.error('发送配置重载请求失败:', error);
      return false;
    }
  }

  async function regenerateAndReloadConfig() {
    console.log('[regenerateAndReloadConfig] ========== 函数被调用 ==========');
    console.log('[regenerateAndReloadConfig] state.configFilePath:', state.configFilePath);

    try {
      if (!state.configFilePath || !fs.existsSync(state.configFilePath)) {
        console.error('原始配置文件不可用，无法重新生成配置');
        return false;
      }

      const configContent = fs.readFileSync(state.configFilePath, 'utf8');
      let config;
      try {
        config = yaml.load(configContent);
        if (!config || typeof config !== 'object') {
          throw new Error('原始配置格式无效');
        }
      } catch (parseError) {
        console.error('解析原始配置文件失败:', parseError);
        return false;
      }

      const userSettings = getUserSettings();
      const mihomoDir = path.join(userDataPath, 'mihomo');
      if (!fs.existsSync(mihomoDir)) {
        try {
          fs.mkdirSync(mihomoDir, { recursive: true });
        } catch (dirError) {
          console.error('创建工作目录失败:', dirError);
          return false;
        }
      }

      const configFilename = path.basename(state.configFilePath);
      const overrideConfigFilename = 'override-' + configFilename;
      const overrideConfigPath = path.join(mihomoDir, overrideConfigFilename);

      try {
        // 先应用覆写到原始配置
        console.log('[regenerateAndReloadConfig] 准备应用覆写');
        console.log('[regenerateAndReloadConfig] applyOverrides类型:', typeof applyOverrides);
        console.log('[regenerateAndReloadConfig] state.configFilePath:', state.configFilePath);

        let configWithOverrides = config;
        if (applyOverrides && typeof applyOverrides === 'function') {
          try {
            console.log('[regenerateAndReloadConfig] 调用applyOverrides...');
            const maybePromise = applyOverrides(context, config, state.configFilePath);
            if (maybePromise && typeof maybePromise.then === 'function') {
              console.log('[regenerateAndReloadConfig] applyOverrides返回Promise，等待...');
              configWithOverrides = await maybePromise;
              console.log('[regenerateAndReloadConfig] applyOverrides完成');
            } else {
              console.log('[regenerateAndReloadConfig] applyOverrides返回同步结果');
              configWithOverrides = maybePromise;
            }
          } catch (overrideError) {
            console.error('应用配置覆盖失败:', overrideError);
            return false;
          }
        } else {
          console.log('[regenerateAndReloadConfig] applyOverrides不可用或不是函数');
        }

        // 然后应用用户设置(优先级最高)
        let mergedConfig = deepMergeConfig(configWithOverrides, userSettings);

        const validatedConfig = validateMergedConfig(mergedConfig);
        validatedConfig['external-controller'] = '0.0.0.0:9090';
        validatedConfig['secret'] = '';
        const mergedConfigContent = yaml.dump(validatedConfig, {
          lineWidth: -1,
          noRefs: true,
          sortKeys: false
        });

        try {
          fs.writeFileSync(overrideConfigPath, mergedConfigContent, 'utf8');
          console.log(`已重新生成配置文件: ${overrideConfigPath}`);
        } catch (writeError) {
          console.error('保存生成的配置文件失败:', writeError);
          return false;
        }

        if (!state.mihomoProcess || !state.mihomoProcess.pid) {
          console.warn('Mihomo进程不在运行状态，无法热重载');
          return false;
        }

        return reloadMihomoConfig(overrideConfigPath);
      } catch (error) {
        console.error('合并配置失败:', error);
        return false;
      }
    } catch (error) {
      console.error('重新生成配置失败:', error);
      return false;
    }
  }

  async function startMihomo(configPath) {
    try {
      if (!fs.existsSync(configPath)) {
        throw new Error(`配置文件不存在: ${configPath}`);
      }

      const configData = parseConfigFile(configPath);
      if (configData) {
        console.log('已解析配置文件，包含代理组：', configData.proxyGroups.length);
        console.log('已解析配置文件，包含代理节点：', configData.proxies.length);
      }

      // 清理旧的 socket 文件
      await cleanupSocketFile();

      // 获取 socket 路径
      const socketPath = getMihomoSocketPath();
      console.log('[Socket] 使用 socket 路径:', socketPath);

      // 设置 API 配置为 socket 模式
      state.activeApiConfig = {
        socketPath: socketPath,
        controllerHost: null,  // socket 模式不使用 HTTP
        controllerPort: null,
        secret: ''  // socket 模式不需要密钥
      };
      console.log('已设置API配置为 socket 模式:', state.activeApiConfig);

      if (state.mihomoProcess) {
        state.mihomoProcess.kill();
      }

      state.configFilePath = configPath;

      try {
        await ensureMihomoDataFiles();
      } catch (error) {
        console.error('准备mihomo数据文件失败，但将继续尝试启动:', error);
      }

      const binPath = findMihomoExecutable();

      if (!fs.existsSync(binPath)) {
        console.error('未找到有效的内核文件:', binPath);
        dialog.showErrorBox('错误', '无法找到有效的内核文件，请确保应用安装正确');
        return false;
      }

      console.log('使用内核文件:', binPath);

      // 在 Unix 系统上确保内核文件有执行权限
      if (process.platform !== 'win32') {
        try {
          fs.chmodSync(binPath, 0o755);
          console.log('[startMihomo] 已设置内核文件执行权限:', binPath);
        } catch (error) {
          console.error('[startMihomo] 设置执行权限失败:', error);
          // 继续尝试启动,可能已经有权限了
        }
      }

      const mihomoDir = path.join(userDataPath, 'mihomo');
      if (!fs.existsSync(mihomoDir)) {
        fs.mkdirSync(mihomoDir, { recursive: true });
      }

      try {
        const testFile = path.join(mihomoDir, 'test_write_permission.txt');
        fs.writeFileSync(testFile, 'test');
        fs.unlinkSync(testFile);
        console.log('工作目录写权限正常');
      } catch (error) {
        console.error('工作目录写权限不足:', error);
        dialog.showErrorBox('权限错误', `Mihomo工作目录没有写权限: ${error.message}`);
        return false;
      }

      const userSettings = getUserSettings();
      console.log('已读取用户设置:', userSettings);
      console.log('[调试] userSettings["external-controller"]:', userSettings['external-controller']);
      console.log('[调试] userSettings["external-controller"] 类型:', typeof userSettings['external-controller']);

      const configFilename = path.basename(configPath);
      const configContent = fs.readFileSync(configPath, 'utf8');
      const config = yaml.load(configContent);

      console.log('[startMihomo] 原始配置proxy-groups前3个:',
        config['proxy-groups'] ? config['proxy-groups'].slice(0, 3).map(g => g.name) : []);

      const overrideConfigFilename = 'override-' + configFilename;
      const overrideConfigPath = path.join(mihomoDir, overrideConfigFilename);

      let mergedConfig;
      let mergedConfigContent;

      try {
        // 先应用覆写到原始配置
        console.log('[startMihomo] 准备应用覆写');
        console.log('[startMihomo] applyOverrides类型:', typeof applyOverrides);
        console.log('[startMihomo] configPath:', configPath);

        let configWithOverrides = await applyOverrides(context, config, configPath);

        console.log('[startMihomo] 覆写应用完成');
        console.log('[startMihomo] 覆写后proxy-groups前3个:',
          configWithOverrides['proxy-groups'] ? configWithOverrides['proxy-groups'].slice(0, 3).map(g => g.name) : []);

        // 然后应用用户设置(优先级最高)
        console.log('[调试] deepMerge 前 configWithOverrides["external-controller"]:', configWithOverrides['external-controller']);
        console.log('[调试] deepMerge 前 userSettings["external-controller"]:', userSettings['external-controller']);
        mergedConfig = deepMergeConfig(configWithOverrides, userSettings);
        console.log('[调试] deepMerge 后 mergedConfig["external-controller"]:', mergedConfig['external-controller']);
        console.log('[startMihomo] 应用用户设置后proxy-groups前3个:',
          mergedConfig['proxy-groups'] ? mergedConfig['proxy-groups'].slice(0, 3).map(g => g.name) : []);

        mergedConfig = validateMergedConfig(mergedConfig);
        console.log('[startMihomo] validate后proxy-groups前3个:',
          mergedConfig['proxy-groups'] ? mergedConfig['proxy-groups'].slice(0, 3).map(g => g.name) : []);

        // 不再强制设置 external-controller,使用用户设置或留空
        // 现在使用 Socket 通信,不需要 HTTP 外部控制器
        if (mergedConfig['external-controller']) {
          console.log('[startMihomo] 使用用户设置的 external-controller:', mergedConfig['external-controller']);
        } else {
          console.log('[startMihomo] 未设置 external-controller,不启动 HTTP API');
        }

        mergedConfigContent = yaml.dump(mergedConfig, {
          lineWidth: -1,
          noRefs: true,
          sortKeys: false
        });
      } catch (error) {
        console.error('配置合并失败:', error);

        const safeConfig = {
          ...config,
          'mixed-port': userSettings['mixed-port'] || 7890,
          'allow-lan': !!userSettings['allow-lan'],
          'ipv6': !!userSettings['ipv6'],
          'log-level': userSettings['log-level'] || 'info'
          // 不再强制设置 external-controller
        };

        mergedConfig = safeConfig;
        mergedConfigContent = yaml.dump(safeConfig, {
          lineWidth: -1,
          noRefs: true,
          sortKeys: false
        });
        console.log('使用安全的回退配置');
      }

      fs.writeFileSync(overrideConfigPath, mergedConfigContent, 'utf8');
      console.log(`已创建高优先级配置文件: ${overrideConfigPath}`);

      console.log(`启动Mihomo: ${binPath} -f ${overrideConfigPath}`);
      console.log(`工作目录: ${mihomoDir}`);

      // 不再在启动前检查 proxies 和 proxy-groups
      // Mihomo 内核会自行验证配置文件的有效性
      // 如果配置无效,内核启动时会报错

      // 使用 -ext-ctl-pipe (Windows) 或 -ext-ctl-unix (Unix) 参数指定 Socket 路径
      const controllerParam = getMihomoControllerParam();
      const controllerArg = getMihomoControllerArg();
      console.log('[Socket] Mihomo 启动参数:', controllerParam, controllerArg);

      state.mihomoProcess = spawn(binPath, [
        '-d', mihomoDir,
        '-f', overrideConfigPath,
        controllerParam, controllerArg  // 使用 socket 而不是 HTTP 端口
      ], {
        cwd: mihomoDir,
        env: {
          ...process.env,
          MIHOMO_HOME_DIR: mihomoDir, // 设置 Mihomo 的 HOME 目录
          MIHOMO_CORE_PATH: mihomoDir
        },
        windowsHide: false,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      // 收集 stdout 和 stderr 输出用于错误提示
      let stdoutOutput = '';
      let stderrOutput = '';
      let fatalErrorDetected = false;

      state.mihomoProcess.stdout.on('data', (data) => {
        const logContent = data.toString();
        stdoutOutput += logContent;  // 收集 stdout 输出
        console.log(`mihomo stdout: ${logContent}`);

        // 检测 fatal 错误
        if (!fatalErrorDetected && logContent.includes('level=fatal')) {
          fatalErrorDetected = true;
          const fatalMatch = logContent.match(/level=fatal msg="([^"]+)"/);
          if (fatalMatch) {
            const errorMessage = `内核启动失败\n\n错误详情:\n${fatalMatch[1]}`;
            console.error(`[startMihomo] 检测到 fatal 错误: ${fatalMatch[1]}`);

            // 立即发送错误信息到前端
            if (state.mainWindow) {
              state.mainWindow.webContents.send('mihomo-start-failed', {
                error: errorMessage
              });
            }
          }
        }

        if (state.mainWindow) {
          state.mainWindow.webContents.send('mihomo-log', logContent);
        }

        process.stdout.write(data);
      });

      state.mihomoProcess.stderr.on('data', (data) => {
        const errorText = data.toString();
        stderrOutput += errorText;  // 收集 stderr 输出
        console.error(`mihomo stderr: ${errorText}`);
        if (state.mainWindow) {
          state.mainWindow.webContents.send('mihomo-error', errorText);
        }
        process.stderr.write(data);
      });

      state.mihomoProcess.on('close', (code) => {
        console.log(`mihomo process exited with code ${code}`);
        if (typeof context.handleMihomoProcessExit === 'function') {
          context.handleMihomoProcessExit(code);
        }
      });

      // 等待内核完全启动并验证 API 可访问
      console.log('[startMihomo] 等待内核启动...');
      const maxRetries = 30;
      const retryInterval = 500;
      let coreReady = false;

      // 在 Unix 系统上，先等待 socket 文件被创建
      if (process.platform !== 'win32') {
        console.log('[startMihomo] 等待 socket 文件创建:', socketPath);
        for (let i = 0; i < 20; i++) {
          if (fs.existsSync(socketPath)) {
            console.log(`[startMihomo] Socket 文件已创建,耗时: ${(i + 1) * 100}ms`);
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 100));
          if (i === 19) {
            console.warn('[startMihomo] Socket 文件未在预期时间内创建');
          }
        }
      }

      for (let i = 0; i < maxRetries; i++) {
        // 首先检查进程是否已退出
        if (state.mihomoProcess && state.mihomoProcess.exitCode !== null) {
          console.error(`Mihomo在启动过程中退出，退出代码: ${state.mihomoProcess.exitCode}`);

          // 构建详细的错误信息
          let errorMessage = `内核启动失败，退出代码: ${state.mihomoProcess.exitCode}`;

          // 从 stdout 中提取 fatal 错误信息
          const fatalMatch = stdoutOutput.match(/level=fatal msg="([^"]+)"/);
          if (fatalMatch) {
            errorMessage += `\n\n错误详情:\n${fatalMatch[1]}`;
          } else if (stderrOutput.trim()) {
            errorMessage += `\n\n错误详情:\n${stderrOutput.trim()}`;
          } else if (stdoutOutput.trim()) {
            // 如果没有 fatal 信息,显示最后几行 stdout
            const lines = stdoutOutput.trim().split('\n');
            const lastLines = lines.slice(-5).join('\n');
            errorMessage += `\n\n最后的输出:\n${lastLines}`;
          }

          // 发送错误信息到前端,使用 Toast 显示
          if (state.mainWindow) {
            state.mainWindow.webContents.send('mihomo-start-failed', {
              error: errorMessage,
              exitCode: state.mihomoProcess.exitCode
            });
          }

          return { success: false, error: errorMessage };
        }

        // 尝试连接内核 API
        try {
          const axios = await context.getAxiosInstance(true);
          await axios.get('/');
          console.log(`[startMihomo] 内核已就绪,尝试次数: ${i + 1},耗时: ${(i + 1) * retryInterval}ms`);
          coreReady = true;
          break;
        } catch (error) {
          if (i === 0) {
            console.log('[startMihomo] 等待内核 API 就绪...');
          }

          if (i === maxRetries - 1) {
            console.warn(`[startMihomo] 内核 API 在 ${maxRetries} 次尝试后仍未就绪`);

            // 构建详细的错误信息
            let errorMessage = `内核启动超时: 无法连接到内核 API (尝试了 ${maxRetries} 次,共 ${(maxRetries * retryInterval) / 1000} 秒)`;

            // 从 stdout 中提取 fatal 错误信息
            const fatalMatch = stdoutOutput.match(/level=fatal msg="([^"]+)"/);
            if (fatalMatch) {
              errorMessage += `\n\n错误详情:\n${fatalMatch[1]}`;
            } else if (stderrOutput.trim()) {
              errorMessage += `\n\n内核错误输出:\n${stderrOutput.trim()}`;
            } else if (stdoutOutput.trim()) {
              // 如果没有 fatal 信息,显示最后几行 stdout
              const lines = stdoutOutput.trim().split('\n');
              const lastLines = lines.slice(-5).join('\n');
              errorMessage += `\n\n最后的输出:\n${lastLines}`;
            } else {
              errorMessage += `\n\n可能原因:\n- 内核未成功创建 Socket/Named Pipe\n- 配置文件有误\n- 端口被占用`;
            }

            // 发送错误信息到前端
            if (state.mainWindow) {
              state.mainWindow.webContents.send('mihomo-start-failed', {
                error: errorMessage
              });
            }

            // 停止内核进程
            if (state.mihomoProcess) {
              state.mihomoProcess.kill();
              state.mihomoProcess = null;
            }

            return { success: false, error: errorMessage };
          }

          await new Promise((resolve) => setTimeout(resolve, retryInterval));
        }
      }

      if (!coreReady) {
        const errorMessage = '内核启动失败: 未知错误';
        return { success: false, error: errorMessage };
      }

      try {
        const lastConfigPath = path.join(userDataPath, 'last-config.json');
        fs.writeFileSync(lastConfigPath, JSON.stringify({ path: configPath }, null, 2), 'utf8');
        console.log('已将此配置设为最后使用的配置:', configPath);
      } catch (saveError) {
        console.error('保存最后使用的配置失败:', saveError);
      }

      if (state.mihomoProcess) {
        if (typeof context.startTrafficStatsUpdate === 'function') {
          context.startTrafficStatsUpdate();
        }
        if (typeof context.startMihomoLogs === 'function') {
          context.startMihomoLogs();
        }
      }

      return { success: true };
    } catch (error) {
      console.error('启动Mihomo时出错:', error);

      const errorMessage = `无法启动Mihomo: ${error.message}`;

      // 发送错误信息到前端,使用 Toast 显示
      if (state.mainWindow) {
        state.mainWindow.webContents.send('mihomo-start-failed', {
          error: errorMessage
        });
      }

      return { success: false, error: errorMessage };
    }
  }

  async function stopMihomo() {
    try {
      if (state.mihomoProcess) {
        state.mihomoProcess.kill();
        state.mihomoProcess = null;
        if (typeof context.stopTrafficStatsUpdate === 'function') {
          context.stopTrafficStatsUpdate();
        }
        if (typeof context.stopConnectionsWebSocket === 'function') {
          context.stopConnectionsWebSocket();
        }
        if (typeof context.stopMihomoLogs === 'function') {
          context.stopMihomoLogs();
        }
        state.configFilePath = null;
        console.log('Mihomo已停止');
        return true;
      }
      return false;
    } catch (error) {
      console.error('停止Mihomo失败:', error);
      return false;
    }
  }

  async function checkMihomoService() {
    try {
      const controllerHost = state.activeApiConfig?.controllerHost || '127.0.0.1';
      const controllerPort = state.activeApiConfig?.controllerPort || '9090';
      return await new Promise((resolve) => {
        const client = http.request(
          {
            hostname: controllerHost,
            port: controllerPort,
            path: '/version',
            method: 'GET',
            timeout: 1000
          },
          (res) => {
            resolve(res.statusCode === 200);
          }
        );

        client.on('error', () => resolve(false));
        client.on('timeout', () => {
          client.destroy();
          resolve(false);
        });
        client.end();
      });
    } catch (error) {
      console.error('检查Mihomo服务状态失败:', error);
      return false;
    }
  }

  async function autoStartMihomo() {
    try {
      console.log('检查内核是否已经在运行...');

      const originalApiConfig = { ...state.activeApiConfig };

      if (!state.activeApiConfig) {
        state.activeApiConfig = {
          controllerHost: '127.0.0.1',
          controllerPort: '9090',
          secret: ''
        };
      }

      const isRunning = await checkMihomoService();

      if (isRunning) {
        console.log('检测到内核已经在运行，获取内核信息...');

        try {
          const host =
            state.activeApiConfig.controllerHost === '0.0.0.0'
              ? '127.0.0.1'
              : state.activeApiConfig.controllerHost;
          const port = state.activeApiConfig.controllerPort;
          const headers = {};
          if (state.activeApiConfig.secret) {
            headers['Authorization'] = `Bearer ${state.activeApiConfig.secret}`;
          }

          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 2000);

          const configResponse = await fetchWithFallback(`http://${host}:${port}/configs`, {
            headers,
            signal: controller.signal
          });

          clearTimeout(timeoutId);

          if (configResponse.ok) {
            const configData = await configResponse.json();
            console.log('成功获取现有内核配置信息', configData);

            state.configFilePath = configData.path || '已连接到现有内核';

            if (state.mainWindow) {
              state.mainWindow.webContents.send('mihomo-autostart', {
                success: true,
                configPath: state.configFilePath,
                existing: true,
                configData
              });
            }

            if (typeof context.startTrafficStatsUpdate === 'function') {
              context.startTrafficStatsUpdate();
            }
            if (typeof context.startConnectionsWebSocket === 'function') {
              context.startConnectionsWebSocket();
            }
            if (typeof context.startMihomoLogs === 'function') {
              context.startMihomoLogs();
            }
            if (typeof context.updateCurrentNodeInfo === 'function') {
              context.updateCurrentNodeInfo();
            }

            return;
          } else {
            console.log(`无法获取内核配置信息，状态码: ${configResponse.status}`);
          }
        } catch (error) {
          console.error('获取现有内核配置信息失败:', error);
        }

        if (state.mainWindow) {
          state.mainWindow.webContents.send('mihomo-autostart', {
            success: true,
            configPath: '已连接到现有内核',
            existing: true
          });
        }

        if (typeof context.startTrafficStatsUpdate === 'function') {
          context.startTrafficStatsUpdate();
        }
        if (typeof context.startConnectionsWebSocket === 'function') {
          context.startConnectionsWebSocket();
        }
        if (typeof context.startMihomoLogs === 'function') {
          context.startMihomoLogs();
        }

        return;
      }

      state.activeApiConfig = originalApiConfig;

      await ensureMihomoDataFiles();

      const configDir = context.get('configDir');
      const subscriptions = await getSubscriptionList(configDir);
      if (subscriptions.length === 0) {
        console.log('没有可用的配置文件，无法自动启动');
        return;
      }

      let configPath;
      try {
        const lastConfigPath = path.join(userDataPath, 'last-config.json');
        if (fs.existsSync(lastConfigPath)) {
          const lastConfig = JSON.parse(fs.readFileSync(lastConfigPath, 'utf8'));
          if (lastConfig.path && fs.existsSync(lastConfig.path)) {
            console.log('找到上次使用的配置文件:', lastConfig.path);
            configPath = lastConfig.path;
          }
        }
      } catch (error) {
        console.error('读取上次配置文件失败:', error);
      }

      if (!configPath) {
        configPath = subscriptions[0].path;
        console.log('没有找到上次的配置，使用第一个配置文件:', configPath);
      }

      const success = await startMihomo(configPath);

      if (success && state.mainWindow) {
        state.mainWindow.webContents.send('mihomo-autostart', {
          success: true,
          configPath
        });

        try {
          const proxyEnabled = dbManager.getSetting('systemProxyEnabled', false);
          console.log('应用上次保存的代理状态:', proxyEnabled);

          if (proxyEnabled) {
            if (typeof context.enableSystemProxy === 'function') {
              await context.enableSystemProxy();
            }
            if (state.mainWindow) {
              state.mainWindow.webContents.send('proxy-status', true);
            }
          } else {
            if (typeof context.disableSystemProxy === 'function') {
              await context.disableSystemProxy();
            }
            if (state.mainWindow) {
              state.mainWindow.webContents.send('proxy-status', false);
            }
          }
        } catch (error) {
          console.error('应用上次代理状态失败:', error);
        }
      }
    } catch (error) {
      console.error('自动启动Mihomo失败:', error);
      if (state.mainWindow) {
        state.mainWindow.webContents.send('mihomo-autostart', {
          success: false,
          error: error.message
        });
      }
    }
  }

  async function getConfig() {
    try {
      if (!state.configFilePath || !fs.existsSync(state.configFilePath)) {
        console.log('当前没有活跃的配置文件');
        return null;
      }

      const content = fs.readFileSync(state.configFilePath, 'utf8');
      if (!content || content.trim() === '') {
        console.error('配置文件为空');
        return null;
      }

      const config = yaml.load(content);
      if (!config) {
        console.error('解析配置文件失败');
        return null;
      }

      return config;
    } catch (error) {
      console.error('获取配置失败:', error);
      return null;
    }
  }

  async function restartMihomoService() {
    try {
      const currentConfig = state.configFilePath;

      if (state.mihomoProcess) {
        state.mihomoProcess.kill();
        state.mihomoProcess = null;
        if (typeof context.stopTrafficStatsUpdate === 'function') {
          context.stopTrafficStatsUpdate();
        }
        if (typeof context.stopConnectionsWebSocket === 'function') {
          context.stopConnectionsWebSocket();
        }
        if (typeof context.stopMihomoLogs === 'function') {
          context.stopMihomoLogs();
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      if (currentConfig) {
        const success = await startMihomo(currentConfig);
        return { success, message: success ? '服务已重启' : '重启失败' };
      }

      return { success: false, message: '没有活动的配置文件' };
    } catch (error) {
      console.error('重启服务失败:', error);
      return { success: false, message: `重启失败: ${error.message}` };
    }
  }

  context.mihomoService = {
    findMihomoExecutable,
    ensureMihomoDataFiles,
    getSubscriptionList,
    parseConfigFile,
    deepMergeConfig,
    validateMergedConfig,
    reloadMihomoConfig,
    sendReloadRequest,
    regenerateAndReloadConfig,
    startMihomo,
    stopMihomo,
    autoStartMihomo,
    checkMihomoService,
    getConfig,
    restartMihomoService
  };
};
