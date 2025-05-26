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
  BarChartIcon,
  Cross2Icon,
  ActivityLogIcon
} from '@radix-ui/react-icons';
import { TabsTrigger, TabsContent, TabsList } from '@/components/ui/tabs';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { format } from 'date-fns';
import { Check, X, Zap, Activity, BarChart2, List, Radio, Power, RefreshCw, Save, Network } from 'lucide-react';
import * as Tooltip from '@radix-ui/react-tooltip';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Toast from '@radix-ui/react-toast';
import * as Dialog from '@radix-ui/react-dialog';
import { useMihomoAPI } from '../services/mihomo-api';

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
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [tunEnabled, setTunEnabled] = useState(false); // 添加TUN模式状态
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
  const [isProxyUpdating, setIsProxyUpdating] = useState(false);
  const [isTunUpdating, setIsTunUpdating] = useState(false); // 添加TUN模式更新状态
  const [isLoading, setIsLoading] = useState(false);
  let mihomoAPI = useMihomoAPI();
  
  // 添加限制数据存储数量的常量
  const MAX_TRAFFIC_DATA_POINTS = 60; // 保存1分钟的数据（假设每秒一个数据点）
  const MAX_CONNECTION_DATA = 30; // 保存30个连接数据点
  
  const [toastOpen, setToastOpen] = useState(false);
  const [toastTitle, setToastTitle] = useState('');
  const [toastDescription, setToastDescription] = useState('');
  const [toastType, setToastType] = useState<'success' | 'error'>('success');

  // 对话框状态
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogTitle, setDialogTitle] = useState('');
  const [dialogDescription, setDialogDescription] = useState('');
  const [dialogAction, setDialogAction] = useState<() => Promise<void>>(() => async () => {});
  const [dialogActionText, setDialogActionText] = useState('');
  const [dialogCancelText, setDialogCancelText] = useState('');
  
  useEffect(() => {
    // 获取API配置
    const getApiConfig = async () => {
      if (window.electronAPI) {
        try {
          const apiConfigResult = await window.electronAPI.getApiConfig();
          if (apiConfigResult.success) {
            // 使用正确的API配置初始化mihomoAPI
            mihomoAPI = useMihomoAPI({
              host: apiConfigResult.controllerHost,
              port: apiConfigResult.controllerPort,
              secret: apiConfigResult.secret
            });
            console.log('Dashboard: API配置已更新:', apiConfigResult);
          }
        } catch (error) {
          console.error('获取API配置失败:', error);
        }
      }
    };
    
    getApiConfig();
  }, []);
  
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
  
  // 获取当前节点信息
  const fetchCurrentNode = async () => {
    try {
      if (!window.electronAPI) return;
      
      // 首先尝试获取配置文件中的第一个代理组
      let firstProxyGroup = "PROXY"; // 默认值
      
      try {
        // 获取配置顺序信息
        const result = await window.electronAPI.getConfigOrder();
        if (result.success && result.data && result.data.proxyGroups && result.data.proxyGroups.length > 0) {
          // 使用配置文件中的第一个代理组
          firstProxyGroup = result.data.proxyGroups[0].name;
          console.log(`使用配置文件中的第一个代理组: ${firstProxyGroup}`);
        } else {
          console.log(`无法获取配置文件代理组信息，使用默认组: ${firstProxyGroup}`);
        }
      } catch (error) {
        console.error('获取配置顺序失败:', error);
      }
      
      // 尝试获取第一个代理组信息
      try {
        console.log(`请求${firstProxyGroup}组信息...`);
        
        // 使用mihomoAPI获取代理组信息
        const proxiesData = await mihomoAPI.proxies();
        if (proxiesData && proxiesData.proxies && proxiesData.proxies[firstProxyGroup]) {
          const groupData = proxiesData.proxies[firstProxyGroup];
          if (groupData.now) {
            console.log(`获取到当前节点: ${groupData.now}`);
            // 只有当节点有变化时才更新
            if (currentNode !== groupData.now) {
              console.log(`更新当前节点: ${currentNode} -> ${groupData.now}`);
              setCurrentNode(groupData.now);
              addLogEntry('info', `当前节点: ${groupData.now}`);
            }
            return;
          }
        } else {
          console.warn(`获取${firstProxyGroup}组信息失败，尝试备选方案`);
        }
      } catch (error) {
        console.error(`请求${firstProxyGroup}组信息出错:`, error);
      }
      
      // 如果第一个代理组获取失败，且不是PROXY组，尝试使用PROXY组作为备选
      if (firstProxyGroup !== "PROXY") {
        try {
          console.log('尝试请求默认PROXY组信息...');
          const proxiesData = await mihomoAPI.proxies();
          if (proxiesData && proxiesData.proxies && proxiesData.proxies["PROXY"]) {
            const groupData = proxiesData.proxies["PROXY"];
            if (groupData.now) {
              console.log(`从PROXY组获取到当前节点: ${groupData.now}`);
              if (currentNode !== groupData.now) {
                console.log(`更新当前节点: ${currentNode} -> ${groupData.now}`);
                setCurrentNode(groupData.now);
                addLogEntry('info', `当前节点: ${groupData.now}`);
              }
              return;
            }
          }
        } catch (error) {
          console.error('请求PROXY组信息出错:', error);
        }
      }
      
      // 如果无法获取指定代理组信息，尝试获取所有代理组
      try {
        console.log('尝试获取所有代理组信息...');
        
        // 使用mihomoAPI获取所有代理组信息
        const proxiesData = await mihomoAPI.proxies();
        if (proxiesData && proxiesData.proxies) {
          // 查找类型为Selector的代理组
          const selectorGroups = Object.entries(proxiesData.proxies).filter(
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
          // 获取配置文件路径以检查mihomo是否启动
          const config = await window.electronAPI.getActiveConfig();
          const configExists = !!config;
          
          // 额外检查mihomo API是否可访问
          let serviceRunning = false;
          try {
            // 使用mihomoAPI检查服务是否运行
            console.log('[调试] 开始检查Mihomo API状态...');
            const versionInfo = await mihomoAPI.version();
            // 只要能拿到 version 字段且不是空字符串就认为服务在运行
            serviceRunning = !!(versionInfo && versionInfo.version);
            console.log('[调试] Mihomo版本检查成功:', versionInfo);
          } catch (apiError) {
            // 如果是401，提示密钥错误
            let errorMsg = '';
            if (apiError instanceof Error) {
              errorMsg = apiError.message;
              console.error('[调试] API错误类型:', apiError.constructor.name);
              if (apiError.stack) {
                console.error('[调试] API错误堆栈:', apiError.stack);
              }
            } else {
              errorMsg = String(apiError);
              console.error('[调试] 非Error类型API错误:', typeof apiError, errorMsg);
            }
            if (errorMsg.includes('401') || errorMsg.includes('未授权') || errorMsg.includes('unauthorized')) {
              addLogEntry('error', '无法访问Mihomo API: 密钥认证失败，请检查密钥设置');
              serviceRunning = false;
            } else {
              // 其他错误才认为服务未运行
              console.error('[调试] Mihomo API检查失败:', apiError);
              serviceRunning = false;
            }
          }
          
          // 运行状态取决于配置文件存在且服务确实在运行
          const running = configExists && serviceRunning;
          
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
            // 尝试获取实际节点
            if (!currentNode) {
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
    
    // 降低检查频率到10秒
    const intervalId = setInterval(checkMihomoStatus, 10000);
    
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
            // 增加保留的数据点数量以提高图表的颗粒度，从30提高到60
            if (newDataArray.length > 60) {
              return newDataArray.slice(-60);
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
    
    // 增加采样频率，从1000毫秒改为500毫秒，获取更细腻的数据
    const intervalId = setInterval(fetchTrafficData, 500);
    return () => clearInterval(intervalId);
  }, []);
  
  // 修复流量图表显示：在组件挂载后开始渲染流量图表
  useEffect(() => {
    if (trafficData.length === 0) {
      // 添加初始数据点，避免空数据显示等待
      const initialTimestamp = Date.now();
      const initialData = [
        { timestamp: initialTimestamp - 3000, up: 0, down: 0 },
        { timestamp: initialTimestamp - 2500, up: 0, down: 0 },
        { timestamp: initialTimestamp - 2000, up: 0, down: 0 },
        { timestamp: initialTimestamp - 1500, up: 0, down: 0 },
        { timestamp: initialTimestamp - 1000, up: 0, down: 0 },
        { timestamp: initialTimestamp - 500, up: 0, down: 0 },
        { timestamp: initialTimestamp, up: 0, down: 0 }
      ];
      setTrafficData(initialData);
    }
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
      console.log(`接收到mihomo停止事件，退出代码: ${code}`);
      setIsRunning(false);
      setActiveConfig(null);
      setCurrentNode(null);
      addLogEntry('info', `Mihomo已停止，退出代码: ${code}`);
    };
    
    const handleProxyStatus = (enabled: boolean) => {
      console.log('接收到代理状态变更:', enabled);
      setProxyEnabled(enabled);
      addLogEntry('info', `系统代理已${enabled ? '启用' : '禁用'}`);
    };
    
    const handleMihomoAutostart = (result: {success: boolean, configPath?: string, error?: string, existing?: boolean}) => {
      if (result.success && result.configPath) {
        setIsRunning(true);
        setActiveConfig(result.configPath);
        
        // 只有在不是连接已有内核的情况下才更新selectedConfig
        if (!result.existing) {
          setSelectedConfig(result.configPath);
        }
        
        // 根据是否连接到现有内核显示不同的日志信息
        if (result.existing) {
          addLogEntry('info', '已连接到已在运行的Mihomo内核');
        } else {
          addLogEntry('info', '已自动启动Mihomo');
        }
        
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
    
    // 添加TUN模式错误处理函数
    const handleTunModeError = (data: {message: string}) => {
      console.error('收到TUN模式错误通知:', data.message);
      showToast('错误', `TUN模式错误: ${data.message}`, 'error');
    };
    
    // 添加服务重启通知处理函数
    const handleServiceRestarting = (data: {reason: string, tunEnabled: boolean}) => {
      console.log('收到服务重启通知:', data);
      if (data.reason === 'tun-mode-change') {
        showToast('信息', `${data.tunEnabled ? '启用' : '禁用'}TUN模式需要重启服务，服务将在几秒后自动重启...`, 'success');
      }
    };
    
    // 添加服务重启完成处理函数
    const handleServiceRestarted = (data: {success: boolean, tunEnabled?: boolean, error?: string}) => {
      console.log('收到服务重启完成通知:', data);
      if (data.success) {
        showToast('成功', `服务重启成功，TUN模式已${data.tunEnabled ? '启用' : '禁用'}`, 'success');
      } else if (data.error) {
        showToast('错误', data.error, 'error');
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
    
    // 注册TUN模式相关事件监听
    if (window.electronAPI.onMessage) {
      window.electronAPI.onMessage('tun-mode-error', handleTunModeError);
      window.electronAPI.onMessage('service-restarting', handleServiceRestarting);
      window.electronAPI.onMessage('service-restarted', handleServiceRestarted);
    }
    
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

    // 移除事件监听
    return () => {
      console.log('清理事件监听器...');
      if (window.electronAPI && window.electronAPI.removeAllListeners) {
        window.electronAPI.removeAllListeners();
      }
    };
  }, [isRunning, currentNode]);  // 仅保留isRunning和currentNode作为依赖项
  
  // 监听系统代理状态变更事件
  useEffect(() => {
    // 安全检查
    const api = window.electronAPI;
    if (!api) return;

    // 首次加载时获取当前代理状态
    const checkProxyStatus = async () => {
      try {
        const status = await api.getProxyStatus();
        setProxyEnabled(status);
      } catch (error) {
        console.error('获取代理状态失败:', error);
      }
    };
    
    checkProxyStatus();

    // 监听代理状态变化
    const handleProxyStatus = (enabled: boolean) => {
      console.log('接收到代理状态变更:', enabled);
      setProxyEnabled(enabled);
      addLogEntry('info', `系统代理已${enabled ? '启用' : '禁用'}`);
    };

    // 添加事件监听
    const removeListener = api.onProxyStatus(handleProxyStatus);

    // 清理函数
    return () => {
      if (removeListener) {
        removeListener();
      }
    };
  }, []);
  
  // 监听TUN模式状态变更事件
  useEffect(() => {
    // 安全检查
    const api = window.electronAPI;
    if (!api) return;

    // 首次加载时获取TUN模式状态
    const checkTunStatus = async () => {
      try {
        const status = await api.getTunStatus();
        setTunEnabled(status);
      } catch (error) {
        // 静默处理错误
      }
    };
    
    checkTunStatus();

    // 监听TUN模式状态变化
    const handleTunStatus = (enabled: boolean) => {
      setTunEnabled(enabled);
      addLogEntry('info', `TUN模式已${enabled ? '启用' : '禁用'}`);
    };

    // 添加事件监听
    const removeListener = api.onTunStatus(handleTunStatus);
    
    // 每5秒检查一次TUN状态，确保UI始终显示正确状态
    const intervalId = setInterval(async () => {
      try {
        // 只有在服务运行状态下才检查TUN状态
        if (isRunning) {
          const currentStatus = await api.getTunStatus();
          // 只有当状态不一致时才更新
          if (currentStatus !== tunEnabled) {
            setTunEnabled(currentStatus);
          }
        }
      } catch (error) {
        // 静默处理错误
      }
    }, 5000);

    // 清理函数
    return () => {
      if (removeListener) {
        removeListener();
      }
      clearInterval(intervalId);
    };
  }, [isRunning, tunEnabled]);
  
  // 添加监听配置切换事件的useEffect
  useEffect(() => {
    if (window.electronAPI && window.electronAPI.onMessage) {
      // 监听配置切换消息
      const removeListener = window.electronAPI.onMessage('config-switched', (data) => {
        console.log('收到配置切换事件:', data);
        if (data.configPath) {
          // 更新配置路径
          setActiveConfig(data.configPath);
          setSelectedConfig(data.configPath);
          setIsRunning(true);
          
          // 如果有节点信息，直接更新
          if (data.nodeName) {
            console.log('从事件更新当前节点:', data.nodeName);
            setCurrentNode(data.nodeName);
          } else {
            // 否则延迟获取
            setTimeout(fetchCurrentNode, 1000);
          }
          
          addLogEntry('info', `配置已切换到: ${data.configPath}`);
        }
      });
      
      return () => {
        // 清理监听器
        removeListener();
      };
    }
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
  
  // 修改启动按钮的处理函数，恢复直接启动功能
  const handleStartMihomo = async () => {
    if (!window.electronAPI) return;
    
    // 如果没有selectedConfig，则使用activeConfig（如果有）
    const configToUse = selectedConfig || activeConfig;
    
    if (!configToUse) {
      showToast('错误', '未选择配置文件，请先在订阅管理页面选择一个配置', 'error');
      return;
    }
    
    try {
      setIsLoading(true);
      addLogEntry('info', '正在启动服务...');
      
      const result = await window.electronAPI.startMihomo(configToUse);
      
      if (result) {
        setActiveConfig(configToUse);
        showToast('成功', '服务启动成功', 'success');
        // 延迟获取节点信息
        setTimeout(fetchCurrentNode, 2000);
      } else {
        showToast('错误', '服务启动失败', 'error');
      }
    } catch (error) {
      console.error('启动服务失败:', error);
      showToast('错误', `启动服务失败: ${error}`, 'error');
    } finally {
      setIsLoading(false);
    }
  };
  
  // 修改停止按钮的处理函数，恢复直接停止功能
  const handleStopMihomo = async () => {
    if (!window.electronAPI) return;
    
    try {
      setIsLoading(true);
      addLogEntry('info', '正在停止服务...');
      
      const result = await window.electronAPI.stopMihomo();
      
      if (result) {
        setActiveConfig(null);
        setCurrentNode(null);
        showToast('成功', '服务已停止', 'success');
      } else {
        showToast('信息', '服务已经处于停止状态', 'success');
      }
    } catch (error) {
      console.error('停止服务失败:', error);
      showToast('错误', `停止服务失败: ${error}`, 'error');
    } finally {
      setIsLoading(false);
    }
  };
  
  // 重启服务功能
  const handleRestartMihomo = async () => {
    if (!window.electronAPI || !activeConfig) return;
    
    try {
      setIsLoading(true);
      addLogEntry('info', '正在重启服务...');
      
      // 先停止
      await window.electronAPI.stopMihomo();
      
      // 等待一段时间确保完全停止
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // 重新启动
      const result = await window.electronAPI.startMihomo(activeConfig);
      
      if (result) {
        showToast('成功', '服务重启成功', 'success');
        // 延迟获取节点信息
        setTimeout(fetchCurrentNode, 2000);
      } else {
        showToast('错误', '服务重启失败', 'error');
      }
    } catch (error) {
      console.error('重启服务失败:', error);
      showToast('错误', `重启服务失败: ${error}`, 'error');
    } finally {
      setIsLoading(false);
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
              <button
                className={`flex items-center justify-center rounded-lg transition-all duration-300 ${
                  isRunning 
                    ? 'bg-gradient-to-r from-red-500 to-red-600 hover:from-red-600 hover:to-red-700 text-white'
                    : 'bg-gradient-to-r from-green-500 to-green-600 hover:from-green-600 hover:to-green-700 text-white'
                } py-1.5 px-3 transform hover:scale-105`}
                onClick={isRunning ? handleStopMihomo : handleStartMihomo}
                disabled={isLoading}
              >
                {isLoading ? (
                  <>
                    <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    处理中...
                  </>
                ) : isRunning ? (
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
                  onClick={handleRestartMihomo}
                  disabled={isLoading}
                >
                  {isLoading ? (
                    <>
                      <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      重启中...
                    </>
                  ) : (
                    <>
                      <ReloadIcon className="mr-1.5" />
                      重启
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
        
        {/* 主要内容区域 */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-6 flex-grow">
          {/* 左侧面板 - 状态信息和开关 */}
          <div className="md:col-span-4 space-y-4">
            {/* 状态信息和开关集成面板 */}
            <div className="bg-white/80 dark:bg-[#2a2a2a]/90 backdrop-blur-md border border-gray-200 dark:border-gray-700 rounded-lg p-4">
              <h3 className="text-lg font-semibold mb-4 text-gray-800 dark:text-gray-200">状态信息</h3>
              
              {/* 状态信息部分 */}
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
              
              {/* 分割线 */}
              <div className="my-6 border-t border-gray-200 dark:border-gray-700"></div>
              
              {/* 开关部分 */}
              <div className="space-y-3">
                <div className="flex items-center justify-between p-3 bg-gradient-to-br from-indigo-50 to-indigo-100 dark:from-[#222222] dark:to-[#1a1a1a] rounded-lg">
                  <div className="flex items-center text-indigo-800 dark:text-indigo-300">
                    <DesktopIcon className="w-4 h-4 mr-1.5" />
                    <span>系统代理</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Switch.Root
                      checked={proxyEnabled}
                      onCheckedChange={handleProxyToggle}
                      disabled={!isRunning || isProxyUpdating}
                      className={`w-11 h-6 rounded-full transition-colors duration-200 ${
                        proxyEnabled 
                          ? 'bg-indigo-500 dark:bg-indigo-600' 
                          : 'bg-gray-200 dark:bg-gray-600'
                      } ${(!isRunning || isProxyUpdating) ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      <Switch.Thumb 
                        className={`block w-5 h-5 bg-white rounded-full shadow transform transition-transform duration-200 ${
                          proxyEnabled ? 'translate-x-6' : 'translate-x-0.5'
                        }`} 
                      />
                    </Switch.Root>
                  </div>
                </div>

                {/* TUN模式开关 */}
                <div className="flex items-center justify-between p-3 bg-gradient-to-br from-green-50 to-green-100 dark:from-[#222222] dark:to-[#1a1a1a] rounded-lg">
                  <div className="flex items-center text-green-800 dark:text-green-300">
                    <Network className="w-4 h-4 mr-1.5" />
                    <span>TUN模式</span>
                    <Tooltip.Provider>
                      <Tooltip.Root>
                        <Tooltip.Trigger asChild>
                          <InfoCircledIcon className="w-3.5 h-3.5 ml-1.5 text-gray-400 cursor-help" />
                        </Tooltip.Trigger>
                        <Tooltip.Portal>
                          <Tooltip.Content
                            className="bg-black/80 text-white text-xs rounded p-2 max-w-xs z-50"
                            sideOffset={5}
                          >
                            TUN模式可以接管所有流量，包括不遵循系统代理设置的应用程序流量
                            <Tooltip.Arrow className="fill-black/80" />
                          </Tooltip.Content>
                        </Tooltip.Portal>
                      </Tooltip.Root>
                    </Tooltip.Provider>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Switch.Root
                      checked={tunEnabled}
                      onCheckedChange={handleTunToggle}
                      disabled={!isRunning || isTunUpdating}
                      className={`w-11 h-6 rounded-full transition-colors duration-200 ${
                        tunEnabled 
                          ? 'bg-green-500 dark:bg-green-600' 
                          : 'bg-gray-200 dark:bg-gray-600'
                      } ${(!isRunning || isTunUpdating) ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      <Switch.Thumb 
                        className={`block w-5 h-5 bg-white rounded-full shadow transform transition-transform duration-200 ${
                          tunEnabled ? 'translate-x-6' : 'translate-x-0.5'
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
              
              <div className="mt-2">
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

    // 减少渲染的数据点，提高性能
    const downsampleData = (data: TrafficData[], maxPoints = 30) => {
      if (data.length <= maxPoints) return data;
      
      const step = Math.floor(data.length / maxPoints);
      const result: TrafficData[] = [];
      
      for (let i = 0; i < data.length; i += step) {
        result.push(data[i]);
      }
      
      // 确保包含最新的数据点
      if (result[result.length - 1] !== data[data.length - 1]) {
        result.push(data[data.length - 1]);
      }
      
      return result;
    };
    
    // 对数据进行降采样
    const downsampledData = downsampleData(trafficData);

    // 将数据转换为相同的单位（KB）进行显示
    const convertToKB = (bytes: number) => bytes / 1024;
    
    const normalizedData = downsampledData.map(d => ({
      timestamp: d.timestamp,
      up: convertToKB(d.up || 0),
      down: convertToKB(d.down || 0)
    }));
    
    // 计算最大值时使用转换后的数据
    const maxValue = Math.max(
      ...normalizedData.map(d => Math.max(d.up, d.down)),
      1  // 最小值设为1KB
    );

    // 优化：计算合适的Y轴刻度
    const calculateYAxisTicks = (max: number): number[] => {
      // 四舍五入到最接近的整数量级
      const magnitude = Math.pow(10, Math.floor(Math.log10(max)));
      const normalizedMax = Math.ceil(max / magnitude) * magnitude;
      
      // 生成4个刻度点，减少一个以适应更紧凑的高度
      const tickCount = 4;
      const ticks = [];
      for (let i = 0; i <= tickCount; i++) {
        ticks.push((normalizedMax / tickCount) * i);
      }
      return ticks;
    };
    
    const yAxisTicks = calculateYAxisTicks(maxValue);
    
    // 格式化Y轴刻度显示
    const formatYAxisLabel = (value: number): string => {
      if (value === 0) return '0';
      if (value < 1024) return `${Math.round(value)} KB`;
      return `${(value / 1024).toFixed(1)} MB`;
    };
    
    // 计算平滑的贝塞尔曲线路径
    const generateSmoothPath = (data: typeof normalizedData[0][], key: 'up' | 'down') => {
      if (data.length < 2) return '';
      
      const width = 100 / (data.length - 1);
      const paddingTop = 15;
      const paddingBottom = 12; // 减少底部padding
      const availableHeight = 100 - paddingTop - paddingBottom;
      
      // 开始路径，平滑开始点
      let path = `M 0,${paddingTop + availableHeight - (data[0][key] / maxValue) * availableHeight}`;
      
      // 使用更平滑的曲线张力
      const tension = 0.4; // 较小的值会使曲线更加丝滑
      
      if (data.length === 2) {
        // 只有两个点时使用简单的线段
        const x2 = width;
        const y2 = paddingTop + availableHeight - (data[1][key] / maxValue) * availableHeight;
        path += ` L ${x2},${y2}`;
      } else {
        // 使用Cardinal样条算法，创建更加丝滑的曲线
        for (let i = 0; i < data.length - 1; i++) {
          const x1 = i * width;
          const y1 = paddingTop + availableHeight - (data[i][key] / maxValue) * availableHeight;
          const x2 = (i + 1) * width;
          const y2 = paddingTop + availableHeight - (data[i + 1][key] / maxValue) * availableHeight;
          
          // 计算控制点，考虑前后点的影响，实现更连续的曲线
          let cpx1, cpy1, cpx2, cpy2;
          
          if (i === 0) {
            // 第一段曲线的控制点
            const dx = x2 - x1;
            const dy = y2 - y1;
            
            cpx1 = x1 + dx * tension;
            cpy1 = y1 + dy * tension;
            
            // 如果有第三个点，用它来影响第二个控制点
            if (data.length > 2) {
              const x3 = (i + 2) * width;
              const y3 = paddingTop + availableHeight - (data[i + 2][key] / maxValue) * availableHeight;
              const dx2 = x3 - x1;
              const dy2 = y3 - y1;
              
              cpx2 = x2 - dx2 * tension / 3;
              cpy2 = y2 - dy2 * tension / 3;
            } else {
              cpx2 = x2 - dx * tension;
              cpy2 = y2 - dy * tension;
            }
          } else if (i === data.length - 2) {
            // 最后一段曲线的控制点
            const x0 = (i - 1) * width;
            const y0 = paddingTop + availableHeight - (data[i - 1][key] / maxValue) * availableHeight;
            const dx1 = x2 - x0;
            const dy1 = y2 - y0;
            
            cpx1 = x1 + dx1 * tension / 3;
            cpy1 = y1 + dy1 * tension / 3;
            
            const dx = x2 - x1;
            const dy = y2 - y1;
            
            cpx2 = x2 - dx * tension;
            cpy2 = y2 - dy * tension;
          } else {
            // 中间段曲线的控制点，考虑前后点以确保连续性
            const x0 = (i - 1) * width;
            const y0 = paddingTop + availableHeight - (data[i - 1][key] / maxValue) * availableHeight;
            const x3 = (i + 2) * width;
            const y3 = paddingTop + availableHeight - (data[i + 2][key] / maxValue) * availableHeight;
            
            // 使用Catmull-Rom样条的变体来计算控制点
            const dx1 = (x2 - x0) * tension;
            const dy1 = (y2 - y0) * tension;
            const dx2 = (x3 - x1) * tension;
            const dy2 = (y3 - y1) * tension;
            
            cpx1 = x1 + dx1 / 3;
            cpy1 = y1 + dy1 / 3;
            cpx2 = x2 - dx2 / 3;
            cpy2 = y2 - dy2 / 3;
          }
          
          // 添加贝塞尔曲线段
          path += ` C ${cpx1},${cpy1} ${cpx2},${cpy2} ${x2},${y2}`;
        }
      }
      
      return path;
    };
    
    const upPath = generateSmoothPath(normalizedData, 'up');
    const downPath = generateSmoothPath(normalizedData, 'down');
    
    // 生成填充区域路径，使用更美观的底部曲线
    const generateGradientFillPath = (linePath: string) => {
      const endPoint = 88;
      // 使用更加平滑的底部连接曲线，而不是直接的直线连接
      return `${linePath} L 100,${endPoint} Q 50,${endPoint + 0.8} 0,${endPoint} Z`;
    };
    
    const upFillPath = generateGradientFillPath(upPath);
    const downFillPath = generateGradientFillPath(downPath);
    
    // 格式化时间轴标签
    const formatTimeLabel = (timestamp: number): string => {
      const date = new Date(timestamp);
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }).slice(-8);
    };
    
    // 生成时间轴标签
    const generateTimeLabels = () => {
      // 增加标签数量，使时间轴更详细
      const labelCount = Math.min(7, normalizedData.length);
      if (labelCount <= 1) return [];
      
      const labels = [];
      for (let i = 0; i < labelCount; i++) {
        const index = Math.floor((normalizedData.length - 1) * (i / (labelCount - 1)));
        const data = normalizedData[index];
        labels.push({
          x: (index / (normalizedData.length - 1)) * 100,
          time: formatTimeLabel(data.timestamp)
        });
      }
      return labels;
    };
    
    const timeLabels = generateTimeLabels();

    // 格式化KB单位的显示
    const formatKBSpeed = (kb: number): string => {
      if (kb < 1) return `${(kb * 1024).toFixed(0)} B/s`;
      if (kb < 1024) return `${kb.toFixed(1)} KB/s`;
      if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(2)} MB/s`;
      return `${(kb / 1024 / 1024).toFixed(2)} GB/s`;
    };

    // 获取最后一个数据点，用于显示当前值标记
    const lastDataIndex = normalizedData.length - 1;
    const lastUpValue = normalizedData[lastDataIndex].up;
    const lastDownValue = normalizedData[lastDataIndex].down;
    const lastUpY = 15 + (88 - 15) - (lastUpValue / maxValue) * (88 - 15);
    const lastDownY = 15 + (88 - 15) - (lastDownValue / maxValue) * (88 - 15);
    
    return (
      <div className="relative overflow-hidden border dark:border-gray-800 rounded-lg bg-white dark:bg-[#2a2a2a] h-56">
        {/* 像心电图一样的网格背景 */}
        <div className="absolute inset-0" style={{
          backgroundImage: `
            linear-gradient(to right, rgba(226, 232, 240, 0.05) 1px, transparent 1px),
            linear-gradient(to bottom, rgba(226, 232, 240, 0.05) 1px, transparent 1px)
          `,
          backgroundSize: '20px 20px'
        }}></div>
        
        <svg className="w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
          {/* 定义渐变和滤镜 */}
          <defs>
            <linearGradient id="downGradient" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="rgba(59, 130, 246, 0.3)" />
              <stop offset="100%" stopColor="rgba(59, 130, 246, 0.01)" />
            </linearGradient>
            <linearGradient id="upGradient" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="rgba(34, 197, 94, 0.3)" />
              <stop offset="100%" stopColor="rgba(34, 197, 94, 0.01)" />
            </linearGradient>

            {/* 边缘渐变遮罩 */}
            <linearGradient id="edgeGradientLeft" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#ffffff" stopOpacity="1" />
              <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="edgeGradientLeftDark" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#2a2a2a" stopOpacity="1" />
              <stop offset="100%" stopColor="#2a2a2a" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="edgeGradientRight" x1="100%" y1="0%" x2="0%" y2="0%">
              <stop offset="0%" stopColor="#ffffff" stopOpacity="1" />
              <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="edgeGradientRightDark" x1="100%" y1="0%" x2="0%" y2="0%">
              <stop offset="0%" stopColor="#2a2a2a" stopOpacity="1" />
              <stop offset="100%" stopColor="#2a2a2a" stopOpacity="0" />
            </linearGradient>
            
            {/* 发光效果滤镜 */}
            <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="1" result="blur" />
              <feComposite in="SourceGraphic" in2="blur" operator="over" />
            </filter>
            
            {/* 心电图线条样式滤镜 */}
            <filter id="ecgGlow" x="-10%" y="-10%" width="120%" height="120%">
              <feGaussianBlur stdDeviation="0.2" result="blur" />
              <feComposite in="SourceGraphic" in2="blur" operator="over" />
            </filter>
            
            {/* 增强脉冲效果滤镜 */}
            <filter id="pulseGlow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="0.6" result="blur" />
              <feComposite in="SourceGraphic" in2="blur" operator="over" />
            </filter>
          </defs>

          {/* Y轴刻度线和标签 - 使用更淡的颜色 */}
          <g className="y-axis">
            {yAxisTicks.map((tick, index) => (
              <g key={`y-tick-${index}`}>
                <line 
                  x1="0" 
                  y1={15 + (88 - 15) - (tick / maxValue) * (88 - 15)} 
                  x2="100" 
                  y2={15 + (88 - 15) - (tick / maxValue) * (88 - 15)} 
                  stroke="rgba(226, 232, 240, 0.15)" 
                  strokeDasharray={index > 0 ? "1,1" : "none"}
                  strokeWidth={index === 0 ? 0.75 : 0.5} 
                />
                {/* 移除Y轴文字标签 */}
              </g>
            ))}
          </g>

          {/* X轴时间标签 - 使用更淡的颜色 */}
          <g className="x-axis">
            {timeLabels.map((label, index) => (
              <g key={`x-tick-${index}`}>
                <line 
                  x1={label.x} 
                  y1="88" 
                  x2={label.x} 
                  y2="89" 
                  stroke="rgba(148, 163, 184, 0.15)" 
                  strokeWidth="0.5" 
                />
                {/* 移除X轴文字标签 */}
              </g>
            ))}
          </g>
          
          {/* 图表底部基线 */}
          <line x1="0" y1="88" x2="100" y2="88" stroke="rgba(148, 163, 184, 0.2)" strokeWidth="0.5" />
          
          {/* 下载流量图形填充 */}
          <path 
            d={downFillPath}
            fill="url(#downGradient)"
            stroke="none"
            opacity="0.6"
          />
          
          {/* 上传流量图形填充 */}
          <path 
            d={upFillPath}
            fill="url(#upGradient)"
            stroke="none"
            opacity="0.6"
          />
          
          {/* 下载流量线条 - 心电图效果 */}
          <path 
            d={downPath} 
            fill="none" 
            stroke="#3b82f6" 
            strokeWidth="0.8"
            filter="url(#ecgGlow)"
            className="drop-shadow-sm"
          />
          
          {/* 上传流量线条 - 心电图效果 */}
          <path 
            d={upPath} 
            fill="none" 
            stroke="#22c55e" 
            strokeWidth="0.8"
            filter="url(#ecgGlow)"
            className="drop-shadow-sm"
          />
          
          {/* 动态数据点 - 下载（改进动画） */}
          <g className="animate-pulse">
            <circle 
              cx="100" 
              cy={lastDownY} 
              r="1" 
              fill="#3b82f6" 
              filter="url(#pulseGlow)"
            />
            <circle 
              cx="100" 
              cy={lastDownY} 
              r="1.6" 
              fill="none" 
              stroke="#3b82f6" 
              strokeWidth="0.4"
              opacity="0.6"
            />
          </g>
          
          {/* 动态数据点 - 上传（改进动画） */}
          <g className="animate-pulse">
            <circle 
              cx="100" 
              cy={lastUpY} 
              r="1" 
              fill="#22c55e"
              filter="url(#pulseGlow)"
            />
            <circle 
              cx="100" 
              cy={lastUpY} 
              r="1.6" 
              fill="none" 
              stroke="#22c55e" 
              strokeWidth="0.4"
              opacity="0.6"
            />
          </g>
          
          {/* 添加额外装饰点，增强心电图的视觉效果 */}
          {normalizedData.map((data, index) => {
            // 更多的装饰点，但避免最后几个和最前几个
            if (index % 6 === 0 && index > 3 && index < normalizedData.length - 3) {
              const x = (index / (normalizedData.length - 1)) * 100;
              const yDown = 15 + (88 - 15) - (data.down / maxValue) * (88 - 15);
              const yUp = 15 + (88 - 15) - (data.up / maxValue) * (88 - 15);
              
              // 使用二元装饰点系统 - 大小不同的点组合
              return (
                <g key={`point-${index}`}>
                  <circle 
                    cx={x} 
                    cy={yDown} 
                    r="0.6" 
                    fill="#3b82f6" 
                    opacity="0.6"
                  />
                  <circle 
                    cx={x} 
                    cy={yDown} 
                    r="0.2" 
                    fill="#ffffff" 
                    opacity="0.9"
                  />
                  <circle 
                    cx={x} 
                    cy={yUp} 
                    r="0.6" 
                    fill="#22c55e" 
                    opacity="0.6"
                  />
                  <circle 
                    cx={x} 
                    cy={yUp} 
                    r="0.2" 
                    fill="#ffffff" 
                    opacity="0.9"
                  />
                </g>
              );
            }
            return null;
          })}
        </svg>

        {/* 悬浮显示最大值 */}
        <div className="absolute top-3 right-3 text-xs bg-white/70 dark:bg-black/50 rounded px-1.5 py-0.5 text-gray-700 dark:text-gray-300 backdrop-blur-sm shadow-sm">
          峰值 {formatKBSpeed(maxValue)}
        </div>
        
        {/* 使用SVG渐变替代DIV遮罩，实现更好的暗黑模式兼容 */}
        <svg className="absolute inset-0 pointer-events-none z-10" preserveAspectRatio="none" viewBox="0 0 100 100">
          <rect x="0" y="0" width="8" height="100" fill="url(#edgeGradientLeft)" className="dark:hidden" />
          <rect x="0" y="0" width="8" height="100" fill="url(#edgeGradientLeftDark)" className="hidden dark:block" />
          <rect x="94" y="0" width="6" height="100" fill="url(#edgeGradientRight)" className="dark:hidden" />
          <rect x="94" y="0" width="6" height="100" fill="url(#edgeGradientRightDark)" className="hidden dark:block" />
        </svg>
      </div>
    );
  };
  
  // 处理系统代理开关 - 适配新的安全验证
  const handleProxyToggle = async (enabled: boolean) => {
    try {
      if (!window.electronAPI) return;

      setIsProxyUpdating(true);
      console.log('切换系统代理:', enabled);
      
      const result = await window.electronAPI.toggleSystemProxy(enabled);
      console.log('系统代理切换结果:', result);
      
      // 处理新的返回格式
      if (result && typeof result === 'object' && 'success' in result) {
        const apiResult = result as { success: boolean; error?: string; status?: boolean };
        
        if (!apiResult.success) {
          console.error('系统代理切换失败:', apiResult.error);
          showToast('错误', `切换系统代理失败: ${apiResult.error || '未知错误'}`, 'error');
          // 手动恢复UI状态，因为状态事件可能不会触发
          setProxyEnabled(!enabled);
        }
      }
      
      // 状态由后端通过事件通知更新
    } catch (error) {
      console.error('切换系统代理失败:', error);
      showToast('错误', `切换系统代理失败: ${error}`, 'error');
      // 恢复UI状态
      setProxyEnabled(!enabled);
    } finally {
      setIsProxyUpdating(false);
    }
  };
  
  // 处理TUN模式开关
  const handleTunToggle = async (enabled: boolean) => {
    try {
      if (!window.electronAPI) return;

      if (enabled) {
        // 显示确认对话框
        showConfirmDialog(
          '启用TUN模式',
          '启动TUN模式将重启内核，可能需要管理员权限运行FlyClash才可以开启，是否继续操作?',
          async () => {
            try {
              setIsTunUpdating(true);
              console.log('启用TUN模式...');
              
              // 立即更新UI状态，提供反馈
              setTunEnabled(true);
              
                              if (window.electronAPI) {
                const result = await window.electronAPI.toggleTunMode(true);
                console.log('TUN模式启用结果:', result);
                
                if (result && typeof result === 'object' && 'success' in result) {
                  const apiResult = result as { success: boolean; error?: string; status?: boolean };
                  
                  if (apiResult.success) {
                    showToast('成功', 'TUN模式已启用', 'success');
                  } else {
                    showToast('失败', `TUN模式启用失败: ${apiResult.error || '未知错误'}`, 'error');
                    setTunEnabled(false);
                  }
                } else if (result) {
                  // 兼容旧API
                  showToast('成功', 'TUN模式已启用', 'success');
                } else {
                  showToast('失败', 'TUN模式启用失败', 'error');
                  setTunEnabled(false);
                }
                
                // 1秒后再次检查TUN状态以确保UI和实际状态一致
                setTimeout(async () => {
                  try {
                    if (!window.electronAPI) return;
                    const currentStatus = await window.electronAPI.getTunStatus();
                    if (currentStatus !== tunEnabled) {
                      console.log('TUN状态不一致，同步UI:', { current: currentStatus, ui: tunEnabled });
                      setTunEnabled(currentStatus);
                    }
                  } catch (error) {
                    console.error('操作后检查TUN状态失败:', error);
                  }
                }, 1000);
              } else {
                showToast('错误', 'ElectronAPI不可用', 'error');
                setTunEnabled(false);
              }
            } catch (error) {
              console.error('启用TUN模式失败:', error);
              showToast('错误', `启用TUN模式失败: ${error}`, 'error');
              // 恢复UI状态
              setTunEnabled(false);
            } finally {
              setIsTunUpdating(false);
            }
          },
          '启用',
          '取消'
        );
      } else {
        // 关闭TUN模式不需要确认
        setIsTunUpdating(true);
        console.log('关闭TUN模式...');
        
        // 立即更新UI状态，提供反馈
        setTunEnabled(false);
        
        if (window.electronAPI) {
          const result = await window.electronAPI.toggleTunMode(false);
          console.log('TUN模式关闭结果:', result);
          
          if (result && typeof result === 'object' && 'success' in result) {
            const apiResult = result as { success: boolean; error?: string; status?: boolean };
            
            if (apiResult.success) {
              showToast('成功', 'TUN模式已关闭', 'success');
            } else {
              showToast('失败', `TUN模式关闭失败: ${apiResult.error || '未知错误'}`, 'error');
              setTunEnabled(true);
            }
          } else if (result) {
            // 兼容旧API
            showToast('成功', 'TUN模式已关闭', 'success');
          } else {
            showToast('失败', 'TUN模式关闭失败', 'error');
            setTunEnabled(true);
          }
          
          // 操作后检查TUN状态
          setTimeout(async () => {
            try {
              if (!window.electronAPI) return;
              const currentStatus = await window.electronAPI.getTunStatus();
              if (currentStatus !== tunEnabled) {
                console.log('TUN状态不一致，同步UI:', { current: currentStatus, ui: tunEnabled });
                setTunEnabled(currentStatus);
              }
            } catch (error) {
              console.error('操作后检查TUN状态失败:', error);
            }
          }, 1000);
        } else {
          showToast('错误', 'ElectronAPI不可用', 'error');
          setTunEnabled(true);
        }
        
        setIsTunUpdating(false);
      }
    } catch (error) {
      console.error('切换TUN模式失败:', error);
      showToast('错误', `切换TUN模式失败: ${error}`, 'error');
      // 恢复UI状态
      setTunEnabled(!enabled);
      setIsTunUpdating(false);
    }
  };
  
  // 在组件卸载时清理资源
  useEffect(() => {
    return () => {
      // 清理事件监听器
      if (window.electronAPI) {
        window.electronAPI.removeAllListeners('dashboard');
      }
      // 清空数据以释放内存
      setTrafficData([]);
      setConnectionCount(0);
      setUpstreamTraffic(0);
      setDownstreamTraffic(0);
      setUpSpeed(0);
      setDownSpeed(0);
      setTotalUpload(0);
      setTotalDownload(0);
    };
  }, []);
  
  // 优化流量数据的处理
  useEffect(() => {
    // 添加清理过期数据的逻辑
    const cleanupInterval = setInterval(() => {
      setTrafficData(prev => {
        if (prev.length > MAX_TRAFFIC_DATA_POINTS) {
          return prev.slice(-MAX_TRAFFIC_DATA_POINTS);
        }
        return prev;
      });
    }, 10000); // 每10秒检查一次
    
    return () => {
      clearInterval(cleanupInterval);
    };
  }, []);
  
  // 优化连接数据的处理 
  useEffect(() => {
    // 添加清理过多连接数据的逻辑
    const cleanupConnectionsInterval = setInterval(() => {
      setConnectionCount(prev => {
        if (prev > MAX_CONNECTION_DATA) {
          return MAX_CONNECTION_DATA;
        }
        return prev;
      });
    }, 15000); // 每15秒检查一次
    
    return () => {
      clearInterval(cleanupConnectionsInterval);
    };
  }, []);
  
  // 显示Toast提示
  const showToast = (title: string, description: string, type: 'success' | 'error') => {
    setToastTitle(title);
    setToastDescription(description);
    setToastType(type);
    setToastOpen(true);
  };

  // 显示确认对话框
  const showConfirmDialog = (
    title: string, 
    description: string, 
    actionFn: () => Promise<void>,
    actionText: string = '确认',
    cancelText: string = '取消'
  ) => {
    setDialogTitle(title);
    setDialogDescription(description);
    setDialogAction(() => actionFn);
    setDialogActionText(actionText);
    setDialogCancelText(cancelText);
    setDialogOpen(true);
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
      
      {/* 添加Toast提示组件 */}
      <Toast.Provider swipeDirection="right">
        <Toast.Root
          open={toastOpen} 
          onOpenChange={setToastOpen}
          className={`fixed bottom-4 right-4 p-4 rounded-md shadow-md ${
            toastType === 'success' 
              ? 'bg-green-500 text-white' 
              : 'bg-red-500 text-white'
          }`}
        >
          <Toast.Title className="font-medium">{toastTitle}</Toast.Title>
          <Toast.Description>{toastDescription}</Toast.Description>
          <Toast.Close asChild>
            <button 
              className="absolute top-2 right-2 text-white" 
              aria-label="Close"
            >
              <Cross2Icon />
            </button>
          </Toast.Close>
        </Toast.Root>
        
        <Toast.Viewport />
      </Toast.Provider>
      
      {/* 添加确认对话框组件 */}
      <Dialog.Root open={dialogOpen} onOpenChange={setDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/50 animate-fade-in" />
          <Dialog.Content className="fixed left-[50%] top-[50%] w-[90%] max-w-md translate-x-[-50%] translate-y-[-50%] rounded-lg bg-white dark:bg-gray-800 p-6 shadow-xl animate-scale-in z-50">
            <Dialog.Title className="text-lg font-bold text-gray-900 dark:text-white">{dialogTitle}</Dialog.Title>
            <Dialog.Description className="mt-2 text-gray-600 dark:text-gray-300">{dialogDescription}</Dialog.Description>
            
            <div className="mt-6 flex justify-end space-x-3">
              <button 
                onClick={() => setDialogOpen(false)} 
                className="py-2 px-4 rounded-md bg-gray-200 hover:bg-gray-300 text-gray-800 dark:bg-gray-700 dark:hover:bg-gray-600 dark:text-white transition-colors"
              >
                {dialogCancelText}
              </button>
              <button 
                onClick={async () => {
                  setDialogOpen(false);
                  await dialogAction();
                }} 
                className="py-2 px-4 rounded-md bg-blue-500 hover:bg-blue-600 text-white transition-colors"
              >
                {dialogActionText}
              </button>
            </div>
            
            <Dialog.Close asChild>
              <button 
                className="absolute top-3 right-3 w-6 h-6 flex items-center justify-center rounded-full text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-white" 
                aria-label="Close"
              >
                <Cross2Icon />
              </button>
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
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