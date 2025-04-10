import React, { useState, useEffect, useRef, useCallback } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Toast from '@radix-ui/react-toast';
import { Cross2Icon, PlusIcon, TrashIcon, GlobeIcon, Pencil1Icon, ReloadIcon, ExternalLinkIcon, UploadIcon } from '@radix-ui/react-icons';
import axios from 'axios';

type Subscription = {
  name: string;
  path: string;
  // 可能的其他字段，如最后更新时间等
  lastUpdated?: string;
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

  useEffect(() => {
    loadSubscriptions();
  }, []);

  const loadSubscriptions = async () => {
    if (!window.electronAPI) return;
    
    try {
      const subs = await window.electronAPI.getSubscriptions();
      setSubscriptions(subs);
    } catch (error) {
      console.error('加载订阅失败:', error);
      showToast('错误', '加载订阅失败', 'error');
    }
  };

  const addSubscription = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!window.electronAPI) return;
    
    if (!subUrl.trim()) {
      showToast('错误', '请输入有效的订阅链接', 'error');
      return;
    }

    setIsLoading(true);
    
    try {
      const configData = await window.electronAPI.fetchSubscription(subUrl);
      
      if (configData) {
        const customName = subName.trim() || '';
        console.log('准备保存订阅 - URL:', subUrl);
        console.log('准备保存订阅 - 自定义名称:', customName);
        
        const filePath = await window.electronAPI.saveSubscription(subUrl, configData, customName);
        
        showToast('成功', '订阅添加成功', 'success');
        setSubUrl('');
        setSubName('');
        setIsDialogOpen(false);
        await loadSubscriptions();
      } else {
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

  // 拖放相关处理函数
  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    if (!window.electronAPI) return;

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
          file.name.replace(/\.(ya?ml)$/, '') // 使用文件名作为默认名称
        );
        
        showToast('成功', `配置文件 ${file.name} 导入成功`, 'success');
      } catch (error) {
        console.error('导入配置文件失败:', error);
        showToast('错误', `导入配置文件 ${file.name} 失败: ${error}`, 'error');
      }
    }

    // 重新加载订阅列表
    await loadSubscriptions();
  }, []);

  // 将文件读取为文本
  const readFileAsText = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => resolve(e.target?.result as string);
      reader.onerror = e => reject(e);
      reader.readAsText(file);
    });
  };

  // 处理文件选择
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    
    if (files.length === 0) return;

    if (!window.electronAPI) return;

    for (const file of files) {
      try {
        // 读取文件内容
        const content = await readFileAsText(file);
        
        // 保存为订阅
        const filePath = await window.electronAPI.saveSubscription(
          `local:${file.name}`,
          content,
          file.name.replace(/\.(ya?ml)$/, '')
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

  // 打开文件选择对话框
  const triggerFileInput = () => {
    fileInputRef.current?.click();
  };

  return (
    <div className="p-6">
      <Toast.Provider swipeDirection="right">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-2xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-blue-500 to-indigo-600 dark:from-blue-400 dark:to-indigo-500">订阅管理</h1>
          
          <div className="flex space-x-3">
            {/* 上传YAML文件按钮 */}
            <button
              className="flex items-center py-2 px-4 bg-green-500 hover:bg-green-600 text-white rounded-md transition-colors"
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
                  className="flex items-center py-2 px-4 bg-blue-500 hover:bg-blue-600 text-white rounded-md transition-colors"
                >
                  <PlusIcon className="mr-2" />
                  添加订阅
                </button>
              </Dialog.Trigger>
              
              <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 bg-black/50" />
                <Dialog.Content className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-white dark:bg-[#2a2a2a] rounded-lg p-6 w-full max-w-md">
                  <Dialog.Title className="text-lg font-bold mb-4 text-gray-800 dark:text-white">
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
                        className="py-2 px-4 bg-blue-500 hover:bg-blue-600 text-white rounded-md transition-colors flex items-center"
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
        
        {/* 拖放区域 */}
        <div 
          className={`mb-6 border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
            isDragging 
              ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20' 
              : 'border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/30'
          }`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <div className="flex flex-col items-center justify-center">
            <UploadIcon className={`w-10 h-10 mb-3 ${isDragging ? 'text-blue-500' : 'text-gray-400 dark:text-gray-500'}`} />
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
              拖放YAML配置文件到此处
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              或 <button onClick={triggerFileInput} className="text-blue-500 hover:underline">点击上传</button>
            </p>
          </div>
        </div>
        
        {/* 卡片网格 */}
        <div className="bg-white dark:bg-[#2a2a2a] rounded-lg shadow-sm p-6">
          <h2 className="text-lg font-semibold text-gray-800 dark:text-white mb-6">我的订阅</h2>
          
          {subscriptions.length === 0 ? (
            <div className="text-center py-12 text-gray-500 dark:text-gray-400">
              <p>还没有添加任何订阅</p>
              <p className="mt-2 text-sm">点击"添加订阅"按钮开始使用</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {subscriptions.map((sub) => (
                <div 
                  key={sub.path} 
                  className="relative rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-[#222222] p-4 shadow-sm hover:shadow-md transition-shadow"
                >
                  <div className="absolute top-3 right-3 flex space-x-2">
                    <button
                      onClick={() => refreshSubscription(sub.path)}
                      className="text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 p-1 rounded-full hover:bg-blue-100 dark:hover:bg-blue-900/30"
                      title="更新订阅"
                      disabled={updatingSubPath === sub.path}
                    >
                      {updatingSubPath === sub.path ? (
                        <ReloadIcon className="w-4 h-4 animate-spin" />
                      ) : (
                        <ReloadIcon className="w-4 h-4" />
                      )}
                    </button>
                    <button
                      onClick={() => deleteSubscription(sub.path)}
                      className="text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300 p-1 rounded-full hover:bg-red-100 dark:hover:bg-red-900/30"
                      title="删除订阅"
                    >
                      <TrashIcon className="w-4 h-4" />
                    </button>
                  </div>
                  
                  <h3 className="font-medium text-gray-800 dark:text-white mb-2 pr-16 truncate">{sub.name}</h3>
                  
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-3 break-all line-clamp-2" title={sub.path}>
                    {sub.path}
                  </p>
                  
                  <div className="flex space-x-2 mt-4">
                    <button
                      onClick={() => openConfigFile(sub.path)}
                      className="text-xs px-3 py-1.5 bg-green-50 text-green-600 hover:bg-green-100 dark:bg-green-900/20 dark:text-green-400 dark:hover:bg-green-900/40 rounded flex items-center justify-center flex-1 transition-colors"
                    >
                      <ExternalLinkIcon className="w-3 h-3 mr-1" />
                      打开文件
                    </button>
                    <button
                      onClick={() => openConfigFolder(sub.path)}
                      className="text-xs px-3 py-1.5 bg-amber-50 text-amber-600 hover:bg-amber-100 dark:bg-amber-900/20 dark:text-amber-400 dark:hover:bg-amber-900/40 rounded flex items-center justify-center flex-1 transition-colors"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="w-3 h-3 mr-1" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                      </svg>
                      打开目录
                    </button>
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
    </div>
  );
} 