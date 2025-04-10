import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  CheckIcon, 
  ReloadIcon, 
  MagnifyingGlassIcon, 
  StarIcon, 
  StarFilledIcon,
  ExclamationTriangleIcon,
  Cross1Icon,
  MixerHorizontalIcon,
  PlusIcon
} from '@radix-ui/react-icons';
import { Badge } from "./ui/badge";

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
};

type MihomoProxy = {
  type: string;
  all?: string[];
  now?: string;
  history?: {delay: number}[];
  server?: string;
  port?: number;
};

// 节点组件
export default function ProxyNodes() {
  const [groups, setGroups] = useState<ProxyGroup[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<string>('all');
  const [testingNodes, setTestingNodes] = useState<Set<string>>(new Set());
  const [favoriteNodes, setFavoriteNodes] = useState<Set<string>>(new Set());
  const [switchingNode, setSwitchingNode] = useState<string | null>(null);
  const [mihomoRunning, setMihomoRunning] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  // 显示错误提示
  const showError = (message: string) => {
    setErrorMessage(message);
    setTimeout(() => setErrorMessage(null), 5000);
  };

  // 过滤节点组
  const filteredGroups = groups.map(group => {
    // 保持原始顺序，只过滤不排序
    const filteredNodes = group.nodes.filter(node => 
      node.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      node.server.toLowerCase().includes(searchTerm.toLowerCase())
    );
    return { ...group, nodes: filteredNodes };
  }).filter(group => group.nodes.length > 0);

  // 收藏的节点，同样保持原始顺序
  const favoriteFilteredGroups = (() => {
    // 1. 检查哪些收藏的节点当前已经不存在
    const existingNodes = new Set<string>();
    groups.forEach(group => {
      group.nodes.forEach(node => {
        existingNodes.add(node.name);
      });
    });
    
    // 2. 生成已下架的收藏节点列表，但不输出警告信息
    const missingFavorites = Array.from(favoriteNodes).filter(name => !existingNodes.has(name));
    // 删除控制台警告，避免频繁的日志输出
    // 保留这些节点而不进行任何操作，因为它们可能是临时性的网络问题
    
    // 3. 按原来的逻辑过滤实际存在的节点
    return groups.map(group => {
    const favoriteNodesList = group.nodes.filter(node => 
      (favoriteNodes.has(node.name)) &&
      (node.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
       node.server.toLowerCase().includes(searchTerm.toLowerCase()))
    );
    return { ...group, nodes: favoriteNodesList };
  }).filter(group => group.nodes.length > 0);
  })();

  // 获取节点列表
  const fetchProxies = async () => {
    setIsLoading(true);
    
    try {
      // 检查Mihomo是否运行
      try {
        const response = await fetch('http://127.0.0.1:9090/version');
        if (!response.ok) {
          setMihomoRunning(false);
          setIsLoading(false);
          return;
        }
        setMihomoRunning(true);
      } catch (error) {
        console.error('Mihomo未运行:', error);
        setMihomoRunning(false);
        setIsLoading(false);
        return;
      }
      
      // 获取配置文件中的原始顺序
      let configOrder: {
        proxyGroups: Array<{name: string, type: string, proxies: string[]}>,
        proxies: Array<{name: string, type: string, server: string, port: number}>
      } | undefined;
      
      if (window.electronAPI) {
        try {
          // 使用类型断言解决TypeScript错误
          const api = window.electronAPI as any;
          const result = await api.getConfigOrder();
          if (result.success && result.data) {
            configOrder = result.data;
            console.log('成功获取配置文件顺序:', configOrder);
          } else {
            console.warn('无法获取配置文件顺序:', result.error);
          }
        } catch (error) {
          console.error('获取配置顺序失败:', error);
        }
      }
      
      // 获取代理信息
      const response = await fetch('http://127.0.0.1:9090/proxies');
      if (!response.ok) {
        throw new Error(`获取代理失败: ${response.statusText}`);
      }
      
      const data = await response.json();
      
      // 使用配置文件顺序构建数据
      const selectorGroups: {[key: string]: MihomoProxy} = {};
      const groupsData: ProxyGroup[] = [];
      let groupsOrder: string[] = []; // 记录组的原始顺序
      
      // 提取所有selector类型的组
      for (const [name, proxy] of Object.entries<MihomoProxy>(data.proxies)) {
        if (proxy.type === 'Selector' || proxy.type === 'URLTest' || proxy.type === 'Fallback') {
          selectorGroups[name] = proxy;
        }
      }
      
      // 如果有配置文件顺序，优先使用配置文件中的顺序
      if (configOrder && configOrder.proxyGroups.length > 0) {
        // 使用配置文件中的组顺序
        groupsOrder = configOrder.proxyGroups.map(group => group.name);
      } else {
        // 如果没有配置文件顺序，则使用API返回的顺序
        for (const name of Object.keys(selectorGroups)) {
          groupsOrder.push(name);
        }
      }
      
      // 处理并构建所有代理组数据，按原始顺序
      for (const groupName of groupsOrder) {
        // 跳过API中不存在的组
        if (!selectorGroups[groupName]) continue;
        
        const proxy = selectorGroups[groupName];
        if (proxy.all && Array.isArray(proxy.all)) {
          let nodesOrder = proxy.all;
          
          // 如果有配置文件顺序，使用配置文件中的节点顺序
          if (configOrder) {
            const configGroup = configOrder.proxyGroups.find(g => g.name === groupName);
            if (configGroup && configGroup.proxies.length > 0) {
              console.log(`使用配置文件中 ${groupName} 组的节点顺序`);
              nodesOrder = configGroup.proxies;
            }
          }
          
          // 映射节点数据，保持顺序
          const nodes = nodesOrder.map((nodeName: string) => {
            const node = data.proxies[nodeName];
            const isGroup = selectorGroups[nodeName] !== undefined;
            
            return {
              name: nodeName,
              type: node?.type || 'Unknown',
              server: isGroup ? '代理组' : (node?.server || 'Unknown'),
              port: isGroup ? 0 : (node?.port || 0),
              delay: node?.history?.length > 0 ? node.history[0].delay : undefined,
              isGroup: isGroup,
            };
          });
          
          groupsData.push({
            name: groupName,
            type: proxy.type,
            nodes,
            now: proxy.now
          });
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
      
      setGroups(groupsData);
    } catch (error) {
      console.error('获取代理失败:', error);
      showError(`获取代理失败: ${String(error)}`);
    } finally {
      setIsLoading(false);
    }
  };

  // 初始加载
  useEffect(() => {
    fetchProxies();
    
    // 从本地存储加载折叠状态
    try {
      const savedCollapsedGroups = localStorage.getItem('collapsedGroups');
      if (savedCollapsedGroups) {
        setCollapsedGroups(new Set(JSON.parse(savedCollapsedGroups)));
      }
    } catch (error) {
      console.error('加载折叠状态失败:', error);
    }
    
    // 监听测试所有节点的事件
    if (window.electronAPI) {
      const api = window.electronAPI as any;
      const testAllNodesHandler = () => {
        console.log('收到测试所有节点请求');
        // 对所有代理组执行批量测试
        groups.forEach(group => {
          handleBatchTest(group.name);
        });
      };
      
      // 添加事件监听器
      api.onTestAllNodes(testAllNodesHandler);
      
      // 清理函数
      return () => {
        // 移除事件监听器
        api.removeAllListeners('test-all-nodes');
      };
    }
    
    // 无电子API时的清理函数
    return () => {};
  }, []); // 删除groups依赖，避免循环渲染

  // 获取节点的动画高度，用于折叠/展开动画
  const getNodeRef = useRef<{[key: string]: HTMLDivElement | null}>({});

  // 测试节点延迟
  const handleTestNode = async (nodeName: string) => {
    if (!mihomoRunning) {
      showError("测试失败: Mihomo服务未运行");
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
      // 使用简单的fetch处理
      const url = new URL(`http://127.0.0.1:9090/proxies/${encodeURIComponent(nodeName)}/delay`);
      url.searchParams.append('url', 'http://www.gstatic.com/generate_204');
      url.searchParams.append('timeout', '5000');
      
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      });
      
      if (!response.ok) {
        // 不再显示错误弹窗，只在控制台记录并将节点设为超时
        console.error(`测试节点延迟失败: ${response.statusText}`);
        // 更新节点为超时状态
        setGroups(prevGroups => {
          return prevGroups.map(group => {
            const updatedNodes = group.nodes.map(node => {
              if (node.name === nodeName) {
                return { ...node, delay: -1 }; // 使用-1表示超时
              }
              return node;
            });
            return { ...group, nodes: updatedNodes };
          });
        });
        return;
      }
      
      const data = await response.json();
      
      // 更新节点延迟
      setGroups(prevGroups => {
        return prevGroups.map(group => {
          const updatedNodes = group.nodes.map(node => {
            if (node.name === nodeName) {
              return { ...node, delay: data.delay };
            }
            return node;
          });
          return { ...group, nodes: updatedNodes };
        });
      });
    } catch (error) {
      console.error('测试节点延迟失败:', error);
      // 不再显示错误弹窗，只在控制台记录
      // 更新节点为超时状态
      setGroups(prevGroups => {
        return prevGroups.map(group => {
          const updatedNodes = group.nodes.map(node => {
            if (node.name === nodeName) {
              return { ...node, delay: -1 }; // 使用-1表示超时
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

  // 使用useCallback包装handleBatchTest函数，避免循环依赖
  const handleBatchTest = useCallback(async (groupName: string) => {
    if (!mihomoRunning) {
      showError("测试失败: Mihomo服务未运行");
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
        console.log('收到测试所有节点请求 (更新后的处理器)');
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

  // 保存折叠状态到本地存储
  useEffect(() => {
    try {
      localStorage.setItem('collapsedGroups', JSON.stringify(Array.from(collapsedGroups)));
    } catch (error) {
      console.error('保存折叠状态失败:', error);
    }
  }, [collapsedGroups]);

  // 从Electron持久化存储加载收藏节点
  useEffect(() => {
    const loadFavoriteNodes = async () => {
      if (!window.electronAPI) return;
      
      try {
        // 从主进程获取收藏节点
        const result = await window.electronAPI.getFavoriteNodes();
        if (result && result.success && Array.isArray(result.nodes)) {
          console.log('从持久化存储加载收藏节点:', result.nodes);
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
            console.log('从localStorage加载收藏节点备份');
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
          console.log('收藏节点保存到持久化存储成功');
        } else {
          throw new Error('保存失败');
        }
      } catch (error) {
        console.error('保存收藏节点到持久化存储失败:', error);
        
        // 如果持久化存储失败，同时保存到localStorage作为备份
        try {
          localStorage.setItem('favoriteNodes', JSON.stringify(Array.from(favoriteNodes)));
          console.log('收藏节点保存到localStorage备份');
        } catch (localStorageError) {
          console.error('保存收藏节点到localStorage备份失败:', localStorageError);
        }
      }
    };
    
    saveFavoriteNodes();
  }, [favoriteNodes]);

  // 加载折叠状态
  useEffect(() => {
    const loadCollapsedGroups = async () => {
      if (!window.electronAPI) return;
      
      try {
        // 从主进程获取折叠状态
        const result = await window.electronAPI.getCollapsedGroups();
        if (result && result.success && Array.isArray(result.groups)) {
          console.log('从持久化存储加载折叠状态:', result.groups);
          setCollapsedGroups(new Set(result.groups));
        }
      } catch (error) {
        console.error('从持久化存储加载折叠状态失败:', error);
        
        // 如果从持久化存储加载失败，尝试从localStorage加载作为备份
        try {
          const savedCollapsed = localStorage.getItem('collapsedGroups');
          if (savedCollapsed) {
            const collapsedArray = JSON.parse(savedCollapsed);
            setCollapsedGroups(new Set(collapsedArray));
            console.log('从localStorage加载折叠状态备份');
          }
        } catch (localStorageError) {
          console.error('从localStorage加载折叠状态备份失败:', localStorageError);
        }
      }
    };
    
    loadCollapsedGroups();
  }, []);

  // 保存折叠状态
  useEffect(() => {
    const saveCollapsedGroups = async () => {
      if (!window.electronAPI) return;
      
      try {
        // 保存到主进程的持久化存储
        const result = await window.electronAPI.saveCollapsedGroups(Array.from(collapsedGroups));
        if (result && result.success) {
          console.log('折叠状态保存到持久化存储成功');
      } else {
          throw new Error('保存失败');
        }
      } catch (error) {
        console.error('保存折叠状态到持久化存储失败:', error);
        
        // 如果持久化存储失败，同时保存到localStorage作为备份
        try {
          localStorage.setItem('collapsedGroups', JSON.stringify(Array.from(collapsedGroups)));
          console.log('折叠状态保存到localStorage备份');
        } catch (localStorageError) {
          console.error('保存折叠状态到localStorage备份失败:', localStorageError);
        }
      }
    };
    
    saveCollapsedGroups();
  }, [collapsedGroups]);

  // 选择节点
  const handleNodeSelect = async (nodeName: string, groupName: string) => {
    if (!mihomoRunning) {
      showError("切换失败: Mihomo服务未运行");
      return;
    }
    
    // 检查是否正在切换中或者选择的是当前组内相同的节点
    const group = groups.find(g => g.name === groupName);
    if (!group) return;
    
    // 如果在当前组中已经选中了该节点，则不需要再次切换
    if (group.now === nodeName) {
      console.log(`节点 ${nodeName} 已在组 ${groupName} 中被选中，无需切换`);
      return;
    }
    
    if (switchingNode) return;
    setSwitchingNode(nodeName);
    
    try {
      console.log(`尝试在组 ${groupName} 中切换到节点: ${nodeName}`);
      
      // 判断是否是主要代理组(PROXY或GLOBAL)
      const isMainGroup = groupName === 'PROXY' || groupName === 'GLOBAL';
      
      // 仅在特定组内切换节点
      const switchResponse = await fetch(`http://127.0.0.1:9090/proxies/${encodeURIComponent(groupName)}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ name: nodeName })
        });
        
        if (!switchResponse.ok) {
          throw new Error(`切换失败: ${switchResponse.statusText}`);
      }
      
      // 等待一段时间以确保切换生效
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // 验证切换是否成功，仅检查当前组
      const verifyResponse = await fetch(`http://127.0.0.1:9090/proxies/${encodeURIComponent(groupName)}`);
      const verifyData = await verifyResponse.json();
      
      if (verifyData.now !== nodeName) {
        console.warn(`切换节点验证失败: 期望 ${nodeName}，实际 ${verifyData.now}`);
        showError(`节点切换不一致，可能需要重试`);
      } else {
        console.log(`组 ${groupName} 节点切换成功: ${nodeName}`);
        
        // 如果切换的是主要代理组，才更新全局选中节点状态
        if (isMainGroup) {
          setSelectedNode(verifyData.now || nodeName);
          // 在这里不再调用notifyNodeChanged，避免界面闪烁
          // 我们只在本地更新状态即可
        }
      }
      
      // 仅更新当前组的选中节点，而不是全局选中节点
      setGroups(prev => prev.map(group => 
        group.name === groupName 
          ? {...group, now: verifyData.now || nodeName}
          : group
      ));
    } catch (error) {
      console.error('切换节点失败:', error);
      showError(`切换失败: ${String(error)}`);
    } finally {
      setSwitchingNode(null);
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
        console.log(`已取消收藏节点: ${nodeName}`);
      } else {
        newSet.add(nodeName);
        console.log(`已收藏节点: ${nodeName}`);
      }
      return newSet;
    });
  };

  // 切换折叠状态
  const toggleGroupCollapse = (groupName: string) => {
    setCollapsedGroups(prev => {
      const newSet = new Set(prev);
      if (newSet.has(groupName)) {
        newSet.delete(groupName);
      } else {
        newSet.add(groupName);
      }
      return newSet;
    });
  };

  // 根据节点名称长度计算最合适的列数
  const calculateOptimalColumns = (nodes: ProxyNode[]) => {
    if (nodes.length === 0) return 6; // 默认6列
    
    // 计算节点名称的平均长度
    const totalLength = nodes.reduce((sum, node) => sum + node.name.length, 0);
    const averageLength = totalLength / nodes.length;
    
    // 根据平均长度设置列数
    if (averageLength > 25) return 2; // 超长节点名
    if (averageLength > 20) return 3; // 长节点名
    if (averageLength > 15) return 4; // 中等长度节点名
    if (averageLength > 10) return 5; // 短节点名
    return 6; // 很短的节点名
  };

  // 修改节点卡片组件，极度简化
  const NodeCard: React.FC<{node: ProxyNode, group: ProxyGroup}> = ({ node, group }) => {
    const isSelected = group.now === node.name;
    const isTesting = testingNodes.has(node.name);
    const isFavorite = favoriteNodes.has(node.name);
    
    return (
      <div 
        className={`relative border rounded-lg overflow-hidden transition-all cursor-pointer p-3 ${
          isSelected 
            ? 'border-blue-500 bg-blue-50/70 dark:bg-[#2a2a2a]/90 shadow-sm dark:border-blue-600' 
            : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-[#2a2a2a] hover:border-gray-300 dark:hover:border-gray-600'
        }`}
        onClick={() => !switchingNode && handleNodeSelect(node.name, group.name)}
      >
        {/* 卡片内容 - 极简结构 */}
        <div className="flex flex-col space-y-1">
          {/* 标题行 */}
          <div className="flex items-center justify-between">
            <h3 
              className="font-medium text-gray-900 dark:text-gray-100 text-sm truncate max-w-[85%] group" 
              title={node.name}
            >
              <span className="truncate inline-block w-full group-hover:whitespace-normal group-hover:break-words">
                {node.name}
              </span>
            </h3>
            <div className="flex space-x-1 shrink-0">
              {/* 测速按钮 */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleTestNode(node.name);
                }}
                disabled={isTesting}
                className="h-5 w-5 flex items-center justify-center rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors text-gray-500 dark:text-gray-400 disabled:opacity-50"
                title="测试延迟"
              >
                <ReloadIcon className={`h-3 w-3 ${isTesting ? 'text-blue-500 animate-spin' : ''}`} />
              </button>
              
              {/* 收藏按钮 */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleToggleFavorite(node.name);
                }}
                className="h-5 w-5 flex items-center justify-center rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                title={isFavorite ? "取消收藏" : "添加到收藏"}
              >
                {isFavorite ? (
                  <StarFilledIcon className="h-3 w-3 text-yellow-500" />
                ) : (
                  <StarIcon className="h-3 w-3 text-gray-400 dark:text-gray-500" />
                )}
              </button>
            </div>
          </div>
          
          {/* 底部信息行 */}
          <div className="flex justify-between items-center">
            <div className="text-xs text-gray-500 dark:text-gray-400">
              {node.type}
            </div>
            {node.delay !== undefined && (
              <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                node.delay < 100 
                  ? 'bg-green-100 text-green-800 dark:bg-[#2a2a2a] dark:text-green-400' 
                  : node.delay < 300
                  ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400'
                  : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400'
              }`}>
                {node.delay}ms
              </span>
            )}
          </div>
        </div>
        
        {/* 切换中状态覆盖层 */}
        {switchingNode === node.name && (
          <div className="absolute inset-0 bg-white/50 dark:bg-gray-900/50 flex items-center justify-center z-20">
            <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
          </div>
        )}
      </div>
    );
  };

  if (!mihomoRunning) {
    return (
      <div className="bg-white dark:bg-[#2a2a2a] rounded-lg shadow-sm border border-gray-200 dark:border-gray-800 p-8">
        <div className="flex flex-col items-center justify-center text-center space-y-4">
          <ExclamationTriangleIcon className="w-12 h-12 text-yellow-500" />
          <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-200">Mihomo服务未运行</h2>
          <p className="text-gray-600 dark:text-gray-400 max-w-md">
            请先启动Mihomo服务，然后刷新页面。确保Mihomo已正确配置并运行在端口9090上。
          </p>
          <button 
            onClick={fetchProxies}
            className="mt-4 px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 transition-colors shadow-sm"
          >
            检查连接
          </button>
        </div>
      </div>
    );
  }

  // 渲染节点网格 - 动态调整列数
  const renderNodes = (group: ProxyGroup) => {
    // 根据节点名称长度计算最佳列数
    const optimalColumns = calculateOptimalColumns(group.nodes);
    
    // 使用Tailwind的响应式类决定不同屏幕尺寸的列数
    let gridClass = "";
    
    // 根据最佳列数设置对应的网格类
    switch(optimalColumns) {
      case 2:
        gridClass = "grid grid-cols-1 sm:grid-cols-2 md:grid-cols-2 lg:grid-cols-2 xl:grid-cols-2 gap-2 mt-3";
        break;
      case 3:
        gridClass = "grid grid-cols-1 sm:grid-cols-2 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3 gap-2 mt-3";
        break;
      case 4:
        gridClass = "grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-3 xl:grid-cols-4 gap-2 mt-3";
        break;
      case 5:
        gridClass = "grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2 mt-3";
        break;
      case 6:
      default:
        gridClass = "grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-2 mt-3";
        break;
    }
    
    return (
      <div className={gridClass}>
        {group.nodes.map(node => (
          <NodeCard key={node.name} node={node} group={group} />
        ))}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-6">
      {/* 错误提示 */}
      {errorMessage && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-900/50 rounded-md p-4 flex items-start">
          <ExclamationTriangleIcon className="w-5 h-5 text-red-500 mt-0.5 shrink-0" />
          <p className="ml-3 text-sm text-red-800 dark:text-red-200">{errorMessage}</p>
          <button
            onClick={() => setErrorMessage(null)}
            className="ml-auto text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300"
          >
            <Cross1Icon className="w-4 h-4" />
          </button>
        </div>
      )}
      
      {/* 顶部控制栏 */}
      <div className="flex justify-between items-center bg-white dark:bg-[#2a2a2a] p-3 rounded-lg shadow-sm border border-gray-200 dark:border-gray-800">
        <div className="flex items-center gap-4 w-full">
          <div className="relative flex-1 max-w-md">
            <input
              type="text"
              className="w-full pl-10 pr-4 py-2 rounded-lg bg-gray-50 dark:bg-[#222222] border border-gray-200 dark:border-gray-700 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-600 focus:border-transparent transition-all"
              placeholder="搜索节点..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            <MagnifyingGlassIcon className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
            {searchTerm && (
            <button 
                className="absolute right-3 top-1/2 transform -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded-full bg-gray-200 dark:bg-gray-600 hover:bg-gray-300 dark:hover:bg-gray-500 transition-colors"
                onClick={() => setSearchTerm('')}
            >
                <Cross1Icon className="w-3 h-3 text-gray-500 dark:text-gray-300" />
            </button>
            )}
      </div>

          <div className="flex items-center">
            <div className="border-r border-gray-200 dark:border-gray-700 pr-4 mr-4">
            <button
                onClick={() => setActiveTab('all')}
                className={`px-3 py-1 text-sm rounded-md mr-2 ${
                activeTab === 'all' 
                  ? 'bg-blue-100 text-blue-700 dark:bg-[#2a2a2a] dark:text-blue-400' 
                  : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
              }`}
            >
                全部节点
            </button>
            <button
                onClick={() => setActiveTab('favorite')}
                className={`px-3 py-1 text-sm rounded-md ${
                activeTab === 'favorite' 
                  ? 'bg-blue-100 text-blue-700 dark:bg-[#2a2a2a] dark:text-blue-400' 
                  : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
              }`}
            >
                <span className="flex items-center">
                  <StarFilledIcon className="w-3 h-3 text-yellow-500 mr-1" />
              收藏节点
                </span>
            </button>
            </div>
            
            <button
              className="p-2 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500 dark:text-gray-400"
              onClick={() => fetchProxies()}
              title="刷新节点列表"
            >
              <ReloadIcon className="w-4 h-4" />
            </button>
          </div>
          </div>
        </div>
        
      {/* 标签页 */}
      <div className="overflow-hidden">
        <div>
          {activeTab === 'all' && (
            <div className="max-h-[calc(100vh-320px)] overflow-auto pr-2 fancy-scrollbar">
              {isLoading ? (
                <div className="space-y-4">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden animate-pulse bg-white dark:bg-[#2a2a2a]">
                      <div className="px-3 py-3 flex items-center">
                        <div className="h-4 w-[100px] bg-gray-200 dark:bg-[#1a1a1a] rounded-md"></div>
                        <div className="h-3 w-[30px] bg-gray-200 dark:bg-[#1a1a1a] rounded-full ml-2"></div>
                        <div className="h-3 w-[60px] bg-gray-200 dark:bg-[#1a1a1a] rounded-md ml-2"></div>
                        <div className="ml-auto h-3 w-[40px] bg-gray-200 dark:bg-[#1a1a1a] rounded"></div>
                          </div>
                      <div className="border-t border-gray-100 dark:border-gray-700/50 p-2">
                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2">
                          {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((j) => (
                            <div key={j} className="h-[70px] bg-gray-200 dark:bg-[#1a1a1a] rounded-lg"></div>
                        ))}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : filteredGroups.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center bg-white dark:bg-[#2a2a2a] rounded-lg shadow-sm border border-gray-200 dark:border-gray-800 p-4">
                  <div className="rounded-full p-4 bg-gray-50 dark:bg-[#222222] mb-5">
                    <MagnifyingGlassIcon className="h-7 w-7 text-gray-400" />
                  </div>
                  <p className="text-gray-700 dark:text-gray-300 font-medium text-lg mb-2">未找到匹配的节点</p>
                  <p className="text-gray-500 dark:text-gray-500 text-sm max-w-md">
                    尝试使用其他关键词搜索，或清除搜索条件查看所有节点
                  </p>
                  {searchTerm && (
                      <button
                      onClick={() => setSearchTerm('')}
                      className="mt-4 px-3 py-1.5 bg-gray-100 dark:bg-[#222222] text-gray-700 dark:text-gray-300 rounded-md hover:bg-gray-200 dark:hover:bg-[#1a1a1a] transition-colors text-sm flex items-center"
                      >
                      <Cross1Icon className="w-3.5 h-3.5 mr-1.5" />
                      清除搜索
                      </button>
                  )}
                    </div>
              ) : (
                filteredGroups.map((group, groupIndex) => (
                  <div key={group.name} className="border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden bg-white dark:bg-[#2a2a2a] mb-4">
                    <div 
                      className="px-3 py-3 flex items-center justify-between cursor-pointer"
                      onClick={() => toggleGroupCollapse(group.name)}
                    >
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100">{group.name}</h3>
                        <Badge variant="outline" className="text-[10px] bg-blue-50 dark:bg-[#2a2a2a] text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800 px-1 h-[18px]">
                          {group.nodes.length}
                        </Badge>
                        <span className="text-[10px] text-gray-500 dark:text-gray-400 uppercase">{group.type}</span>
                      </div>
                      <div className="flex items-center gap-2">
                            <button
                          onClick={(e) => { 
                            e.stopPropagation();
                            handleBatchTest(group.name);
                          }}
                          className="text-[10px] text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 transition-colors px-1.5 py-0.5 rounded hover:bg-blue-50 dark:hover:bg-[#222222] font-medium flex items-center"
                        >
                          <ReloadIcon className="h-2.5 w-2.5 mr-1" />
                          测试
                            </button>
                        <div className="text-gray-400">
                          <svg 
                            xmlns="http://www.w3.org/2000/svg" 
                            width="16" 
                            height="16" 
                            viewBox="0 0 24 24" 
                            fill="none" 
                            stroke="currentColor" 
                            strokeWidth="2" 
                            strokeLinecap="round" 
                            strokeLinejoin="round"
                            className={`arrow-icon ${collapsedGroups.has(group.name) ? 'up' : ''}`}
                          >
                            <polyline points="6 9 12 15 18 9"></polyline>
                          </svg>
                              </div>
                            </div>
                          </div>
                    <div 
                      ref={(el) => { getNodeRef.current[group.name] = el; }}
                      className={`group-content ${collapsedGroups.has(group.name) ? 'collapsed' : 'expanded'}`}
                    >
                      <div className="border-t border-gray-100 dark:border-gray-700/50 p-2">
                        {renderNodes(group)}
                          </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
          
          {activeTab === 'favorite' && (
            <div className="max-h-[calc(100vh-320px)] overflow-auto pr-2 fancy-scrollbar">
              {isLoading ? (
                <div className="space-y-4">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden animate-pulse bg-white dark:bg-[#2a2a2a]">
                      <div className="px-3 py-3 flex items-center">
                        <div className="h-4 w-[100px] bg-gray-200 dark:bg-[#1a1a1a] rounded-md"></div>
                        <div className="h-3 w-[30px] bg-gray-200 dark:bg-[#1a1a1a] rounded-full ml-2"></div>
                        <div className="h-3 w-[60px] bg-gray-200 dark:bg-[#1a1a1a] rounded-md ml-2"></div>
                        <div className="ml-auto h-3 w-[40px] bg-gray-200 dark:bg-[#1a1a1a] rounded"></div>
                          </div>
                      <div className="border-t border-gray-100 dark:border-gray-700/50 p-2">
                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2">
                          {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((j) => (
                            <div key={j} className="h-[70px] bg-gray-200 dark:bg-[#1a1a1a] rounded-lg"></div>
                        ))}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : favoriteFilteredGroups.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center bg-white dark:bg-[#2a2a2a] rounded-lg shadow-sm border border-gray-200 dark:border-gray-800 p-4">
                  <div className="rounded-full p-4 bg-gray-50 dark:bg-[#222222] mb-5 relative">
                    <StarIcon className="h-7 w-7 text-yellow-500 opacity-70" />
                    <div className="absolute -right-1 -bottom-1 rounded-full bg-gray-50 dark:bg-[#222222] p-1.5">
                      <PlusIcon className="h-4 w-4 text-gray-500" />
                  </div>
                </div>
                  <p className="text-gray-700 dark:text-gray-300 font-medium text-lg mb-2">未找到收藏的节点</p>
                  <p className="text-gray-500 dark:text-gray-500 text-sm max-w-md">
                    你可以通过点击节点卡片左上角的星标图标 ⭐ 将节点添加到收藏列表中，方便快速访问常用节点
                  </p>
                      <button
                    onClick={() => setActiveTab('all')}
                    className="mt-4 px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 transition-colors shadow-sm text-sm"
                      >
                    查看所有节点
                      </button>
                    </div>
              ) : (
                favoriteFilteredGroups.map(group => (
                  <div key={group.name} className="border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden bg-white dark:bg-[#2a2a2a] mb-4">
                    <div 
                      className="px-3 py-3 flex items-center justify-between cursor-pointer"
                      onClick={() => toggleGroupCollapse(group.name)}
                    >
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100">{group.name}</h3>
                        <Badge variant="outline" className="text-[10px] bg-blue-50 dark:bg-[#2a2a2a] text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800 px-1 h-[18px]">
                          {group.nodes.length}
                        </Badge>
                        <span className="text-[10px] text-gray-500 dark:text-gray-400 uppercase">{group.type}</span>
                      </div>
                      <div className="flex items-center gap-2">
                            <button
                          onClick={(e) => { 
                            e.stopPropagation(); 
                            handleBatchTest(group.name); 
                          }}
                          className="text-[10px] text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 transition-colors px-1.5 py-0.5 rounded hover:bg-blue-50 dark:hover:bg-[#222222] font-medium flex items-center"
                        >
                          <ReloadIcon className="h-2.5 w-2.5 mr-1" />
                          测试
                            </button>
                        <div className="text-gray-400">
                          <svg 
                            xmlns="http://www.w3.org/2000/svg" 
                            width="16" 
                            height="16" 
                            viewBox="0 0 24 24" 
                            fill="none" 
                            stroke="currentColor" 
                            strokeWidth="2" 
                            strokeLinecap="round" 
                            strokeLinejoin="round"
                            className={`arrow-icon ${collapsedGroups.has(group.name) ? 'up' : ''}`}
                          >
                            <polyline points="6 9 12 15 18 9"></polyline>
                          </svg>
                              </div>
                            </div>
                          </div>
                    <div 
                      ref={(el) => { getNodeRef.current[group.name] = el; }}
                      className={`group-content ${collapsedGroups.has(group.name) ? 'collapsed' : 'expanded'}`}
                    >
                      <div className="border-t border-gray-100 dark:border-gray-700/50 p-2">
                        {renderNodes(group)}
                          </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
      
      {/* 底部状态栏 - 精简 */}
      <div className="flex items-center justify-between px-3 py-2 bg-white dark:bg-[#2a2a2a] rounded-lg shadow-sm border border-gray-200 dark:border-gray-800 text-xs text-gray-500 dark:text-gray-400">
        <div className="flex items-center gap-3">
          <span>{groups.reduce((acc, group) => acc + group.nodes.length, 0)} 个节点</span>
          <span>{filteredGroups.reduce((acc, group) => acc + group.nodes.length, 0)} 个已过滤</span>
          <span>{favoriteNodes.size} 个收藏</span>
        </div>
        {selectedNode && (
          <div className="flex items-center">
            <div className="w-1.5 h-1.5 rounded-full bg-green-500 mr-1.5"></div>
            <span className="font-medium text-gray-700 dark:text-gray-300">{selectedNode}</span>
        </div>
        )}
      </div>
      
      {/* 样式 */}
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
        
        /* 折叠动画相关样式 */
        .group-content {
          transition: all 0.3s cubic-bezier(0.25, 1, 0.5, 1);
          will-change: height, opacity, transform;
          transform-origin: top;
        }
        
        .group-content.collapsed {
          height: 0 !important;
          opacity: 0;
          transform: scaleY(0.95);
        }
        
        .group-content.expanded {
          opacity: 1;
          transform: scaleY(1);
        }
        
        /* 箭头旋转动画 */
        .arrow-icon {
          transition: transform 0.3s cubic-bezier(0.25, 1, 0.5, 1);
        }
        
        .arrow-icon.up {
          transform: rotate(180deg);
        }
      `}</style>
    </div>
  );
} 