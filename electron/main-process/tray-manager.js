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
          iconPath = path.join(__dirname, '../public', iconFileName);
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
          iconPath = path.join(__dirname, '../public', iconFileName);
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

        console.log(`托盘图标路径: ${iconPath}`);

        if (fs.existsSync(iconPath)) {
          trayIcon = nativeImage.createFromPath(iconPath);
        } else {
          console.warn(`图标文件不存在: ${iconPath}`);
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

    state.tray.on('click', () => {
      if (!state.mainWindow || state.mainWindow.isDestroyed()) return;
      state.mainWindow.isVisible() ? state.mainWindow.hide() : state.mainWindow.show();
    });

    return state.tray;
  }

  async function updateTrayMenu() {
    if (!state.tray) await ensureTray();
    if (!state.tray) return;

    try {
      const proxyEnabled = state.systemProxyEnabled;

      const menuItems = [
        { label: '显示主窗口', click: () => state.mainWindow && state.mainWindow.show() },
        { type: 'separator' },
        { label: '启用系统代理', type: 'checkbox', checked: proxyEnabled, click: context.toggleSystemProxy },
        { label: '启用TUN模式', type: 'checkbox', checked: state.tunModeEnabled, click: context.toggleTunMode },
        {
          label: '断开所有连接',
          click: async () => {
            try {
              if (!state.activeApiConfig) {
                console.error('无法断开连接: API配置不可用');
                return;
              }

              // Socket 模式: 使用 fetchMihomoAPI
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

      let nodeMenuItems = [];

      try {
        const isServiceRunning = await context.checkMihomoService();
        if (isServiceRunning && state.activeApiConfig) {
          // Socket 模式: 使用 fetchMihomoAPI
          const response = await context.fetchMihomoAPI('/proxies');
          if (response.ok) {
            const data = await response.json();
            const proxyGroups = [];

            for (const [name, proxy] of Object.entries(data.proxies)) {
              if (proxy.type === 'Selector' || proxy.type === 'URLTest' || proxy.type === 'Fallback') {
                if (proxy.all && proxy.all.length > 0) {
                  if (name === 'PROXY' || name === 'GLOBAL') {
                    proxyGroups.unshift({ name, type: proxy.type, all: proxy.all, now: proxy.now });
                  } else {
                    proxyGroups.push({ name, type: proxy.type, all: proxy.all, now: proxy.now });
                  }
                }
              }
            }

            if (proxyGroups.length > 0) {
              const groupSubmenuItems = [];

              for (const group of proxyGroups) {
                const nodesSubmenu = [];
                const sortedNodeNames = [...group.all].sort((a, b) => {
                  if (a === group.now) return -1;
                  if (b === group.now) return 1;
                  const nodeA = data.proxies[a];
                  const nodeB = data.proxies[b];
                  const delayA = nodeA?.history?.[0]?.delay ?? -1;
                  const delayB = nodeB?.history?.[0]?.delay ?? -1;
                  if (delayA > 0 && delayB > 0) return delayA - delayB;
                  if (delayA > 0) return -1;
                  if (delayB > 0) return 1;
                  return a.localeCompare(b);
                });

                for (const nodeName of sortedNodeNames) {
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

              nodeMenuItems = [{ type: 'separator' }, { label: '节点选择', submenu: groupSubmenuItems }];
            }
          }
        }
      } catch (error) {
        console.error('获取节点列表失败:', error);
      }

      const contextMenu = Menu.buildFromTemplate([
        ...menuItems,
        ...nodeMenuItems,
        { type: 'separator' },
        {
          label: '退出',
          click: () => {
            state.isQuitting = true;
            app.quit();
          }
        }
      ]);

      state.tray.setContextMenu(contextMenu);

      if (state.currentNode) {
        state.tray.setToolTip(`FlyClash - ${state.currentNode}`);
      } else {
        state.tray.setToolTip('FlyClash');
      }
    } catch (error) {
      console.error('更新托盘菜单失败:', error);
      const basicMenu = Menu.buildFromTemplate([
        { label: '显示主窗口', click: () => state.mainWindow?.show() },
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
    }
  }

  context.trayManager = {
    ensureTray,
    updateTrayMenu
  };
};
