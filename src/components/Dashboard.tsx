import React, { useState, useEffect, useRef } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import * as Switch from '@radix-ui/react-switch';
import { 
  PlayIcon, 
  StopIcon, 
  ReloadIcon, 
  DownloadIcon, 
  UploadIcon,
  ClockIcon,
  LightningBoltIcon,
  GlobeIcon,
  InfoCircledIcon,
  FileTextIcon,
  DesktopIcon,
  BarChartIcon
} from '@radix-ui/react-icons';

// 引入 LogEntry 类型，无需重新定义 electronAPI
type LogEntry = {
  id: number;
  type: 'info' | 'error';
  content: string;
  timestamp: Date;
};

type TrafficData = {
  timestamp: number;
  up: number;
  down: number;
};

export default function Dashboard() {
  const [isRunning, setIsRunning] = useState(false);
  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [activeConfig, setActiveConfig] = useState<string | null>(null);
  const [subscriptions, setSubscriptions] = useState<Array<{name: string, path: string}>>([]);
  const [selectedConfig, setSelectedConfig] = useState<string | null>(null);
  const [currentNode, setCurrentNode] = useState<string | null>(null);
  const [trafficData, setTrafficData] = useState<TrafficData[]>([]);
  const [connectionCount, setConnectionCount] = useState(0);
  const [upstreamTraffic, setUpstreamTraffic] = useState(0);
  const [downstreamTraffic, setDownstreamTraffic] = useState(0);
  const [upSpeed, setUpSpeed] = useState(0);
  const [downSpeed, setDownSpeed] = useState(0);
  const [autoScroll, setAutoScroll] = useState(true);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [totalUpload, setTotalUpload] = useState(0);
  const [totalDownload, setTotalDownload] = useState(0);
  const logEndRef = useRef<HTMLDivElement>(null);
  const logIdCounterRef = useRef(0);
  
  // 获取所有配置文件
  useEffect(() => {
    const fetchSubscriptions = async () => {
      if (window.electronAPI) {
        try {
          const subs = await window.electronAPI.getSubscriptions();
          setSubscriptions(subs);
          
          // 先尝试从localStorage获取上次选择的配置
          const savedConfig = localStorage.getItem('selectedConfig');
          
          if (savedConfig) {
            // 检查保存的配置是否仍然存在于当前订阅列表中
            const configExists = subs.some(sub => sub.path === savedConfig);
            if (configExists) {
              setSelectedConfig(savedConfig);
            } else if (subs.length > 0) {
              // 如果已保存的配置不存在，则使用第一个配置
              setSelectedConfig(subs[0].path);
            }
          } else if (subs.length > 0 && !selectedConfig) {
            // 如果没有已保存的配置，则使用第一个配置
            setSelectedConfig(subs[0].path);
          }
        } catch (error) {
          console.error('获取订阅失败:', error);
          addLogEntry('error', `获取订阅失败: ${error}`);
        }
      }
    };
    
    fetchSubscriptions();
  }, []);
  
  // 保存选择的配置到localStorage
  useEffect(() => {
    if (selectedConfig) {
      localStorage.setItem('selectedConfig', selectedConfig);
    }
  }, [selectedConfig]);
  
  // 新增：从mihomo API获取当前节点信息
  const fetchCurrentNode = async () => {
    if (!window.electronAPI || !isRunning) return;
    
    try {
      console.log('正在从mihomo API获取当前节点信息...');
      
      // 第一步：获取配置文件中的代理组信息
      let firstProxyGroup = "PROXY"; // 默认尝试PROXY组
      
      if (window.electronAPI) {
        // 使用适当的类型声明获取配置顺序
        try {
          const result = await window.electronAPI.getConfigOrder();
          
          if (result.success && result.data && result.data.proxyGroups.length > 0) {
            // 获取配置文件中的第一个代理组名
            firstProxyGroup = result.data.proxyGroups[0].name;
            console.log(`从配置文件获取到第一个代理组: ${firstProxyGroup}`);
          } else {
            console.warn('无法从配置获取代理组信息，使用默认PROXY组');
          }
        } catch (error) {
          console.error('获取配置顺序出错:', error);
        }
      }
      
      // 第二步：尝试请求第一个代理组的信息
      try {
        console.log(`尝试请求代理组[${firstProxyGroup}]的信息...`);
        const response = await fetch(`http://127.0.0.1:9090/proxies/${firstProxyGroup}`);
        
        if (response.ok) {
          const data = await response.json();
          if (data && data.name && data.now) {
            console.log(`从mihomo API获取到当前节点: ${data.now}`);
            // 只有当节点有变化时才更新
            if (currentNode !== data.now) {
              console.log(`更新当前节点: ${currentNode} -> ${data.now}`);
              setCurrentNode(data.now);
              addLogEntry('info', `当前节点: ${data.now}`);
            }
            return;
          }
        } else {
          console.warn(`获取${firstProxyGroup}组信息失败: ${response.status} ${response.statusText}`);
        }
      } catch (error) {
        console.error(`请求${firstProxyGroup}组信息出错:`, error);
      }
      
      // 如果第一个组获取失败，尝试使用默认的PROXY组
      if (firstProxyGroup !== "PROXY") {
        try {
          console.log('尝试请求默认PROXY组的信息...');
          const response = await fetch('http://127.0.0.1:9090/proxies/PROXY');
          
          if (response.ok) {
            const data = await response.json();
            if (data && data.now) {
              console.log(`从默认PROXY组获取到当前节点: ${data.now}`);
              // 只有当节点有变化时才更新
              if (currentNode !== data.now) {
                console.log(`更新当前节点: ${currentNode} -> ${data.now}`);
                setCurrentNode(data.now);
                addLogEntry('info', `当前节点: ${data.now}`);
              }
              return;
            }
          }
        } catch (error) {
          console.error('请求默认PROXY组信息出错:', error);
        }
      }
      
      // 如果还是获取失败，尝试获取所有代理组信息
      try {
        console.log('尝试获取所有代理组信息...');
        const response = await fetch('http://127.0.0.1:9090/proxies');
        
        if (response.ok) {
          const data = await response.json();
          if (data && data.proxies) {
            // 查找类型为Selector的代理组
            const selectorGroups = Object.entries(data.proxies).filter(
              ([name, proxy]) => (proxy as any).type === 'Selector'
            );
            
            if (selectorGroups.length > 0) {
              // 选择第一个Selector组
              const [groupName, groupInfo] = selectorGroups[0];
              const nodeName = (groupInfo as any).now;
              
              if (nodeName) {
                console.log(`从代理组[${groupName}]获取到当前节点: ${nodeName}`);
                // 只有当节点有变化时才更新
                if (currentNode !== nodeName) {
                  console.log(`更新当前节点: ${currentNode} -> ${nodeName}`);
                  setCurrentNode(nodeName);
                  addLogEntry('info', `当前节点: ${nodeName}`);
                }
                return;
              }
            }
          }
        }
      } catch (error) {
        console.error('获取所有代理组信息出错:', error);
      }
      
      // 如果所有尝试都失败，则保持当前节点不变
      console.warn('无法获取任何节点信息');
    } catch (error) {
      console.error('获取当前节点信息出错:', error);
    }
  };
  
  // 添加mihomo状态
  useEffect(() => {
    let previousRunningState = false;
    
    // 初始检查
    const checkMihomoStatus = async () => {
      try {
        if (window.electronAPI) {
          const config = await window.electronAPI.getActiveConfig();
          const running = !!config;
          
          // 检测到从运行状态变为非运行状态，可能是意外崩溃
          if (previousRunningState && !running && activeConfig) {
            console.log('检测到mihomo可能意外停止，尝试重启...');
            addLogEntry('info', '检测到mihomo可能意外停止，尝试重启...');
            
            // 使用之前的配置重启
            setTimeout(async () => {
              if (window.electronAPI) {
                const result = await window.electronAPI.startMihomo(activeConfig);
                if (result) {
                  addLogEntry('info', '自动恢复mihomo成功');
                  // 启动后延迟获取当前节点信息
                  setTimeout(fetchCurrentNode, 2000);
                } else {
                  addLogEntry('error', '自动恢复mihomo失败');
                }
              }
            }, 2000);
          }
          
          previousRunningState = running;
          setIsRunning(running);
          if (running) {
            setActiveConfig(config);
            // 修改：不再硬编码为"自动选择"，而是尝试获取实际节点
            if (!currentNode) {
              // 立即尝试获取实际节点
              fetchCurrentNode();
            }
          } else {
            // mihomo未运行时重置节点信息
            if (currentNode) {
              setCurrentNode(null);
            }
          }
        }
      } catch (error) {
        console.error('获取mihomo状态失败:', error);
      }
    };
    
    // 立即检查一次
    checkMihomoStatus();
    
    // 降低检查频率，从5秒改为15秒，减少界面刷新
    const intervalId = setInterval(checkMihomoStatus, 15000);
    
    return () => {
      clearInterval(intervalId);
    };
  }, [activeConfig, currentNode]);
  
  // 获取流量数据
  useEffect(() => {
    const fetchTrafficData = async () => {
      if (!window.electronAPI) return;
      
      try {
        const config = await window.electronAPI.getActiveConfig();
        if (!config) return;
        
        // 从mihomo API获取真实流量数据
        const traffic = await window.electronAPI.getTrafficStats();
        if (traffic) {
          const now = Date.now();
          const newData = {
            timestamp: now,
            up: traffic.up,
            down: traffic.down
          };
          
          setTrafficData(prev => {
            const newDataArray = [...prev, newData];
            // 只保留最近30个数据点
            if (newDataArray.length > 30) {
              return newDataArray.slice(-30);
            }
            return newDataArray;
          });
          
          // 更新实时速度
          setUpSpeed(traffic.upSpeed);
          setDownSpeed(traffic.downSpeed);
          
          // 新增：获取连接信息以更新总流量数据
          await window.electronAPI.fetchConnectionsInfo();
        }
      } catch (error) {
        console.error('获取流量数据失败:', error);
      }
    };
    
    const intervalId = setInterval(fetchTrafficData, 1000);
    return () => clearInterval(intervalId);
  }, []);
  
  // 设置事件监听
  useEffect(() => {
    if (!window.electronAPI) return;
    
    const handleMihomoLog = (data: string) => {
      addLogEntry('info', data);
    };
    
    const handleMihomoError = (data: string) => {
      addLogEntry('error', data);
    };
    
    const handleMihomoStopped = (code: number) => {
      setIsRunning(false);
      addLogEntry('info', `Mihomo已停止，退出代码: ${code}`);
    };
    
    const handleProxyStatus = (enabled: boolean) => {
      setProxyEnabled(enabled);
      addLogEntry('info', `系统代理已${enabled ? '启用' : '禁用'}`);
    };
    
    const handleMihomoAutostart = (result: {success: boolean, configPath?: string, error?: string}) => {
      if (result.success && result.configPath) {
        setIsRunning(true);
        setActiveConfig(result.configPath);
        setSelectedConfig(result.configPath);
        addLogEntry('info', '已自动启动Mihomo');
        
        // 延迟2秒后获取实际节点信息
        setTimeout(async () => {
          try {
            // 使用增强版节点获取函数
            await fetchCurrentNode();
          } catch (error) {
            console.error('获取自动启动后节点状态失败:', error);
            // 如果获取失败，默认设置为DIRECT
            setCurrentNode('DIRECT');
            addLogEntry('info', '无法获取当前节点，默认设置为: DIRECT');
          }
        }, 2000);
      } else if (result.error) {
        addLogEntry('error', `自动启动Mihomo失败: ${result.error}`);
      }
    };
    
    // 添加节点变更事件处理函数
    const handleNodeChanged = (data: {nodeName: string}) => {
      if (data && data.nodeName) {
        console.log(`收到节点变更通知: ${data.nodeName}`);
        setCurrentNode(data.nodeName);
        addLogEntry('info', `已切换到节点: ${data.nodeName}`);
      }
    };

    // 添加连接信息更新事件处理函数
    const handleConnectionsUpdate = (data: any) => {
      if (data) {
        try {
          // 更新连接数
          if (typeof data.activeConnections === 'number') {
            setConnectionCount(data.activeConnections);
          }
          // 更新当前节点
          if (data.currentNode) {
            setCurrentNode(data.currentNode);
          }
          // 更新流量数据
          if (typeof data.downloadTotal === 'number') {
            setDownstreamTraffic(data.downloadTotal);
            // 更新总下载流量
            setTotalDownload(data.downloadTotal);
          }
          if (typeof data.uploadTotal === 'number') {
            setUpstreamTraffic(data.uploadTotal);
            // 更新总上传流量
            setTotalUpload(data.uploadTotal);
          }
        } catch (error) {
          console.error('处理连接信息更新时出错:', error);
        }
      } else {
        console.warn('收到的连接信息数据为空');
      }
    };
    
    // 注册事件监听
    console.log('注册事件监听器...');
    window.electronAPI.onMihomoLog(handleMihomoLog);
    window.electronAPI.onMihomoError(handleMihomoError);
    window.electronAPI.onMihomoStopped(handleMihomoStopped);
    window.electronAPI.onProxyStatus(handleProxyStatus);
    window.electronAPI.onMihomoAutostart(handleMihomoAutostart);
    window.electronAPI.onNodeChanged(handleNodeChanged);
    window.electronAPI.onConnectionsUpdate(handleConnectionsUpdate);
    
    // 初始请求当前节点和连接信息
    if (isRunning && currentNode) {
      console.log('Dashboard组件已挂载，且mihomo正在运行，请求更新节点和连接信息');
      
      // 请求通知当前节点
      if (window.electronAPI.notifyNodeChanged) {
        console.log('通知前端当前节点:', currentNode);
        window.electronAPI.notifyNodeChanged(currentNode).catch(err => {
          console.error('通知节点变更失败:', err);
        });
      }
    }
    
    return () => {
      console.log('移除所有事件监听器...');
      if (window.electronAPI) {
        window.electronAPI.removeAllListeners('dashboard');
      }
    };
  }, [isRunning, currentNode]);  // 仅保留isRunning和currentNode作为依赖项
  
  // 修复流量图表显示：在组件挂载后开始渲染流量图表
  useEffect(() => {
    if (trafficData.length === 0) {
      // 添加初始数据点，避免空数据显示等待
      const initialTimestamp = Date.now();
      const initialData = [
        { timestamp: initialTimestamp - 2000, up: 0, down: 0 },
        { timestamp: initialTimestamp - 1000, up: 0, down: 0 },
        { timestamp: initialTimestamp, up: 0, down: 0 }
      ];
      setTrafficData(initialData);
    }
  }, []);
  
  // 初始化系统代理状态
  useEffect(() => {
    const initProxyStatus = async () => {
      if (!window.electronAPI) return;
      
      try {
        const status = await window.electronAPI.getProxyStatus();
        setProxyEnabled(status);
      } catch (error) {
        console.error('获取系统代理状态失败:', error);
      }
    };
    
    initProxyStatus();
    
    // 监听代理状态变化
    if (window.electronAPI) {
      window.electronAPI.onProxyStatus((_event, enabled) => {
        setProxyEnabled(enabled);
      });
    }
    
    return () => {
      if (window.electronAPI) {
        window.electronAPI.removeAllListeners('proxy-status');
      }
    };
  }, []);
  
  const addLogEntry = (type: 'info' | 'error', content: string) => {
    // 增加计数器来确保唯一ID
    logIdCounterRef.current += 1;
    
    setLogEntries(prev => [
      ...prev, 
      { 
        id: Date.now() * 1000 + logIdCounterRef.current, // 组合时间戳和计数器确保唯一性
        type, 
        content, 
        timestamp: new Date() 
      }
    ]);
  };
  
  const handleStartMihomo = async () => {
    if (!window.electronAPI) return;
    
    try {
      // 检查是否有选择的配置文件
      if (!selectedConfig) {
        console.error('没有选择配置文件');
        addLogEntry('error', '请先选择一个配置文件');
        return;
      }
      
      // 保存最后使用的配置文件
      try {
        await window.electronAPI.saveLastConfig(selectedConfig);
        console.log('已保存最后使用的配置文件');
      } catch (saveError) {
        console.error('保存最后使用的配置文件失败:', saveError);
        // 继续执行，这不是致命错误
      }
      
      console.log('启动Mihomo使用配置文件:', selectedConfig);
      addLogEntry('info', `正在启动Mihomo: ${selectedConfig}`);
      
      const result = await window.electronAPI.startMihomo(selectedConfig);
      
      if (result) {
        console.log('Mihomo启动成功');
        addLogEntry('info', 'Mihomo启动成功');
        setIsRunning(true);
        setActiveConfig(selectedConfig);
        
        // 更新当前使用的节点信息
        setTimeout(fetchCurrentNode, 2000);
      } else {
        console.error('Mihomo启动失败');
        addLogEntry('error', 'Mihomo启动失败，请检查配置文件');
      }
    } catch (error) {
      console.error('启动Mihomo失败:', error);
      addLogEntry('error', `启动Mihomo失败: ${error}`);
    }
  };
  
  const handleStopMihomo = async () => {
    if (!window.electronAPI) return;
    
    try {
      addLogEntry('info', '正在停止Mihomo...');
      const result = await window.electronAPI.stopMihomo();
      
      if (result) {
        setIsRunning(false);
        setActiveConfig(null);
        setCurrentNode(null);
        addLogEntry('info', 'Mihomo已停止');
      } else {
        addLogEntry('error', '停止Mihomo失败');
      }
    } catch (error) {
      console.error('停止Mihomo失败:', error);
      addLogEntry('error', `停止Mihomo失败: ${error}`);
    }
  };
  
  // 切换配置文件
  const handleSwitchConfig = async (newConfigPath: string) => {
    if (!window.electronAPI) return;
    
    try {
      console.log('开始切换配置文件:', newConfigPath);
      
      // 保存最后使用的配置文件
      try {
        await window.electronAPI.saveLastConfig(newConfigPath);
        console.log('已保存最后使用的配置文件');
      } catch (saveError) {
        console.error('保存最后使用的配置文件失败:', saveError);
        // 继续执行，这不是致命错误
      }
      
      // 先停止当前Mihomo
      console.log('停止当前Mihomo服务...');
      await handleStopMihomo();
      
      // 等待服务完全停止
      console.log('等待服务停止...');
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      // 设置新配置并启动
      console.log('设置新配置并启动:', newConfigPath);
      setSelectedConfig(newConfigPath);
      
      // 确保选择器已更新
      setTimeout(async () => {
        console.log('启动Mihomo使用配置:', newConfigPath);
        // 直接启动Mihomo，传入新配置路径
        if (window.electronAPI) {
          try {
            console.log('直接调用startMihomo API:', newConfigPath);
            const result = await window.electronAPI.startMihomo(newConfigPath);
            
            if (result) {
              console.log('切换配置成功:', newConfigPath);
              setActiveConfig(newConfigPath);
              setIsRunning(true);
              // 延迟获取节点信息，使用增强版节点获取函数
              setTimeout(fetchCurrentNode, 2000);
            } else {
              console.error('直接启动失败，尝试使用handleStartMihomo');
              await handleStartMihomo();
            }
          } catch (error) {
            console.error('直接启动出错，回退到handleStartMihomo:', error);
            await handleStartMihomo();
          }
        }
        console.log('配置切换完成');
      }, 500);
    } catch (error) {
      console.error('切换配置文件失败:', error);
      addLogEntry('error', `切换配置文件失败: ${error}`);
    }
  };
  
  // 格式化流量数据
  const formatTraffic = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let size = bytes;
    
    while (size >= 1024 && i < units.length - 1) {
      size /= 1024;
      i++;
    }
    
    return `${size.toFixed(2)} ${units[i]}`;
  };
  
  // 格式化速度
  const formatSpeed = (bytesPerSecond: number): string => {
    if (bytesPerSecond === 0) return '0 B/s';
    
    const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    let i = 0;
    let speed = bytesPerSecond;
    
    while (speed >= 1024 && i < units.length - 1) {
      speed /= 1024;
      i++;
    }
    
    return `${speed.toFixed(2)} ${units[i]}`;
  };
  
  // 控制面板内容
  const renderDashboardTab = () => {
    return (
      <div className="flex flex-col h-full">
        {/* 顶部控制栏 */}
        <div className="bg-white/80 dark:bg-[#2a2a2a]/90 backdrop-blur-md border border-gray-200 dark:border-gray-700 rounded-lg p-4 mb-6">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div className="flex items-center space-x-4">
              <h2 className="text-xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-blue-500 to-indigo-600 dark:from-blue-400 dark:to-indigo-500">
                控制中心
              </h2>
            </div>
            
            <div className="flex items-center space-x-3">
              <select 
                className="py-1.5 px-3 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-[#333333] text-gray-700 dark:text-gray-200 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-all duration-200"
                value={selectedConfig || ''}
                onChange={(e) => {
                  const newConfig = e.target.value;
                  setSelectedConfig(newConfig);
                  // 如果Mihomo正在运行且选择了不同的配置，直接切换
                  if (isRunning && newConfig !== activeConfig) {
                    handleSwitchConfig(newConfig);
                  }
                }}
              >
                {subscriptions.length === 0 && (
                  <option value="" disabled>没有可用的配置文件</option>
                )}
                {subscriptions.map((sub) => (
                  <option key={sub.path} value={sub.path}>
                    {sub.name}
                  </option>
                ))}
              </select>
              
              <button
                className={`flex items-center justify-center rounded-lg transition-all duration-300 ${
                  isRunning 
                    ? 'bg-gradient-to-r from-red-500 to-red-600 hover:from-red-600 hover:to-red-700 text-white'
                    : 'bg-gradient-to-r from-green-500 to-green-600 hover:from-green-600 hover:to-green-700 text-white'
                } py-1.5 px-3 transform hover:scale-105`}
                onClick={isRunning ? handleStopMihomo : handleStartMihomo}
                disabled={!selectedConfig && !isRunning}
              >
                {isRunning ? (
                  <>
                    <StopIcon className="mr-1.5" />
                    停止
                  </>
                ) : (
                  <>
                    <PlayIcon className="mr-1.5" />
                    启动
                  </>
                )}
              </button>
              
              {isRunning && (
                <button
                  className="flex items-center justify-center bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white rounded-lg py-1.5 px-3 transition-all duration-300 transform hover:scale-105"
                  onClick={async () => {
                    // 检查是否选择了新的配置文件
                    if (selectedConfig !== activeConfig) {
                      // 使用新选择的配置重启
                      handleSwitchConfig(selectedConfig || '');
                    } else {
                      // 使用相同的配置重启
                      await handleStopMihomo();
                      setTimeout(handleStartMihomo, 1000);
                    }
                  }}
                >
                  <ReloadIcon className="mr-1.5" />
                  重启
                </button>
              )}
            </div>
          </div>
        </div>
        
        {/* 主要内容区域 */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-6 flex-grow">
          {/* 左侧面板 - 状态信息和开关 */}
          <div className="md:col-span-4 space-y-6">
            {/* 状态信息面板 */}
            <div className="bg-white/80 dark:bg-[#2a2a2a]/90 backdrop-blur-md border border-gray-200 dark:border-gray-700 rounded-lg p-4">
              <h3 className="text-lg font-semibold mb-4 text-gray-800 dark:text-gray-200">状态信息</h3>
              
              <div className="space-y-3">
                <div className="flex items-center justify-between p-3 bg-gradient-to-br from-blue-50 to-blue-100 dark:from-[#222222] dark:to-[#1a1a1a] rounded-lg">
                  <div className="flex items-center text-blue-800 dark:text-blue-300">
                    <LightningBoltIcon className="w-4 h-4 mr-1.5" />
                    <span>运行状态</span>
                  </div>
                  <div className="flex items-center">
                    <span className={`w-2 h-2 rounded-full mr-2 ${isRunning ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`}></span>
                    <span className="font-medium text-gray-800 dark:text-gray-200">{isRunning ? '运行中' : '已停止'}</span>
                  </div>
                </div>
                
                {/* 当前节点 - 保持垂直布局以支持长节点名称换行 */}
                <div className="p-3 bg-gradient-to-br from-purple-50 to-purple-100 dark:from-[#222222] dark:to-[#1a1a1a] rounded-lg">
                  <div className="flex items-center text-purple-800 dark:text-purple-300 mb-1.5">
                    <GlobeIcon className="w-4 h-4 mr-1.5" />
                    <span className="font-medium">当前节点</span>
                  </div>
                  <div className="font-medium text-gray-800 dark:text-gray-200 break-words w-full overflow-hidden">
                    {currentNode || '未选择'}
                  </div>
                </div>
                
                <div className="flex items-center justify-between p-3 bg-gradient-to-br from-orange-50 to-orange-100 dark:from-[#222222] dark:to-[#1a1a1a] rounded-lg">
                  <div className="flex items-center text-orange-800 dark:text-orange-300">
                    <InfoCircledIcon className="w-4 h-4 mr-1.5" />
                    <span>连接数</span>
                  </div>
                  <div className="font-medium text-gray-800 dark:text-gray-200">
                    {connectionCount}
                  </div>
                </div>
              </div>
            </div>
            
            {/* 开关面板 - 新增 */}
            <div className="bg-white/80 dark:bg-[#2a2a2a]/90 backdrop-blur-md border border-gray-200 dark:border-gray-700 rounded-lg p-4">
              <h3 className="text-lg font-semibold mb-4 text-gray-800 dark:text-gray-200">开关</h3>
              
              <div className="space-y-3">
                <div className="flex items-center justify-between p-3 bg-gradient-to-br from-indigo-50 to-indigo-100 dark:from-[#222222] dark:to-[#1a1a1a] rounded-lg">
                  <div className="flex items-center text-indigo-800 dark:text-indigo-300">
                    <DesktopIcon className="w-4 h-4 mr-1.5" />
                    <span>系统代理</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Switch.Root
                      checked={proxyEnabled}
                      onCheckedChange={handleToggleProxy}
                      disabled={!isRunning}
                      className={`w-11 h-6 rounded-full transition-colors duration-200 ${
                        proxyEnabled 
                          ? 'bg-indigo-500 dark:bg-[#444444]' 
                          : 'bg-gray-200 dark:bg-gray-600'
                      } ${!isRunning ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      <Switch.Thumb 
                        className={`block w-5 h-5 bg-white rounded-full shadow transform transition-transform duration-200 ${
                          proxyEnabled ? 'translate-x-6' : 'translate-x-0.5'
                        }`} 
                      />
                    </Switch.Root>
                  </div>
                </div>
              </div>
            </div>
          </div>
          
          {/* 右侧面板 - 流量统计和图表 */}
          <div className="md:col-span-8 space-y-6">
            {/* 流量统计面板 */}
            <div className="bg-white/80 dark:bg-[#2a2a2a]/90 backdrop-blur-md border border-gray-200 dark:border-gray-700 rounded-lg p-4">
              <h3 className="text-lg font-semibold mb-4 text-gray-800 dark:text-gray-200">流量统计</h3>
              
              <div className="grid grid-cols-2 gap-4 mb-4">
                <div className="bg-gradient-to-br from-blue-50 to-blue-100 dark:from-[#222222] dark:to-[#1a1a1a] rounded-lg p-4">
                  <div className="flex items-center mb-2">
                    <DownloadIcon className="w-5 h-5 text-blue-500 mr-1.5" />
                    <span className="text-sm text-gray-600 dark:text-gray-300">下载</span>
                  </div>
                  <div className="text-2xl font-semibold text-gray-800 dark:text-gray-200">
                    {formatTraffic(totalDownload)}
                  </div>
                  <div className="text-sm text-blue-600 dark:text-blue-300 mt-1">
                    {formatSpeed(downSpeed)}
                  </div>
                </div>
                
                <div className="bg-gradient-to-br from-green-50 to-green-100 dark:from-[#222222] dark:to-[#1a1a1a] rounded-lg p-4">
                  <div className="flex items-center mb-2">
                    <UploadIcon className="w-5 h-5 text-green-500 mr-1.5" />
                    <span className="text-sm text-gray-600 dark:text-gray-300">上传</span>
                  </div>
                  <div className="text-2xl font-semibold text-gray-800 dark:text-gray-200">
                    {formatTraffic(totalUpload)}
                  </div>
                  <div className="text-sm text-green-600 dark:text-green-300 mt-1">
                    {formatSpeed(upSpeed)}
                  </div>
                </div>
              </div>
              
              <div className="mt-4">
                <h4 className="text-sm font-medium mb-2 text-gray-700 dark:text-gray-300">实时流量</h4>
                {renderTrafficChart()}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  };
  
  // 日志标签页内容
  const renderLogTab = () => {
    const handleSaveLogs = async () => {
      if (!window.electronAPI || logEntries.length === 0) return;
      
      try {
        const result = await window.electronAPI.saveLogs(logEntries);
        if (result.success) {
          addLogEntry('info', `日志已保存到: ${result.filePath}`);
        } else {
          addLogEntry('error', `保存日志失败: ${result.error}`);
        }
      } catch (error) {
        console.error('保存日志失败:', error);
        addLogEntry('error', `保存日志失败: ${error}`);
      }
    };

    return (
      <div className="bg-white/80 dark:bg-[#2a2a2a]/90 backdrop-blur-md border border-gray-200 dark:border-gray-700 rounded-lg p-4 h-full">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-blue-500 to-indigo-600 dark:from-blue-400 dark:to-indigo-500">运行日志</h2>
          
          <button 
            onClick={handleSaveLogs}
            disabled={logEntries.length === 0}
            className="flex items-center justify-center bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white rounded-lg py-1.5 px-3 text-sm transition-all duration-300 transform hover:scale-105 disabled:opacity-50 disabled:transform-none disabled:hover:scale-100"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
            </svg>
            保存日志
          </button>
        </div>
        
        <Tabs.Root defaultValue="all" className="w-full h-full flex flex-col">
          <Tabs.List className="flex border-b border-gray-200 dark:border-gray-700 mb-4">
            <Tabs.Trigger
              value="all"
              className="px-4 py-2 text-sm font-medium text-gray-500 dark:text-gray-300 border-b-2 border-transparent data-[state=active]:border-blue-500 data-[state=active]:text-blue-600 dark:data-[state=active]:text-blue-400 transition-all duration-200"
            >
              全部
            </Tabs.Trigger>
            <Tabs.Trigger
              value="info"
              className="px-4 py-2 text-sm font-medium text-gray-500 dark:text-gray-300 border-b-2 border-transparent data-[state=active]:border-blue-500 data-[state=active]:text-blue-600 dark:data-[state=active]:text-blue-400 transition-all duration-200"
            >
              信息
            </Tabs.Trigger>
            <Tabs.Trigger
              value="error"
              className="px-4 py-2 text-sm font-medium text-gray-500 dark:text-gray-300 border-b-2 border-transparent data-[state=active]:border-blue-500 data-[state=active]:text-blue-600 dark:data-[state=active]:text-blue-400 transition-all duration-200"
            >
              错误
            </Tabs.Trigger>
          </Tabs.List>
          
          <div className="flex-grow overflow-hidden">
            <Tabs.Content value="all" className="w-full h-full">
              <LogView entries={logEntries} logEndRef={logEndRef} />
            </Tabs.Content>
            
            <Tabs.Content value="info" className="w-full h-full">
              <LogView entries={logEntries.filter(entry => entry.type === 'info')} logEndRef={logEndRef} />
            </Tabs.Content>
            
            <Tabs.Content value="error" className="w-full h-full">
              <LogView entries={logEntries.filter(entry => entry.type === 'error')} logEndRef={logEndRef} />
            </Tabs.Content>
          </div>
        </Tabs.Root>
      </div>
    );
  };
  
  // 在标签页切换时检查mihomo状态
  const handleTabChange = (value: string) => {
    setActiveTab(value);
    
    // 当切换到仪表盘标签页时，检查mihomo状态
    if (value === 'dashboard' && window.electronAPI) {
      window.electronAPI.getActiveConfig().then(config => {
        setIsRunning(!!config);
        if (config) {
          setActiveConfig(config);
        }
      }).catch(error => {
        console.error('获取mihomo状态失败:', error);
      });
    }
  };
  
  // 优化图表渲染
  const renderTrafficChart = () => {
    if (trafficData.length < 2) {
      return (
        <div className="flex items-center justify-center h-60 bg-gray-50 dark:bg-[#222222] rounded-lg shadow-sm">
          <div className="text-gray-500 dark:text-gray-400">等待数据...</div>
        </div>
      );
    }

    // 将数据转换为相同的单位（KB）进行显示
    const convertToKB = (bytes: number) => bytes / 1024;
    
    const normalizedData = trafficData.map(d => ({
      timestamp: d.timestamp,
      up: convertToKB(d.up || 0),
      down: convertToKB(d.down || 0)
    }));
    
    // 计算最大值时使用转换后的数据
    const maxValue = Math.max(
      ...normalizedData.map(d => Math.max(d.up, d.down)),
      1  // 最小值设为1KB
    );
    
    const generatePath = (data: typeof normalizedData[0][], key: 'up' | 'down') => {
      const width = 100 / (data.length - 1);
      const paddingTop = 15;
      const paddingBottom = 15;
      const availableHeight = 100 - paddingTop - paddingBottom;
      
      let path = `M 0,${paddingTop + availableHeight - (data[0][key] / maxValue) * availableHeight}`;
      
      for (let i = 1; i < data.length; i++) {
        const x = i * width;
        const y = paddingTop + availableHeight - (data[i][key] / maxValue) * availableHeight;
        path += ` L ${x},${y}`;
      }
      
      return path;
    };
    
    const upPath = generatePath(normalizedData, 'up');
    const downPath = generatePath(normalizedData, 'down');
    
    const generateFillPath = (linePath: string) => {
      const endPoint = 85;
      return `${linePath} L 100,${endPoint} L 0,${endPoint} Z`;
    };
    
    const upFillPath = generateFillPath(upPath);
    const downFillPath = generateFillPath(downPath);

    // 格式化KB单位的显示
    const formatKBSpeed = (kb: number): string => {
      if (kb < 1) return `${(kb * 1024).toFixed(2)} B/s`;
      if (kb < 1024) return `${kb.toFixed(2)} KB/s`;
      if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(2)} MB/s`;
      return `${(kb / 1024 / 1024).toFixed(2)} GB/s`;
    };
    
    return (
      <div className="bg-gray-50 dark:bg-[#222222] rounded-lg shadow-sm p-4 h-60 flex flex-col border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="flex justify-between items-center text-sm text-gray-500 dark:text-gray-400 mb-2">
          <div className="flex items-center">
            <span className="block w-4 h-3 bg-blue-500 rounded-sm mr-2"></span>
            <span>下载</span>
            <span className="ml-2 font-semibold text-blue-600 dark:text-blue-400">{formatKBSpeed(convertToKB(downSpeed))}</span>
          </div>
          <div className="flex items-center">
            <span className="block w-4 h-3 bg-green-500 rounded-sm mr-2"></span>
            <span>上传</span>
            <span className="ml-2 font-semibold text-green-600 dark:text-green-400">{formatKBSpeed(convertToKB(upSpeed))}</span>
          </div>
        </div>
        
        <div className="flex-1 relative">
          <svg className="w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">
            {/* 网格线 */}
            <line x1="0" y1="25" x2="100" y2="25" stroke="rgba(229, 231, 235, 0.3)" strokeWidth="1" />
            <line x1="0" y1="50" x2="100" y2="50" stroke="rgba(229, 231, 235, 0.3)" strokeWidth="1" />
            <line x1="0" y1="75" x2="100" y2="75" stroke="rgba(229, 231, 235, 0.3)" strokeWidth="1" />
            
            {/* 下载流量图形填充 */}
            <path 
              d={downFillPath}
              fill="rgba(59, 130, 246, 0.15)"
              stroke="none"
            />
            
            {/* 上传流量图形填充 */}
            <path 
              d={upFillPath}
              fill="rgba(34, 197, 94, 0.15)"
              stroke="none"
            />
            
            {/* 下载流量线条 */}
            <path 
              d={downPath} 
              fill="none" 
              stroke="rgb(59 130 246)" 
              strokeWidth="1.5"
            />
            
            {/* 上传流量线条 */}
            <path 
              d={upPath} 
              fill="none" 
              stroke="rgb(34 197 94)" 
              strokeWidth="1.5"
            />
          </svg>
        </div>
      </div>
    );
  };
  
  // 处理系统代理开关
  const handleToggleProxy = async (enabled: boolean) => {
    if (!window.electronAPI) return;
    
    try {
      // 调用主进程切换系统代理
      const result = await window.electronAPI.toggleSystemProxy(enabled);
      if (result) {
        setProxyEnabled(enabled);
        addLogEntry('info', `系统代理已${enabled ? '启用' : '禁用'}`);
      } else {
        addLogEntry('error', `切换系统代理失败`);
      }
    } catch (error) {
      console.error('切换系统代理失败:', error);
      addLogEntry('error', `切换系统代理失败: ${error}`);
    }
  };
  
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-hidden">
        <div className="h-full">
          <div className="px-4 pb-4 pt-0 bg-gradient-to-br from-[#f9f9f9] to-[#f9f9f9] dark:from-[#1a1a1a] dark:to-[#1a1a1a] min-h-full">
            <h1 className="text-2xl font-bold mb-4 text-gray-800 dark:text-white bg-clip-text text-transparent bg-gradient-to-r from-blue-500 to-indigo-600">控制面板</h1>
            
            <Tabs.Root value={activeTab} onValueChange={handleTabChange} className="w-full">
              <Tabs.List className="flex space-x-2 mb-4">
                <Tabs.Trigger
                  value="dashboard"
                  className="flex items-center px-3 py-1.5 bg-white dark:bg-[#2a2a2a] rounded-lg shadow text-sm font-medium text-gray-500 dark:text-gray-300 data-[state=active]:text-blue-600 dark:data-[state=active]:text-blue-400 data-[state=active]:bg-blue-50 dark:data-[state=active]:bg-blue-900/20 transition-all duration-200"
                >
                  <DesktopIcon className="mr-1.5" />
                  仪表盘
                </Tabs.Trigger>
                <Tabs.Trigger
                  value="logs"
                  className="flex items-center px-3 py-1.5 bg-white dark:bg-[#2a2a2a] rounded-lg shadow text-sm font-medium text-gray-500 dark:text-gray-300 data-[state=active]:text-blue-600 dark:data-[state=active]:text-blue-400 data-[state=active]:bg-blue-50 dark:data-[state=active]:bg-blue-900/20 transition-all duration-200"
                >
                  <FileTextIcon className="mr-1.5" />
                  日志
                </Tabs.Trigger>
              </Tabs.List>
              
              <Tabs.Content value="dashboard" className="w-full">
                {renderDashboardTab()}
              </Tabs.Content>
              
              <Tabs.Content value="logs" className="w-full">
                {renderLogTab()}
              </Tabs.Content>
            </Tabs.Root>
          </div>
        </div>
      </div>
    </div>
  );
}

function LogView({ 
  entries, 
  logEndRef 
}: { 
  entries: LogEntry[], 
  logEndRef: React.RefObject<any>
}) {
  const [autoScroll, setAutoScroll] = useState(true);
  
  const handleScroll = () => {
    if (!logEndRef.current) return;
    
    const { scrollTop, scrollHeight, clientHeight } = logEndRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
    setAutoScroll(isAtBottom);
  };
  
  useEffect(() => {
    if (autoScroll && logEndRef.current) {
      logEndRef.current.scrollTop = logEndRef.current.scrollHeight;
    }
  }, [entries, autoScroll]);
  
  return (
    <div 
      ref={logEndRef}
      className="h-[calc(100vh-12rem)] overflow-y-auto bg-gray-50 dark:bg-[#222222] rounded-lg p-3 font-mono text-sm"
      onScroll={handleScroll}
    >
      {entries.length === 0 ? (
        <div className="text-gray-500 dark:text-gray-400 text-center py-4">暂无日志</div>
      ) : (
        entries.map(entry => (
          <div 
            key={entry.id} 
            className={`mb-1 ${
              entry.type === 'error' 
                ? 'text-red-600 dark:text-red-400' 
                : 'text-gray-700 dark:text-gray-300'
            }`}
          >
            <span className="text-gray-500 dark:text-gray-500 mr-2">
              {new Date(entry.timestamp).toLocaleTimeString()}
            </span>
            {entry.content}
          </div>
        ))
      )}
    </div>
  );
} 