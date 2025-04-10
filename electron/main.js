const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, nativeTheme, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const isDev = process.env.NODE_ENV === 'development';
const yaml = require('js-yaml');
const WebSocket = require('ws');
const net = require('net');
const http = require('http');
const serveStatic = require('serve-static');
const finalhandler = require('finalhandler');

let mainWindow;
let tray;
let mihomoProcess;
let configFilePath;
let isQuitting = false;
let autoStartEnabled = true; // 默认启用自动启动
let currentNode = null;

// 连接管理相关变量
let connectionsWebSocket = null;
let connectionsRetry = 10;
let lastConnectionsInfo = {
  downloadTotal: 0,
  uploadTotal: 0,
  connections: [],
  memory: 0,
  currentNode: null,
  activeConnections: 0
};

// 修改应用的appName，确保保存在Roaming目录下的文件夹名为flyclash
app.name = 'flyclash';

// 应用数据存储路径
const userDataPath = app.getPath('userData');
const configDir = path.join(userDataPath, 'config');

// 确保配置目录存在
if (!fs.existsSync(configDir)) {
  fs.mkdirSync(configDir, { recursive: true });
}

// 流量统计相关变量
let lastTrafficStats = {
  up: 0,
  down: 0,
  upSpeed: 0,
  downSpeed: 0,
  timestamp: Date.now()
};

// WebSocket连接
let trafficWebSocket = null;
let trafficRetry = 10;
let lastValidStats = null;  // 用于存储最后一次有效的流量数据

// 格式化流量数据
function formatTraffic(bytes) {
  if (bytes === 0) return '0 B';
  
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let size = bytes;
  
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  
  return `${size.toFixed(2)} ${units[i]}`;
}

// 格式化速度
function formatSpeed(bytesPerSecond) {
  if (bytesPerSecond === 0) return '0 B/s';
  
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let i = 0;
  let speed = bytesPerSecond;
  
  while (speed >= 1024 && i < units.length - 1) {
    speed /= 1024;
    i++;
  }
  
  return `${speed.toFixed(2)} ${units[i]}`;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
    frame: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: nativeTheme.shouldUseDarkColors ? '#1a1a1a' : '#f9f9f9',
      symbolColor: nativeTheme.shouldUseDarkColors ? '#f3f4f6' : '#000000',
      height: 48
    },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1f2937' : '#ffffff'
  });

  // 监听系统主题变化
  nativeTheme.on('updated', () => {
    mainWindow.setTitleBarOverlay({
      color: nativeTheme.shouldUseDarkColors ? '#1a1a1a' : '#f9f9f9',
      symbolColor: nativeTheme.shouldUseDarkColors ? '#f3f4f6' : '#000000',
      height: 48
    });
  });

  // 开发环境使用localhost:3000
  if (isDev) {
    const startUrl = 'http://localhost:3000';
  mainWindow.loadURL(startUrl);
  } else {
    // 生产环境使用内部HTTP服务器提供页面
    loadPageWithServer('');
  }

  // 确保CSS加载正确
  mainWindow.webContents.on('did-finish-load', () => {
    if (!isDev) {
      try {
        // 尝试注入正确的CSS路径
        const cssDir = path.join(__dirname, '../out/_next/static/css');
        const cssFiles = fs.readdirSync(cssDir);
        if (cssFiles.length > 0) {
          const cssContent = fs.readFileSync(path.join(cssDir, cssFiles[0]), 'utf8');
          mainWindow.webContents.insertCSS(cssContent)
            .catch(err => console.error('注入CSS内容失败:', err));
        } else {
          console.error('没有找到CSS文件');
        }
      } catch (error) {
        console.error('CSS注入过程中出错:', error);
      }
    }
  });

  // 处理导航请求
  ipcMain.handle('loadPage', async (event, pageName) => {
    try {
      console.log(`切换到页面: ${pageName}`);
      
      // 在开发模式下使用localhost:3000
      if (isDev) {
        await mainWindow.loadURL(`http://localhost:3000/${pageName}`);
        return { success: true };
      }

      // 生产模式 - 使用共享的HTTP服务器函数
      await loadPageWithServer(pageName);
      
      return { success: true };
    } catch (error) {
      console.error('加载页面失败:', error);
      return { success: false, error: error.message };
    }
  });

  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    
    // 通知渲染进程当前主题状态
    try {
      const currentTheme = nativeTheme.themeSource === 'system' 
        ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
        : nativeTheme.themeSource;
      mainWindow.webContents.send('theme-changed', currentTheme);
      console.log('已通知渲染进程当前主题:', currentTheme);
    } catch (error) {
      console.error('通知主题状态失败:', error);
    }
    
    // 自动启动Mihomo
    if (autoStartEnabled) {
      setTimeout(autoStartMihomo, 1000);
    }
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

async function startMihomo(configPath) {
  if (mihomoProcess) {
    mihomoProcess.kill();
  }

  configFilePath = configPath;
  const binPath = isDev 
    ? path.join(process.cwd(), '../mihomo-windows-amd64.exe')
    : path.join(process.resourcesPath, 'cores/mihomo-windows-amd64.exe');

  if (!fs.existsSync(binPath)) {
    dialog.showErrorBox('错误', '无法找到Mihomo核心文件');
    return;
  }

  try {
    // 确保配置文件存在
    if (!fs.existsSync(configPath)) {
      dialog.showErrorBox('错误', `配置文件不存在: ${configPath}`);
      return false;
    }

    // 创建mihomo工作目录
    const mihomoDir = path.join(userDataPath, 'mihomo');
    if (!fs.existsSync(mihomoDir)) {
      fs.mkdirSync(mihomoDir, { recursive: true });
    }
    
    // 确认工作目录有写权限
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

    // 拷贝配置文件到工作目录以确保mihomo能够正确访问
    const configFilename = path.basename(configPath);
    const localConfigPath = path.join(mihomoDir, configFilename);
    try {
      const configContent = fs.readFileSync(configPath, 'utf8');
      fs.writeFileSync(localConfigPath, configContent);
      console.log(`已将配置文件复制到工作目录: ${localConfigPath}`);
    } catch (error) {
      console.error('复制配置文件失败:', error);
      // 继续使用原始配置路径
    }

    // 记录启动信息
    console.log(`启动Mihomo: ${binPath} -f ${configPath}`);
    console.log(`工作目录: ${mihomoDir}`);

    // 验证配置文件内容
    try {
      // 尝试加载js-yaml包
      let yaml;
      try {
        yaml = require('js-yaml');
      } catch (e) {
        console.log('未安装js-yaml，使用简单验证方法');
        
        const configContent = fs.readFileSync(configPath, 'utf8');
        if (!configContent.includes('proxies:') || !configContent.includes('proxy-groups:')) {
          dialog.showErrorBox('配置错误', '配置文件缺少必要的proxies或proxy-groups字段');
          return false;
        }
        // 简单验证通过
        return true;
      }
      
      // 如果yaml包加载成功，使用完整验证
      const configContent = fs.readFileSync(configPath, 'utf8');
      const config = yaml.load(configContent);
      
      // 检查配置文件中必要的字段
      if (!config || !config.proxies || !config['proxy-groups']) {
        dialog.showErrorBox('配置错误', '配置文件缺少必要的proxies或proxy-groups字段');
        return false;
      }

      // 检查代理组是否为空
      if (config['proxy-groups'].length === 0) {
        dialog.showErrorBox('配置错误', '配置文件中的代理组为空');
        return false;
      }

      // 检查代理是否为空
      if (config.proxies.length === 0) {
        dialog.showErrorBox('配置错误', '配置文件中没有代理节点');
        return false;
      }
    } catch (error) {
      console.error('配置文件验证失败:', error);
      dialog.showErrorBox('配置文件错误', `解析配置文件失败: ${error.message}`);
      return false;
    }

    // 启动mihomo，设置工作目录为mihomoDir
    mihomoProcess = spawn(binPath, ['-f', localConfigPath || configPath], {
      cwd: mihomoDir,
      env: {
        ...process.env,
        MIHOMO_CORE_PATH: mihomoDir
      },
      windowsHide: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    mihomoProcess.stdout.on('data', (data) => {
      console.log(`mihomo stdout: ${data}`);
      if (mainWindow) {
        mainWindow.webContents.send('mihomo-log', data.toString());
      }
      
      // 直接输出到控制台/终端
      process.stdout.write(data);
    });

    mihomoProcess.stderr.on('data', (data) => {
      console.error(`mihomo stderr: ${data}`);
      if (mainWindow) {
        mainWindow.webContents.send('mihomo-error', data.toString());
      }
      
      // 直接输出到控制台/终端
      process.stderr.write(data);
    });

    mihomoProcess.on('close', (code) => {
      console.log(`mihomo process exited with code ${code}`);
      if (mainWindow) {
        mainWindow.webContents.send('mihomo-stopped', code);
      }
    });

    // 检查进程是否成功启动
    await new Promise(resolve => setTimeout(resolve, 1000));
    if (mihomoProcess.exitCode !== null) {
      console.error(`Mihomo立即退出，退出代码: ${mihomoProcess.exitCode}`);
      dialog.showErrorBox('启动失败', `Mihomo启动后立即退出，退出代码: ${mihomoProcess.exitCode}`);
      return false;
    }

    // 启动成功后保存这个配置文件作为最后使用的配置
    try {
      const lastConfigPath = path.join(userDataPath, 'last-config.json');
      fs.writeFileSync(lastConfigPath, JSON.stringify({ path: configPath }, null, 2), 'utf8');
      console.log('已将此配置设为最后使用的配置:', configPath);
    } catch (saveError) {
      console.error('保存最后使用的配置失败:', saveError);
      // 继续执行，这不是致命错误
    }
    
    if (mihomoProcess) {
      startTrafficStatsUpdate();
    }

    return true;
  } catch (error) {
    console.error('Failed to start mihomo:', error);
    dialog.showErrorBox('启动失败', `无法启动Mihomo: ${error.message}`);
    return false;
  }
}

function setupTray() {
  // 尝试多个可能的图标路径
  let iconPath = null;
  const possiblePaths = [
    // 开发环境路径
    isDev ? path.join(__dirname, '../public/favicon.ico') : null,
    // 生产环境首选路径
    !isDev ? path.join(process.resourcesPath, 'public/favicon.ico') : null,
    // 备选路径 - 直接在 resources 下
    !isDev ? path.join(process.resourcesPath, 'favicon.ico') : null,
    // 应用程序目录下
    !isDev ? path.join(app.getAppPath(), 'public/favicon.ico') : null,
    // out 目录下
    !isDev ? path.join(app.getAppPath(), 'out/favicon.ico') : null
  ].filter(Boolean); // 过滤掉 null 值
  
  // 尝试每个路径，直到找到存在的图标文件
  for (const tryPath of possiblePaths) {
    if (fs.existsSync(tryPath)) {
      iconPath = tryPath;
      console.log(`找到托盘图标: ${iconPath}`);
      break;
    }
  }
  
  // 如果所有路径都不存在，使用第一个路径作为默认值
  if (!iconPath) {
    iconPath = possiblePaths[0];
    console.warn(`警告: 未找到托盘图标文件，使用默认路径: ${iconPath}`);
  }
  
  try {
    tray = new Tray(iconPath);
    updateTrayMenu();
    tray.on('click', () => {
      mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
    });
  } catch (error) {
    console.error('设置托盘图标失败:', error);
    // 尝试在没有图标的情况下创建托盘
    try {
      console.log('尝试在没有图标的情况下创建托盘...');
      tray = new Tray(nativeImage.createEmpty());
      updateTrayMenu();
    } catch (fallbackError) {
      console.error('无法创建托盘:', fallbackError);
    }
  }
}

// 更新托盘菜单，包括节点列表
async function updateTrayMenu() {
  if (!tray) return;
  
  try {
    // 获取当前代理状态
    let proxyEnabled = false;
    try {
      const result = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable').toString();
      proxyEnabled = result.includes('0x1');
    } catch (error) {
      console.error('获取代理状态失败:', error);
    }
    
    // 基础菜单项
    const menuItems = [
      { label: '显示主窗口', click: () => mainWindow.show() },
      { type: 'separator' },
      { label: '启用系统代理', type: 'checkbox', checked: proxyEnabled, click: toggleSystemProxy },
      { 
        label: '断开所有连接', 
        click: async () => {
          try {
            // 使用Mihomo API断开所有连接
            const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
            const response = await fetch('http://127.0.0.1:9090/connections', {
              method: 'DELETE'
            });
            
            if (response.ok) {
              console.log('成功断开所有连接');
              // 可选：显示通知
              if (mainWindow) {
                mainWindow.webContents.send('connections-closed');
              }
            } else {
              console.error(`断开所有连接失败: ${response.statusText}`);
            }
          } catch (error) {
            console.error('断开所有连接时出错:', error);
          }
        }
      }
    ];
    
    // 尝试获取节点列表
    let nodeMenuItems = [];
    
    try {
      // 检查Mihomo是否运行
      const isServiceRunning = await checkMihomoService();
      if (isServiceRunning) {
        // 使用fetch API获取代理节点信息
        const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
        
        // 获取代理节点信息
        const response = await fetch('http://127.0.0.1:9090/proxies');
        if (response.ok) {
          const data = await response.json();
          
          // 获取所有代理组
          const proxyGroups = [];
          
          // 查找所有类型为Selector, URLTest, Fallback的代理组
          for (const [name, proxy] of Object.entries(data.proxies)) {
            if (proxy.type === 'Selector' || proxy.type === 'URLTest' || proxy.type === 'Fallback') {
              if (proxy.all && proxy.all.length > 0) {
                // 将PROXY或GLOBAL组放在最前面
                if (name === 'PROXY' || name === 'GLOBAL') {
                  proxyGroups.unshift({
                    name: name,
                    type: proxy.type,
                    all: proxy.all,
                    now: proxy.now
                  });
                } else {
                  proxyGroups.push({
                    name: name,
                    type: proxy.type,
                    all: proxy.all,
                    now: proxy.now
                  });
                }
              }
            }
          }
          
          // 创建所有代理组的子菜单
          if (proxyGroups.length > 0) {
            const groupSubmenuItems = [];
            
            // 为每个代理组创建子菜单
            for (const group of proxyGroups) {
              const nodesSubmenu = [];
              
              // 先对节点进行排序 - 将当前选中节点和有延迟信息的节点排在前面
              const sortedNodeNames = [...group.all].sort((a, b) => {
                // 当前选中的节点排在最前面
                if (a === group.now) return -1;
                if (b === group.now) return 1;
                
                const nodeA = data.proxies[a];
                const nodeB = data.proxies[b];
                
                // 有延迟信息的节点优先
                const delayA = nodeA?.history?.[0]?.delay ?? -1;
                const delayB = nodeB?.history?.[0]?.delay ?? -1;
                
                // 都有延迟信息，按延迟从小到大排序
                if (delayA > 0 && delayB > 0) return delayA - delayB;
                
                // 有延迟信息的排在前面
                if (delayA > 0) return -1;
                if (delayB > 0) return 1;
                
                // 都没有延迟信息，按字母顺序排序
                return a.localeCompare(b);
              });
              
              // 为每个节点创建菜单项
              for (const nodeName of sortedNodeNames) {
                const node = data.proxies[nodeName];
                if (node) {
                  // 跳过其他代理组类型（不跳过，部分配置允许代理组嵌套）
                  // if (node.type === 'Selector' || node.type === 'URLTest' || node.type === 'Fallback') {
                  //   continue;
                  // }
                  
                  let label = nodeName;
                  // 添加延迟显示（如果有）
                  if (node.history && node.history.length > 0) {
                    const delay = node.history[0].delay;
                    if (delay > 0) {
                      label = `${nodeName} (${delay}ms)`;
                    } else if (delay === 0) {
                      label = `${nodeName} (超时)`;
                    }
                  }
                  
                  // 如果是代理组，添加标记
                  if (node.type === 'Selector' || node.type === 'URLTest' || node.type === 'Fallback') {
                    label = `${label} [组]`;
                  }
                  
                  nodesSubmenu.push({
                    label: label,
                    type: 'radio',
                    checked: nodeName === group.now,
                    click: async () => {
                      // 调用API切换节点
                      try {
                        // 切换节点
                        const switchResponse = await fetch(`http://127.0.0.1:9090/proxies/${encodeURIComponent(group.name)}`, {
                          method: 'PUT',
                          headers: {
                            'Content-Type': 'application/json'
                          },
                          body: JSON.stringify({ name: nodeName })
                        });
                        
                        if (switchResponse.ok) {
                          console.log(`成功切换组 ${group.name} 到节点: ${nodeName}`);
                          
                          // 如果是主要组（PROXY或GLOBAL），同时更新当前节点
                          if (group.name === 'PROXY' || group.name === 'GLOBAL') {
                            // 切换成功后更新UI
                            if (mainWindow) {
                              mainWindow.webContents.send('node-changed', { nodeName });
                            }
                            // 更新当前节点
                            currentNode = nodeName;
                            // 更新托盘提示
                            tray.setToolTip(`FlyClash - ${nodeName}`);
                          }
                          
                          // 更新托盘菜单
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
              }
              
              // 如果有节点，添加到代理组菜单
              if (nodesSubmenu.length > 0) {
                // 标记当前选中的节点
                const groupLabel = group.name === 'PROXY' || group.name === 'GLOBAL' 
                  ? `${group.name} ★` 
                  : group.name;
                
                groupSubmenuItems.push({
                  label: groupLabel,
                  submenu: nodesSubmenu
                });
              }
            }
            
            // 添加所有代理组菜单
            nodeMenuItems = [
              { type: 'separator' },
              { 
                label: '节点选择', 
                submenu: groupSubmenuItems
              }
            ];
          }
        }
      }
    } catch (error) {
      console.error('获取节点列表失败:', error);
    }
    
    // 组合完整菜单
    const contextMenu = Menu.buildFromTemplate([
      ...menuItems,
      ...nodeMenuItems,
      { type: 'separator' },
      { label: '退出', click: () => {
        isQuitting = true;
        app.quit();
      }}
    ]);
    
    tray.setContextMenu(contextMenu);
    
    // 更新托盘提示，显示当前节点
    if (currentNode) {
      tray.setToolTip(`FlyClash - ${currentNode}`);
    } else {
      tray.setToolTip('FlyClash');
    }
  } catch (error) {
    console.error('更新托盘菜单失败:', error);
    // 创建基本菜单作为后备
    const basicMenu = Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => mainWindow.show() },
      { type: 'separator' },
      { label: '退出', click: () => {
        isQuitting = true;
        app.quit();
      }}
    ]);
    tray.setContextMenu(basicMenu);
  }
}

function toggleSystemProxy(menuItem) {
  const enabled = menuItem.checked;
  if (enabled) {
    // 启用系统代理，默认端口7890
    try {
      execSync('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f');
      execSync('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ /d "127.0.0.1:7890" /f');
      mainWindow.webContents.send('proxy-status', true);
    } catch (error) {
      console.error('Failed to enable system proxy:', error);
      dialog.showErrorBox('代理设置失败', '无法启用系统代理');
      menuItem.checked = false;
    }
  } else {
    // 禁用系统代理
    try {
      execSync('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f');
      mainWindow.webContents.send('proxy-status', false);
    } catch (error) {
      console.error('Failed to disable system proxy:', error);
      dialog.showErrorBox('代理设置失败', '无法禁用系统代理');
      menuItem.checked = true;
    }
  }
}

// 自动启动Mihomo功能
async function autoStartMihomo() {
  try {
    // 获取保存的订阅列表
    const subscriptions = await getSubscriptionList();
    if (subscriptions.length === 0) {
      console.log('没有可用的配置文件，无法自动启动');
      return;
    }
    
    // 尝试从存储中读取上次使用的配置文件路径
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
    
    // 如果没有找到上次的配置或文件不存在，使用第一个可用的配置
    if (!configPath) {
      configPath = subscriptions[0].path;
      console.log('没有找到上次的配置，使用第一个配置文件:', configPath);
    }
    
    const success = await startMihomo(configPath);
    
    if (success && mainWindow) {
      // 通知前端更新状态
      mainWindow.webContents.send('mihomo-autostart', {
        success: true,
        configPath: configPath
      });
      
      // 自动应用上次的代理状态
      try {
        const proxyConfigPath = path.join(userDataPath, 'proxy-config.json');
        if (fs.existsSync(proxyConfigPath)) {
          const proxyConfig = JSON.parse(fs.readFileSync(proxyConfigPath, 'utf8'));
          console.log('应用上次保存的代理状态:', proxyConfig.enabled);
          
          if (proxyConfig.enabled) {
            // 启用系统代理
            execSync('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f');
            execSync('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ /d "127.0.0.1:7890" /f');
            mainWindow.webContents.send('proxy-status', true);
          } else {
            // 禁用系统代理
            execSync('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f');
            mainWindow.webContents.send('proxy-status', false);
          }
        }
      } catch (error) {
        console.error('应用上次代理状态失败:', error);
      }
    }
  } catch (error) {
    console.error('自动启动Mihomo失败:', error);
    if (mainWindow) {
      mainWindow.webContents.send('mihomo-autostart', {
        success: false,
        error: error.message
      });
    }
  }
}

// 获取订阅列表
function getSubscriptionList() {
  return new Promise((resolve) => {
    if (!fs.existsSync(configDir)) {
      resolve([]);
      return;
    }
    
    const subscriptions = fs.readdirSync(configDir)
      .filter(file => file.endsWith('.yaml'))
      .map(file => ({
        name: file.replace('.yaml', ''),
        path: path.join(configDir, file)
      }));
    
    resolve(subscriptions);
  });
}

// 解析YAML配置文件
function parseConfigFile(filePath) {
  try {
    const fileContent = fs.readFileSync(filePath, 'utf8');
    
    // 使用js-yaml解析
    let yaml;
    try {
      yaml = require('js-yaml');
    } catch (e) {
      console.error('js-yaml模块未安装，无法解析配置');
      return null;
    }
    
    const config = yaml.load(fileContent);
    if (!config) {
      return null;
    }
    
    // 提取所有代理组和节点，保持原始顺序
    const proxyGroups = [];
    
    if (config["proxy-groups"] && Array.isArray(config["proxy-groups"])) {
      for (const group of config["proxy-groups"]) {
        if (group.name && (group.type === 'select' || group.type === 'url-test' || group.type === 'fallback')) {
          proxyGroups.push({
            name: group.name,
            type: group.type,
            proxies: group.proxies || []
          });
        }
      }
    }
    
    // 提取所有代理节点
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
    
      return {
      proxyGroups,
      proxies
    };
  } catch (error) {
    console.error('解析配置文件失败:', error);
    return null;
  }
}

// 新增: 获取配置文件中的原始代理组顺序
ipcMain.handle('get-config-order', async (event) => {
  try {
    // 如果Mihomo未运行，没有活跃的配置文件
    if (!configFilePath) {
            return {
        success: false,
        error: 'Mihomo未运行，没有活跃的配置文件'
      };
    }
    
    // 解析配置文件
    const configData = parseConfigFile(configFilePath);
    if (!configData) {
      return {
        success: false,
        error: '解析配置文件失败'
      };
    }
    
    return {
      success: true,
      data: configData
    };
  } catch (error) {
    console.error('获取配置顺序失败:', error);
    return {
      success: false,
      error: `获取配置顺序失败: ${error.message}`
    };
  }
});

// 新增: 获取当前配置
async function getConfig() {
  try {
    if (!configFilePath || !fs.existsSync(configFilePath)) {
      console.log('当前没有活跃的配置文件');
      return null;
    }
    
    // 读取配置文件
    const content = fs.readFileSync(configFilePath, 'utf8');
    
    if (!content || content.trim() === '') {
      console.error('配置文件为空');
      return null;
    }
    
    // 解析YAML
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

// 更新流量统计
function updateTrafficStats() {
  // 如果WebSocket已经连接，不需要重新连接
  if (trafficWebSocket && trafficWebSocket.readyState === 1) { // 1 = OPEN
    return;
  }

  // 使用标准的WebSocket地址
  const wsUrl = 'ws://127.0.0.1:9090/traffic';
  
  // 创建流量统计WebSocket
  trafficWebSocket = new WebSocket(wsUrl);

  trafficWebSocket.on('open', () => {
    console.log('流量统计WebSocket连接已建立');
    trafficRetry = 10; // 重置重试计数
  });

  trafficWebSocket.on('message', (data) => {
    try {
      const json = JSON.parse(data);
      
      // 确保数据格式正确
      if (!json || typeof json.up !== 'number' || typeof json.down !== 'number') {
        console.error('无效的流量数据格式');
        return;
      }

      // 更新统计数据
      const stats = {
        up: json.up,
        down: json.down,
        timestamp: Date.now(),
        upSpeed: json.up,
        downSpeed: json.down
      };

      lastTrafficStats = stats;
      
      // 发送更新到主窗口
      if (mainWindow) {
        mainWindow.webContents.send('traffic-update', stats);
      }
      
      // 每当收到流量更新时，同时获取总流量数据
      fetchConnectionsInfo();
      
      // 只在流量变化较大时输出日志（大于10MB的变化）
      const significantChange = Math.abs(stats.up - lastTrafficStats.up) > 10 * 1024 * 1024 || 
                               Math.abs(stats.down - lastTrafficStats.down) > 10 * 1024 * 1024;
      if (significantChange) {
        console.log(`流量更新: 上传 ${formatTraffic(stats.up)}, 下载 ${formatTraffic(stats.down)}`);
      }
    } catch (error) {
      console.error('处理流量数据时出错:', error);
    }
  });

  trafficWebSocket.on('close', () => {
    // 只在第一次关闭时输出日志
    if (trafficRetry === 10) {
      console.log('流量统计WebSocket连接已关闭');
    }
    trafficWebSocket = null;

    if (trafficRetry > 0) {
      trafficRetry--;
      // 只在第一次和最后一次重试时输出日志
      if (trafficRetry === 9 || trafficRetry === 0) {
        console.log(`尝试重新连接WebSocket，剩余重试次数: ${trafficRetry}`);
      }
      updateTrafficStats();
    } else {
      console.log('WebSocket重连次数已达上限，停止重试');
    }
  });

  trafficWebSocket.on('error', (error) => {
    console.error('流量统计WebSocket错误:', error);
    if (trafficWebSocket) {
      trafficWebSocket.close();
      trafficWebSocket = null;
    }
  });
}

// 设置定时更新流量统计
let trafficStatsInterval;
function startTrafficStatsUpdate() {
  if (trafficStatsInterval) {
    clearInterval(trafficStatsInterval);
  }
  
  // 初始化WebSocket连接
  updateTrafficStats();
  
  // 设置定时器，每1秒检查一次WebSocket连接状态
  trafficStatsInterval = setInterval(() => {
    if (!trafficWebSocket || trafficWebSocket.readyState !== 1) {
      // 移除重连日志，避免刷屏
      updateTrafficStats();
    }
  }, 1000); // 每1秒检查一次
}

function stopTrafficStatsUpdate() {
  if (trafficStatsInterval) {
    clearInterval(trafficStatsInterval);
    trafficStatsInterval = null;
  }
  
  if (trafficWebSocket) {
    trafficWebSocket.close();
    trafficWebSocket = null;
  }
}

// 启动连接管理WebSocket
async function startConnectionsWebSocket() {
  try {
    if (!currentNode) {
      throw new Error('未选择节点');
    }

    // 创建新的WebSocket连接
    connectionsWebSocket = new WebSocket(`ws://localhost:8080/connections/${currentNode}`);
    
    // 设置连接超时
    const connectionTimeout = setTimeout(() => {
      if (connectionsWebSocket.readyState !== WebSocket.OPEN) {
        connectionsWebSocket.close();
        throw new Error('连接超时');
      }
    }, 5000);

    // 连接建立
    connectionsWebSocket.on('open', () => {
      clearTimeout(connectionTimeout);
      console.log(`已连接到节点 ${currentNode}`);
    });

    // 连接关闭
    connectionsWebSocket.on('close', () => {
      console.log(`与节点 ${currentNode} 的连接已关闭`);
      // 尝试重新连接
      setTimeout(() => {
        if (currentNode) {
          startConnectionsWebSocket().catch(console.error);
        }
      }, 5000);
    });

    // 错误处理
    connectionsWebSocket.on('error', (error) => {
      console.error('WebSocket错误:', error);
      clearTimeout(connectionTimeout);
    });

  } catch (error) {
    console.error('启动WebSocket连接失败:', error);
    throw error;
  }
}

// 更新当前节点信息
async function updateCurrentNodeInfo() {
  try {
    // 使用正确的API端点获取PROXY组信息
    const response = await fetch('http://127.0.0.1:9090/proxies/PROXY');
    if (response.ok) {
      const data = await response.json();
      console.log('获取到PROXY组信息:', data);
      
      if (data && data.now) {
        currentNode = data.now;
        console.log('更新当前节点为:', currentNode);
        
        // 更新lastConnectionsInfo中的节点信息
        lastConnectionsInfo = {
          ...lastConnectionsInfo,
          currentNode: currentNode
        };
        
        // 通知主窗口节点已更新
        if (mainWindow && mainWindow.webContents && !mainWindow.isDestroyed()) {
          console.log('发送节点变更事件:', currentNode);
          
          // 立即发送节点更新
          mainWindow.webContents.send('node-changed', { nodeName: currentNode });
          
          // 添加延迟，确保前端有足够时间处理节点更新
          setTimeout(() => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              console.log('延迟发送连接信息更新:', lastConnectionsInfo);
              mainWindow.webContents.send('connections-update', lastConnectionsInfo);
            }
          }, 500);
        } else {
          console.warn('主窗口未准备好，无法发送节点变更事件');
        }
      } else {
        console.error('PROXY组信息中没有now字段:', data);
      }
    } else {
      console.error('获取PROXY组信息失败:', response.status, response.statusText);
    }
  } catch (error) {
    console.error('获取当前节点信息失败:', error);
  }
}

// 停止连接管理WebSocket
function stopConnectionsWebSocket() {
  if (connectionsWebSocket) {
    connectionsWebSocket.close();
    connectionsWebSocket = null;
  }
  connectionsRetry = 10;
}

// 添加检查Mihomo服务状态的函数
async function checkMihomoService() {
  try {
    const response = await fetch('http://127.0.0.1:9090/proxies');
    if (response.ok) {
      return true;
    }
    return false;
  } catch (error) {
    console.error('[DEBUG] Mihomo服务检查失败:', error);
    return false;
  }
}

app.whenReady().then(() => {
  // 加载主题设置
  const themeSource = nativeTheme.themeSource;
  console.log('应用启动时的主题设置:', themeSource);

  // 创建主窗口
  createWindow();
  
  // 设置系统托盘
  setupTray();
  
  // 定期更新托盘菜单 (每60秒更新一次，保持节点延迟信息最新)
  setInterval(updateTrayMenu, 60000);
  
  startConnectionsWebSocket(); // 启动连接管理

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // IPC事件处理
  ipcMain.handle('start-mihomo', (event, configPath) => {
    return startMihomo(configPath);
  });

  ipcMain.handle('stop-mihomo', () => {
    if (mihomoProcess) {
      mihomoProcess.kill();
      mihomoProcess = null;
      stopTrafficStatsUpdate();
      return true;
    }
    return false;
  });

  // 添加: 主题设置
  ipcMain.handle('set-theme', (event, theme) => {
    try {
      console.log('设置主题:', theme);
      if (!mainWindow || mainWindow.isDestroyed()) {
        return { success: false, error: '窗口不存在' };
      }

      // 保存主题设置到配置文件
      const themeConfigPath = path.join(userDataPath, 'theme-config.json');
      fs.writeFileSync(themeConfigPath, JSON.stringify({ theme }), 'utf8');
      
      // 根据主题更新窗口
      switch (theme) {
        case 'light':
          nativeTheme.themeSource = 'light';
          mainWindow.webContents.send('theme-changed', 'light');
          break;
        case 'dark':
          nativeTheme.themeSource = 'dark';
          mainWindow.webContents.send('theme-changed', 'dark');
          break;
        case 'system':
        default:
          nativeTheme.themeSource = 'system';
          mainWindow.webContents.send('theme-changed', nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
          break;
      }

      // 更新标题栏颜色
      mainWindow.setTitleBarOverlay({
        color: nativeTheme.shouldUseDarkColors ? '#1a1a1a' : '#f9f9f9',
        symbolColor: nativeTheme.shouldUseDarkColors ? '#f3f4f6' : '#000000',
        height: 48
      });

      return { success: true, theme };
    } catch (error) {
      console.error('设置主题失败:', error);
      return { success: false, error: error.message };
    }
  });
  
  // 添加: 获取当前主题设置
  ipcMain.handle('get-theme', () => {
    try {
      // 从配置文件读取主题设置
      const themeConfigPath = path.join(userDataPath, 'theme-config.json');
      if (fs.existsSync(themeConfigPath)) {
        const themeConfig = JSON.parse(fs.readFileSync(themeConfigPath, 'utf8'));
        return { success: true, theme: themeConfig.theme || 'system' };
      }
      
      // 默认返回系统设置
      return { success: true, theme: 'system' };
    } catch (error) {
      console.error('获取主题设置失败:', error);
      return { success: false, theme: 'system', error: error.message };
    }
  });

  ipcMain.handle('save-subscription', (event, subUrl, configData, customName) => {
    // 添加调试输出
    console.log('保存订阅 - URL:', subUrl);
    console.log('保存订阅 - 自定义名称:', customName);
    
    // 如果提供了自定义名称，使用它作为文件名，否则使用时间戳
    const fileName = customName 
      ? `${customName.replace(/[^\w\u4e00-\u9fa5\-\.]/g, '_')}.yaml` // 替换非法字符
      : `sub_${Date.now()}.yaml`;
    
    console.log('保存订阅 - 最终文件名:', fileName);
    
    const filePath = path.join(configDir, fileName);
    fs.writeFileSync(filePath, configData);
    
    // 保存订阅URL到记录文件
    try {
      // 读取订阅URL记录文件（如果存在）
      const urlsPath = path.join(configDir, 'subscription_urls.json');
      let urlsData = {};
      if (fs.existsSync(urlsPath)) {
        urlsData = JSON.parse(fs.readFileSync(urlsPath, 'utf8'));
      }
      
      // 更新URL记录
      urlsData[fileName] = subUrl;
      
      // 保存更新后的记录
      fs.writeFileSync(urlsPath, JSON.stringify(urlsData, null, 2), 'utf8');
      console.log(`订阅URL已记录: ${fileName} -> ${subUrl}`);
    } catch (error) {
      console.warn('保存订阅URL记录失败:', error);
    }
    
    return filePath;
  });

  ipcMain.handle('get-subscriptions', () => {
    if (!fs.existsSync(configDir)) return [];
    
    return fs.readdirSync(configDir)
      .filter(file => file.endsWith('.yaml'))
      .map(file => ({
        name: file.replace('.yaml', ''),
        path: path.join(configDir, file)
      }));
  });

  ipcMain.handle('delete-subscription', (event, filePath) => {
    try {
      fs.unlinkSync(filePath);
      return true;
    } catch (error) {
      console.error(`Failed to delete ${filePath}:`, error);
      return false;
    }
  });

  ipcMain.handle('get-traffic-stats', () => {
    return lastTrafficStats;
  });

  // 新增：从主进程获取订阅内容
  ipcMain.handle('fetch-subscription', async (event, subUrl) => {
    try {
      const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
      
      // 确保订阅URL有效
      if (!subUrl || !subUrl.startsWith('http')) {
        throw new Error('无效的订阅URL');
      }
      
      console.log('正在获取订阅内容...');
      const response = await fetch(subUrl);
      
      if (!response.ok) {
        throw new Error(`获取订阅失败: ${response.statusText}`);
      }
      
      const content = await response.text();
      
      if (!content || content.trim() === '') {
        throw new Error('订阅内容为空');
      }
      
      // 检查获取的内容是否是有效的YAML或JSON
      try {
        yaml.load(content);
      } catch (yamlError) {
        try {
          JSON.parse(content);
        } catch (jsonError) {
          throw new Error('订阅内容格式无效，不是有效的YAML或JSON');
        }
      }
      
      console.log('订阅内容获取成功');
      return content;
    } catch (error) {
      console.error('获取订阅失败:', error);
      return null;
    }
  });

  ipcMain.handle('open-external', (event, url) => {
    shell.openExternal(url);
    return { success: true };
  });

  // 新增：打开文件
  ipcMain.handle('open-file', (event, filePath) => {
    try {
      // 在Windows上，使用shell.openPath打开文件
      shell.openPath(filePath);
      return { success: true };
    } catch (error) {
      console.error('打开文件失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 新增：打开文件所在目录
  ipcMain.handle('open-file-location', (event, filePath) => {
    try {
      // 在Windows上，使用shell.showItemInFolder打开文件所在目录
      shell.showItemInFolder(filePath);
      return { success: true };
    } catch (error) {
      console.error('打开文件所在目录失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 新增：更新指定的订阅
  ipcMain.handle('refresh-subscription', async (event, filePath) => {
    try {
      // 获取订阅URL
      // 直接调用get-subscription-url处理程序函数
      const getSubscriptionUrlHandler = async (filePath) => {
        try {
          // 获取文件名
          const fileName = path.basename(filePath);
          
          // 读取订阅URL记录
          const urlsPath = path.join(configDir, 'subscription_urls.json');
          if (!fs.existsSync(urlsPath)) {
            console.log('订阅URL记录文件不存在，尝试创建新记录');
            
            // 创建一个空的记录文件
            fs.writeFileSync(urlsPath, JSON.stringify({}, null, 2), 'utf8');
            
            // 对于旧版本添加的订阅，我们可以提示用户重新添加
            return { success: false, error: '未找到订阅URL记录。这可能是因为此订阅是在旧版本添加的，请尝试删除并重新添加订阅。' };
          }
          
          // 解析记录文件
          const urlsData = JSON.parse(fs.readFileSync(urlsPath, 'utf8'));
          
          // 首先尝试使用完整文件名查找
          let url = urlsData[fileName];
          
          // 如果找不到，尝试只使用文件名部分（不包含路径）
          if (!url) {
            const fileNameOnly = fileName.replace(/\.yaml$/, '');
            for (const [key, value] of Object.entries(urlsData)) {
              const keyWithoutExt = key.replace(/\.yaml$/, '');
              if (keyWithoutExt === fileNameOnly) {
                url = value;
                
                // 更新记录以使用正确的文件名
                urlsData[fileName] = value;
                fs.writeFileSync(urlsPath, JSON.stringify(urlsData, null, 2), 'utf8');
                break;
              }
            }
          }
          
          if (!url) {
            console.log(`未找到文件 ${fileName} 对应的订阅URL`);
            return { success: false, error: '未找到对应的订阅URL。请尝试删除并重新添加订阅。' };
          }
          
          console.log(`找到文件 ${fileName} 对应的订阅URL: ${url}`);
          return { success: true, url };
        } catch (error) {
          console.error('获取订阅URL失败:', error);
          return { success: false, error: error.message };
        }
      };
      
      const urlResult = await getSubscriptionUrlHandler(filePath);
      
      if (!urlResult.success || !urlResult.url) {
        return { success: false, error: urlResult.error || '无法获取订阅URL' };
      }
      
      const subUrl = urlResult.url;
      console.log(`准备刷新订阅: ${filePath}, URL: ${subUrl}`);
      
      // 获取订阅内容
      const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
      
      // 确保订阅URL有效
      if (!subUrl || !subUrl.startsWith('http')) {
        throw new Error('无效的订阅URL');
      }
      
      console.log('正在获取订阅内容...');
      const response = await fetch(subUrl, {
        headers: {
          'User-Agent': 'FlyClash/0.1.0'
        }
      });
      
      if (!response.ok) {
        throw new Error(`获取订阅失败: ${response.statusText}`);
      }
      
      const configData = await response.text();
      
      if (!configData || configData.trim() === '') {
        throw new Error('订阅内容为空');
      }
      
      // 检查获取的内容是否是有效的YAML或JSON
      try {
        yaml.load(configData);
      } catch (yamlError) {
        try {
          JSON.parse(configData);
        } catch (jsonError) {
          throw new Error('订阅内容格式无效，不是有效的YAML或JSON');
        }
      }
      
      // 直接实现更新订阅文件的功能，而不是调用updateSubscription
      try {
        // 确保文件路径和配置数据有效
        if (!filePath || !configData) {
          throw new Error('无效的文件路径或配置数据');
        }
        
        console.log('正在更新订阅文件:', filePath);
        
        // 备份原始文件
        const backupPath = `${filePath}.bak`;
        if (fs.existsSync(filePath)) {
          fs.copyFileSync(filePath, backupPath);
        }
        
        // 写入新的配置内容
        fs.writeFileSync(filePath, configData, 'utf8');
        
        // 更新订阅URL的记录（如果有记录系统）
        if (subUrl) {
          try {
            // 读取订阅URL记录文件（如果存在）
            const urlsPath = path.join(configDir, 'subscription_urls.json');
            let urlsData = {};
            if (fs.existsSync(urlsPath)) {
              urlsData = JSON.parse(fs.readFileSync(urlsPath, 'utf8'));
            }
            
            // 更新URL记录
            urlsData[path.basename(filePath)] = subUrl;
            
            // 保存更新后的记录
            fs.writeFileSync(urlsPath, JSON.stringify(urlsData, null, 2), 'utf8');
          } catch (error) {
            console.warn('更新订阅URL记录失败，但配置文件已更新:', error);
          }
        }
        
        console.log('订阅更新成功');
        return { success: true, filePath };
      } catch (error) {
        console.error('更新订阅失败:', error);
        // 如果有备份，尝试恢复
        const backupPath = `${filePath}.bak`;
        if (fs.existsSync(backupPath)) {
          try {
            fs.copyFileSync(backupPath, filePath);
            console.log('已从备份恢复原始文件');
          } catch (restoreError) {
            console.error('从备份恢复失败:', restoreError);
          }
        }
        return { success: false, error: error.message };
      }
    } catch (error) {
      console.error('刷新订阅失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 切换节点
  ipcMain.handle('select-node', async (event, nodeName, groupName, updateGlobal = false) => {
    try {
      console.log(`切换节点: ${nodeName} 在组 ${groupName}`);
      
      if (!groupName) {
        groupName = 'PROXY'; // 默认使用PROXY组
      }
      
      // 切换指定组的节点
      const response = await fetch(`http://127.0.0.1:9090/proxies/${encodeURIComponent(groupName)}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ name: nodeName })
      });

      if (!response.ok) {
        throw new Error(`切换节点失败: ${response.statusText}`);
      }
      
      console.log(`成功切换到节点: ${nodeName} 在组 ${groupName}`);
      
      // 如果是PROXY或GLOBAL组，或者要求更新全局节点，更新当前节点变量
      if (groupName === 'PROXY' || groupName === 'GLOBAL' || updateGlobal) {
        currentNode = nodeName;
        console.log('更新当前节点:', currentNode);
        
        // 更新托盘菜单
        updateTrayMenu();
      }
      
      return { success: true };
    } catch (error) {
      console.error('选择节点失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 新增：接收节点变更通知
  ipcMain.handle('notify-node-changed', async (event, nodeName) => {
    try {
      console.log(`接收到节点变更通知: ${nodeName}`);
      
      // 更新当前节点
      currentNode = nodeName;
      
      // 更新托盘菜单以反映新节点
      updateTrayMenu();
      
      return { success: true };
    } catch (error) {
      console.error('处理节点变更通知失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 新增：获取代理节点信息
  ipcMain.handle('get-proxies', async (event) => {
    try {
      console.log(`[DEBUG] 开始获取代理节点信息`);
      
      // 检查Mihomo服务状态
      const isServiceRunning = await checkMihomoService();
      if (!isServiceRunning) {
        console.error('[DEBUG] Mihomo服务未运行');
        throw new Error('Mihomo服务未运行，请先启动Mihomo');
      }
      
      // 使用fetch API获取代理节点信息
      const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
      
      // 获取代理节点信息
      const response = await fetch('http://127.0.0.1:9090/proxies');
      const data = await response.json();
      
      console.log(`[DEBUG] 获取代理节点信息成功`);
      
      // 处理数据，提取节点组和当前选中的节点
      const groups = [];
      let selected = null;
      
      // 首先查找PROXY组
      if (data.proxies && data.proxies['PROXY']) {
        const proxyGroup = data.proxies['PROXY'];
        selected = proxyGroup.now;
        
        // 提取节点组
        if (proxyGroup.all && proxyGroup.all.length > 0) {
          const nodes = [];
          for (const nodeName of proxyGroup.all) {
            if (data.proxies[nodeName]) {
              const node = data.proxies[nodeName];
              nodes.push({
                name: nodeName,
                type: node.type,
                server: node.server || '',
                port: node.port || 0,
                delay: node.delay || undefined
              });
            }
          }
          
          groups.push({
            name: 'PROXY',
            type: proxyGroup.type,
            nodes: nodes
          });
        }
      }
      // 如果PROXY组不存在，则查找GLOBAL组作为备选
      else if (data.proxies && data.proxies['GLOBAL']) {
        const globalGroup = data.proxies['GLOBAL'];
        selected = globalGroup.now;
        
        // 提取节点组
        if (globalGroup.all && globalGroup.all.length > 0) {
          const nodes = [];
          for (const nodeName of globalGroup.all) {
            if (data.proxies[nodeName]) {
              const node = data.proxies[nodeName];
              nodes.push({
                name: nodeName,
                type: node.type,
                server: node.server || '',
                port: node.port || 0,
                delay: node.delay || undefined
              });
            }
          }
          
          groups.push({
            name: 'GLOBAL',
            type: globalGroup.type,
            nodes: nodes
          });
        }
      }
      
      // 提取其他节点组
      for (const [name, proxy] of Object.entries(data.proxies)) {
        if (proxy.type === 'Selector' || proxy.type === 'URLTest' || proxy.type === 'Fallback' || proxy.type === 'LoadBalance') {
          if (name !== 'GLOBAL' && name !== 'PROXY' && proxy.all && proxy.all.length > 0) {
            const nodes = [];
            for (const nodeName of proxy.all) {
              if (data.proxies[nodeName]) {
                const node = data.proxies[nodeName];
                nodes.push({
                  name: nodeName,
                  type: node.type,
                  server: node.server || '',
                  port: node.port || 0,
                  delay: node.delay || undefined
                });
              }
            }
            
            groups.push({
              name: name,
              type: proxy.type,
              nodes: nodes
            });
          }
        }
      }
      
      return {
        groups: groups,
        selected: selected
      };
    } catch (error) {
      console.error(`[DEBUG] 获取代理节点信息失败:`, error);
      return { groups: [], selected: null };
    }
  });

  // 测试节点延迟
  ipcMain.handle('test-node-delay', async (event, nodeName) => {
    try {
      console.log(`[DEBUG] 开始测试节点延迟: ${nodeName}`);
      
      // 检查Mihomo服务状态
      const isServiceRunning = await checkMihomoService();
      if (!isServiceRunning) {
        console.error('[DEBUG] Mihomo服务未运行，无法测试节点延迟');
        throw new Error('Mihomo服务未运行，无法测试节点延迟');
      }
      
      // 使用fetch API测试节点延迟
          const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
      
      // 设置URL和参数
      const url = new URL(`http://127.0.0.1:9090/proxies/${encodeURIComponent(nodeName)}/delay`);
      url.searchParams.append('url', 'http://www.gstatic.com/generate_204');
      url.searchParams.append('timeout', '5000');
      
      // 发送请求
      console.log(`[DEBUG] 发送测试延迟请求: ${url.toString()}`);
      const response = await fetch(url.toString());
      
      // 处理响应
          if (response.ok) {
            const data = await response.json();
        console.log(`[DEBUG] 节点 ${nodeName} 延迟测试结果: ${data.delay}ms`);
        
        // 返回延迟结果
        return data.delay;
          } else {
        const errorText = await response.text();
        console.error(`[DEBUG] 测试节点延迟失败: ${response.status} ${response.statusText} - ${errorText}`);
        throw new Error(`测试节点延迟失败: ${response.statusText}`);
          }
        } catch (error) {
      console.error(`[DEBUG] 测试节点延迟过程中出错:`, error);
      
      // 返回-1表示测试失败
          return -1;
    }
  });

  ipcMain.handle('get-active-config', () => {
    return configFilePath || null;
  });
  
  ipcMain.handle('get-proxy-nodes', (event, configPath) => {
    try {
      // 如果提供了配置路径，使用它；否则使用当前活跃的配置
      const targetPath = configPath || configFilePath;
      if (!targetPath || !fs.existsSync(targetPath)) {
        console.log('配置文件不存在:', targetPath);
        return null;
      }
      
      // 直接从配置文件中解析节点信息，而不是调用RESTful API
      // 这样即使mihomo未运行或崩溃，也能显示节点信息
      return parseConfigFile(targetPath);
    } catch (error) {
      console.error('获取代理节点失败:', error);
      return null;
    }
  });
  
  // 设置是否自动启动
  ipcMain.handle('set-auto-start', (event, enabled) => {
    autoStartEnabled = !!enabled;
    // 可以将设置保存到配置文件中，这里简化处理
    return true;
  });
  
  // 获取自动启动设置
  ipcMain.handle('get-auto-start', () => {
    return autoStartEnabled;
  });
  
  // 节点收藏管理
  ipcMain.handle('get-favorite-nodes', () => {
    try {
      const favoritesPath = path.join(userDataPath, 'favorites.json');
      if (!fs.existsSync(favoritesPath)) {
        console.log('收藏节点文件不存在');
        return { success: true, nodes: [] };
      }
      
      const favoritesData = JSON.parse(fs.readFileSync(favoritesPath, 'utf8'));
      console.log('成功加载收藏节点:', favoritesData);
      return { success: true, nodes: favoritesData };
    } catch (error) {
      console.error('获取收藏节点失败:', error);
      return { success: false, nodes: [], error: error.message };
    }
  });
  
  ipcMain.handle('save-favorite-nodes', (event, nodes) => {
    try {
      if (!Array.isArray(nodes)) {
        throw new Error('无效的节点数据格式');
      }
      
      const favoritesPath = path.join(userDataPath, 'favorites.json');
      fs.writeFileSync(favoritesPath, JSON.stringify(nodes), 'utf8');
      console.log('收藏节点保存成功:', nodes);
      return { success: true };
    } catch (error) {
      console.error('保存收藏节点失败:', error);
      return { success: false, error: error.message };
    }
  });
  
  // 节点组折叠管理
  ipcMain.handle('get-collapsed-groups', () => {
    try {
      const collapsedPath = path.join(userDataPath, 'collapsed-groups.json');
      if (!fs.existsSync(collapsedPath)) {
        console.log('折叠组文件不存在');
        return { success: true, groups: [] };
      }
      
      const collapsedData = JSON.parse(fs.readFileSync(collapsedPath, 'utf8'));
      console.log('成功加载折叠组:', collapsedData);
      return { success: true, groups: collapsedData };
    } catch (error) {
      console.error('获取折叠组失败:', error);
      return { success: false, groups: [], error: error.message };
    }
  });
  
  ipcMain.handle('save-collapsed-groups', (event, groups) => {
    try {
      if (!Array.isArray(groups)) {
        throw new Error('无效的组数据格式');
      }
      
      const collapsedPath = path.join(userDataPath, 'collapsed-groups.json');
      fs.writeFileSync(collapsedPath, JSON.stringify(groups), 'utf8');
      console.log('折叠组保存成功:', groups);
      return { success: true };
    } catch (error) {
      console.error('保存折叠组失败:', error);
      return { success: false, error: error.message };
    }
  });
  
  // 保存日志到文件
  ipcMain.handle('save-logs', (event, logEntries) => {
    try {
      const logsDir = path.join(userDataPath, 'logs');
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }
      
      const date = new Date();
      const fileName = `mihomo-logs-${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}-${String(date.getHours()).padStart(2, '0')}-${String(date.getMinutes()).padStart(2, '0')}.txt`;
      const filePath = path.join(logsDir, fileName);
      
      // 格式化日志内容
      const logContent = logEntries.map(entry => {
        const timestamp = new Date(entry.timestamp).toLocaleString();
        const type = entry.type === 'error' ? '[错误]' : '[信息]';
        return `${timestamp} ${type} ${entry.content}`;
      }).join('\n');
      
      fs.writeFileSync(filePath, logContent, 'utf8');
      console.log(`日志已保存到: ${filePath}`);
      
      return { success: true, filePath };
    } catch (error) {
      console.error('保存日志失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 新增: 切换系统代理
  ipcMain.handle('toggleSystemProxy', async (event, enabled) => {
    try {
      if (enabled) {
        // 启用系统代理，默认端口7890
        execSync('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f');
        execSync('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ /d "127.0.0.1:7890" /f');
        mainWindow.webContents.send('proxy-status', true);
        
        // 保存代理状态到配置文件
        try {
          const proxyConfigPath = path.join(userDataPath, 'proxy-config.json');
          fs.writeFileSync(proxyConfigPath, JSON.stringify({ enabled: true }, null, 2), 'utf8');
          console.log('已保存代理状态: 启用');
        } catch (err) {
          console.error('保存代理状态失败:', err);
        }
        
        return true;
      } else {
        // 禁用系统代理
        execSync('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f');
        mainWindow.webContents.send('proxy-status', false);
        
        // 保存代理状态到配置文件
        try {
          const proxyConfigPath = path.join(userDataPath, 'proxy-config.json');
          fs.writeFileSync(proxyConfigPath, JSON.stringify({ enabled: false }, null, 2), 'utf8');
          console.log('已保存代理状态: 禁用');
        } catch (err) {
          console.error('保存代理状态失败:', err);
        }
        
        return true;
      }
    } catch (error) {
      console.error('切换系统代理失败:', error);
      return false;
    }
  });

  // 新增: 获取系统代理状态
  ipcMain.handle('getProxyStatus', async () => {
    try {
      // 首先尝试从配置文件中读取
      const proxyConfigPath = path.join(userDataPath, 'proxy-config.json');
      
      if (fs.existsSync(proxyConfigPath)) {
        try {
          const proxyConfig = JSON.parse(fs.readFileSync(proxyConfigPath, 'utf8'));
          console.log('从配置文件读取代理状态:', proxyConfig.enabled);
          
          // 如果配置文件中的状态与系统不一致，则同步系统代理状态
          const systemResult = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable').toString();
          const systemEnabled = systemResult.includes('0x1');
          
          if (proxyConfig.enabled !== systemEnabled) {
            console.log('代理配置与系统状态不一致，同步系统状态');
            if (proxyConfig.enabled) {
              execSync('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f');
              execSync('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ /d "127.0.0.1:7890" /f');
            } else {
              execSync('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f');
            }
          }
          
          return proxyConfig.enabled;
        } catch (parseError) {
          console.error('解析代理配置文件失败:', parseError);
        }
      }
      
      // 如果无法从配置文件中读取，则从系统中读取当前状态
      const result = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable').toString();
      const enabled = result.includes('0x1');
      
      // 将当前系统状态保存到配置文件
      try {
        fs.writeFileSync(proxyConfigPath, JSON.stringify({ enabled }, null, 2), 'utf8');
        console.log('已保存系统当前代理状态:', enabled);
      } catch (saveError) {
        console.error('保存代理状态失败:', saveError);
      }
      
      return enabled;
    } catch (error) {
      console.error('获取系统代理状态失败:', error);
      return false;
    }
  });

  // 添加获取连接信息的函数
  ipcMain.handle('get-connections', async () => {
    try {
      const response = await fetch('http://127.0.0.1:9090/connections');
      if (response.ok) {
        const data = await response.json();
        console.log('获取到连接信息:', data); // 添加日志
        return data;
      } else {
        console.error('获取连接信息失败:', response.status, response.statusText);
        return null;
      }
    } catch (error) {
      console.error('获取连接信息失败:', error);
      return null;
    }
  });

  // 添加关闭特定连接的函数
  ipcMain.handle('close-connection', async (event, connectionId) => {
    try {
      console.log(`尝试关闭连接: ${connectionId}`); // 添加日志
      const response = await fetch(`http://127.0.0.1:9090/connections/${connectionId}`, {
        method: 'DELETE'
      });
      const success = response.ok;
      console.log(`关闭连接结果: ${success ? '成功' : '失败'}`); // 添加日志
      return success;
    } catch (error) {
      console.error('关闭连接失败:', error);
      return false;
    }
  });

  // 添加关闭所有连接的函数
  ipcMain.handle('close-all-connections', async () => {
    try {
      console.log('尝试关闭所有连接'); // 添加日志
      const response = await fetch('http://127.0.0.1:9090/connections', {
        method: 'DELETE'
      });
      const success = response.ok;
      console.log(`关闭所有连接结果: ${success ? '成功' : '失败'}`); // 添加日志
      return success;
    } catch (error) {
      console.error('关闭所有连接失败:', error);
      return false;
    }
  });

  // 处理连接信息更新
  ipcMain.on('connections-update', (event, data) => {
    if (mainWindow) {
      console.log('主进程发送连接信息更新:', data);
      mainWindow.webContents.send('connections-update', {
        connections: data.connections || [],
        downloadTotal: data.downloadTotal || 0,
        uploadTotal: data.uploadTotal || 0,
        currentNode: currentNode,
        activeConnections: data.connections ? data.connections.filter(conn => conn.isActive).length : 0
      });
    }
  });

  // 处理节点变更
  ipcMain.on('node-changed', (event, data) => {
    if (mainWindow) {
      console.log('主进程发送节点变更:', data);
      // 更新当前节点
      if (data && data.nodeName) {
        currentNode = data.nodeName;
      }
      
      mainWindow.webContents.send('node-changed', {
        nodeName: data && data.nodeName ? data.nodeName : (currentNode || '无')
      });
      
      // 同时更新连接信息
      const connectionInfo = {
        ...lastConnectionsInfo,
        currentNode: currentNode
      };
      mainWindow.webContents.send('connections-update', connectionInfo);
    }
  });

  // 新增：获取总连接信息和总流量
  ipcMain.handle('fetch-connections-info', async () => {
    return fetchConnectionsInfo();
  });

  // 添加API保存最后一次使用的配置文件
  ipcMain.handle('save-last-config', (event, configPath) => {
    try {
      if (!configPath) {
        console.log('无效的配置路径，无法保存');
        return { success: false, error: '无效的配置路径' };
      }
      
      // 保存配置路径到用户数据目录
      const lastConfigPath = path.join(userDataPath, 'last-config.json');
      fs.writeFileSync(lastConfigPath, JSON.stringify({ path: configPath }, null, 2), 'utf8');
      console.log('已保存最后使用的配置文件:', configPath);
      
      return { success: true };
    } catch (error) {
      console.error('保存最后使用的配置文件失败:', error);
      return { success: false, error: error.message };
    }
  });
});

app.on('window-all-closed', () => {
  stopConnectionsWebSocket(); // 停止连接管理
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  if (mihomoProcess) {
    mihomoProcess.kill();
  }
  
  // 关闭静态文件服务器
  if (global.staticServer && global.staticServer.listening) {
    console.log('关闭静态文件服务器');
    global.staticServer.close();
  }
  
  // 确保退出时关闭系统代理
  try {
    execSync('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f');
  } catch (error) {
    console.error('Failed to disable system proxy on exit:', error);
  }
}); 

async function switchNode(nodeName) {
  try {
    // 关闭现有连接
    if (connectionsWebSocket) {
      connectionsWebSocket.close();
      connectionsWebSocket = null;
    }

    // 更新当前节点
    currentNode = nodeName;
    
    // 重新建立连接
    await startConnectionsWebSocket();
    
    // 更新UI
    if (mainWindow) {
      mainWindow.webContents.send('node-switched', { node: nodeName });
    }
    
    // 更新托盘提示和菜单
    if (tray) {
      tray.setToolTip(`FlyClash - ${nodeName}`);
      // 更新托盘菜单以反映当前节点
      updateTrayMenu();
    }
    
    console.log(`已切换到节点: ${nodeName}`);
  } catch (error) {
    console.error('切换节点失败:', error);
    // 通知前端切换失败
    if (mainWindow) {
      mainWindow.webContents.send('node-switch-error', { 
        error: error.message,
        node: nodeName 
      });
    }
  }
}

// 获取总连接信息和总流量
async function fetchConnectionsInfo() {
  try {
    const response = await fetch('http://127.0.0.1:9090/connections');
    if (response.ok) {
      const data = await response.json();
      
      // 更新连接信息，包括总流量
      lastConnectionsInfo = {
        ...lastConnectionsInfo,
        downloadTotal: data.downloadTotal || 0,
        uploadTotal: data.uploadTotal || 0,
        connections: data.connections || [],
        activeConnections: data.connections ? data.connections.length : 0
      };
      
      // 发送更新到主窗口
      if (mainWindow) {
        mainWindow.webContents.send('connections-update', lastConnectionsInfo);
      }
    }
  } catch (error) {
    console.error('获取连接信息失败:', error);
  }
}

// 共享函数：使用HTTP服务器加载页面
async function loadPageWithServer(pageName) {
  try {
    // 如果已经有一个服务器在运行，关闭它
    if (global.staticServer && global.staticServer.listening) {
      global.staticServer.close();
    }
    
    // 创建静态文件服务
    const serve = serveStatic(path.join(__dirname, '../out'), { 
      index: ['index.html'], 
      extensions: ['html'],
      fallthrough: false // 添加此选项以返回404错误
    });
    
    // 创建服务器
    const server = http.createServer((req, res) => {
      // 记录请求
      console.log(`[静态服务器] ${req.method} ${req.url}`);
      
      // 处理静态文件请求
      serve(req, res, (err) => {
        if (err) {
          console.error('[静态服务器] 错误:', err);
          res.statusCode = err.status || 500;
          res.end(err.message);
          return;
        }
        finalhandler(req, res)(err);
      });
    });
    
    // 在随机端口上启动服务器
    const port = await new Promise((resolve) => {
      server.listen(0, () => {
        const address = server.address();
        console.log(`静态文件服务器运行在 http://localhost:${address.port}`);
        resolve(address.port);
      });
    });
    
    // 保存服务器引用，以便以后可以关闭它
    global.staticServer = server;
    
    // 确定要加载的URL路径
    let urlPath;
    switch (pageName) {
      case 'nodes':
        urlPath = '/nodes/';
        break;
      case 'settings':
        urlPath = '/settings/';
        break;
      case 'subscriptions':
        urlPath = '/subscriptions/';
        break;
      default:
        urlPath = '/';
        break;
    }
    
    // 加载URL
    const pageUrl = `http://localhost:${port}${urlPath}`;
    console.log(`加载页面URL: ${pageUrl}`);
    return mainWindow.loadURL(pageUrl);
  } catch (error) {
    console.error('加载页面失败:', error);
    throw error;
  }
} 