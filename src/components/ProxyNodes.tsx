import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  CheckIcon,
  ReloadIcon,
  MagnifyingGlassIcon,
  GlobeIcon,
  StarIcon,
  StarFilledIcon,
  ExclamationTriangleIcon,
  Cross1Icon,
  MixerHorizontalIcon,
  PlusIcon,
  CheckCircledIcon,
  ChevronRightIcon,
  ViewVerticalIcon,
  ViewHorizontalIcon
} from '@radix-ui/react-icons';
import { Badge } from "./ui/badge";
import { useMihomoAPI } from '../services/mihomo-api';
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { useTranslation } from 'react-i18next';
import { useRouter } from 'next/navigation';
// 引入虚拟化列表库
import { FixedSizeGrid as Grid } from 'react-window';
import AutoSizer from 'react-virtualized-auto-sizer';
import { EmojiText } from './ui/emoji';

const isDev = process.env.NODE_ENV === 'development';

// 定义类型
type ProxyNode = {
  name: string;
  type: string;
  server: string;
  port: number;
  delay?: number;
  isGroup?: boolean;
};

type ProxyGroup = {
  name: string;
  type: string;
  nodes: ProxyNode[];
  now?: string;
  icon?: string | null;
};

type MihomoProxy = {
  type: string;
  all?: string[];
  now?: string;
  history?: {delay: number}[];
  server?: string;
  port?: number;
};

const isGroupType = (type?: string | null) => {
  if (!type) return false;
  const normalized = type.toLowerCase().replace(/-/g, '');
  return ['selector', 'urltest', 'fallback', 'loadbalance', 'smart'].includes(normalized);
};

const renderGroupIcon = (icon?: string | null) => {
  if (!icon) return null;
  const trimmed = icon.trim();
  if (!trimmed) return null;
  const isImageSource = /^https?:\/\//i.test(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('data:image') || trimmed.startsWith('file://');

  if (isDev) {
    console.log('[renderGroupIcon] icon:', trimmed.substring(0, 100), 'isImageSource:', isImageSource);
  }

  if (isImageSource) {
    return (
      <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-muted/40">
        <img src={trimmed} alt="" className="h-7 w-7 object-contain" />
      </span>
    );
  }

  return (
    <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary text-base font-semibold">
      {trimmed.length > 2 ? trimmed.slice(0, 2) : trimmed}
    </span>
  );
};

// 节点组件
export default function ProxyNodes() {
  const { t } = useTranslation();
  // 不再从 sessionStorage 恢复整棵代理树，首次进入时统一从内核拉取最新数据
  const [groups, setGroups] = useState<ProxyGroup[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<string>('all');
  const [testingNodes, setTestingNodes] = useState<Set<string>>(new Set());
  const [testingGroups, setTestingGroups] = useState<Set<string>>(new Set());
  const [favoriteNodes, setFavoriteNodes] = useState<Set<string>>(new Set());
  // 初始化时从sessionStorage加载mihomo运行状态
  const [mihomoRunning, setMihomoRunning] = useState(() => {
    if (typeof window === 'undefined') return false;
    try {
      const saved = sessionStorage.getItem('mihomoRunningState');
      if (saved !== null) {
        return saved === 'true';
      }
      // 如果有缓存的groups数据，说明之前mihomo是运行的
      const hasCache = sessionStorage.getItem('proxyGroupsCache');
      return hasCache !== null;
    } catch (error) {
      console.error('Failed to load mihomo running state:', error);
      return false;
    }
  });
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  
  // 初始化折叠状态，从localStorage加载，确保有效
  const loadSavedCollapsedState = () => {
    // 检查是否在浏览器环境
    if (typeof window === 'undefined') {
      return new Set();
    }

    try {
      const savedState = localStorage.getItem('collapsedGroups');
      if (savedState) {
        const parsed = JSON.parse(savedState);
        if (Array.isArray(parsed)) {
          if (isDev) {
            console.log('初始化时从localStorage加载折叠状态:', parsed);
          }
          return new Set(parsed);
        }
      }
      // 如果没有保存的状态，检查是否是首次访问
      const isFirstVisit = localStorage.getItem('proxyNodesFirstVisit');
      if (isFirstVisit === null) {
        // 首次访问，标记并返回空Set（表示全部展开，然后会被下面的useEffect设置为全部折叠）
        localStorage.setItem('proxyNodesFirstVisit', 'false');
        return new Set();
      }
    } catch (error) {
      console.error('加载折叠状态失败:', error);
    }
    return new Set();
  };

  // 使用函数初始化，确保只运行一次
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(loadSavedCollapsedState);
  const isInitialLoadRef = useRef(true);
  const isUserScrollingRef = useRef(false);
  const scrollIdleTimeoutRef = useRef<number | null>(null);
  const pendingRefreshRef = useRef(false);

  // 导出调试函数到window对象，可在控制台访问
  if (typeof window !== 'undefined') {
    (window as any).debugCollapsedGroups = {
      getCollapsed: () => Array.from(collapsedGroups),
      getLocalStorage: () => {
        try {
          const saved = localStorage.getItem('collapsedGroups');
          return saved ? JSON.parse(saved) : null;
        } catch (e) {
          return `Error: ${e}`;
        }
      },
      forceCollapse: (groupName: string) => {
        const newSet = new Set(collapsedGroups);
        newSet.add(groupName);
        setCollapsedGroups(newSet);
        localStorage.setItem('collapsedGroups', JSON.stringify(Array.from(newSet)));
        if (isDev) {
          console.log(`已强制折叠: ${groupName}`);
        }
        return Array.from(newSet);
      },
      forceExpand: (groupName: string) => {
        const newSet = new Set(collapsedGroups);
        newSet.delete(groupName);
        setCollapsedGroups(newSet);
        localStorage.setItem('collapsedGroups', JSON.stringify(Array.from(newSet)));
        if (isDev) {
          console.log(`已强制展开: ${groupName}`);
        }
        return Array.from(newSet);
      },
      reset: () => {
        setCollapsedGroups(new Set());
        localStorage.removeItem('collapsedGroups');
        if (isDev) {
          console.log('已重置所有折叠状态');
        }
      }
    };
  }
  
  const LAYOUT_SETTING_KEY = 'proxyGroupsLayoutMode';
  const SORT_MODE_KEY = 'nodesSortMode';

  const [currentMode, setCurrentMode] = useState<string>('rule');
  const [layoutMode, setLayoutMode] = useState<'single' | 'double'>(() => {
    if (typeof window === 'undefined') {
      return 'single';
    }

    try {
      const saved = localStorage.getItem(LAYOUT_SETTING_KEY);
      return (saved === 'double' ? 'double' : 'single') as 'single' | 'double';
    } catch {
      return 'single';
    }
  });
  const [sortMode, setSortMode] = useState<'default' | 'latency'>(() => {
    if (typeof window === 'undefined') {
      return 'default';
    }

    try {
      const saved = localStorage.getItem(SORT_MODE_KEY);
      return saved === 'latency' ? 'latency' : 'default';
    } catch {
      return 'default';
    }
  });
  const [showOptionsMenu, setShowOptionsMenu] = useState(false);
  const router = useRouter();
  let mihomoAPI = useMihomoAPI();

  const applySortMode = useCallback((value: 'default' | 'latency') => {
    setSortMode(value);
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(SORT_MODE_KEY, value);
      } catch (error) {
        console.error('缓存排序模式失败:', error);
      }
    }
  }, []);

  const persistSortMode = useCallback(async (value: 'default' | 'latency') => {
    applySortMode(value);

    try {
      if (typeof window !== 'undefined' && window.electronAPI?.setSetting) {
        const result = await window.electronAPI.setSetting(SORT_MODE_KEY, value);
        if (result?.success === false && isDev) {
          console.error('保存排序模式失败:', result.error);
        }
      }
    } catch (error) {
      console.error('保存排序模式失败:', error);
    }
  }, [applySortMode]);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.electronAPI?.getSetting) {
      return;
    }

    let cancelled = false;

    const loadLayoutPreference = async () => {
      try {
        const result = await window.electronAPI.getSetting(LAYOUT_SETTING_KEY, 'single');
        if (!cancelled && result?.success) {
          const value = result.value === 'double' ? 'double' : 'single';
          setLayoutMode(value);
          try {
            localStorage.setItem(LAYOUT_SETTING_KEY, value);
          } catch {}
        }
      } catch (error) {
        console.error('加载代理组布局设置失败:', error);
      }
    };

    loadLayoutPreference();

    // 加载排序模式设置
    const loadSortModePreference = async () => {
      try {
        const result = await window.electronAPI.getSetting(SORT_MODE_KEY, sortMode);
        if (!cancelled && result?.success) {
          const value = result.value === 'latency' ? 'latency' : 'default';
          applySortMode(value);
          return;
        }
      } catch (error) {
        console.error('加载排序模式设置失败:', error);
      }

      // IPC 获取失败时，尝试从本地缓存恢复
      if (!cancelled) {
        if (typeof window !== 'undefined') {
          try {
            const fallback = localStorage.getItem(SORT_MODE_KEY) === 'latency' ? 'latency' : 'default';
            applySortMode(fallback);
          } catch (error) {
            console.error('加载排序模式本地缓存失败:', error);
          }
        }
      }
    };

    loadSortModePreference();

    return () => {
      cancelled = true;
    };
  }, [applySortMode, sortMode]);

  // 获取节点的动画高度，用于折叠/展开动画
  const getNodeRef = useRef<{[key: string]: HTMLDivElement | null}>({});
  const contentRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // 获取API配置并正确初始化mihomoAPI
    const getApiConfig = async () => {
      if (window.electronAPI) {
        try {
          const apiConfigResult = await window.electronAPI.getApiConfig();
          if (apiConfigResult.success) {
            // 确保密钥值存在且不为空，避免使用默认空字符串
            const secret = apiConfigResult.secret ? apiConfigResult.secret : undefined;
            
            // 使用正确的API配置初始化mihomoAPI
            mihomoAPI = useMihomoAPI({
              host: apiConfigResult.controllerHost,
              port: apiConfigResult.controllerPort,
              secret: secret // 如果为空，则使用undefined
            });
            
            if (isDev) {
              console.log('[调试] API配置已更新, 密钥:', secret ? '已设置' : '未设置');
            }
            
            // 立即触发版本检查以验证配置是否生效
            try {
              const versionInfo = await mihomoAPI.version();
              if (isDev) {
                console.log('[调试] Mihomo版本检查成功:', versionInfo);
              }
              setMihomoRunning(true);
            } catch (versionError) {
              if (isDev) {
                console.error('[调试] Mihomo版本检查失败:', versionError);
              }
              setMihomoRunning(false);
            }
          } else {
            if (isDev) {
              console.error('[调试] 获取API配置失败:', apiConfigResult.error);
            }
          }
        } catch (error) {
          if (isDev) {
            console.error('[调试] 获取API配置出错:', error);
          }
        }
      }
    };
    
    getApiConfig();
    
    // 定期刷新API配置，确保密钥最新
    const configRefreshInterval = setInterval(() => {
      getApiConfig();
    }, 60000); // 每分钟刷新一次
    
    return () => {
      clearInterval(configRefreshInterval);
    };
  }, []);

  // 显示错误提示
  const showError = (message: string) => {
    setSuccessMessage(null); // 清除成功信息
    setErrorMessage(message);
    setTimeout(() => setErrorMessage(null), 5000);
  };

  // 保存mihomo运行状态到sessionStorage
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      sessionStorage.setItem('mihomoRunningState', mihomoRunning.toString());
    } catch (error) {
      console.error('Failed to cache mihomo running state:', error);
    }
  }, [mihomoRunning]);

  // 过滤节点组
  const filteredGroups = React.useMemo(() => {
    return groups.map(group => {
      const filteredNodes = group.nodes.filter(node =>
        node.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        node.server.toLowerCase().includes(searchTerm.toLowerCase())
      );
      return { ...group, nodes: filteredNodes };
    }).filter(group => group.nodes.length > 0);
  }, [groups, searchTerm]);

  // 收藏的节点过滤
  const favoriteFilteredGroups = React.useMemo(() => {
    return groups.map(group => {
      const favoriteNodesList = group.nodes.filter(node =>
        (favoriteNodes.has(node.name)) &&
        (node.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
         node.server.toLowerCase().includes(searchTerm.toLowerCase()))
      );
      return { ...group, nodes: favoriteNodesList };
    }).filter(group => group.nodes.length > 0);
  }, [groups, favoriteNodes, searchTerm]);

  // 获取节点列表
  const fetchProxies = async () => {
    if (isInitialLoadRef.current) {
      setIsLoading(true);
    }

    try {
      // 检查Mihomo是否运行
      try {
        // 使用API验证mihomo是否运行
        const versionInfo = await mihomoAPI.version();
        if (versionInfo) {
          setMihomoRunning(true);
        } else {
          setMihomoRunning(false);
          // 只在初始加载时才设置loading为false
          if (groups.length === 0) {
            setIsLoading(false);
          }
          return;
        }
      } catch (error) {
        console.error('Mihomo未运行:', error);
        setMihomoRunning(false);
        // 只在初始加载时才设置loading为false
        if (groups.length === 0) {
          setIsLoading(false);
        }
        return;
      }

      // 获取当前模式
      let currentProxyMode = 'rule';
      try {
        const config = await mihomoAPI.configs();
        currentProxyMode = config.mode;
        setCurrentMode(currentProxyMode);
      } catch (error) {
        console.error('获取当前模式失败:', error);
      }

      // 如果是直连模式，可以提前结束加载过程
      if (currentProxyMode === 'direct') {
        if (isDev) {
          console.log('直连模式，不加载节点列表');
        }
        setGroups([]);
        if (isInitialLoadRef.current) {
          setIsLoading(false);
          isInitialLoadRef.current = false;
        }
        return;
      }
      
      // 获取配置文件中的原始顺序
      let configOrder: {
        proxyGroups: Array<{ name: string; type: string; proxies: string[]; hidden?: boolean; icon?: string | null }>,
        proxies: Array<{ name: string; type: string; server: string; port: number }>
      } | undefined;
      
      if (window.electronAPI) {
        try {
          const api = window.electronAPI as any;
          if (isDev) {
            console.log('[调试] 开始从配置文件获取代理组顺序');
          }
          const result = await api.getConfigOrder();
          if (isDev) {
            console.log('[调试] 获取配置文件顺序结果:', result);
          }

          if (result.success && result.data) {
            configOrder = result.data;
            if (isDev) {
              console.log('[调试] 成功获取配置文件顺序');
            }

            // 详细记录代理组顺序，方便调试
            if (isDev) {
              if (configOrder && configOrder.proxyGroups) {
                console.log('[调试] 配置文件中的代理组顺序:');
                configOrder.proxyGroups.forEach((group, index) => {
                  console.log(`${index + 1}. ${group.name} (${group.type}), 包含节点: ${group.proxies.length}`);
                });
              } else {
                console.log('[调试] 配置中没有代理组信息');
              }
            }
          } else if (isDev) {
            console.warn('[调试] 无法获取配置文件顺序:', result.error);
          }
        } catch (error) {
          if (isDev) {
            console.error('[调试] 获取配置顺序失败:', error);
          }
        }
      }

      // 获取代理信息
      const proxiesData = await mihomoAPI.proxies();
      if (!proxiesData || !proxiesData.proxies) {
        throw new Error('获取代理信息失败');
      }
      const data = proxiesData;

      const hiddenGroups = new Set<string>();
      if (configOrder?.proxyGroups && Array.isArray(configOrder.proxyGroups)) {
        for (const group of configOrder.proxyGroups) {
          if (group?.hidden === true && typeof group.name === 'string') {
            hiddenGroups.add(group.name);
          }
        }
      }

      const groupsData: ProxyGroup[] = [];
      
      // 根据当前模式决定如何显示节点
      if (currentProxyMode === 'global') {
        // 全局模式下，只显示GLOBAL代理组
        if (isDev) {
          console.log(`[调试] 当前为全局模式，只显示GLOBAL代理组`);
        }
        
        try {
          // 使用mihomoAPI获取GLOBAL代理组信息，不再直接用fetch
          const globalData = data.proxies['GLOBAL'];
          
          if (globalData && globalData.all && Array.isArray(globalData.all)) {
            const isHiddenGlobal = (globalData as any)?.hidden === true || hiddenGroups.has('GLOBAL');
            if (isHiddenGlobal) {
              hiddenGroups.add('GLOBAL');
              if (isDev) {
                console.log('[调试] GLOBAL 代理组设置了 hidden:true，跳过展示');
              }
              if (globalData.now) {
                setSelectedNode(globalData.now);
              }
            } else {

            const nodes = globalData.all
              .map((nodeName: string) => {
                const node = data.proxies[nodeName];
                if (!node) {
                  console.warn(`[ProxyNodes] GLOBAL 组引用了不存在的节点: ${nodeName}, 已忽略`);
                  return null;
                }
                const isGroup = isGroupType(node.type);
              
                return {
                  name: nodeName,
                  type: node.type,
                  server: isGroup ? '代理组' : ((node as any)?.server || ''),
                  port: isGroup ? 0 : ((node as any)?.port || 0),
                  delay: node.history && node.history.length > 0 ? node.history[0].delay : undefined,
                  isGroup: isGroup,
                };
              })
              .filter((n): n is ProxyNode => n !== null);
            
            const globalConfigGroup = configOrder?.proxyGroups?.find((g: any) => g.name === 'GLOBAL');
            const globalConfigIcon = globalConfigGroup?.icon || (globalData as any)?.icon || null;

            // 获取最终图标（优先使用配置中的图标，否则使用规则匹配）
            let globalIcon = globalConfigIcon;
            try {
              const result = await window.electronAPI?.proxyIcon?.getGroupIcon('GLOBAL', globalConfigIcon);
              if (result?.success && result.iconPath) {
                globalIcon = result.iconPath;
              }
            } catch (error) {
              console.error('[ProxyNodes] 获取GLOBAL组图标失败:', error);
            }

            groupsData.push({
              name: 'GLOBAL',
              type: 'Selector',
              nodes,
              now: globalData.now,
              icon: globalIcon,
            });
            }
          }
        } catch (error) {
          if (isDev) {
            console.error('[调试] 获取GLOBAL代理组失败:', error);
          }
          showError(`获取GLOBAL代理组失败: ${String(error)}`);
        }
      } else {
        // 规则模式下，显示所有代理组，但不包括GLOBAL
        if (isDev) {
          console.log(`[调试] 当前为规则模式，不显示GLOBAL代理组`);
        }
        // 规则模式下，显示所有代理组
        // 使用配置文件顺序构建数据
        const selectorGroups: {[key: string]: any} = {};
        let groupsOrder: string[] = []; // 记录组的原始顺序
        
        // 提取所有selector类型的组，规则模式下排除GLOBAL组
        for (const [name, proxy] of Object.entries<any>(data.proxies)) {
          // 在规则模式下不显示GLOBAL代理组
          if (name === 'GLOBAL' && currentProxyMode === 'rule') {
            console.log('[调试] 规则模式下忽略GLOBAL代理组');
            continue;
          }
          
          if ((proxy as any)?.hidden === true) {
            hiddenGroups.add(name);
            if (isDev) {
              console.log(`[调试] 代理组 ${name} 在配置中设置了 hidden:true，跳过展示`);
            }
            continue;
          }
          
          if (isGroupType(proxy.type)) {
            selectorGroups[name] = proxy;
          }
        }
        
        // 严格按照配置文件中的顺序排列代理组，完全忽略API返回的顺序
        if (configOrder && configOrder.proxyGroups && configOrder.proxyGroups.length > 0) {
          // 使用配置文件中的组顺序，规则模式下过滤掉GLOBAL组
          if (isDev) {
            console.log('[调试] 严格使用配置文件中的代理组顺序');
          }
          groupsOrder = configOrder.proxyGroups
            .filter(group => group.hidden !== true)
            .filter(group => !(group.name === 'GLOBAL' && currentProxyMode === 'rule'))
            .map(group => group.name);
          
          // 记录顺序详情
          if (isDev) {
            console.log(`[调试] 配置文件中的代理组顺序: ${groupsOrder.join(', ')}`);
          }
          
          // 检查对比API中的代理组
          const apiGroups = Object.keys(selectorGroups);
          if (isDev) {
            console.log(`[调试] API中的代理组: ${apiGroups.join(', ')}`);
          }
          
          // 检查配置文件中有但API中没有的组
          const missingInApi = groupsOrder.filter(name => !apiGroups.includes(name));
          if (isDev && missingInApi.length > 0) {
            console.log(`[调试] 配置文件中有但API中不存在的代理组: ${missingInApi.join(', ')}`);
          }
          
          // 检查API中有但配置文件中没有的组
          const missingInConfig = apiGroups.filter(name => !groupsOrder.includes(name));
          if (missingInConfig.length > 0) {
            if (isDev) {
              console.log(`[调试] API中有但配置文件中不存在的代理组: ${missingInConfig.join(', ')}`);
            }
            
            // 将API中额外的组添加到列表末尾
            for (const name of missingInConfig) {
              if (isDev) {
                console.log(`[调试] 添加配置文件中不存在的代理组: ${name}`);
              }
              groupsOrder.push(name);
            }
          }
        } else {
          if (isDev) {
            console.log('[调试] 未找到配置文件中的代理组顺序，尝试使用现有的分组顺序');
          }

          // 优先使用上一轮已经展示给用户的分组顺序，避免在配置暂时不可用时顺序跳动
          if (groups.length > 0) {
            const existingOrder = groups.map(g => g.name);
            const knownSet = new Set(existingOrder);

            // 先按现有顺序保留仍然存在的分组
            groupsOrder = existingOrder.filter(name => selectorGroups[name]);

            // 再把这次新增的分组追加到末尾
            for (const name of Object.keys(selectorGroups)) {
              if (!knownSet.has(name)) {
                groupsOrder.push(name);
              }
            }

            if (isDev) {
              console.log(`[调试] 使用现有分组顺序回退: ${groupsOrder.join(', ')}`);
            }
          } else {
            // 如果连现有分组都没有（首次加载），才退回使用API返回的顺序
            if (isDev) {
              console.log('[调试] 没有现有分组顺序，使用API返回的顺序');
            }
            for (const name of Object.keys(selectorGroups)) {
              groupsOrder.push(name);
            }
          }
        }
        
        // 按 hidden 标记最终过滤一次，防止回退顺序中包含已隐藏组
        groupsOrder = groupsOrder.filter(name => !hiddenGroups.has(name));
        if (isDev) {
          console.log(`将按照以下顺序构建代理组数据: ${groupsOrder.join(', ')}`);
        }
        
        // 处理并构建所有代理组数据，严格按照groupsOrder的顺序
        for (const groupName of groupsOrder) {
          // 跳过API中不存在的组
          if (!selectorGroups[groupName]) {
            if (isDev) {
              console.log(`跳过API中不存在的组: ${groupName}`);
            }
            continue;
          }

          if (hiddenGroups.has(groupName)) {
            if (isDev) {
              console.log(`[调试] 代理组 ${groupName} 设置了 hidden:true，跳过展示`);
            }
            continue;
          }
          
          if (isDev) {
            console.log(`构建代理组: ${groupName}`);
          }
          const proxy = selectorGroups[groupName];
          const configGroup = configOrder?.proxyGroups?.find((g: any) => g.name === groupName);
          if (proxy.all && Array.isArray(proxy.all)) {
            let nodesOrder = proxy.all;

            if (configGroup && Array.isArray(configGroup.proxies) && configGroup.proxies.length > 0) {
              if (isDev) {
                console.log(`[调试] 使用配置文件中 ${groupName} 组的节点顺序`);
              }

              const apiNodeNames = proxy.all || [];
              const configNodeNames = configGroup.proxies;

              const missingInApi = configNodeNames.filter((name: string) => !apiNodeNames.includes(name));
              if (isDev && missingInApi.length > 0) {
                console.log(`[调试] 配置文件中有但API中不存在的节点: ${missingInApi.join(', ')}`);
              }

              const missingInConfig = apiNodeNames.filter((name: string) => !configNodeNames.includes(name));
              if (isDev && missingInConfig.length > 0) {
                console.log(`[调试] API中有但配置文件中不存在的节点: ${missingInConfig.join(', ')}`);
              }

              nodesOrder = [...configNodeNames];
              missingInConfig.forEach((nodeName: string) => {
                nodesOrder.push(nodeName);
              });

              if (isDev) {
                console.log(`[调试] 最终节点顺序: ${nodesOrder.length}个节点`);
              }
            } else {
              if (isDev) {
                console.log(`[调试] 配置文件中没有找到 ${groupName} 组的节点顺序信息，使用API返回的顺序`);
              }
            }

            const nodes = nodesOrder
              .map((nodeName: string) => {
                const node = data.proxies[nodeName];
                if (!node) {
                  console.warn(`[ProxyNodes] 组 ${groupName} 引用了不存在的节点: ${nodeName}, 已忽略`);
                  return null;
                }
                const isGroup = isGroupType(node.type);

                return {
                  name: nodeName,
                  type: node.type,
                  server: isGroup ? '代理组' : ((node as any)?.server || ''),
                  port: isGroup ? 0 : ((node as any)?.port || 0),
                  delay: node.history && node.history.length > 0 ? node.history[0].delay : undefined,
                  isGroup: isGroup,
                };
              })
              .filter((n): n is ProxyNode => n !== null);

            const groupConfigIcon = configGroup?.icon || (proxy as any)?.icon || null;

            // 获取最终图标（优先使用配置中的图标，否则使用规则匹配）
            let groupIcon = groupConfigIcon;
            try {
              const result = await window.electronAPI?.proxyIcon?.getGroupIcon(groupName, groupConfigIcon);
              if (result?.success && result.iconPath) {
                groupIcon = result.iconPath;
              }
            } catch (error) {
              console.error(`[ProxyNodes] 获取${groupName}组图标失败:`, error);
            }

            groupsData.push({
              name: groupName,
              type: proxy.type,
              nodes,
              now: proxy.now,
              icon: groupIcon,
            });
          }
        }
      }
      
      // 从localStorage读取收藏节点
      try {
        const savedFavorites = localStorage.getItem('favoriteNodes');
        if (savedFavorites) {
          setFavoriteNodes(new Set(JSON.parse(savedFavorites)));
        }
      } catch (error) {
        console.error('读取收藏节点失败:', error);
      }
      
      // 记录当前选中的节点，无需关注是哪个组
      // 遍历所有组找出被选中的节点
      for (const group of groupsData) {
        if (group.now) {
          setSelectedNode(group.now);
          break;
        }
      }
      
      // 确保groupsData的顺序保持不变，直接设置到状态中
      if (isDev) {
        console.log(`最终构建了${groupsData.length}个代理组`);
      }
      setGroups(groupsData);
    } catch (error) {
      console.error('获取代理失败:', error);
      showError(`获取代理失败: ${String(error)}`);
    } finally {
      if (isInitialLoadRef.current) {
        setIsLoading(false);
        isInitialLoadRef.current = false;
      }
    }
  };

  const scheduleSoftRefresh = () => {
    if (isUserScrollingRef.current) {
      pendingRefreshRef.current = true;
      return;
    }
    fetchProxies();
  };

  // 初始加载以及在配置/Profile 更新时刷新
  useEffect(() => {
    scheduleSoftRefresh();

    const onProfileUpdated = () => {
      scheduleSoftRefresh();
    };

    const onProxyIconChanged = () => {
      scheduleSoftRefresh();
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('profile-updated', onProfileUpdated);
      window.addEventListener('proxy-icon-changed', onProxyIconChanged);
    }

    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('profile-updated', onProfileUpdated);
        window.removeEventListener('proxy-icon-changed', onProxyIconChanged);
      }
    };
  }, []);

  // 监听全局滚动，滚动时延迟刷新，避免卡顿
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleScroll = () => {
      isUserScrollingRef.current = true;
      if (scrollIdleTimeoutRef.current !== null) {
        window.clearTimeout(scrollIdleTimeoutRef.current);
      }
      scrollIdleTimeoutRef.current = window.setTimeout(() => {
        isUserScrollingRef.current = false;
        if (pendingRefreshRef.current) {
          pendingRefreshRef.current = false;
          scheduleSoftRefresh();
        }
      }, 300);
    };

    window.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      window.removeEventListener('scroll', handleScroll);
      if (scrollIdleTimeoutRef.current !== null) {
        window.clearTimeout(scrollIdleTimeoutRef.current);
      }
    };
  }, []);

  // 在groups首次加载完成后，如果没有保存的折叠状态，则默认全部折叠
  useEffect(() => {
    if (groups.length > 0 && typeof window !== 'undefined') {
      const savedState = localStorage.getItem('collapsedGroups');
      // 只在没有保存状态时(null)设置默认全部折叠
      // 如果savedState是'[]'，表示用户选择了全部展开，应该保持
      if (savedState === null) {
        const allGroupNames = groups.map(g => g.name);
        const newCollapsedSet = new Set(allGroupNames);
        setCollapsedGroups(newCollapsedSet);
        try {
          localStorage.setItem('collapsedGroups', JSON.stringify(allGroupNames));
          if (isDev) {
            console.log('首次加载，默认全部折叠:', allGroupNames);
          }
        } catch (error) {
          console.error('保存默认折叠状态失败:', error);
        }
      }
    }
  }, [groups.length]); // 只在groups首次加载时触发

  // 测试节点延迟
  const handleTestNode = async (nodeName: string) => {
    if (!mihomoRunning) {
      showError(t('nodes.testFailed'));
      return;
    }
    
    if (testingNodes.has(nodeName)) return;
    
    // 添加到测试中的节点
    setTestingNodes(prev => {
      const newSet = new Set(prev);
      newSet.add(nodeName);
      return newSet;
    });
    
    try {
      // 使用统一的 Mihomo API 进行延迟测试
      const result = await mihomoAPI.proxiesDelay(nodeName, {
        timeout: 5000,
      });

      const delayValue = typeof result?.delay === 'number' ? result.delay : 0;

      setGroups(prevGroups => {
        return prevGroups.map(group => {
          const updatedNodes = group.nodes.map(node => {
            if (node.name === nodeName) {
              return { ...node, delay: delayValue };
            }
            return node;
          });
          return { ...group, nodes: updatedNodes };
        });
      });
    } catch (error) {
      if (isDev) {
        console.error('[调试] 测试节点延迟失败:', error);
      }
      // 更新节点为超时状态
      setGroups(prevGroups => {
        return prevGroups.map(group => {
          const updatedNodes = group.nodes.map(node => {
            if (node.name === nodeName) {
              return { ...node, delay: 0 }; // 使用0表示超时
            }
            return node;
          });
          return { ...group, nodes: updatedNodes };
        });
      });
    } finally {
      // 从测试集合中移除
      setTestingNodes(prev => {
        const newSet = new Set(prev);
        newSet.delete(nodeName);
        return newSet;
      });
    }
  };

  // 测试代理组延迟（优先使用 Mihomo 组延迟接口）
  const handleTestGroup = async (groupName: string) => {
    if (!mihomoRunning) {
      showError(t('nodes.testFailed'));
      return;
    }

    if (testingGroups.has(groupName)) return;

    const group = groups.find(g => g.name === groupName);
    if (!group) return;

    // 标记该组为测试中
    setTestingGroups(prev => {
      const newSet = new Set(prev);
      newSet.add(groupName);
      return newSet;
    });

    try {
      // 使用 /group/{name}/delay 一次性测试组内所有节点
      const result = await mihomoAPI.groupDelay(groupName, {
        timeout: 5000,
      });

      setGroups(prevGroups => {
        return prevGroups.map(g => {
          if (g.name !== groupName) return g;

          const updatedNodes = g.nodes.map(node => {
            const value = result ? (result as any)[node.name] : undefined;
            if (typeof value === 'number') {
              return { ...node, delay: value };
            }
            return node;
          });

          return { ...g, nodes: updatedNodes };
        });
      });

      const delays = result || {};
      const successCount = Object.values(delays).filter(v => typeof v === 'number' && v > 0).length;
      const failCount = group.nodes.length - successCount;

      showSuccess(t('nodes.testGroupComplete', { groupName, successCount, failCount }));
    } catch (error: any) {
      console.error(`测试代理组 ${groupName} 失败:`, error);
      showError(`测试代理组失败: ${error?.message || '未知错误'}`);
    } finally {
      setTestingGroups(prev => {
        const newSet = new Set(prev);
        newSet.delete(groupName);
        return newSet;
      });
    }
  };

  // 使用useCallback包装handleBatchTest函数，避免循环依赖
  const handleBatchTest = useCallback(async (groupName: string) => {
    if (!mihomoRunning) {
      showError(t('nodes.testFailed'));
      return;
    }

    const group = groups.find(g => g.name === groupName);
    if (!group) return;

    // 一次最多测试5个节点，避免过载
    const batchSize = 5;
    const nodes = [...group.nodes];

    for (let i = 0; i < nodes.length; i += batchSize) {
      const batch = nodes.slice(i, i + batchSize);

      // 将所有节点添加到测试集合
      setTestingNodes(prev => {
        const newSet = new Set(prev);
        batch.forEach(node => newSet.add(node.name));
        return newSet;
      });

      // 并行测试这批节点
      await Promise.all(
        batch.map(async node => {
          try {
            await handleTestNode(node.name);
            // 添加延迟，避免同时发送太多请求
            await new Promise(r => setTimeout(r, 300));
          } catch (error) {
            console.error(`测试节点 ${node.name} 失败:`, error);
          }
        })
      );
    }
  }, [groups, mihomoRunning, handleTestNode, showError]);

  // 单独添加一个effect来处理事件监听
  useEffect(() => {
    // 确保有groups数据且有electronAPI的情况下再设置
    if (groups.length > 0 && window.electronAPI) {
      const api = window.electronAPI as any;
      
      // 移除旧的监听器，避免重复
      api.removeAllListeners('test-all-nodes');
      
      // 添加新的监听器
      api.onTestAllNodes(() => {
        if (isDev) {
          console.log('收到测试所有节点请求 (更新后的处理器)');
        }
        // 对所有代理组执行批量测试
        groups.forEach(group => {
          handleBatchTest(group.name);
        });
      });
    }
  }, [groups, handleBatchTest]); // 现在可以安全地添加handleBatchTest作为依赖

  // 从本地存储加载收藏节点
  useEffect(() => {
    try {
      const savedFavorites = localStorage.getItem('favoriteNodes');
      if (savedFavorites) {
        const favoritesArray = JSON.parse(savedFavorites);
        setFavoriteNodes(new Set(favoritesArray));
      }
    } catch (error) {
      console.error('加载收藏节点失败:', error);
    }
  }, []);

  // 保存收藏节点到本地存储
  useEffect(() => {
    try {
      localStorage.setItem('favoriteNodes', JSON.stringify(Array.from(favoriteNodes)));
    } catch (error) {
      console.error('保存收藏节点失败:', error);
    }
  }, [favoriteNodes]);

  // 从Electron持久化存储加载收藏节点
  useEffect(() => {
    const loadFavoriteNodes = async () => {
      if (!window.electronAPI) return;
      
      try {
        // 从主进程获取收藏节点
        const result = await window.electronAPI.getFavoriteNodes();
        if (result && result.success && Array.isArray(result.nodes)) {
          if (isDev) {
            console.log('从持久化存储加载收藏节点:', result.nodes);
          }
          setFavoriteNodes(new Set(result.nodes));
        }
      } catch (error) {
        console.error('从持久化存储加载收藏节点失败:', error);
        
        // 如果从持久化存储加载失败，尝试从localStorage加载作为备份
        try {
          const savedFavorites = localStorage.getItem('favoriteNodes');
          if (savedFavorites) {
            const favoritesArray = JSON.parse(savedFavorites);
            setFavoriteNodes(new Set(favoritesArray));
            if (isDev) {
              console.log('从localStorage加载收藏节点备份');
            }
          }
        } catch (localStorageError) {
          console.error('从localStorage加载收藏节点备份失败:', localStorageError);
        }
      }
    };
    
    loadFavoriteNodes();
  }, []);

  // 保存收藏节点到Electron持久化存储
  useEffect(() => {
    const saveFavoriteNodes = async () => {
      if (!window.electronAPI || favoriteNodes.size === 0) return;
      
      try {
        // 保存到主进程的持久化存储
        const result = await window.electronAPI.saveFavoriteNodes(Array.from(favoriteNodes));
        if (result && result.success) {
          if (isDev) {
            console.log('收藏节点保存到持久化存储成功');
          }
        } else {
          throw new Error('保存失败');
        }
      } catch (error) {
        console.error('保存收藏节点到持久化存储失败:', error);
        
        // 如果持久化存储失败，同时保存到localStorage作为备份
        try {
          localStorage.setItem('favoriteNodes', JSON.stringify(Array.from(favoriteNodes)));
          if (isDev) {
            console.log('收藏节点保存到localStorage备份');
          }
        } catch (localStorageError) {
          console.error('保存收藏节点到localStorage备份失败:', localStorageError);
        }
      }
    };
    
    saveFavoriteNodes();
  }, [favoriteNodes]);

  // 重写折叠切换函数，确保状态更改后立即保存到localStorage
  const toggleGroupCollapse = (groupName: string) => {
    setCollapsedGroups(prev => {
      const newSet = new Set(prev);
      
      if (newSet.has(groupName)) {
        newSet.delete(groupName);
        if (isDev) {
          console.log(`展开节点组: ${groupName}`);
        }
      } else {
        newSet.add(groupName);
        if (isDev) {
          console.log(`折叠节点组: ${groupName}`);
        }
      }
      
      // 立即同步保存到localStorage
      try {
        localStorage.setItem('collapsedGroups', JSON.stringify(Array.from(newSet)));
        if (isDev) {
          console.log('已保存折叠状态到localStorage:', Array.from(newSet));
        }
      } catch (error) {
        console.error('保存折叠状态失败:', error);
      }
      
      return newSet;
    });
  };



  // 根据节点名称长度计算最合适的列数
  const calculateOptimalColumns = (nodes: ProxyNode[], isDoubleLayout: boolean = false) => {
    if (nodes.length === 0) return isDoubleLayout ? 3 : 6; // 双列模式默认3列,单列模式默认6列

    // 计算节点名称的平均长度
    const totalLength = nodes.reduce((sum, node) => sum + node.name.length, 0);
    const averageLength = totalLength / nodes.length;

    // 双列模式下减少列数，但不强制单列 - 让卡片更宽以适应长名称
    if (isDoubleLayout) {
      if (averageLength > 30) return 1; // 极长节点名才使用单列
      if (averageLength > 20) return 2; // 长节点名使用双列
      if (averageLength > 15) return 2; // 中等长度节点名使用双列
      if (averageLength > 10) return 3; // 短节点名使用三列
      return 3; // 很短的节点名使用三列
    }

    // 单列模式保持原有逻辑
    if (averageLength > 25) return 2; // 超长节点名
    if (averageLength > 20) return 3; // 长节点名
    if (averageLength > 15) return 4; // 中等长度节点名
    if (averageLength > 10) return 5; // 短节点名
    return 6; // 很短的节点名
  };

  // 重构GroupNodes组件，简化渲染逻辑
  const GroupNodes: React.FC<{
    group: ProxyGroup;
    collapsedGroups: Set<string>;
    handleTestNode: (nodeName: string) => Promise<void>;
    handleNodeSelect: (nodeName: string, groupName: string) => Promise<void>;
    handleToggleFavorite: (nodeName: string) => void;
    testingNodes: Set<string>;
    favoriteNodes: Set<string>;
    layoutMode: 'single' | 'double';
    sortMode: 'default' | 'latency';
  }> = ({
    group,
    collapsedGroups,
    handleTestNode,
    handleNodeSelect,
    handleToggleFavorite,
    testingNodes,
    favoriteNodes,
    layoutMode,
    sortMode
  }) => {
    const isCollapsed = collapsedGroups.has(group.name);

    // 根据排序模式对节点进行排序
    const sortedNodes = React.useMemo(() => {
      if (sortMode === 'latency') {
        const getLatencyWeight = (delay?: number) =>
          typeof delay === 'number' && delay > 0 ? delay : Number.POSITIVE_INFINITY;

        return [...group.nodes].sort((a, b) => {
          // 无延迟/超时(0)/异常值统一排在最后
          return getLatencyWeight(a.delay) - getLatencyWeight(b.delay);
        });
      }
      return group.nodes;
    }, [group.nodes, sortMode]);

    // 添加监听折叠状态的useEffect
    useEffect(() => {
      if (isDev) {
        console.log(`组 ${group.name} 折叠状态更新: ${isCollapsed ? '已折叠' : '已展开'}`);
      }
    }, [group.name, isCollapsed]);

    // 根据节点名称长度计算最佳列数,传入布局模式，仅使用真实出口节点参与计算
    const baseNodes = group.nodes.filter(n => !n.isGroup && n.type && n.type.toLowerCase() !== 'unknown');
    const optimalColumns = calculateOptimalColumns(baseNodes.length > 0 ? baseNodes : group.nodes, layoutMode === 'double');
    
    // 内部节点卡片组件 - 使用useCallback记忆化以避免不必要的重新渲染
    const NodeCardInner = useCallback(({ node, group }: { node: ProxyNode, group: ProxyGroup }) => {
      const isSelected = group.now === node.name;
      const isTesting = testingNodes.has(node.name);
      const isFavorite = favoriteNodes.has(node.name);
      
      return (
        <div
          className={`relative rounded-lg overflow-hidden transition-all cursor-pointer p-3 border ${
            isSelected
              ? 'border-blue-300 dark:border-blue-500 bg-blue-100/90 dark:bg-blue-500/15'
              : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-[#2a2a2a]'
          }`}
          onClick={() => handleNodeSelect(node.name, group.name)}
        >
          <div className="flex flex-col space-y-1">
            <div className="flex items-center justify-between">
              <h3
                className="font-medium text-gray-900 dark:text-gray-100 text-sm truncate max-w-[85%] group"
                title={node.name}
              >
                <EmojiText
                  text={node.name}
                  className="truncate inline-block w-full group-hover:whitespace-normal group-hover:break-words"
                />
              </h3>
              <div className="flex space-x-1 shrink-0">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleTestNode(node.name);
                  }}
                  disabled={isTesting}
                  className="h-6 w-6 flex items-center justify-center rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors text-gray-500 dark:text-gray-400 disabled:opacity-50"
                  title={t('nodes.testLatency')}
                >
                  <ReloadIcon className={`h-4 w-4 ${isTesting ? 'text-blue-500 animate-spin' : ''}`} />
                </button>

                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleToggleFavorite(node.name);
                  }}
                  className="h-6 w-6 flex items-center justify-center rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                  title={isFavorite ? t('nodes.removeFromFavorite') : t('nodes.addToFavorite')}
                >
                  {isFavorite ? (
                    <StarFilledIcon className="h-4 w-4 text-yellow-500" />
                  ) : (
                    <StarIcon className="h-4 w-4 text-gray-400 dark:text-gray-500" />
                  )}
                </button>
              </div>
            </div>

            <div className="flex justify-between items-center">
              <div className="text-xs text-gray-500 dark:text-gray-400">
                {node.type}
              </div>
              {node.delay !== undefined && (
                <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                  node.delay === 0
                    ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400'
                    : node.delay < 100
                    ? 'bg-green-100 text-green-800 dark:bg-[#2a2a2a] dark:text-green-400'
                    : node.delay < 300
                    ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400'
                    : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400'
                }`}>
                  {node.delay === 0 ? t('nodes.timeout') : `${node.delay}ms`}
                </span>
              )}
            </div>
          </div>
        </div>
      );
    }, [testingNodes, favoriteNodes, handleNodeSelect, handleTestNode, handleToggleFavorite]);
    
    // 内容渲染函数 - 仅在内容加载时渲染
    const renderContent = () => {
      if (sortedNodes.length > 100) {
        // 对于大量节点使用虚拟化渲染
        return (
          <div style={{ height: 'auto', width: '100%', minHeight: '400px' }}>
            <AutoSizer>
              {({ width }: { height: number, width: number }) => {
                // 计算每个单元格的宽度和高度
                const columnCount = Math.min(optimalColumns, 6);

                const columnWidth = width / columnCount;
                const rowCount = Math.ceil(sortedNodes.length / columnCount);
                // 卡片固定高度
                const rowHeight = 90;
                
                return (
                  <Grid
                    className="custom-scrollbar"
                    columnCount={columnCount}
                    columnWidth={columnWidth}
                    height={Math.min(rowCount * rowHeight, 600)} // 设置最大高度，避免过长
                    rowCount={rowCount}
                    rowHeight={rowHeight}
                    width={width}
                    overscanRowCount={2} // 增加过扫描行数以提高滚动性能
                    overscanColumnCount={1} // 增加过扫描列数以提高滚动性能
                  >
                    {({ columnIndex, rowIndex, style }) => {
                      const index = rowIndex * columnCount + columnIndex;
                      const node = sortedNodes[index];
                      
                      if (!node) return null;
                      
                      return (
                        <div style={{
                          ...style,
                          padding: '6px',
                          boxSizing: 'border-box'
                        }}>
                          <NodeCardInner node={node} group={group} />
                        </div>
                      );
                    }}
                  </Grid>
                );
              }}
            </AutoSizer>
          </div>
        );
      }
      
      // 对于少量节点使用传统的网格布局
      let gridClass = "";

      // 双列布局模式下使用更少的列数，让卡片更宽以容纳长名称
      if (layoutMode === 'double') {
        switch(optimalColumns) {
          case 1:
            // 极长节点名：所有断点都是单列
            gridClass = "grid grid-cols-1 gap-2 mt-3";
            break;
          case 2:
            // 长节点名：大屏幕才显示双列，让每个卡片有足够宽度
            gridClass = "grid grid-cols-1 xl:grid-cols-2 gap-2 mt-3";
            break;
          case 3:
          default:
            // 中短节点名：根据屏幕宽度自适应1-3列
            gridClass = "grid grid-cols-1 xl:grid-cols-2 2xl:grid-cols-3 gap-2 mt-3";
            break;
        }
      } else {
        // 单列布局模式 - 减少列数让卡片更宽
        switch(optimalColumns) {
          case 2:
            gridClass = "grid grid-cols-1 sm:grid-cols-2 gap-2 mt-3";
            break;
          case 3:
            gridClass = "grid grid-cols-1 sm:grid-cols-2 md:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3 gap-2 mt-3";
            break;
          case 4:
            gridClass = "grid grid-cols-1 sm:grid-cols-2 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3 gap-2 mt-3";
            break;
          case 5:
            gridClass = "grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-3 xl:grid-cols-4 gap-2 mt-3";
            break;
          case 6:
          default:
            gridClass = "grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-3 xl:grid-cols-4 gap-2 mt-3";
            break;
        }
      }
      
      return (
        <div className={gridClass}>
          {sortedNodes.map(node => (
            <div key={node.name} className="node-card-container">
              <NodeCardInner key={node.name} node={node} group={group} />
            </div>
          ))}
        </div>
      );
    };
    
    return (
      <div 
        className={isCollapsed ? 'nodes-hidden' : 'nodes-visible'} 
        data-collapsed={isCollapsed ? 'true' : 'false'}
        data-group={group.name}
      >
        {!isCollapsed && renderContent()}
      </div>
    );
  };

  // 处理模式切换
  const handleModeChange = async (mode: string) => {
    try {
      // 更新UI状态
      setCurrentMode(mode);
      
      // 更新Mihomo配置
      await mihomoAPI.patchConfigs({ mode });
      
      // 清除连接（可选，根据用户体验决定）
      await mihomoAPI.deleteConnections();

      // 在模式切换后立即刷新节点列表
      await fetchProxies();
      
      // 显示成功提示
      const modeText = mode === 'rule' ? t('nodes.ruleMode') : mode === 'global' ? t('nodes.globalMode') : t('nodes.directMode');
      showSuccess(t('nodes.switchedToMode', { mode: modeText }));
    } catch (error) {
      console.error('切换模式失败:', error);
      showError(t('nodes.switchModeFailed', { error: String(error) }));
      
      // 失败时恢复UI状态
      try {
        const config = await mihomoAPI.configs();
        setCurrentMode(config.mode);
      } catch {}
    }
  };
  
  // 显示成功提示
  const showSuccess = (message: string) => {
    setErrorMessage(null); // 清除错误信息
    setSuccessMessage(message);
    setTimeout(() => setSuccessMessage(null), 3000);
  };

  // 渲染直连模式提示
  const DirectModeMessage = () => (
    <div className="rounded-2xl bg-slate-50 p-8 text-center shadow-sm dark:bg-slate-800/40">
      <div className="flex flex-col items-center justify-center space-y-3">
        <svg xmlns="http://www.w3.org/2000/svg" className="w-12 h-12 text-green-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <path d="M8 12h8" />
          <path d="M12 8v8" />
        </svg>
        <h3 className="text-lg font-medium text-foreground">{t('nodes.directModeEnabled')}</h3>
        <p className="max-w-lg text-sm text-muted-foreground">
          {t('nodes.directModeDesc')}
          <br />
          {t('nodes.directModeNote')}
        </p>
      </div>
    </div>
  );

  // 组件卸载时保存当前折叠状态
  useEffect(() => {
    // 返回清理函数
    return () => {
      console.log('组件卸载，保存折叠状态');
      // 立即保存当前折叠状态到localStorage
      try {
        localStorage.setItem('collapsedGroups', JSON.stringify(Array.from(collapsedGroups)));
        console.log('组件卸载时已保存折叠状态到localStorage:', Array.from(collapsedGroups));
      } catch (error) {
        console.error('组件卸载时保存折叠状态失败:', error);
      }
      
      // 如果有electronAPI，也保存到持久化存储
      if (window.electronAPI) {
        window.electronAPI.saveCollapsedGroups(Array.from(collapsedGroups))
          .then(result => {
            if (result && result.success) {
              console.log('组件卸载时已保存折叠状态到持久化存储');
            }
          })
          .catch(error => {
            console.error('组件卸载时保存到持久化存储失败:', error);
          });
      }
    };
  }, [collapsedGroups]);

  // 选择节点 - 优化后的逻辑
  const handleNodeSelect = async (nodeName: string, groupName: string) => {
    if (!mihomoRunning) {
      showError(t('nodes.switchFailed'));
      return;
    }
    
    // 检查选择的是当前组内相同的节点
    const group = groups.find(g => g.name === groupName);
    if (!group) return;
    
    // 如果在当前组中已经选中了该节点，则不需要再次切换
    if (group.now === nodeName) {
      if (isDev) {
        console.log(`节点 ${nodeName} 已在组 ${groupName} 中被选中，无需切换`);
      }
      return;
    }
    
    // 保存旧节点，用于恢复
    const oldNode = group.now;
    
    // 乐观更新UI
    setGroups(prev => prev.map(g => 
      g.name === groupName 
        ? {...g, now: nodeName}
        : g
    ));
    
    // 判断是否是主要代理组(PROXY或GLOBAL)
    const isMainGroup = groupName === 'PROXY' || groupName === 'GLOBAL';
    if (isMainGroup) {
      setSelectedNode(nodeName);
    }
    
    try {
      // 首先获取API配置，确保使用最新的密钥
      let apiConfig;
      try {
        apiConfig = await window.electronAPI!.getApiConfig();
        if (isDev) {
          console.log(`[调试] 获取API配置成功: ${apiConfig.success ? '成功' : '失败'}`);
        }
        if (!apiConfig.success) {
          throw new Error(`获取API配置失败: ${apiConfig.error || '未知错误'}`);
        }
      } catch (configError) {
        if (isDev) {
          console.error('[调试] 获取API配置出错:', configError);
        }
        throw new Error(`获取API配置出错: ${String(configError)}`);
      }
      
      if (isDev) {
        console.log(`[调试] 尝试在组 ${groupName} 中切换到节点: ${nodeName}`);
        console.log(`[调试] 使用密钥: ${apiConfig.secret ? '已设置' : '未设置'}`);
      }
      
      // 发送切换请求，使用electronAPI.requestMihomoAPI
      const switchUrl = `/proxies/${encodeURIComponent(groupName)}`;
      if (isDev) {
        console.log(`[调试] 发送PUT请求到: ${switchUrl}`);
        console.log(`[调试] 请求体: ${JSON.stringify({ name: nodeName })}`);
      }
      
      const switchResponse = await window.electronAPI!.requestMihomoAPI(switchUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ name: nodeName })
      });
      
      if (!switchResponse.ok) {
        if (isDev) {
          console.error(`[调试] 切换失败: 状态码=${switchResponse.status}, 状态文本=${switchResponse.statusText}`);
        }
        try {
          const errorData = switchResponse.data;
          if (isDev) {
            console.error(`[调试] 错误响应内容: ${typeof errorData === 'string' ? errorData : JSON.stringify(errorData)}`);
          }
        } catch (e) {
          if (isDev) {
            console.error('[调试] 无法读取错误响应内容');
          }
        }
        throw new Error(`切换失败: ${switchResponse.statusText}`);
      }
      
      if (isDev) {
        console.log(`[调试] 切换请求成功，状态码: ${switchResponse.status}`);
      }
      
      // 验证切换结果
      const verifyUrl = `/proxies/${encodeURIComponent(groupName)}`;
      if (isDev) {
        console.log(`[调试] 发送验证请求到: ${verifyUrl}`);
      }
      
      const verifyResponse = await window.electronAPI!.requestMihomoAPI(verifyUrl);
      
      if (!verifyResponse.ok) {
        if (isDev) {
          console.error(`[调试] 验证请求失败: 状态码=${verifyResponse.status}, 状态文本=${verifyResponse.statusText}`);
        }
        try {
          const errorData = verifyResponse.data;
          if (isDev) {
            console.error(`[调试] 错误响应内容: ${typeof errorData === 'string' ? errorData : JSON.stringify(errorData)}`);
          }
        } catch (e) {
          if (isDev) {
            console.error('[调试] 无法读取错误响应内容');
          }
        }
        throw new Error(`验证请求失败: ${verifyResponse.statusText}`);
      }
      
      const verifyData = verifyResponse.data;
      if (isDev) {
        console.log(`[调试] 验证响应数据:`, verifyData);
      }
      
      if (verifyData.now !== nodeName) {
        if (isDev) {
          console.warn(`[调试] 切换节点验证失败: 期望 ${nodeName}，实际 ${verifyData.now}`);
        }
        throw new Error(`节点切换不一致，可能需要重试`);
      } else {
        if (isDev) {
          console.log(`[调试] 组 ${groupName} 节点切换成功: ${nodeName}`);
        }
      }
    } catch (error) {
      if (isDev) {
        console.error('[调试] 切换节点失败:', error);
      }
      showError(`切换失败: ${String(error)}`);
      
      // 恢复原来的选中状态
      setGroups(prev => prev.map(g => 
        g.name === groupName 
          ? {...g, now: oldNode}
          : g
      ));
      
      if (isMainGroup && oldNode) {
        setSelectedNode(oldNode);
      }
    }
  };

  // 处理收藏节点
  const handleToggleFavorite = (nodeName: string) => {
    // 检查当前节点是否存在于任何组中
    const nodeExists = groups.some(group => 
      group.nodes.some(node => node.name === nodeName)
    );
    
    if (!nodeExists) {
      console.warn(`尝试收藏不存在的节点: ${nodeName}`);
      showError(`节点 ${nodeName} 不存在或已被下线`);
      return;
    }
    
    setFavoriteNodes(prev => {
      const newSet = new Set(prev);
      if (newSet.has(nodeName)) {
        newSet.delete(nodeName);
        if (isDev) {
          console.log(`已取消收藏节点: ${nodeName}`);
        }
      } else {
        newSet.add(nodeName);
        if (isDev) {
          console.log(`已收藏节点: ${nodeName}`);
        }
      }
      return newSet;
    });
  };

  const displayGroups = activeTab === 'favorites' ? favoriteFilteredGroups : filteredGroups;
  const totalNodes = groups.reduce((acc, group) => acc + group.nodes.length, 0);
  const visibleNodes = displayGroups.reduce((acc, group) => acc + group.nodes.length, 0);
  const modeDisplay = currentMode === 'rule' ? t('nodes.ruleMode') : currentMode === 'global' ? t('nodes.globalMode') : t('nodes.directMode');

  if (!mihomoRunning) {
    return (
      <div className="py-12 text-center">
        <div className="mx-auto flex max-w-md flex-col items-center gap-4">
          <ExclamationTriangleIcon className="h-12 w-12 text-amber-500" />
          <h2 className="text-xl font-semibold text-foreground">{t('nodes.mihomoNotRunning')}</h2>
          <p className="text-sm text-muted-foreground">
            {t('nodes.mihomoNotRunningDesc')}
          </p>
          <button
            onClick={fetchProxies}
            className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90"
          >
            <ReloadIcon className="h-4 w-4" /> {t('nodes.checkConnection')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative space-y-3">
      {/* 顶部模式切换按钮：靠近标题区域右上角，尽量与标题同一水平线 */}
      <div className="absolute right-0 -top-12 md:-top-16 z-10">
        <Tabs value={currentMode} onValueChange={handleModeChange} className="w-full md:w-auto">
          <TabsList className="flex h-9 w-full items-center justify-between gap-2 rounded-full border border-slate-200 bg-slate-50/80 p-1 transition dark:border-slate-700/40 dark:bg-slate-800/10 md:w-auto">
            <TabsTrigger
              value="rule"
              className="flex-1 rounded-full text-xs font-medium text-slate-600 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 data-[state=active]:bg-blue-500 data-[state=active]:text-white data-[state=active]:shadow-sm dark:text-slate-200 dark:data-[state=inactive]:hover:text-blue-200"
            >
              {t('nodes.ruleMode')}
            </TabsTrigger>
            <TabsTrigger
              value="global"
              className="flex-1 rounded-full text-xs font-medium text-slate-600 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 data-[state=active]:bg-blue-500 data-[state=active]:text-white data-[state=active]:shadow-sm dark:text-slate-200 dark:data-[state=inactive]:hover:text-blue-200"
            >
              {t('nodes.globalMode')}
            </TabsTrigger>
            <TabsTrigger
              value="direct"
              className="flex-1 rounded-full text-xs font-medium text-slate-600 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 data-[state=active]:bg-blue-500 data-[state=active]:text-white data-[state=active]:shadow-sm dark:text-slate-200 dark:data-[state=inactive]:hover:text-blue-200"
            >
              {t('nodes.directMode')}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {errorMessage && (
        <div className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-600 shadow-sm dark:bg-rose-500/15 dark:text-rose-100">
          <ExclamationTriangleIcon className="mr-2 inline-block h-5 w-5 align-middle" />
          {errorMessage}
        </div>
      )}

      {successMessage && (
        <div className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700 shadow-sm dark:bg-emerald-500/15 dark:text-emerald-200">
          <CheckCircledIcon className="mr-2 inline-block h-5 w-5 align-middle" />
          {successMessage}
        </div>
      )}

      {currentMode !== 'direct' && (
        <div className="rounded-2xl bg-white px-4 py-4 shadow-sm dark:bg-[#2a2a2a]">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div className="relative w-full max-w-md">
              <input
                type="text"
                className="h-11 w-full rounded-full border border-slate-200/70 bg-slate-50 pl-10 pr-12 text-sm text-foreground transition focus:border-slate-200 focus:outline-none focus:ring-2 focus:ring-slate-200 dark:border-slate-700/60 dark:bg-[#3a3a3a] dark:text-slate-100 dark:focus:border-slate-600 dark:focus:ring-slate-600"
                placeholder={t('nodes.searchPlaceholder')}
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
              <MagnifyingGlassIcon className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
              {searchTerm && (
                <button
                  type="button"
                  className="absolute right-3 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full bg-slate-200 text-slate-600 transition hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600"
                  onClick={() => setSearchTerm('')}
                >
                  <Cross1Icon className="h-4 w-4" />
                </button>
              )}
            </div>

            <div className="flex flex-col gap-3 md:flex-row md:items-center md:gap-4">
              <div className="flex items-center gap-2 rounded-full bg-white px-1 py-1 text-xs font-medium dark:bg-[#222222]">
                <button
                  type="button"
                  onClick={() => setActiveTab('all')}
                  className={`inline-flex h-9 w-9 items-center justify-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-slate-200/70 dark:focus:ring-slate-700/50 ${
                    activeTab === 'all'
                      ? 'bg-slate-200 text-slate-700 shadow-sm dark:bg-slate-700 dark:text-slate-200'
                      : 'bg-transparent text-slate-500 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-700/60'
                  }`}
                  title={t('nodes.allNodes')}
                >
                  <GlobeIcon className="h-5 w-5" />
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('favorites')}
                  className={`inline-flex h-9 w-9 items-center justify-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-slate-200/70 dark:focus:ring-slate-700/50 ${
                    activeTab === 'favorites'
                      ? 'bg-slate-200 text-slate-700 shadow-sm dark:bg-slate-700 dark:text-slate-200'
                      : 'bg-transparent text-slate-500 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-700/60'
                  }`}
                  title={t('nodes.favoriteNodes')}
                >
                  <StarIcon className="h-5 w-5" />
                </button>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const newMode = layoutMode === 'single' ? 'double' : 'single';
                    setLayoutMode(newMode);
                    try {
                      localStorage.setItem(LAYOUT_SETTING_KEY, newMode);
                    } catch (error) {
                      console.error('保存布局模式失败:', error);
                    }
                    try {
                      window.electronAPI?.setSetting?.(LAYOUT_SETTING_KEY, newMode)
                        .then((result) => {
                          if (result && result.success === false) {
                            console.error('保存代理组布局设置失败:', result.error);
                          }
                        })
                        .catch((error) => {
                          console.error('保存代理组布局设置失败:', error);
                        });
                    } catch (error) {
                      console.error('保存代理组布局设置失败:', error);
                    }
                  }}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-slate-100 text-slate-600 transition hover:bg-slate-200 focus:outline-none focus:ring-2 focus:ring-slate-200/70 dark:bg-slate-800/70 dark:text-slate-200 dark:hover:bg-slate-700/70 dark:focus:ring-slate-700/50"
                  title={layoutMode === 'single' ? t('nodes.switchToDoubleLayout') : t('nodes.switchToSingleLayout')}
                >
                  {layoutMode === 'single' ? <ViewHorizontalIcon className="h-5 w-5" /> : <ViewVerticalIcon className="h-5 w-5" />}
                </button>
                <button
                  type="button"
                  onClick={fetchProxies}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-slate-100 text-slate-600 transition hover:bg-slate-200 focus:outline-none focus:ring-2 focus:ring-slate-200/70 dark:bg-slate-800/70 dark:text-slate-200 dark:hover:bg-slate-700/70 dark:focus:ring-slate-700/50"
                  title={t('nodes.refreshList')}
                >
                  <ReloadIcon className="h-5 w-5" />
                </button>
                {/* 选项菜单 */}
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setShowOptionsMenu(!showOptionsMenu)}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-slate-100 text-slate-600 transition hover:bg-slate-200 focus:outline-none focus:ring-2 focus:ring-slate-200/70 dark:bg-slate-800/70 dark:text-slate-200 dark:hover:bg-slate-700/70 dark:focus:ring-slate-700/50"
                    title={t('nodes.options')}
                  >
                    <MixerHorizontalIcon className="h-5 w-5" />
                  </button>

                  {showOptionsMenu && (
                    <>
                      <div
                        className="fixed inset-0 z-[100]"
                        onClick={() => setShowOptionsMenu(false)}
                      />
                      <div className="absolute right-0 top-full mt-1 w-48 bg-white dark:bg-[#2a2a2a] rounded-lg shadow-lg border border-slate-200 dark:border-slate-700 py-1 z-[101]">
                        <button
                          onClick={() => {
                            const hasAnyCollapsed = collapsedGroups.size > 0;
                            if (hasAnyCollapsed) {
                              // 展开所有
                              setCollapsedGroups(new Set());
                              try {
                                // 保存空数组表示全部展开状态
                                localStorage.setItem('collapsedGroups', JSON.stringify([]));
                                if (isDev) {
                                  console.log('已展开所有代理组');
                                }
                              } catch (error) {
                                console.error('展开所有代理组失败:', error);
                              }
                            } else {
                              // 收起所有
                              const allGroupNames = new Set(displayGroups.map(g => g.name));
                              setCollapsedGroups(allGroupNames);
                              try {
                                localStorage.setItem('collapsedGroups', JSON.stringify(Array.from(allGroupNames)));
                                if (isDev) {
                                  console.log('已收起所有代理组');
                                }
                              } catch (error) {
                                console.error('收起所有代理组失败:', error);
                              }
                            }
                            setShowOptionsMenu(false);
                          }}
                          className="w-full px-3 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-2"
                        >
                          {collapsedGroups.size > 0 ? t('nodes.expandAll') : t('nodes.collapseAll')}
                        </button>
                        <div className="h-px bg-slate-200 dark:bg-slate-700 my-1" />
                        <button
                          onClick={async () => {
                            await persistSortMode('default');
                            setShowOptionsMenu(false);
                          }}
                          className={`w-full px-3 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center ${
                            sortMode === 'default' ? 'text-blue-600 dark:text-blue-400' : ''
                          }`}
                        >
                          <div className="w-4 h-4 flex items-center justify-center mr-2">
                            {sortMode === 'default' && <CheckCircledIcon className="w-4 h-4" />}
                          </div>
                          <span>{t('nodes.defaultSort')}</span>
                        </button>
                        <button
                          onClick={async () => {
                            await persistSortMode('latency');
                            setShowOptionsMenu(false);
                          }}
                          className={`w-full px-3 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center ${
                            sortMode === 'latency' ? 'text-blue-600 dark:text-blue-400' : ''
                          }`}
                        >
                          <div className="w-4 h-4 flex items-center justify-center mr-2">
                            {sortMode === 'latency' && <CheckCircledIcon className="w-4 h-4" />}
                          </div>
                          <span>{t('nodes.sortByLatency')}</span>
                        </button>
                        <div className="h-px bg-slate-200 dark:bg-slate-700 my-1" />
                        <button
                          onClick={() => {
                            router.push('/proxy-icon-settings');
                            setShowOptionsMenu(false);
                          }}
                          className="w-full px-3 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-2"
                        >
                          {t('proxyIcon.iconSettings')}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {currentMode === 'direct' ? (
        <DirectModeMessage />
      ) : (
        <div className={layoutMode === 'double' ? 'columns-2 gap-2' : 'space-y-2'}>
          {displayGroups.length > 0 ? (
            <>
              {displayGroups.map((group) => {
                const collapseKey = group.name;
                const isCollapsed = collapsedGroups.has(collapseKey);

                const groupType = group.type.toUpperCase();
                const selectedNodeInGroup = group.now || '-';
                const isTestingGroup = testingGroups.has(group.name);

                return (
                  <div
                    key={`${group.name}-${group.type}`}
                    className={`group-panel rounded-2xl bg-white px-4 py-2 shadow-sm transition dark:bg-[#2a2a2a] overflow-hidden ${
                      layoutMode === 'double' ? 'break-inside-avoid mb-2' : ''
                    }`}
                  >
                    <div className="group-header flex w-full items-center justify-between rounded-xl py-1.5">
                      <button
                        type="button"
                        onClick={() => toggleGroupCollapse(collapseKey)}
                        className="flex items-center gap-3 flex-1 text-left transition hover:bg-slate-100/60 dark:hover:bg-slate-800/40 rounded-xl px-3 py-1"
                      >
                        <div className="flex items-center gap-3">
                          {renderGroupIcon(group.icon)}
                          <div>
                            <div className="text-sm font-semibold text-foreground">{group.name}</div>
                            <div className="mt-0.5 text-xs text-muted-foreground">
                              {groupType} · <EmojiText text={selectedNodeInGroup} className="inline" />
                            </div>
                          </div>
                        </div>
                      </button>

                      <div className="flex items-center gap-2 pr-3">
                        {!isCollapsed && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleTestGroup(group.name);
                            }}
                            disabled={isTestingGroup}
                            className="inline-flex items-center justify-center text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition disabled:opacity-50 disabled:cursor-not-allowed"
                            title={t('nodes.testAllNodes')}
                          >
                            <ReloadIcon className={`h-5 w-5 ${isTestingGroup ? 'animate-spin' : ''}`} />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => toggleGroupCollapse(collapseKey)}
                          className="inline-flex items-center justify-center text-muted-foreground hover:text-foreground transition p-1"
                          title={isCollapsed ? t('nodes.expand') : t('nodes.collapse')}
                        >
                          <ChevronRightIcon
                            className={`h-5 w-5 transition-transform duration-200 ${
                              isCollapsed ? '' : 'rotate-90'
                            }`}
                          />
                        </button>
                      </div>
                    </div>

                    <div
                      className={`border-t border-slate-100 dark:border-slate-800/50 transition-all duration-150 ease-out ${
                        isCollapsed ? 'max-h-0 opacity-0 overflow-hidden' : 'opacity-100 pt-3'
                      }`}
                    >
                      <GroupNodes
                        group={group}
                        collapsedGroups={collapsedGroups}
                        handleTestNode={handleTestNode}
                        handleNodeSelect={handleNodeSelect}
                        handleToggleFavorite={handleToggleFavorite}
                        testingNodes={testingNodes}
                        favoriteNodes={favoriteNodes}
                        layoutMode={layoutMode}
                        sortMode={sortMode}
                      />
                    </div>
                  </div>
                );
              })}
            </>
          ) : (
            <div className="rounded-xl bg-slate-50 py-12 text-center text-sm text-muted-foreground dark:bg-slate-800/40">
              {t('nodes.noMatchingNodes')}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground md:flex-row">
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex items-center gap-2 text-foreground">
            <span
              className={`h-2 w-2 rounded-full ${
                currentMode === 'rule'
                  ? 'bg-sky-500'
                  : currentMode === 'global'
                  ? 'bg-violet-500'
                  : 'bg-emerald-500'
              }`}
            ></span>
            {modeDisplay}
          </span>
          {currentMode !== 'direct' ? (
            <>
              <span>{t('nodes.total')} {totalNodes} {t('nodes.nodes')}</span>
              <span>{t('nodes.currentFilter')} {visibleNodes} {t('nodes.nodes')}</span>
              <span>{t('nodes.favorite')} {favoriteNodes.size} {t('nodes.nodes')}</span>
            </>
          ) : (
            <span>{t('nodes.directModeNote2')}</span>
          )}
        </div>
        {selectedNode && currentMode !== 'direct' && (
          <span className="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-200">
            {t('nodes.currentNode')} {selectedNode}
          </span>
        )}
      </div>
      <style jsx>{`
        .fancy-scrollbar::-webkit-scrollbar {
          width: 6px;
        }
        .fancy-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .fancy-scrollbar::-webkit-scrollbar-thumb {
          background: #d1d5db;
          border-radius: 6px;
        }
        .fancy-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #9ca3af;
        }
        .dark .fancy-scrollbar::-webkit-scrollbar-thumb {
          background: #374151;
        }
        .dark .fancy-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #4b5563;
        }

        .custom-scrollbar::-webkit-scrollbar {
          width: 6px;
          height: 6px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: rgba(0, 0, 0, 0.05);
          border-radius: 3px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #cbd5e1;
          border-radius: 3px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #94a3b8;
        }
        .dark .custom-scrollbar::-webkit-scrollbar-track {
          background: rgba(255, 255, 255, 0.05);
        }
        .dark .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #475569;
        }
        .dark .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #64748b;
        }

        .group-content {
          height: auto;
          transition: all 0.3s ease;
          opacity: 1;
          transform: translateY(0);
          overflow: hidden;
        }

        .group-content.collapsed {
          opacity: 0;
          transform: translateY(-10px);
          height: 0 !important;
          margin: 0;
          padding: 0;
          transition: all 0.25s ease;
          pointer-events: none;
        }

        .group-panel {
          transition: background-color 0.2s ease;
        }

        .group-header {
          transition: background-color 0.2s ease-out;
        }

        .group-header:hover {
          background-color: rgba(15, 23, 42, 0.04);
        }

        .dark .group-header:hover {
          background-color: rgba(255, 255, 255, 0.04);
        }

        .nodes-visible {
          opacity: 1;
          transform: translateY(0);
          transition: opacity 0.3s ease, transform 0.3s ease;
        }

        .nodes-hidden {
          opacity: 0;
          height: 0;
          overflow: hidden;
        }

        .node-card-container {
          transition: transform 0.2s ease-out;
          will-change: transform;
        }

        .node-card-container:hover {
          transform: translateY(-2px);
        }
      `}</style>
    </div>
  );
}
