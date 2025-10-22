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
    userDataPath
  } = context;

  const { applyOverrides } = require('../ipc-handlers/overrides');
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

    if (isDev) {
      const devDirPath = process.cwd();
      const parentDir = path.join(devDirPath, '..');

      try {
        const files = fs.readdirSync(parentDir);
        const mihomoExeFiles = files.filter(
          (file) => file.toLowerCase().includes('mihomo') && file.endsWith('.exe')
        );

        if (mihomoExeFiles.length > 0) {
          binPath = path.join(parentDir, mihomoExeFiles[0]);
          console.log('开发环境找到mihomo内核:', binPath);
        }
      } catch (error) {
        console.error('搜索开发环境内核文件失败:', error);
      }

      if (!binPath) {
        binPath = path.join(parentDir, 'mihomo-windows-amd64.exe');
      }
    } else {
      const coresDir = path.join(process.resourcesPath, 'cores');

      try {
        if (fs.existsSync(coresDir)) {
          const files = fs.readdirSync(coresDir);
          const exeFiles = files.filter((file) => file.endsWith('.exe'));

          if (exeFiles.length > 0) {
            const mihomoExe = exeFiles.find((file) => file.toLowerCase().includes('mihomo'));

            if (mihomoExe) {
              binPath = path.join(coresDir, mihomoExe);
              console.log('发现mihomo内核:', binPath);
            } else {
              binPath = path.join(coresDir, exeFiles[0]);
              console.log('使用默认内核文件:', binPath);
            }
          }
        }
      } catch (error) {
        console.error('搜索内核文件失败:', error);
      }

      if (!binPath) {
        binPath = path.join(process.resourcesPath, 'cores/mihomo-windows-amd64.exe');
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
      const mustOverrideFields = ['mixed-port', 'allow-lan', 'ipv6', 'log-level', 'external-controller', 'secret'];

      if (mustOverrideFields.includes(key)) {
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

    validatedConfig['external-controller'] = '0.0.0.0:9090';
    validatedConfig['secret'] = '';

    const requiredArrayFields = ['proxies', 'proxy-groups'];
    for (const field of requiredArrayFields) {
      if (!validatedConfig[field] || !Array.isArray(validatedConfig[field])) {
        if (field === 'proxies' && (!validatedConfig.proxies || !Array.isArray(validatedConfig.proxies))) {
          throw new Error(`无效的配置：缺少 ${field} 数组`);
        }
        if (!validatedConfig[field]) {
          validatedConfig[field] = [];
          console.log(`创建空的 ${field} 数组作为默认值`);
        }
      }
    }

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
      const configData = JSON.stringify({ path: configPath });
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

      console.log('已请求Mihomo重新加载配置:', configPath);
    } catch (error) {
      console.error('发送配置重载请求失败:', error);
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
        let mergedConfig = deepMergeConfig(config, userSettings);

        console.log('[regenerateAndReloadConfig] 准备应用覆写');
        console.log('[regenerateAndReloadConfig] applyOverrides类型:', typeof applyOverrides);
        console.log('[regenerateAndReloadConfig] state.configFilePath:', state.configFilePath);

        if (applyOverrides && typeof applyOverrides === 'function') {
          try {
            console.log('[regenerateAndReloadConfig] 调用applyOverrides...');
            const maybePromise = applyOverrides(context, mergedConfig, state.configFilePath);
            if (maybePromise && typeof maybePromise.then === 'function') {
              console.log('[regenerateAndReloadConfig] applyOverrides返回Promise，等待...');
              mergedConfig = await maybePromise;
              console.log('[regenerateAndReloadConfig] applyOverrides完成');
            } else {
              console.log('[regenerateAndReloadConfig] applyOverrides返回同步结果');
              mergedConfig = maybePromise;
            }
          } catch (overrideError) {
            console.error('应用配置覆盖失败:', overrideError);
            return false;
          }
        } else {
          console.log('[regenerateAndReloadConfig] applyOverrides不可用或不是函数');
        }

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

      state.activeApiConfig = {
        controllerHost: '127.0.0.1',
        controllerPort: '9090',
        secret: ''
      };
      console.log('已设置API配置为固定值:', state.activeApiConfig);

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
        mergedConfig = deepMergeConfig(config, userSettings);
        console.log('[startMihomo] deepMerge后proxy-groups前3个:',
          mergedConfig['proxy-groups'] ? mergedConfig['proxy-groups'].slice(0, 3).map(g => g.name) : []);

        console.log('[startMihomo] 准备应用覆写');
        console.log('[startMihomo] applyOverrides类型:', typeof applyOverrides);
        console.log('[startMihomo] configPath:', configPath);

        mergedConfig = await applyOverrides(context, mergedConfig, configPath);

        console.log('[startMihomo] 覆写应用完成');
        console.log('[startMihomo] 覆写后proxy-groups前3个:',
          mergedConfig['proxy-groups'] ? mergedConfig['proxy-groups'].slice(0, 3).map(g => g.name) : []);

        mergedConfig = validateMergedConfig(mergedConfig);
        console.log('[startMihomo] validate后proxy-groups前3个:',
          mergedConfig['proxy-groups'] ? mergedConfig['proxy-groups'].slice(0, 3).map(g => g.name) : []);
        mergedConfig['external-controller'] = '0.0.0.0:9090';
        mergedConfig['secret'] = '';
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
          'log-level': userSettings['log-level'] || 'info',
          'external-controller': '0.0.0.0:9090',
          secret: ''
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

      try {
        if (!mergedConfig.proxies || !Array.isArray(mergedConfig.proxies)) {
          dialog.showErrorBox('配置错误', '配置文件缺少必要的proxies字段');
          return false;
        }

        if (!mergedConfig['proxy-groups'] || !Array.isArray(mergedConfig['proxy-groups'])) {
          dialog.showErrorBox('配置错误', '配置文件缺少必要的proxy-groups字段');
          return false;
        }
      } catch (error) {
        console.error('配置文件验证失败:', error);
        dialog.showErrorBox('配置文件错误', `解析配置文件失败: ${error.message}`);
        return false;
      }

      state.mihomoProcess = spawn(binPath, ['-f', overrideConfigPath], {
        cwd: mihomoDir,
        env: {
          ...process.env,
          MIHOMO_CORE_PATH: mihomoDir
        },
        windowsHide: false,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      state.mihomoProcess.stdout.on('data', (data) => {
        const logContent = data.toString();
        console.log(`mihomo stdout: ${logContent}`);

        if (state.mainWindow) {
          state.mainWindow.webContents.send('mihomo-log', logContent);
        }

        process.stdout.write(data);
      });

      state.mihomoProcess.stderr.on('data', (data) => {
        console.error(`mihomo stderr: ${data}`);
        if (state.mainWindow) {
          state.mainWindow.webContents.send('mihomo-error', data.toString());
        }
        process.stderr.write(data);
      });

      state.mihomoProcess.on('close', (code) => {
        console.log(`mihomo process exited with code ${code}`);
        if (typeof context.handleMihomoProcessExit === 'function') {
          context.handleMihomoProcessExit(code);
        }
      });

      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (state.mihomoProcess && state.mihomoProcess.exitCode !== null) {
        console.error(`Mihomo立即退出，退出代码: ${state.mihomoProcess.exitCode}`);
        dialog.showErrorBox('启动失败', `Mihomo启动后立即退出，退出代码: ${state.mihomoProcess.exitCode}`);
        return false;
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

      return true;
    } catch (error) {
      console.error('启动Mihomo时出错:', error);
      dialog.showErrorBox('启动失败', `无法启动Mihomo: ${error.message}`);
      return false;
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
