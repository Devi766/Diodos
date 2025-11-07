module.exports = function initTrayManager(context) {
  const {
    app,
    Menu,
    Tray,
    nativeImage,
    path,
    fs,
    state
  } = context;

  async function ensureTray() {
    if (state.tray && !state.tray.isDestroyed?.()) {
      return state.tray;
    }

    const isMac = process.platform === 'darwin';

    try {
      let trayIcon;

      if (isMac) {
        // macOS: 使用模板图标
        const iconFileName = 'logoTemplate.png';
        let iconPath;

        // 开发环境
        if (context.isDev) {
          iconPath = path.join(__dirname, '../../public', iconFileName);
        } else {
          // 生产环境：尝试多个可能的路径
          const possiblePaths = [
            path.join(process.resourcesPath, 'public', iconFileName),
            path.join(process.resourcesPath, iconFileName),
            path.join(app.getAppPath(), 'public', iconFileName)
          ];

          for (const tryPath of possiblePaths) {
            if (fs.existsSync(tryPath)) {
              iconPath = tryPath;
              break;
            }
          }

          if (!iconPath) {
            iconPath = possiblePaths[0]; // 使用第一个作为默认
          }
        }

        console.log(`[macOS] 托盘图标路径: ${iconPath}`);
        console.log(`[macOS] 文件存在: ${fs.existsSync(iconPath)}`);

        if (fs.existsSync(iconPath)) {
          trayIcon = nativeImage.createFromPath(iconPath);
          if (!trayIcon.isEmpty()) {
            const size = trayIcon.getSize();
            console.log(`[macOS] 原始图标尺寸: ${size.width}x${size.height}`);

            // macOS 托盘图标标准尺寸：22x22 (Retina 屏幕会自动使用 @2x)
            const targetSize = 22;
            if (size.width !== targetSize || size.height !== targetSize) {
              trayIcon = trayIcon.resize({ width: targetSize, height: targetSize });
              console.log(`[macOS] 图标已调整为: ${targetSize}x${targetSize}`);
            }

            // 设置为模板图标（必须在创建 Tray 之前设置）
            trayIcon.setTemplateImage(true);
            console.log('[macOS] 托盘图标设置成功: Template 模式');
          } else {
            console.warn('[macOS] 图标加载为空');
            trayIcon = nativeImage.createEmpty();
          }
        } else {
          console.warn(`[macOS] 图标文件不存在: ${iconPath}`);
          trayIcon = nativeImage.createEmpty();
        }
      } else {
        // Windows/Linux: 使用 favicon.ico
        const iconFileName = 'favicon.ico';
        let iconPath;

        if (context.isDev) {
          iconPath = path.join(__dirname, '../../public', iconFileName);
        } else {
          const possiblePaths = [
            path.join(process.resourcesPath, 'public', iconFileName),
            path.join(process.resourcesPath, iconFileName),
            path.join(app.getAppPath(), 'public', iconFileName)
          ];

          for (const tryPath of possiblePaths) {
            if (fs.existsSync(tryPath)) {
              iconPath = tryPath;
              break;
            }
          }

          if (!iconPath) {
            iconPath = possiblePaths[0];
          }
        }

        console.log(`[Windows/Linux] 托盘图标路径: ${iconPath}`);
        console.log(`[Windows/Linux] 文件存在: ${fs.existsSync(iconPath)}`);

        if (fs.existsSync(iconPath)) {
          trayIcon = nativeImage.createFromPath(iconPath);

          if (!trayIcon.isEmpty()) {
            const size = trayIcon.getSize();
            console.log(`[Windows/Linux] 原始图标尺寸: ${size.width}x${size.height}`);
          } else {
            console.warn('[Windows/Linux] 图标加载为空');
            trayIcon = nativeImage.createEmpty();
          }
        } else {
          console.warn(`[Windows/Linux] 图标文件不存在: ${iconPath}`);
          trayIcon = nativeImage.createEmpty();
        }
      }

      state.tray = new Tray(trayIcon);
      console.log('托盘创建成功');
    } catch (error) {
      console.error('设置托盘图标失败:', error);
      try {
        console.log('尝试在没有图标的情况下创建托盘...');
        state.tray = new Tray(nativeImage.createEmpty());
      } catch (fallbackError) {
        console.error('无法创建托盘:', fallbackError);
        throw fallbackError;
      }
    }

    // 设置托盘事件监听
    if (!isMac) {
      // Windows/Linux: 左键点击显示/隐藏窗口
      state.tray.on('click', () => {
        if (!state.mainWindow || state.mainWindow.isDestroyed()) return;

        if (state.mainWindow.isVisible()) {
          state.mainWindow.hide();
          // 窗口隐藏时，启动自动轻量模式定时器
          if (context.lightweightModeManager) {
            context.lightweightModeManager.startAutoLightweightTimer();
          }
        } else {
          state.mainWindow.show();
          // 窗口显示时，取消自动轻量模式定时器
          if (context.lightweightModeManager) {
            context.lightweightModeManager.cancelAutoLightweightTimer();
          }
        }
      });
    }

    // 右键点击时更新菜单（所有平台）
    state.tray.on('right-click', async () => {
      console.log('[托盘] 右键点击，更新菜单');
      await updateTrayMenu();
    });

    // macOS 特殊处理：点击图标时更新菜单（macOS 会自动显示菜单）
    if (isMac) {
      state.tray.on('click', async () => {
        console.log('[托盘] macOS 点击，更新菜单');
        await updateTrayMenu();
      });
    }

    return state.tray;
  }

  let updateTrayMenuInProgress = false;

  async function updateTrayMenu() {
    if (!state.tray) await ensureTray();
    if (!state.tray) return;

    // 防止重复更新
    if (updateTrayMenuInProgress) {
      console.log('[托盘菜单] 正在更新中，跳过本次请求');
      return;
    }

    updateTrayMenuInProgress = true;

    try {
      const proxyEnabled = state.systemProxyEnabled;

      const menuItems = [
        {
          label: '显示主窗口',
          click: () => {
            if (state.mainWindow) {
              state.mainWindow.show();
              // 窗口显示时，取消自动轻量模式定时器
              if (context.lightweightModeManager) {
                context.lightweightModeManager.cancelAutoLightweightTimer();
              }
            }
          }
        },
        { type: 'separator' },
        { label: '启用系统代理', type: 'checkbox', checked: proxyEnabled, click: (menuItem) => context.toggleSystemProxy(menuItem) },
        { label: '启用TUN模式', type: 'checkbox', checked: state.tunModeEnabled, click: (menuItem) => context.toggleTunMode(menuItem) },
        {
          label: '断开所有连接',
          click: async () => {
            try {
              if (!state.activeApiConfig) {
                console.error('无法断开连接: API配置不可用');
                return;
              }

              const response = await context.fetchMihomoAPI('/connections', {
                method: 'DELETE'
              });

              if (response.ok) {
                console.log('成功断开所有连接');
                state.mainWindow?.webContents.send('connections-closed');
              } else {
                console.error(`断开所有连接失败: ${response.statusText}`);
              }
            } catch (error) {
              console.error('断开所有连接时出错:', error);
            }
          }
        }
      ];

      // 添加代理模式选择菜单
      let proxyModeItems = [];
      try {
        const isServiceRunning = await context.checkMihomoService();
        if (isServiceRunning && state.activeApiConfig) {
          const response = await context.fetchMihomoAPI('/configs');
          if (response.ok) {
            const data = await response.json();
            const currentMode = data.mode || 'rule';

            const modeSubmenu = [
              {
                label: '规则模式',
                type: 'radio',
                checked: currentMode === 'rule',
                click: async () => {
                  try {
                    const updateResponse = await context.fetchMihomoAPI('/configs', {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ mode: 'rule' })
                    });

                    if (updateResponse.ok) {
                      console.log('已切换到规则模式');
                      setTimeout(() => updateTrayMenu(), 500);
                    } else {
                      console.error('切换模式失败:', updateResponse.statusText);
                    }
                  } catch (error) {
                    console.error('切换模式时出错:', error);
                  }
                }
              },
              {
                label: '全局模式',
                type: 'radio',
                checked: currentMode === 'global',
                click: async () => {
                  try {
                    const updateResponse = await context.fetchMihomoAPI('/configs', {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ mode: 'global' })
                    });

                    if (updateResponse.ok) {
                      console.log('已切换到全局模式');
                      setTimeout(() => updateTrayMenu(), 500);
                    } else {
                      console.error('切换模式失败:', updateResponse.statusText);
                    }
                  } catch (error) {
                    console.error('切换模式时出错:', error);
                  }
                }
              },
              {
                label: '直连模式',
                type: 'radio',
                checked: currentMode === 'direct',
                click: async () => {
                  try {
                    const updateResponse = await context.fetchMihomoAPI('/configs', {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ mode: 'direct' })
                    });

                    if (updateResponse.ok) {
                      console.log('已切换到直连模式');
                      setTimeout(() => updateTrayMenu(), 500);
                    } else {
                      console.error('切换模式失败:', updateResponse.statusText);
                    }
                  } catch (error) {
                    console.error('切换模式时出错:', error);
                  }
                }
              }
            ];

            proxyModeItems = [
              { type: 'separator' },
              { label: '代理模式', submenu: modeSubmenu }
            ];
          }
        }
      } catch (error) {
        console.error('获取代理模式失败:', error);
      }

      // 添加配置文件选择菜单
      let configMenuItems = [];
      try {
        const dbManager = context.dbManager;
        if (dbManager) {
          const subscriptions = dbManager.getAllSubscriptions();

          if (subscriptions && subscriptions.length > 0) {
            const currentConfigPath = state.configFilePath;

            const configSubmenu = subscriptions.map((sub) => ({
              label: sub.name,
              type: 'radio',
              checked: currentConfigPath === sub.file_path,
              click: async () => {
                try {
                  if (currentConfigPath === sub.file_path) {
                    console.log('已经在使用该配置');
                    return;
                  }

                  console.log(`切换到配置: ${sub.name} (${sub.file_path})`);

                  await context.mihomoService?.stopMihomo?.();

                  const started = await context.mihomoService?.startMihomo?.(sub.file_path);

                  if (started) {
                    console.log('配置切换成功');
                    state.configFilePath = sub.file_path;

                    if (context.dbManager?.setSetting) {
                      context.dbManager.setSetting('lastActiveConfig', sub.file_path);
                    }

                    setTimeout(() => updateTrayMenu(), 1000);
                  } else {
                    console.error('启动新配置失败');
                  }
                } catch (error) {
                  console.error('切换配置时出错:', error);
                }
              }
            }));

            configMenuItems = [
              { type: 'separator' },
              { label: '配置文件', submenu: configSubmenu }
            ];
          }
        }
      } catch (error) {
        console.error('获取配置列表失败:', error);
      }

      let nodeMenuItems = [];

      try {
        if (state.activeApiConfig) {
          console.log('[托盘菜单] 开始获取节点列表...');

          // 获取当前代理模式
          const configResponse = await context.fetchMihomoAPI('/configs');
          let currentMode = 'rule';
          if (configResponse.ok) {
            const configData = await configResponse.json();
            currentMode = configData.mode || 'rule';
            console.log('[托盘菜单] 当前代理模式:', currentMode);
          }

          // 直连模式下不显示节点菜单
          if (currentMode === 'direct') {
            console.log('[托盘菜单] 直连模式，跳过节点菜单');
          } else {
            const response = await context.fetchMihomoAPI('/proxies');
            console.log('[托盘菜单] 获取代理响应状态:', response.ok);

            if (response.ok) {
              const data = await response.json();
              console.log('[托盘菜单] 代理数据:', Object.keys(data.proxies || {}).length, '个条目');

              // 获取配置文件顺序
              let configOrder = null;
              try {
                if (context.dbManager && state.configFilePath) {
                  const fs = require('fs');
                  const yaml = require('js-yaml');

                  if (fs.existsSync(state.configFilePath)) {
                    const configContent = fs.readFileSync(state.configFilePath, 'utf8');
                    const config = yaml.load(configContent);
                    configOrder = {
                      proxyGroups: config['proxy-groups'] || [],
                      proxies: config.proxies || []
                    };
                    console.log('[托盘菜单] 成功加载配置文件顺序，代理组数:', configOrder.proxyGroups.length);
                  }
                }
              } catch (error) {
                console.log('[托盘菜单] 获取配置顺序失败:', error.message);
              }

              const proxyGroups = [];
              const selectorGroups = {};

              // 提取所有 selector 类型的组
              for (const [name, proxy] of Object.entries(data.proxies || {})) {
                if (proxy.type === 'Selector' || proxy.type === 'URLTest' || proxy.type === 'Fallback') {
                  // 全局模式只显示 GLOBAL 组
                  if (currentMode === 'global' && name !== 'GLOBAL') {
                    continue;
                  }
                  // 规则模式不显示 GLOBAL 组
                  if (currentMode === 'rule' && name === 'GLOBAL') {
                    continue;
                  }

                  if (proxy.all && proxy.all.length > 0) {
                    selectorGroups[name] = proxy;
                  }
                }
              }

              // 按配置文件顺序排列
              let groupsOrder = [];
              if (configOrder && configOrder.proxyGroups && configOrder.proxyGroups.length > 0) {
                groupsOrder = configOrder.proxyGroups
                  .filter(group => {
                    if (currentMode === 'global' && group.name !== 'GLOBAL') return false;
                    if (currentMode === 'rule' && group.name === 'GLOBAL') return false;
                    return true;
                  })
                  .map(group => group.name);

                // 添加 API 中有但配置文件中没有的组
                const missingInConfig = Object.keys(selectorGroups).filter(name => !groupsOrder.includes(name));
                groupsOrder.push(...missingInConfig);
              } else {
                groupsOrder = Object.keys(selectorGroups);
              }

              console.log('[托盘菜单] 代理组顺序:', groupsOrder.join(', '));

              // 按顺序构建代理组
              for (const groupName of groupsOrder) {
                if (!selectorGroups[groupName]) continue;

                const proxy = selectorGroups[groupName];
                const configGroup = configOrder?.proxyGroups?.find(g => g.name === groupName);

                // 确定节点顺序
                let nodesOrder = proxy.all || [];
                if (configGroup && configGroup.proxies && configGroup.proxies.length > 0) {
                  const configNodeNames = configGroup.proxies;
                  const apiNodeNames = proxy.all || [];
                  const missingInConfig = apiNodeNames.filter(name => !configNodeNames.includes(name));
                  nodesOrder = [...configNodeNames, ...missingInConfig];
                }

                proxyGroups.push({
                  name: groupName,
                  type: proxy.type,
                  all: nodesOrder,
                  now: proxy.now
                });
              }

              console.log('[托盘菜单] 找到的代理组数量:', proxyGroups.length);

            if (proxyGroups.length > 0) {
              const groupSubmenuItems = [];

              for (const group of proxyGroups) {
                const nodesSubmenu = [];
                // 使用配置文件中的节点顺序，不再按延迟排序
                const nodeNames = group.all;

                for (const nodeName of nodeNames) {
                  const node = data.proxies[nodeName];
                  if (!node) continue;

                  let label = nodeName;
                  if (node.history && node.history.length > 0) {
                    const delay = node.history[0].delay;
                    if (delay > 0) {
                      label = `${nodeName} (${delay}ms)`;
                    } else if (delay === 0) {
                      label = `${nodeName} (超时)`;
                    }
                  }
                  if (node.type === 'Selector' || node.type === 'URLTest' || node.type === 'Fallback') {
                    label = `${label} [组]`;
                  }

                  nodesSubmenu.push({
                    label,
                    type: 'radio',
                    checked: nodeName === group.now,
                    click: async () => {
                      try {
                        if (!state.activeApiConfig) {
                          console.error('无法切换节点: API配置不可用');
                          return;
                        }

                        // Socket 模式: 使用 fetchMihomoAPI
                        const switchResponse = await context.fetchMihomoAPI(`/proxies/${encodeURIComponent(group.name)}`, {
                          method: 'PUT',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ name: nodeName })
                        });

                        if (switchResponse.ok) {
                          console.log(`成功切换组 ${group.name} 到节点: ${nodeName}`);

                          if (group.name === 'PROXY' || group.name === 'GLOBAL') {
                            state.mainWindow?.webContents.send('node-changed', { nodeName });
                            state.currentNode = nodeName;
                            state.tray?.setToolTip(`FlyClash - ${nodeName}`);
                          }

                          setTimeout(() => updateTrayMenu(), 1000);
                        } else {
                          console.error(`切换节点失败: ${switchResponse.statusText}`);
                        }
                      } catch (error) {
                        console.error('切换节点失败:', error);
                      }
                    }
                  });
                }

                if (nodesSubmenu.length > 0) {
                  const groupLabel = group.name === 'PROXY' || group.name === 'GLOBAL' ? `${group.name} ★` : group.name;
                  groupSubmenuItems.push({ label: groupLabel, submenu: nodesSubmenu });
                }
              }

              nodeMenuItems = [{ type: 'separator' }, { label: '代理组', submenu: groupSubmenuItems }];
              console.log('[托盘菜单] 节点菜单已创建，组数:', groupSubmenuItems.length);
            } else {
              console.log('[托盘菜单] 代理组列表为空');
            }
            } else {
              console.log('[托盘菜单] 获取代理失败');
            }
          }
        } else {
          console.log('[托盘菜单] API配置不可用，跳过节点菜单');
        }
      } catch (error) {
        console.error('[托盘菜单] 获取节点列表失败:', error);
        console.error(error.stack);
      }

      console.log('[托盘菜单] 菜单项统计 - 基础:', menuItems.length, '模式:', proxyModeItems.length, '配置:', configMenuItems.length, '节点:', nodeMenuItems.length);

      const contextMenu = Menu.buildFromTemplate([
        ...menuItems,
        ...proxyModeItems,
        ...configMenuItems,
        ...nodeMenuItems,
        { type: 'separator' },
        {
          label: '轻量模式',
          click: async () => {
            try {
              if (context.lightweightModeManager) {
                await context.lightweightModeManager.enterLightweightMode();
                setTimeout(() => app.exit(0), 500);
              }
            } catch (error) {
              console.error('[托盘] 进入轻量模式失败:', error);
            }
          }
        },
        {
          label: '退出',
          click: () => {
            state.isQuitting = true;
            app.quit();
          }
        }
      ]);

      state.tray.setContextMenu(contextMenu);
      console.log('[托盘菜单] 菜单已更新');

      if (state.currentNode) {
        state.tray.setToolTip(`FlyClash - ${state.currentNode}`);
      } else {
        state.tray.setToolTip('FlyClash');
      }
    } catch (error) {
      console.error('更新托盘菜单失败:', error);
      const basicMenu = Menu.buildFromTemplate([
        {
          label: '显示主窗口',
          click: () => {
            if (state.mainWindow) {
              state.mainWindow.show();
              // 窗口显示时，取消自动轻量模式定时器
              if (context.lightweightModeManager) {
                context.lightweightModeManager.cancelAutoLightweightTimer();
              }
            }
          }
        },
        { type: 'separator' },
        {
          label: '退出',
          click: () => {
            state.isQuitting = true;
            app.quit();
          }
        }
      ]);
      state.tray.setContextMenu(basicMenu);
    } finally {
      updateTrayMenuInProgress = false;
    }
  }

  context.trayManager = {
    ensureTray,
    updateTrayMenu
  };
};
