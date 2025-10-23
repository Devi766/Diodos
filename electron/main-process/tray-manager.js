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

    let iconPath = null;
    const possiblePaths = [
      context.isDev ? path.join(__dirname, '../public/favicon.ico') : null,
      !context.isDev ? path.join(process.resourcesPath, 'public/favicon.ico') : null,
      !context.isDev ? path.join(process.resourcesPath, 'favicon.ico') : null,
      !context.isDev ? path.join(app.getAppPath(), 'public/favicon.ico') : null,
      !context.isDev ? path.join(app.getAppPath(), 'out/favicon.ico') : null
    ].filter(Boolean);

    for (const tryPath of possiblePaths) {
      if (fs.existsSync(tryPath)) {
        iconPath = tryPath;
        console.log(`找到托盘图标: ${iconPath}`);
        break;
      }
    }

    if (!iconPath) {
      iconPath = possiblePaths[0];
      console.warn(`警告: 未找到托盘图标文件，使用默认路径: ${iconPath}`);
    }

    try {
      state.tray = new Tray(iconPath);
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
