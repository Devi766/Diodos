import React, { useState, useEffect, useRef, useCallback } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Toast from '@radix-ui/react-toast';
import { Cross2Icon, PlusIcon, TrashIcon, GlobeIcon, Pencil1Icon, ReloadIcon, ExternalLinkIcon, UploadIcon, CheckIcon, PlayIcon, DragHandleDots2Icon } from '@radix-ui/react-icons';
import axios from 'axios';

type Subscription = {
  name: string;
  path: string;
  // 订阅信息字段
  usedTraffic?: string | null;
  remainingTraffic?: string | null;
  expiryDate?: string | null;
  lastUpdated?: string;
  // 新增：排序索引
  order?: number;
};

// 计算流量进度百分比
const calculateProgressPercentage = (usedTraffic: string | null, remainingTraffic: string | null): number => {
  if (!usedTraffic || !remainingTraffic) return 0;
  
  try {
    // 提取数字和单位（GB、MB等）
    // 支持多种格式: "10.5GB", "10.5 GB", "10.5 G", "10.5"
    const usedMatch = usedTraffic.match(/^([\d.]+)\s*([KMGT]i?B?)?$/i);
    const remainingMatch = remainingTraffic.match(/^([\d.]+)\s*([KMGT]i?B?)?$/i);
    
    if (!usedMatch || !remainingMatch) {
      console.log('无法解析流量字符串格式:', usedTraffic, remainingTraffic);
      return 50; // 默认值
    }
    
    const used = parseFloat(usedMatch[1]);
    const remaining = parseFloat(remainingMatch[1]);
    
    // 标准化单位
    const normalizeUnit = (unit: string | undefined): string => {
      if (!unit) return 'B';
      // 处理多种写法: G, GB, GiB 转为标准形式
      const match = unit.toUpperCase().match(/([KMGT])/i);
      return match ? match[1] + 'B' : 'B';
    };
    
    const usedUnit = normalizeUnit(usedMatch[2]);
    const remainingUnit = normalizeUnit(remainingMatch[2]);
    
    // 如果单位相同
    if (usedUnit === remainingUnit) {
      const total = used + remaining;
      return total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0;
    }
    
    // 单位不同时的转换 (按最小单位计算)
    const unitMultiplier: Record<string, number> = {
      'B': 1,
      'KB': 1024,
      'MB': 1024 * 1024,
      'GB': 1024 * 1024 * 1024,
      'TB': 1024 * 1024 * 1024 * 1024
    };
    
    const usedBytes = used * (unitMultiplier[usedUnit] || 1);
    const remainingBytes = remaining * (unitMultiplier[remainingUnit] || 1);
    
    const totalBytes = usedBytes + remainingBytes;
    // 确保返回值在0-100之间
    return totalBytes > 0 ? Math.min(100, Math.max(0, (usedBytes / totalBytes) * 100)) : 0;
  } catch (e) {
    console.error('计算流量进度条出错:', e);
    return 50;
  }
};

// 判断是否即将到期（30天内）
const isExpiringSoon = (expiryDate: string | null): boolean => {
  if (!expiryDate) return false;
  
  try {
    // 常见的日期格式
    // 1. 2023/01/01
    // 2. 2023-01-01
    // 3. 01/01/2023
    // 4. 01-01-2023
    // 5. 01.01.2023
    // 6. Jan 1, 2023
    
    let expiry: Date;
    
    // 尝试检测日期格式并解析
    if (/^\d{4}[-/\.]\d{1,2}[-/\.]\d{1,2}$/.test(expiryDate)) {
      // YYYY-MM-DD 或 YYYY/MM/DD 或 YYYY.MM.DD
      expiry = new Date(expiryDate);
    } else if (/^\d{1,2}[-/\.]\d{1,2}[-/\.]\d{4}$/.test(expiryDate)) {
      // DD-MM-YYYY 或 MM-DD-YYYY 格式
      const parts = expiryDate.split(/[-/\.]/);
      // 假设MM-DD-YYYY格式（美式）
      expiry = new Date(`${parts[2]}-${parts[0]}-${parts[1]}`);
      
      // 如果日期无效且第一部分≤12，尝试DD-MM-YYYY格式（欧式）
      if (isNaN(expiry.getTime()) && parseInt(parts[0]) <= 12) {
        expiry = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
      }
    } else {
      // 尝试标准解析
      expiry = new Date(expiryDate);
    }
    
    // 验证日期的有效性
    if (isNaN(expiry.getTime())) {
      console.warn('无法解析日期:', expiryDate);
      return false;
    }
    
    const now = new Date();
    
    // 计算距离到期还有多少天
    const daysDiff = Math.floor((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    
    return daysDiff >= 0 && daysDiff <= 30;
  } catch (e) {
    console.error('解析到期日期出错:', e);
    return false;
  }
};

// 判断流量是否较少（低于20%）
const isLowTraffic = (usedTraffic: string | null, remainingTraffic: string | null): boolean => {
  const percentage = calculateProgressPercentage(usedTraffic, remainingTraffic);
  return percentage > 80; // 已用超过80%
};

// 获取进度条颜色类
const getProgressColorClass = (usedTraffic: string | null, remainingTraffic: string | null): string => {
  if (!usedTraffic || !remainingTraffic) return 'bg-blue-500';
  
  const isLow = isLowTraffic(usedTraffic, remainingTraffic);
  if (isLow) {
    return 'bg-red-500';
  }
  return 'bg-blue-500';
};

// 格式化流量信息显示（添加图标和颜色）
const getTrafficInfo = (subscription: Subscription) => {
  const { usedTraffic, remainingTraffic } = subscription;
  
  // 确保类型是 string | null
  const usedTrafficValue: string | null = usedTraffic || null;
  const remainingTrafficValue: string | null = remainingTraffic || null;
  
  // 低流量警告
  const isLow = remainingTrafficValue && usedTrafficValue ? 
    isLowTraffic(usedTrafficValue, remainingTrafficValue) : false;
  
  return {
    usedColorClass: 'text-red-500 dark:text-red-400 font-medium',
    remainingColorClass: isLow ? 
      'text-amber-500 dark:text-amber-400 font-medium' : 
      'text-emerald-500 dark:text-emerald-400 font-medium',
    progressColorClass: getProgressColorClass(usedTrafficValue, remainingTrafficValue),
    progress: calculateProgressPercentage(usedTrafficValue, remainingTrafficValue),
    isLow
  };
};

export default function SubscriptionManager() {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [subUrl, setSubUrl] = useState('');
  const [subName, setSubName] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [selectedSub, setSelectedSub] = useState<Subscription | null>(null);
  const [toastOpen, setToastOpen] = useState(false);
  const [toastTitle, setToastTitle] = useState('');
  const [toastDescription, setToastDescription] = useState('');
  const [toastType, setToastType] = useState<'success' | 'error'>('success');
  const [updatingSubPath, setUpdatingSubPath] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 新增: 当前活跃的配置文件路径
  const [activeConfig, setActiveConfig] = useState<string | null>(null);
  // 新增: 是否正在切换配置
  const [switchingConfig, setSwitchingConfig] = useState<string | null>(null);
  // 新增: 服务运行状态
  const [isServiceRunning, setIsServiceRunning] = useState<boolean>(false);
  
  // 拖拽相关状态
  const [draggedItem, setDraggedItem] = useState<Subscription | null>(null);
  const [dragOverItem, setDragOverItem] = useState<Subscription | null>(null);
  const [isDraggingCard, setIsDraggingCard] = useState(false);
  
  // 元素引用，用于滚动到视图中
  const draggedItemRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    loadSubscriptions();
    loadActiveConfig();
    
    // 设置定期刷新活跃配置的计时器
    const intervalId = setInterval(loadActiveConfig, 5000);
    
    // 监听订阅导入事件
    let unsubscribeImport: (() => void) | undefined;
    
    if (window.electronAPI?.onImportSubscription) {
      console.log('设置订阅导入事件监听器');
      unsubscribeImport = window.electronAPI.onImportSubscription((url: string) => {
        console.log('收到订阅导入请求，URL:', url);
        if (url && url.trim() !== '') {
          console.log('准备导入订阅，设置URL并打开对话框');
          // 设置订阅URL并自动打开订阅添加对话框
          setSubUrl(url);
          setIsDialogOpen(true);
        } else {
          console.log('收到的订阅URL为空');
        }
      });
    } else {
      console.log('onImportSubscription API不可用');
    }
    
    return () => {
      clearInterval(intervalId);
      if (unsubscribeImport) unsubscribeImport();
    };
  }, []);

  // 新增: 加载当前活跃的配置
  const loadActiveConfig = async () => {
    if (!window.electronAPI) return;
    
    try {
      const config = await window.electronAPI.getActiveConfig();
      setActiveConfig(config);
      setIsServiceRunning(!!config);
    } catch (error) {
      console.error('获取当前配置失败:', error);
    }
  };
  
  // 新增: 切换使用的配置文件
  const switchConfig = async (configPath: string) => {
    if (!window.electronAPI) return;
    
    // 如果当前配置已经是这个，不需要切换
    if (activeConfig === configPath) {
      showToast('提示', '该配置文件已经处于激活状态', 'success');
      return;
    }
    
    setSwitchingConfig(configPath);
    
    try {
      // 检查服务是否正在运行
      if (isServiceRunning) {
        // 先停止当前服务
        await window.electronAPI.stopMihomo();
        
        // 等待一段时间确保服务已停止
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      // 启动新的服务
      const result = await window.electronAPI.startMihomo(configPath);
      
      if (result) {
        showToast('成功', '成功切换配置文件', 'success');
        setActiveConfig(configPath);
        
        // 关键修改：等待服务完全启动后获取节点信息
        setTimeout(async () => {
          try {
            // 获取最新节点状态
            if (window.electronAPI) {
              // 使用getProxies方法获取节点状态而不是getCurrentNode
              const proxies = await window.electronAPI.getProxies();
              if (proxies && proxies.groups) {
                // 找到当前选中的节点
                const selectedNode = Object.values(proxies.proxies || {})
                  .find((proxy: any) => proxy.selected) as any;
                
                if (selectedNode?.name) {
                  console.log('当前节点已更新为:', selectedNode.name);
                  
                  // 通知其他组件配置已切换 - 使用已有的notifyNodeChanged方法
                  await window.electronAPI.notifyNodeChanged(selectedNode.name);
                }
              }
            }
          } catch (error) {
            console.error('获取节点信息失败:', error);
          }
        }, 2000); // 等待2秒让服务完全启动
      } else {
        showToast('错误', '切换配置文件失败', 'error');
      }
    } catch (error) {
      console.error('切换配置文件失败:', error);
      showToast('错误', `切换配置文件失败: ${error}`, 'error');
    } finally {
      setSwitchingConfig(null);
      loadActiveConfig(); // 重新加载当前活跃配置
    }
  };

  const loadSubscriptions = async () => {
    if (!window.electronAPI) return;
    
    try {
      const subs = await window.electronAPI.getSubscriptions();
      
      // 从本地存储中获取排序信息
      const savedOrder = getSavedOrder();
      
      // 应用排序
      const sortedSubs = sortSubscriptionsByOrder(subs, savedOrder);
      setSubscriptions(sortedSubs);
    } catch (error) {
      console.error('加载订阅失败:', error);
      showToast('错误', '加载订阅失败', 'error');
    }
  };
  
  // 新增: 获取保存的排序
  const getSavedOrder = (): Record<string, number> => {
    try {
      const saved = localStorage.getItem('subscriptionOrder');
      return saved ? JSON.parse(saved) : {};
    } catch (error) {
      console.error('加载排序信息失败:', error);
      return {};
    }
  };
  
  // 新增: 保存排序到本地存储
  const saveOrder = (subs: Subscription[]) => {
    try {
      const orderMap: Record<string, number> = {};
      subs.forEach((sub, index) => {
        orderMap[sub.path] = index;
      });
      
      localStorage.setItem('subscriptionOrder', JSON.stringify(orderMap));
    } catch (error) {
      console.error('保存排序信息失败:', error);
    }
  };
  
  // 新增: 根据排序信息排序订阅
  const sortSubscriptionsByOrder = (subs: Subscription[], orderMap: Record<string, number>): Subscription[] => {
    return [...subs].sort((a, b) => {
      const orderA = orderMap[a.path] !== undefined ? orderMap[a.path] : Number.MAX_SAFE_INTEGER;
      const orderB = orderMap[b.path] !== undefined ? orderMap[b.path] : Number.MAX_SAFE_INTEGER;
      return orderA - orderB;
    });
  };
  
  // 新增: 拖拽开始处理函数
  const handleCardDragStart = (e: React.DragEvent<HTMLDivElement>, item: Subscription) => {
    setDraggedItem(item);
    setIsDraggingCard(true);
    
    // 为拖拽元素设置数据
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', item.path);
    
    // 延迟设置拖拽样式，解决 Firefox 中的拖拽图像问题
    setTimeout(() => {
      if (e.target instanceof HTMLElement) {
        e.target.classList.add('opacity-50');
      }
    }, 0);
  };
  
  // 新增: 拖拽结束处理函数
  const handleCardDragEnd = (e: React.DragEvent<HTMLDivElement>) => {
    setIsDraggingCard(false);
    setDraggedItem(null);
    setDragOverItem(null);
    
    // 清除拖拽样式
    if (e.target instanceof HTMLElement) {
      e.target.classList.remove('opacity-50');
    }
  };
  
  // 新增: 拖拽悬停处理函数
  const handleCardDragOver = (e: React.DragEvent<HTMLDivElement>, item: Subscription) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    
    // 只有悬停在不同项上时才更新
    if (draggedItem && draggedItem.path !== item.path) {
      setDragOverItem(item);
    }
  };
  
  // 新增: 处理元素放置函数
  const handleCardDrop = (e: React.DragEvent<HTMLDivElement>, target: Subscription) => {
    e.preventDefault();
    
    if (!draggedItem) return;
    
    // 重新排序订阅列表
    const newSubscriptions = [...subscriptions];
    const draggedIndex = newSubscriptions.findIndex(sub => sub.path === draggedItem.path);
    const targetIndex = newSubscriptions.findIndex(sub => sub.path === target.path);
    
    if (draggedIndex === -1 || targetIndex === -1) return;
    
    // 移除拖拽的项并在目标位置插入
    const [draggedSub] = newSubscriptions.splice(draggedIndex, 1);
    newSubscriptions.splice(targetIndex, 0, draggedSub);
    
    // 更新状态
    setSubscriptions(newSubscriptions);
    
    // 保存新顺序
    saveOrder(newSubscriptions);
    
    // 清除拖拽状态
    setDraggedItem(null);
    setDragOverItem(null);
  };

  const addSubscription = async (e: React.FormEvent) => {
    e.preventDefault();
    
    console.log('开始添加订阅，URL:', subUrl);
    
    if (!window.electronAPI) {
      console.error('electronAPI不可用，无法添加订阅');
      return;
    }
    
    if (!subUrl.trim()) {
      console.error('订阅URL为空，取消添加');
      showToast('错误', '请输入有效的订阅链接', 'error');
      return;
    }

    setIsLoading(true);
    console.log('正在从服务器获取订阅内容...');
    
    try {
      const configData = await window.electronAPI.fetchSubscription(subUrl);
      console.log('获取订阅内容结果:', configData ? '成功' : '失败');
      
      if (configData) {
        const customName = subName.trim() || '';
        console.log('准备保存订阅 - URL:', subUrl);
        console.log('准备保存订阅 - 自定义名称:', customName);
        console.log('准备保存订阅 - 流量信息:', configData.subscriptionInfo);
        
        // 确保传递订阅信息
        const filePath = await window.electronAPI.saveSubscription(
          subUrl, 
          configData.content, 
          customName, 
          configData.subscriptionInfo
        );
        
        console.log('订阅保存成功，文件路径:', filePath);
        showToast('成功', '订阅添加成功', 'success');
        setSubUrl('');
        setSubName('');
        setIsDialogOpen(false);
        
        // 立即重新加载订阅列表以显示最新信息（包括流量信息）
        await loadSubscriptions();
      } else {
        console.error('获取订阅内容失败');
        showToast('错误', '获取订阅内容失败', 'error');
      }
    } catch (error) {
      console.error('添加订阅失败:', error);
      showToast('错误', `添加订阅失败: ${error}`, 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const deleteSubscription = async (filePath: string) => {
    if (!window.electronAPI) return;
    
    try {
      const result = await window.electronAPI.deleteSubscription(filePath);
      
      if (result) {
        showToast('成功', '订阅删除成功', 'success');
        await loadSubscriptions();
      } else {
        showToast('错误', '删除订阅失败', 'error');
      }
    } catch (error) {
      console.error('删除订阅失败:', error);
      showToast('错误', `删除订阅失败: ${error}`, 'error');
    }
  };
  
  const refreshSubscription = async (filePath: string) => {
    if (!window.electronAPI) return;
    
    setUpdatingSubPath(filePath);
    
    try {
      const result = await window.electronAPI.refreshSubscription(filePath);
      
      if (result && result.success) {
        showToast('成功', '订阅更新成功', 'success');
        await loadSubscriptions();
      } else {
        showToast('错误', result.error || '更新订阅失败', 'error');
      }
    } catch (error) {
      console.error('更新订阅失败:', error);
      showToast('错误', `更新订阅失败: ${error}`, 'error');
    } finally {
      setUpdatingSubPath(null);
    }
  };

  const openConfigFile = async (filePath: string) => {
    if (!window.electronAPI) return;
    
    try {
      await window.electronAPI.openFile(filePath);
    } catch (error) {
      console.error('打开文件失败:', error);
      showToast('错误', `打开文件失败: ${error}`, 'error');
    }
  };

  const openConfigFolder = async (filePath: string) => {
    if (!window.electronAPI) return;
    
    try {
      await window.electronAPI.openFileLocation(filePath);
    } catch (error) {
      console.error('打开目录失败:', error);
      showToast('错误', `打开目录失败: ${error}`, 'error');
    }
  };

  const showToast = (title: string, description: string, type: 'success' | 'error') => {
    setToastTitle(title);
    setToastDescription(description);
    setToastType(type);
    setToastOpen(true);
  };

  // 拖放文件相关处理函数
  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    
    // 只在拖拽文件时设置isDragging
    if (e.dataTransfer.types.includes('Files')) {
    setIsDragging(true);
    }
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    
    // 只在拖拽文件时设置isDragging
    if (e.dataTransfer.types.includes('Files')) {
    setIsDragging(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    
    // 检查是否离开了主容器
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX;
    const y = e.clientY;
    
    // 如果鼠标位置在容器外部，则设置isDragging为false
    if (
      x < rect.left ||
      x >= rect.right ||
      y < rect.top ||
      y >= rect.bottom
    ) {
      setIsDragging(false);
    }
  }, []);

  // 文件拖放处理函数
  const handleFileDrop = useCallback(async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    if (!window.electronAPI) return;
    
    // 如果是卡片拖拽，不处理文件
    if (isDraggingCard) return;

    // 获取拖拽的文件
    const files = Array.from(e.dataTransfer.files);
    
    if (files.length === 0) return;

    // 检查是否为YAML文件
    const validFiles = files.filter(file => 
      file.name.endsWith('.yaml') || 
      file.name.endsWith('.yml') || 
      file.type === 'application/x-yaml' ||
      file.type === 'text/yaml'
    );

    if (validFiles.length === 0) {
      showToast('错误', '请上传有效的YAML配置文件', 'error');
      return;
    }

    // 处理每个有效文件
    for (const file of validFiles) {
      try {
        // 读取文件内容
        const content = await readFileAsText(file);
        
        // 保存为订阅
        const filePath = await window.electronAPI.saveSubscription(
          `local:${file.name}`, // 使用本地标识符
          content,
          file.name.replace(/\.(ya?ml)$/, ''), // 使用文件名作为默认名称
          {
            lastUpdated: new Date().toISOString()
          }
        );
        
        showToast('成功', `配置文件 ${file.name} 导入成功`, 'success');
      } catch (error) {
        console.error('导入配置文件失败:', error);
        showToast('错误', `导入配置文件 ${file.name} 失败: ${error}`, 'error');
      }
    }

    // 重新加载订阅列表
    await loadSubscriptions();
  }, [isDraggingCard]);

  // 处理文件选择
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!window.electronAPI) return;
    
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    for (const file of files) {
      try {
        // 读取文件内容
        const content = await readFileAsText(file);
        
        // 保存为订阅
        const filePath = await window.electronAPI.saveSubscription(
          `local:${file.name}`,
          content,
          file.name.replace(/\.(ya?ml)$/, ''),
          {
            lastUpdated: new Date().toISOString()
          }
        );
        
        showToast('成功', `配置文件 ${file.name} 导入成功`, 'success');
      } catch (error) {
        console.error('导入配置文件失败:', error);
        showToast('错误', `导入配置文件 ${file.name} 失败: ${error}`, 'error');
      }
    }

    // 清空文件输入，允许再次选择相同的文件
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }

    // 重新加载订阅列表
    await loadSubscriptions();
  };

  // 将文件读取为文本
  const readFileAsText = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => resolve(e.target?.result as string);
      reader.onerror = e => reject(e);
      reader.readAsText(file);
    });
  };

  // 打开文件选择对话框
  const triggerFileInput = () => {
    fileInputRef.current?.click();
  };

  return (
    <div 
      className="p-6 relative"
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleFileDrop}
    >
      <Toast.Provider swipeDirection="right">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-2xl font-bold text-[#3b82f6] dark:text-[#3b82f6] flex items-center">
            订阅管理
          </h1>
          
          <div className="flex space-x-3">
            {/* 上传YAML文件按钮 */}
            <button
              className="flex items-center py-2 px-4 bg-green-500 hover:bg-green-600 text-white rounded-md transition-colors shadow-sm"
              onClick={triggerFileInput}
            >
              <UploadIcon className="mr-2" />
              上传配置
            </button>
            <input
              type="file"
              ref={fileInputRef}
              className="hidden"
              accept=".yaml,.yml,application/x-yaml,text/yaml"
              onChange={handleFileSelect}
              multiple
            />
            
            {/* 添加订阅按钮 */}
            <Dialog.Root open={isDialogOpen} onOpenChange={setIsDialogOpen}>
              <Dialog.Trigger asChild>
                <button
                  className="flex items-center py-2 px-4 bg-blue-500 hover:bg-blue-600 text-white rounded-md transition-colors shadow-sm"
                >
                  <PlusIcon className="mr-2" />
                  添加订阅
                </button>
              </Dialog.Trigger>
              
              <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 bg-black/50 backdrop-blur-sm" />
                <Dialog.Content className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-white dark:bg-[#2a2a2a] rounded-lg p-6 w-full max-w-md shadow-xl">
                  <Dialog.Title className="text-lg font-bold mb-4 text-gray-800 dark:text-white flex items-center">
                    <GlobeIcon className="w-5 h-5 mr-2 text-blue-500" />
                    添加订阅
                  </Dialog.Title>
                  
                  <form onSubmit={addSubscription}>
                    <div className="mb-4">
                      <label className="block text-sm font-medium mb-2 text-gray-700 dark:text-gray-300 flex items-center">
                        <GlobeIcon className="w-4 h-4 mr-2 text-blue-500" />
                        订阅链接
                      </label>
                      <div className="relative">
                        <input
                          type="text"
                          className="w-full py-2 pl-10 pr-3 border border-gray-300 dark:border-gray-700 rounded-md bg-white dark:bg-[#222222] text-gray-700 dark:text-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-all"
                          placeholder="https://example.com/subscription"
                          value={subUrl}
                          onChange={(e) => setSubUrl(e.target.value)}
                          required
                        />
                        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                          <GlobeIcon className="h-5 w-5 text-gray-400" />
                        </div>
                      </div>
                    </div>
                    
                    <div className="mb-4">
                      <label className="block text-sm font-medium mb-2 text-gray-700 dark:text-gray-300 flex items-center">
                        <Pencil1Icon className="w-4 h-4 mr-2 text-blue-500" />
                        备注名称（可选）
                      </label>
                      <div className="relative">
                        <input
                          type="text"
                          className="w-full py-2 pl-10 pr-3 border border-gray-300 dark:border-gray-700 rounded-md bg-white dark:bg-[#222222] text-gray-700 dark:text-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-all"
                          placeholder="自定义配置文件名称"
                          value={subName}
                          onChange={(e) => setSubName(e.target.value)}
                        />
                        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                          <Pencil1Icon className="h-5 w-5 text-gray-400" />
                        </div>
                      </div>
                      <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400 flex items-start">
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-1 text-gray-400 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        <span>配置文件将以此名称保存，不填则使用默认名称。自定义名称可以帮助区分不同的订阅。</span>
                      </p>
                    </div>
                    
                    <div className="flex justify-end gap-2">
                      <Dialog.Close asChild>
                        <button
                          type="button"
                          className="py-2 px-4 bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-800 dark:text-gray-200 rounded-md transition-colors"
                        >
                          取消
                        </button>
                      </Dialog.Close>
                      
                      <button
                        type="submit"
                        className="py-2 px-4 bg-blue-500 hover:bg-blue-600 text-white rounded-md transition-colors flex items-center shadow-sm"
                        disabled={isLoading}
                      >
                        {isLoading ? '处理中...' : '添加'}
                      </button>
                    </div>
                  </form>
                  
                  <Dialog.Close asChild>
                    <button
                      aria-label="Close"
                      className="absolute top-4 right-4 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                    >
                      <Cross2Icon />
                    </button>
                  </Dialog.Close>
                </Dialog.Content>
              </Dialog.Portal>
            </Dialog.Root>
          </div>
        </div>
        
        {/* 拖放区域 - 始终存在但只在拖动时可见 */}
        <div 
          className={`fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-sm transition-opacity duration-300 ${
            isDragging ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
          }`}
        >
          <div className={`bg-white dark:bg-[#2a2a2a] rounded-lg p-8 shadow-xl border-2 border-dashed border-blue-500 mx-4 max-w-lg w-full transition-transform duration-300 transform ${
            isDragging ? 'scale-100' : 'scale-95'
          }`}>
            <div className="flex flex-col items-center justify-center">
              <UploadIcon className="w-16 h-16 mb-4 text-blue-500" />
              <p className="text-lg font-medium text-gray-700 dark:text-gray-300">
                释放以上传YAML配置文件
              </p>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
                支持.yaml和.yml格式文件
              </p>
            </div>
          </div>
        </div>
        
        {/* 卡片网格 */}
        <div className="bg-white dark:bg-[#2a2a2a] rounded-lg shadow-sm p-6">
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-lg font-semibold text-gray-800 dark:text-white flex items-center">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
              我的订阅
            </h2>
            
            <div className="text-xs text-gray-500 dark:text-gray-400 flex items-center">
              {subscriptions.length > 0 && (
                <span className="bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 px-2 py-1 rounded-full">
                  共 {subscriptions.length} 个订阅
                </span>
              )}
              {isServiceRunning && (
                <span className="ml-2 bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 px-2 py-1 rounded-full flex items-center">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
                  </svg>
                  服务运行中
                </span>
              )}
              {subscriptions.length > 1 && (
                <span className="ml-2 bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 px-2 py-1 rounded-full flex items-center">
                  <DragHandleDots2Icon className="h-3 w-3 mr-1" />
                  可直接拖动卡片排序
                </span>
              )}
            </div>
          </div>
          
          {subscriptions.length === 0 ? (
            <div className="text-center py-16 bg-gray-50 dark:bg-gray-800/30 rounded-lg">
              <div className="flex flex-col items-center justify-center">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-16 w-16 text-gray-300 dark:text-gray-600 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <p className="text-lg font-medium text-gray-500 dark:text-gray-400">还没有添加任何订阅</p>
                <p className="mt-2 text-sm text-gray-500 dark:text-gray-500">点击"添加订阅"按钮开始使用</p>
                <button
                  onClick={() => setIsDialogOpen(true)}
                  className="mt-4 px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-md transition-colors shadow-sm flex items-center"
                >
                  <PlusIcon className="mr-2" />
                  添加订阅
                </button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
              {subscriptions.map((sub) => (
                <div 
                  key={sub.path} 
                  ref={draggedItem?.path === sub.path ? draggedItemRef : null}
                  className={`relative rounded-lg border ${
                    activeConfig === sub.path 
                      ? 'border-gray-200 dark:border-gray-700 bg-white dark:bg-[#222222] border-l-4 border-l-blue-500 dark:border-l-blue-400' 
                      : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-[#222222]'
                  } p-4 shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all duration-300 flex flex-col h-[220px] group 
                    ${draggedItem?.path === sub.path ? 'opacity-70 scale-[1.02] shadow-lg border-blue-400 dark:border-blue-400' : 'opacity-100'}
                    ${dragOverItem?.path === sub.path ? 'border-dashed border-blue-500 dark:border-blue-400 translate-y-1 shadow-md' : ''}
                    ${isDraggingCard && draggedItem?.path !== sub.path && dragOverItem?.path !== sub.path ? 'opacity-90' : ''}
                    ${activeConfig !== sub.path ? 'hover:bg-blue-50/50 dark:hover:bg-blue-900/5' : ''}
                    hover:border-blue-300 dark:hover:border-blue-600 cursor-grab active:cursor-grabbing`}
                  onClick={(e) => {
                    // 只有点击卡片本身或者内容区域时才激活配置
                    // 不要在拖拽过程中触发点击事件
                    if (!isDraggingCard && activeConfig !== sub.path && !switchingConfig) {
                      e.stopPropagation();
                      switchConfig(sub.path);
                    }
                  }}
                  draggable="true"
                  onDragStart={(e) => handleCardDragStart(e, sub)}
                  onDragEnd={handleCardDragEnd}
                  onDragOver={(e) => { e.preventDefault(); handleCardDragOver(e, sub); }}
                  onDrop={(e) => { e.stopPropagation(); handleCardDrop(e, sub); }}
                >
                  {/* 活跃标志 - 更简洁的设计 */}
                  {activeConfig === sub.path && (
                    <div className="absolute -top-2 -right-2 bg-blue-500 text-white p-1 rounded-full shadow-sm">
                      <CheckIcon className="w-3 h-3" />
                    </div>
                  )}
                  
                  {/* 操作按钮 - 正常状态半透明，悬浮时完全显示 */}
                  <div className="absolute top-3 right-3 flex gap-0 opacity-70 group-hover:opacity-100 transition-opacity">
                    {/* 打开文件按钮 */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation(); // 阻止事件冒泡，避免触发卡片点击
                        openConfigFile(sub.path);
                      }}
                      className="text-green-600 hover:text-green-800 dark:text-green-400 dark:hover:text-green-300 p-0.5 rounded-full hover:bg-green-100 dark:hover:bg-green-900/30 transition-colors"
                      title="打开文件"
                    >
                      <ExternalLinkIcon className="w-4 h-4" />
                    </button>
                    
                    {/* 打开目录按钮 */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation(); // 阻止事件冒泡，避免触发卡片点击
                        openConfigFolder(sub.path);
                      }}
                      className="text-amber-600 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-300 p-0.5 rounded-full hover:bg-amber-100 dark:hover:bg-amber-900/30 transition-colors"
                      title="打开目录"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                      </svg>
                    </button>
                    
                    {/* 刷新按钮 */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation(); // 阻止事件冒泡，避免触发卡片点击
                        refreshSubscription(sub.path);
                      }}
                      className="text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 p-0.5 rounded-full hover:bg-blue-100 dark:hover:bg-blue-900/30 transition-colors"
                      title="更新订阅"
                      disabled={updatingSubPath === sub.path}
                    >
                      {updatingSubPath === sub.path ? (
                        <ReloadIcon className="w-4 h-4 animate-spin" />
                      ) : (
                        <ReloadIcon className="w-4 h-4" />
                      )}
                    </button>
                    
                    {/* 删除按钮 */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation(); // 阻止事件冒泡，避免触发卡片点击
                        deleteSubscription(sub.path);
                      }}
                      className="text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300 p-0.5 rounded-full hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors"
                      title="删除订阅"
                      disabled={activeConfig === sub.path} // 不允许删除当前活跃的配置
                    >
                      <TrashIcon className="w-4 h-4" />
                    </button>
                  </div>
                  
                  {/* 订阅标题 - 移除左侧内边距 */}
                  <div className="border-b border-gray-100 dark:border-gray-800 pb-2 mb-3">
                    <h3 className="font-medium text-gray-800 dark:text-white text-base pr-14 truncate flex items-center">
                      {sub.name}
                      {activeConfig === sub.path ? (
                        <span className="ml-1.5 py-0.5 px-1.5 text-[9px] bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 rounded font-normal">
                          当前
                        </span>
                      ) : (
                        <span className="ml-1.5 py-0.5 px-1.5 text-[9px] bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 rounded font-normal opacity-0 group-hover:opacity-100 transition-opacity">
                          点击激活
                        </span>
                      )}
                    </h3>
                  </div>
                  
                  {/* 显示正在切换状态的加载指示器 */}
                  {switchingConfig === sub.path && (
                    <div className="absolute inset-0 flex items-center justify-center bg-white/80 dark:bg-gray-900/80 rounded-lg z-10">
                      <div className="flex flex-col items-center">
                        <ReloadIcon className="w-8 h-8 animate-spin text-blue-500 mb-2" />
                        <span className="text-sm text-gray-600 dark:text-gray-300">正在激活配置...</span>
                      </div>
                    </div>
                  )}
                  
                  {/* 内容区域 - 占用主要空间 */}
                  <div className="flex-grow">
                    {/* 订阅流量信息 */}
                    {(sub.usedTraffic || sub.remainingTraffic || sub.expiryDate) ? (
                      <div className="bg-gray-50 dark:bg-gray-800/30 rounded-md p-3 text-xs h-full flex flex-col justify-between group-hover:bg-blue-50 dark:group-hover:bg-blue-900/10 transition-colors">
                        <div className="flex flex-col space-y-4">
                          {/* 流量信息区域 */}
                          {(sub.usedTraffic || sub.remainingTraffic) && (
                            <div className="space-y-2.5">
                              <div className="flex justify-between items-center">
                                <span className="text-gray-500 dark:text-gray-400 flex items-center">
                                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5 mr-1 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
                                  </svg>
                                  流量使用情况
                                </span>
                                <div className="flex items-center space-x-1.5">
                                  {sub.usedTraffic && (
                                    <span className={getTrafficInfo(sub).usedColorClass}>{sub.usedTraffic}</span>
                                  )}
                                  {sub.usedTraffic && sub.remainingTraffic && (
                                    <span className="text-gray-400 dark:text-gray-500">/</span>
                                  )}
                                  {sub.remainingTraffic && (
                                    <span className={getTrafficInfo(sub).remainingColorClass}>{sub.remainingTraffic}</span>
                                  )}
                                  
                                  {/* 流量百分比 */}
                                  {sub.usedTraffic && sub.remainingTraffic && (
                                    <span className={`ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full ${
                                      getTrafficInfo(sub).isLow 
                                        ? 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400'
                                        : 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                                    }`}>
                                      {Math.round(getTrafficInfo(sub).progress)}%
                                    </span>
                                  )}
                                </div>
                              </div>
                              
                              {/* 进度条 */}
                              <div className="relative w-full h-2.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                                {/* 进度条填充 */}
                                {sub.usedTraffic && sub.remainingTraffic && (
                                  <div 
                                    className={`h-full rounded-full transition-all duration-500 ease-out shadow-inner ${getTrafficInfo(sub).progressColorClass}`}
                                    style={{ 
                                      width: `${getTrafficInfo(sub).progress}%` 
                                    }}
                                    title={`已使用 ${Math.round(getTrafficInfo(sub).progress)}%`}
                                  ></div>
                                )}
                                {(!sub.remainingTraffic && sub.usedTraffic) && (
                                  <div className="h-full bg-red-500 rounded-full w-full shadow-inner"></div>
                                )}
                                {(sub.remainingTraffic && !sub.usedTraffic) && (
                                  <div className="h-full bg-blue-500 rounded-full w-full shadow-inner"></div>
                                )}
                                
                                {/* 流量警告提示 */}
                                {getTrafficInfo(sub).isLow && (
                                  <div className="absolute right-0 top-0 transform translate-x-1/2 -translate-y-1/2">
                                    <div className="bg-red-100 dark:bg-red-900/50 text-red-600 dark:text-red-400 text-[9px] px-1.5 py-0.5 rounded-full whitespace-nowrap shadow-sm">
                                      流量不足
                                    </div>
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                          
                          {/* 到期时间 */}
                          {sub.expiryDate && (
                            <div className="flex justify-between items-center">
                              <span className="text-gray-500 dark:text-gray-400 flex items-center">
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5 mr-1 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                                </svg>
                                到期时间
                              </span>
                              <span className={`font-medium ${isExpiringSoon(sub.expiryDate) ? 'text-amber-500 dark:text-amber-400' : 'text-gray-700 dark:text-gray-200'}`}>
                                {sub.expiryDate}
                                {isExpiringSoon(sub.expiryDate) && (
                                  <span className="ml-1.5 py-0.5 px-1.5 text-[9px] bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 rounded-full">
                                    即将到期
                                  </span>
                                )}
                              </span>
                            </div>
                          )}
                        </div>
                        
                        {/* 最后更新时间 */}
                        {sub.lastUpdated && (
                          <div className="flex justify-between items-center text-[10px] text-gray-400 dark:text-gray-500 pt-1.5 mt-2 border-t border-gray-200 dark:border-gray-700">
                            <span className="flex items-center">
                              <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                              </svg>
                              最后更新
                            </span>
                            <span>{sub.lastUpdated}</span>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="bg-gray-50 dark:bg-gray-800/30 rounded-md p-3 text-xs h-full flex flex-col justify-between group-hover:bg-blue-50 dark:group-hover:bg-blue-900/10 transition-colors">
                        <div className="mb-2">
                          <p className="text-gray-500 dark:text-gray-400 text-center py-2 flex items-center justify-center">
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-1.5 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                            暂无订阅信息
                          </p>
                          <p className="text-xs text-gray-500 dark:text-gray-400 break-all line-clamp-3 mt-1 px-1" title={sub.path}>
                            {sub.path}
                          </p>
                        </div>
                        <div className="flex items-center justify-center my-2 text-amber-500 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 py-1.5 px-2 rounded-md">
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                          <span>点击更新按钮获取订阅信息</span>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        
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
      
      {/* 拖拽中的全局指示 */}
      {isDraggingCard && (
        <div className="fixed bottom-4 left-1/2 transform -translate-x-1/2 bg-blue-500 text-white py-2 px-4 rounded-md shadow-lg z-50 flex items-center">
          <DragHandleDots2Icon className="mr-2 h-4 w-4" />
          <span>拖动卡片到目标位置</span>
        </div>
      )}
    </div>
  );
} 