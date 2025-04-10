import React, { useState, useEffect } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Toast from '@radix-ui/react-toast';
import { Cross2Icon, PlusIcon, TrashIcon, GlobeIcon, Pencil1Icon, ReloadIcon, ExternalLinkIcon } from '@radix-ui/react-icons';
import axios from 'axios';

type Subscription = {
  name: string;
  path: string;
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

  return (
    <div className="p-6">
      <Toast.Provider swipeDirection="right">
        <h1 className="text-2xl font-bold mb-6 text-transparent bg-clip-text bg-gradient-to-r from-blue-500 to-indigo-600 dark:from-blue-400 dark:to-indigo-500">订阅管理</h1>
        
        <div className="bg-white dark:bg-[#2a2a2a] rounded-lg shadow-sm p-6">
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-lg font-semibold text-gray-800 dark:text-white">我的订阅</h2>
            
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
          
          {subscriptions.length === 0 ? (
            <div className="text-center py-12 text-gray-500 dark:text-gray-400">
              <p>还没有添加任何订阅</p>
              <p className="mt-2 text-sm">点击"添加订阅"按钮开始使用</p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-md border border-gray-200 dark:border-gray-700">
              <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                <thead className="bg-gray-50 dark:bg-[#2a2a2a]">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      名称
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      路径
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      操作
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white dark:bg-[#222222] divide-y divide-gray-200 dark:divide-gray-800">
                  {subscriptions.map((sub) => (
                    <tr key={sub.path}>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700 dark:text-gray-300">
                        {sub.name}
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-700 dark:text-gray-300 truncate max-w-[200px]">
                        {sub.path}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <div className="flex items-center justify-end space-x-2">
                          <button
                            onClick={() => refreshSubscription(sub.path)}
                            className="text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
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
                            onClick={() => openConfigFile(sub.path)}
                            className="text-green-600 hover:text-green-800 dark:text-green-400 dark:hover:text-green-300"
                            title="打开配置文件"
                          >
                            <ExternalLinkIcon className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => openConfigFolder(sub.path)}
                            className="text-amber-600 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-300"
                            title="打开所在目录"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                            </svg>
                          </button>
                          <button
                            onClick={() => deleteSubscription(sub.path)}
                            className="text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300"
                            title="删除订阅"
                          >
                            <TrashIcon className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
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