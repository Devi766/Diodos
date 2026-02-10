'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Layout from '@/components/Layout';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { NetworkIcon, Gauge, Upload, Download, Radio, Globe, Clock, Activity, AlertCircle, Terminal, Share, Play, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog';
import SpeedtestShare from '../components/SpeedtestShare';
import MediaStreamingTest from '../components/MediaStreamingTest';
import LoopbackManager from '@/components/LoopbackManager';
import { useTranslation } from 'react-i18next';

export default function ToolsPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const [speedtestDialogOpen, setSpeedtestDialogOpen] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [mediaTestDialogOpen, setMediaTestDialogOpen] = useState(false);
  const [loopbackDialogOpen, setLoopbackDialogOpen] = useState(false);
  const [isMacOS, setIsMacOS] = useState(false);

  const [speedtestRunning, setSpeedtestRunning] = useState(false);
  const [speedtestResult, setSpeedtestResult] = useState<null | {
    downloadSpeed: number;
    uploadSpeed: number;
    ping: number;
    jitter: number;
    server: string;
    location: string;
    progress: number;
  }>(null);
  const [speedtestError, setSpeedtestError] = useState<string | null>(null);
  const [speedtestLogs, setSpeedtestLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [currentNode, setCurrentNode] = useState('未知节点');
  
  // 用于动画效果
  const [animateDownload, setAnimateDownload] = useState(false);
  const [animateUpload, setAnimateUpload] = useState(false);
  const [currentTestPhase, setCurrentTestPhase] = useState<'idle' | 'preparing' | 'ping' | 'download' | 'upload'>('idle');

  // 保存解除事件监听函数的引用
  const unsubscribeRef = useRef<(() => void) | null>(null);

  // 获取当前节点信息的增强版函数
  const fetchCurrentNode = async () => {
    if (!window.electronAPI) return;
    
    try {
      // 尝试直接使用electronAPI获取当前节点信息
      try {
        const connectionsInfo = await window.electronAPI.fetchConnectionsInfo();
        if (connectionsInfo && connectionsInfo.currentNode) {
          // currentNode已经是节点名称而不是策略组名称
          setCurrentNode(connectionsInfo.currentNode);
          console.log('通过connectionsInfo获取到节点名称:', connectionsInfo.currentNode);
          return;
        }
      } catch (error) {
        console.error('通过connections获取节点信息失败:', error);
      }
      
      // 尝试获取当前活跃的API配置并直接访问PROXY组
      try {
        const apiConfig = await window.electronAPI.getApiConfig();
        if (apiConfig && apiConfig.success) {
          // 尝试直接请求PROXY组信息
          const response = await window.electronAPI.requestMihomoAPI('/proxies/PROXY');
          if (response && response.ok && response.data) {
            // now字段是当前PROXY组选择的节点名称
            if (response.data.now) {
              setCurrentNode(response.data.now);
              console.log('通过PROXY组获取到节点名称:', response.data.now);
              return;
            }
          }
        }
      } catch (error) {
        console.error('请求PROXY组信息失败:', error);
      }
      
      // 尝试获取所有代理组，并找出第一个策略组中选择的节点
      try {
        const configOrder = await window.electronAPI.getConfigOrder();
        if (configOrder && configOrder.success && configOrder.data && 
            configOrder.data.proxyGroups && configOrder.data.proxyGroups.length > 0) {
          // 获取第一个代理组的名称
          const visibleGroups = configOrder.data.proxyGroups.filter((g: any) => g?.hidden !== true);
          const firstGroupName = visibleGroups[0]?.name;
          if (firstGroupName) {
            console.log('获取到第一个代理组名称:', firstGroupName);
            
            // 请求该代理组的信息
            const groupResponse = await window.electronAPI.requestMihomoAPI(`/proxies/${encodeURIComponent(firstGroupName)}`);
            if (groupResponse && groupResponse.ok && groupResponse.data && groupResponse.data.now) {
              // now字段是该组选择的节点名称
              setCurrentNode(groupResponse.data.now);
              console.log(`通过${firstGroupName}组获取到节点名称:`, groupResponse.data.now);
              return;
            }
          }
        }
      } catch (error) {
        console.error('请求特定代理组信息失败:', error);
      }
      
      // 获取所有代理信息作为后备方案
      try {
        const proxiesResponse = await window.electronAPI.requestMihomoAPI('/proxies');
        if (proxiesResponse && proxiesResponse.ok && proxiesResponse.data) {
          // 查找PROXY组使用的节点
          if (proxiesResponse.data.proxies && proxiesResponse.data.proxies.PROXY && proxiesResponse.data.proxies.PROXY.now) {
            const nodeName = proxiesResponse.data.proxies.PROXY.now;
            setCurrentNode(nodeName);
            console.log('通过所有代理信息获取到PROXY组节点名称:', nodeName);
            return;
          }
          
          // 如果没有PROXY组，查找第一个类型为Selector的代理组选择的节点
          const proxyGroups = Object.entries(proxiesResponse.data.proxies || {})
            .filter(([_, proxy]) => proxy && typeof proxy === 'object' && (proxy as any).type === 'Selector');
          
          if (proxyGroups.length > 0) {
            const [groupName, groupInfo] = proxyGroups[0];
            const nodeName = (groupInfo as any).now;
            if (nodeName) {
              setCurrentNode(nodeName);
              console.log(`通过所有代理信息获取到${groupName}组节点名称:`, nodeName);
              return;
            }
          }
        }
      } catch (error) {
        console.error('获取所有代理信息失败:', error);
      }
      
      // 尝试使用get-proxies API作为最后的后备方案
      try {
        const proxies = await window.electronAPI.getProxies();
        if (proxies && proxies.proxies) {
          // 查找PROXY组
          if (proxies.proxies.PROXY && proxies.proxies.PROXY.now) {
            const nodeName = proxies.proxies.PROXY.now;
            setCurrentNode(nodeName);
            console.log('通过getProxies获取到PROXY组节点名称:', nodeName);
            return;
          }
          
          // 尝试找到任意一个Selector类型的代理组
          for (const [groupName, proxy] of Object.entries(proxies.proxies)) {
            if ((proxy as any).type === 'Selector' && (proxy as any).now) {
              const nodeName = (proxy as any).now;
              setCurrentNode(nodeName);
              console.log(`通过getProxies获取到${groupName}组节点名称:`, nodeName);
              return;
            }
          }
        }
      } catch (error) {
        console.error('通过getProxies获取节点信息失败:', error);
      }
      
    } catch (error) {
      console.error("获取节点信息失败:", error);
    }
  };

  // 在组件加载时获取当前节点信息和检测平台
  useEffect(() => {
    fetchCurrentNode();

    // 检测平台
    if (typeof navigator !== 'undefined') {
      const platform = navigator.platform.toLowerCase();
      setIsMacOS(platform.includes('mac'));
    }
  }, []);

  // 在组件卸载时移除事件监听
  useEffect(() => {
    return () => {
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (speedtestResult) {
      if (speedtestResult.progress > 20 && speedtestResult.progress <= 60) {
        setCurrentTestPhase('download');
        setAnimateDownload(true);
      } else if (speedtestResult.progress > 60) {
        setCurrentTestPhase('upload');
        setAnimateUpload(true);
      } else if (speedtestResult.progress <= 20) {
        setCurrentTestPhase('ping');
      }
    } else {
      setCurrentTestPhase('idle');
      setAnimateDownload(false);
      setAnimateUpload(false);
    }
  }, [speedtestResult]);

  // 新增一个effect用于监听测速完成状态
  useEffect(() => {
    // 如果测速已经结束，确保所有动画都停止
    if (!speedtestRunning && speedtestResult) {
      setAnimateDownload(false);
      setAnimateUpload(false);
    }
  }, [speedtestRunning, speedtestResult]);

  const openLoopbackManager = () => {
    setLoopbackDialogOpen(true);
  };

  const openSpeedtestDialog = () => {
    setSpeedtestDialogOpen(true);
    setSpeedtestResult(null);
    setSpeedtestRunning(false);
    setSpeedtestError(null);
    setSpeedtestLogs([]);
    setShowLogs(false);
  };

  const openShareDialog = () => {
    if (!speedtestResult) {
      toast.error(t('tools.speedtest.completeFirst'));
      return;
    }
    setShareDialogOpen(true);
  };

  const openMediaTestDialog = () => {
    setMediaTestDialogOpen(true);
  };

  const runSpeedtest = async () => {
    if (!window.electronAPI) {
      toast.error(t('tools.enableLoopback.noAccess'));
      return;
    }

    try {
      // 清除之前的错误和结果
      setSpeedtestError(null);
      setSpeedtestRunning(true);
      setCurrentTestPhase('preparing');
      setSpeedtestLogs([]);
      
      // 初始化测速结果对象
      setSpeedtestResult({
        downloadSpeed: 0,
        uploadSpeed: 0,
        ping: 0,
        jitter: 0,
        server: '',
        location: '',
        progress: 5  // 开始于5%
      });

      // 显示启动测速的提示
      toast.info(t('tools.speedtest.starting'));

      // 取消之前的订阅
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
      }

      // 订阅speedtest输出事件
      const unsubscribe = window.electronAPI.onSpeedtestOutput((data) => {
        console.log('收到speedtest输出:', data);

        // 添加到日志
        if (data.message) {
          setSpeedtestLogs(prev => [...prev, data.message as string]);
        }

        // 根据输出类型处理数据
        if (data.type === 'status') {
          if (data.phase === 'start') {
            setCurrentTestPhase('preparing');
          } else if (data.phase === 'complete') {
            // 测速完成 - 停止所有动画
            toast.success(t('tools.speedtest.completed'));
            setSpeedtestRunning(false);
            setAnimateDownload(false);
            setAnimateUpload(false);
            // 确保进度条显示100%
            setSpeedtestResult(prev => {
              if (!prev) return null;
              return { ...prev, progress: 100 };
            });
          } else if (data.phase === 'error') {
            // 发生错误 - 停止所有动画
            setSpeedtestError(data.message || t('tools.speedtest.error'));
            toast.error(t('tools.speedtest.testError', { error: data.message || t('tools.speedtest.unknownError') }));
            setSpeedtestRunning(false);
            setAnimateDownload(false);
            setAnimateUpload(false);
          }
        } else if (data.type === 'progress') {
          // 更新进度信息
          if (data.phase === 'ping') {
            setCurrentTestPhase('ping');
            setAnimateDownload(false);
            setAnimateUpload(false);
            
            // 更新结果对象
            setSpeedtestResult(prev => {
              if (!prev) return null;
              
              const updatedResult = { ...prev };
              
              // 更新ping值
              if (data.ping !== undefined) {
                updatedResult.ping = data.ping || 0;
              }
              
              // 更新jitter值
              if (data.jitter !== undefined) {
                updatedResult.jitter = data.jitter || 0;
              }
              
              // 更新进度
              if (data.progress !== undefined) {
                updatedResult.progress = data.progress || prev.progress;
              }
              
              return updatedResult;
            });
          } else if (data.phase === 'download') {
            setCurrentTestPhase('download');
            setAnimateDownload(true);
            setAnimateUpload(false);
            
            // 更新结果对象
            setSpeedtestResult(prev => {
              if (!prev) return null;
              
              const updatedResult = { ...prev };
              
              // 更新下载速度
              if (data.downloadSpeed !== undefined) {
                updatedResult.downloadSpeed = data.downloadSpeed || 0;
              }
              
              // 更新进度
              if (data.progress !== undefined) {
                updatedResult.progress = data.progress || prev.progress;
              }
              
              return updatedResult;
            });
          } else if (data.phase === 'upload') {
            setCurrentTestPhase('upload');
            setAnimateDownload(false);
            setAnimateUpload(true);
            
            // 更新结果对象
            setSpeedtestResult(prev => {
              if (!prev) return null;
              
              const updatedResult = { ...prev };
              
              // 更新上传速度
              if (data.uploadSpeed !== undefined) {
                updatedResult.uploadSpeed = data.uploadSpeed || 0;
              }
              
              // 更新进度
              if (data.progress !== undefined) {
                updatedResult.progress = data.progress || prev.progress;
              }
              
              return updatedResult;
            });
          }
        } else if (data.type === 'stderr' && data.message) {
          // 记录错误输出
          console.error('Speedtest错误输出:', data.message);
        }
      });
      
      // 保存解除订阅函数
      unsubscribeRef.current = unsubscribe;
      
      // 执行直接测速命令
      console.log('调用直接测速...');
      const result = await window.electronAPI.runSpeedtestDirect();
      console.log('测速最终结果:', result);
      
      if (result.success && result.data) {
        // 更新最终结果(主要是服务器信息)
        setSpeedtestResult(prev => {
          if (!prev) return {
            downloadSpeed: result.data?.download || 0,
            uploadSpeed: result.data?.upload || 0,
            ping: result.data?.ping || 0,
            jitter: result.data?.jitter || 0,
            server: result.data?.server?.host || '',
            location: `${result.data?.server?.name || ''}, ${result.data?.server?.country || ''}`,
            progress: 100
          };
          
          return {
            ...prev,
            downloadSpeed: result.data?.download || prev.downloadSpeed,
            uploadSpeed: result.data?.upload || prev.uploadSpeed,
            ping: result.data?.ping || prev.ping,
            jitter: result.data?.jitter || prev.jitter,
            server: result.data?.server?.host || '',
            location: `${result.data?.server?.name || ''}, ${result.data?.server?.country || ''}`,
            progress: 100
          };
        });
        
        // 确保测速完成后停止所有动画
        setSpeedtestRunning(false);
        setAnimateDownload(false);
        setAnimateUpload(false);
        // 测速完成后将测试阶段重置为idle
        setCurrentTestPhase('idle');
      } else if (!result.success) {
        // 如果没有在事件中捕获到错误，则显示错误信息
        const errorMsg = result.error || t('tools.speedtest.unknownError');
        if (!speedtestError) {
          setSpeedtestError(errorMsg);
          toast.error(t('tools.speedtest.testError', { error: errorMsg }));
        }

        // 确保测速失败后停止所有动画
        setSpeedtestRunning(false);
        setAnimateDownload(false);
        setAnimateUpload(false);
        setCurrentTestPhase('idle');
      }
    } catch (error) {
      console.error('测速出错:', error);
      toast.error(t('tools.speedtest.executeError'));
      setSpeedtestError(t('tools.speedtest.checkConsole'));
    } finally {
      setSpeedtestRunning(false);
    }
  };

  return (
    <Layout>
      <div className="space-y-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-foreground">{t('tools.title')}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t('tools.subtitle')}</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-2 gap-6">
          {/* UWP 回环豁免管理 - 仅在 Windows 上显示 */}
          {!isMacOS && (
            <Card className="overflow-hidden hover:shadow-sm transition-shadow">
              <CardHeader className="pb-6">
                <div className="flex items-center space-x-3 mb-2">
                  <NetworkIcon className="w-5 h-5 text-gray-600 dark:text-gray-300" />
                  <CardTitle>{t('tools.loopback.title')}</CardTitle>
                </div>
                <CardDescription className="text-gray-500 dark:text-gray-400">
                  {t('tools.loopback.description')}
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-0">
                <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                  {t('tools.loopback.detail')}
                </p>
                <Button
                  onClick={openLoopbackManager}
                  className="w-full bg-blue-500 hover:bg-blue-600 text-white"
                  variant="default"
                >
                  {t('tools.loopback.open')}
                </Button>
              </CardContent>
            </Card>
          )}

          {/* 网络测速工具 - 仅在 Windows 上显示 */}
          {!isMacOS && (
            <Card className="overflow-hidden hover:shadow-sm transition-shadow">
              <CardHeader className="pb-6">
                <div className="flex items-center space-x-3 mb-2">
                  <Gauge className="w-5 h-5 text-gray-600 dark:text-gray-300" />
                  <CardTitle>{t('tools.speedtest.title')}</CardTitle>
                </div>
                <CardDescription className="text-gray-500 dark:text-gray-400">
                  {t('tools.speedtest.description')}
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-0">
                <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                  {t('tools.speedtest.detail')}
                </p>
                <Button
                  onClick={openSpeedtestDialog}
                  className="w-full bg-blue-500 hover:bg-blue-600 text-white"
                  variant="default"
                >
                  {t('tools.speedtest.start')}
                </Button>
              </CardContent>
            </Card>
          )}

          <Card className="overflow-hidden hover:shadow-sm transition-shadow">
            <CardHeader className="pb-6">
              <div className="flex items-center space-x-3 mb-2">
                <Play className="w-5 h-5 text-gray-600 dark:text-gray-300" />
                <CardTitle>{t('tools.mediaTest.title')}</CardTitle>
              </div>
              <CardDescription className="text-gray-500 dark:text-gray-400">
                {t('tools.mediaTest.description')}
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                {t('tools.mediaTest.detail')}
              </p>
              <Button
                onClick={openMediaTestDialog}
                className="w-full bg-blue-500 hover:bg-blue-600 text-white"
                variant="default"
              >
                {t('tools.mediaTest.start')}
              </Button>
            </CardContent>
          </Card>

          {/* 订阅转换器 */}
          <Card className="overflow-hidden hover:shadow-sm transition-shadow">
            <CardHeader className="pb-6">
              <div className="flex items-center space-x-3 mb-2">
                <RefreshCw className="w-5 h-5 text-gray-600 dark:text-gray-300" />
                <CardTitle>{t('converter.title')}</CardTitle>
              </div>
              <CardDescription className="text-gray-500 dark:text-gray-400">
                {t('converter.subtitle')}
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                支持 Clash、Clash Meta、Sing-box 等多种格式的订阅转换
              </p>
              <Button
                onClick={() => router.push('/converter')}
                className="w-full bg-blue-500 hover:bg-blue-600 text-white"
                variant="default"
              >
                打开转换器
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Speedtest 对话框 */}
      <Dialog open={speedtestDialogOpen} onOpenChange={setSpeedtestDialogOpen}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Gauge className="w-5 h-5" /> {t('tools.speedtest.dialogTitle')}
            </DialogTitle>
            <DialogDescription>
              {t('tools.speedtest.dialogDescription')}
            </DialogDescription>
          </DialogHeader>

          <div className="py-4">
            {!speedtestRunning && !speedtestResult && !speedtestError && (
              <div className="space-y-4">
                <p className="text-center text-gray-600 dark:text-gray-400">
                  {t('tools.speedtest.clickToStart')}
                </p>
                <div className="flex justify-center my-8">
                  <Gauge className="w-20 h-20 text-blue-500 opacity-20" />
                </div>
                <Button
                  onClick={runSpeedtest}
                  className="w-full bg-blue-500 hover:bg-blue-600 text-white"
                  variant="default"
                >
                  {t('tools.speedtest.start')}
                </Button>
              </div>
            )}

            {/* 错误信息显示 */}
            {speedtestError && !speedtestRunning && (
              <div className="space-y-4">
                <div className="bg-red-50 dark:bg-red-900/20 p-4 rounded-md border border-red-200 dark:border-red-800">
                  <div className="flex items-start">
                    <AlertCircle className="w-5 h-5 text-red-500 mt-0.5 mr-2 flex-shrink-0" />
                    <div>
                      <h4 className="font-medium text-red-800 dark:text-red-300">{t('tools.speedtest.failed')}</h4>
                      <p className="text-sm text-red-700 dark:text-red-400 mt-1">{speedtestError}</p>
                    </div>
                  </div>
                </div>

                <p className="text-sm text-gray-600 dark:text-gray-400">
                  {t('tools.speedtest.errorDetail')}
                </p>

                <Button
                  onClick={runSpeedtest}
                  className="w-full bg-blue-500 hover:bg-blue-600 text-white mt-4"
                  variant="default"
                >
                  {t('tools.speedtest.retry')}
                </Button>
              </div>
            )}

            {(speedtestRunning || speedtestResult) && (
              <div className="space-y-4">
                {speedtestRunning && (
                  <>
                    <div className="flex justify-between items-center mb-1">
                      <span className="text-sm font-medium flex items-center">
                        <Activity className="w-4 h-4 mr-1 text-blue-500 animate-pulse" />
                        {currentTestPhase === 'preparing' && t('tools.speedtest.preparing')}
                        {currentTestPhase === 'ping' && t('tools.speedtest.testingPing')}
                        {currentTestPhase === 'download' && t('tools.speedtest.testingDownload')}
                        {currentTestPhase === 'upload' && t('tools.speedtest.testingUpload')}
                      </span>
                      <span className="text-sm font-medium">{speedtestResult?.progress || 0}%</span>
                    </div>
                    <Progress 
                      value={speedtestResult?.progress || 0} 
                      className="h-2 mb-4"
                      indicatorColor={
                        currentTestPhase === 'preparing' ? 'blue' :
                        currentTestPhase === 'ping' ? 'purple' :
                        currentTestPhase === 'download' ? 'blue' :
                        currentTestPhase === 'upload' ? 'green' : 'blue'
                      }
                    />
                  </>
                )}

                <div className="grid grid-cols-2 gap-4 mb-4">
                  <div 
                    className={cn(
                      "flex flex-col items-center p-3 bg-gray-50 dark:bg-gray-900 rounded-md transition-all duration-500",
                      animateDownload && speedtestRunning && "bg-blue-50 dark:bg-blue-900/30 scale-105",
                      currentTestPhase === 'download' && speedtestRunning && "ring-2 ring-blue-300 dark:ring-blue-700"
                    )}
                  >
                    <Download className={cn(
                      "w-5 h-5 text-blue-500 mb-1",
                      currentTestPhase === 'download' && speedtestRunning && "animate-bounce"
                    )} />
                    <span className="text-xs text-gray-500 dark:text-gray-400">{t('tools.speedtest.downloadSpeed')}</span>
                    <span className={cn(
                      "text-lg font-bold transition-all duration-500",
                      animateDownload && speedtestRunning && "text-blue-600 dark:text-blue-400"
                    )}>
                      {speedtestResult?.downloadSpeed || 0} Mbps
                    </span>
                  </div>
                  <div
                    className={cn(
                      "flex flex-col items-center p-3 bg-gray-50 dark:bg-gray-900 rounded-md transition-all duration-500",
                      animateUpload && speedtestRunning && "bg-green-50 dark:bg-green-900/30 scale-105",
                      currentTestPhase === 'upload' && speedtestRunning && "ring-2 ring-green-300 dark:ring-green-700"
                    )}
                  >
                    <Upload className={cn(
                      "w-5 h-5 text-green-500 mb-1",
                      currentTestPhase === 'upload' && speedtestRunning && "animate-bounce"
                    )} />
                    <span className="text-xs text-gray-500 dark:text-gray-400">{t('tools.speedtest.uploadSpeed')}</span>
                    <span className={cn(
                      "text-lg font-bold transition-all duration-500",
                      animateUpload && speedtestRunning && "text-green-600 dark:text-green-400"
                    )}>
                      {speedtestResult?.uploadSpeed || 0} Mbps
                    </span>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4 mb-4">
                  <div
                    className={cn(
                      "flex flex-col items-center p-3 bg-gray-50 dark:bg-gray-900 rounded-md transition-all duration-500",
                      currentTestPhase === 'ping' && speedtestRunning && "ring-2 ring-purple-300 dark:ring-purple-700 bg-purple-50 dark:bg-purple-900/30 scale-105"
                    )}
                  >
                    <Clock className={cn(
                      "w-5 h-5 text-purple-500 mb-1",
                      currentTestPhase === 'ping' && speedtestRunning && "animate-pulse"
                    )} />
                    <span className="text-xs text-gray-500 dark:text-gray-400">{t('tools.speedtest.ping')}</span>
                    <span className={cn(
                      "text-lg font-bold",
                      currentTestPhase === 'ping' && speedtestRunning && "text-purple-600 dark:text-purple-400"
                    )}>
                      {speedtestResult?.ping || 0} ms
                    </span>
                  </div>
                  <div className="flex flex-col items-center p-3 bg-gray-50 dark:bg-gray-900 rounded-md transition-all duration-500">
                    <Radio className="w-5 h-5 text-purple-500 mb-1" />
                    <span className="text-xs text-gray-500 dark:text-gray-400">{t('tools.speedtest.jitter')}</span>
                    <span className={cn(
                      "text-lg font-bold",
                      currentTestPhase === 'ping' && speedtestRunning && "text-purple-600 dark:text-purple-400"
                    )}>
                      {speedtestResult?.jitter || 0} ms
                    </span>
                  </div>
                </div>

                {speedtestResult?.server && (
                  <div className="flex items-center p-3 bg-gray-50 dark:bg-gray-900 rounded-md">
                    <Globe className="w-5 h-5 text-gray-500 mr-2 flex-shrink-0" />
                    <div>
                      <span className="text-xs text-gray-500 dark:text-gray-400 block">{t('tools.speedtest.server')}</span>
                      <span className="text-sm font-medium break-all">{speedtestResult.location || 'Unknown'}</span>
                    </div>
                  </div>
                )}

                {/* 日志输出 */}
                <div className="mt-4">
                  <button
                    onClick={() => setShowLogs(!showLogs)}
                    className="flex items-center text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
                  >
                    <Terminal className="w-4 h-4 mr-1" />
                    {showLogs ? t('tools.speedtest.hideLogs') : t('tools.speedtest.showLogs')}
                  </button>

                  {showLogs && speedtestLogs.length > 0 && (
                    <div className="mt-2 bg-gray-100 dark:bg-gray-800 p-3 rounded-md text-xs font-mono h-48 overflow-y-auto">
                      {speedtestLogs.map((log, index) => (
                        <div key={index} className="text-gray-700 dark:text-gray-300">{log}</div>
                      ))}
                    </div>
                  )}
                </div>

                {!speedtestRunning && speedtestResult && (
                  <DialogFooter className="gap-2 flex-wrap sm:flex-nowrap">
                    <Button
                      onClick={runSpeedtest}
                      className="bg-blue-500 hover:bg-blue-600 text-white"
                      variant="default"
                    >
                      {t('tools.speedtest.retest')}
                    </Button>

                    <Button
                      onClick={openShareDialog}
                      className="bg-green-500 hover:bg-green-600 text-white"
                      variant="default"
                    >
                      <Share className="mr-2 h-4 w-4" />
                      {t('tools.speedtest.share')}
                    </Button>
                  </DialogFooter>
                )}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
      
      {/* 分享结果对话框 */}
      <Dialog open={shareDialogOpen} onOpenChange={setShareDialogOpen}>
        <DialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Share className="w-5 h-5" /> {t('tools.shareDialog.title')}
            </DialogTitle>
            <DialogDescription>
              {t('tools.shareDialog.description')}
            </DialogDescription>
          </DialogHeader>

          <div className="py-4">
            {speedtestResult && (
              <SpeedtestShare
                downloadSpeed={speedtestResult.downloadSpeed}
                uploadSpeed={speedtestResult.uploadSpeed}
                ping={speedtestResult.ping}
                jitter={speedtestResult.jitter}
                location={speedtestResult.location}
                server={speedtestResult.server}
                nodeName={currentNode}
                logo="/logo.png"
              />
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* 媒体服务检测对话框 */}
      <Dialog open={mediaTestDialogOpen} onOpenChange={setMediaTestDialogOpen}>
        <DialogContent className="sm:max-w-[700px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Play className="w-5 h-5" /> {t('tools.mediaTest.dialogTitle')}
            </DialogTitle>
            <DialogDescription>
              {t('tools.mediaTest.dialogDescription')}
            </DialogDescription>
          </DialogHeader>

          <div className="py-4">
            <MediaStreamingTest currentNode={currentNode} />
          </div>
        </DialogContent>
      </Dialog>

      {/* UWP 回环豁免管理对话框 */}
      <Dialog open={loopbackDialogOpen} onOpenChange={setLoopbackDialogOpen}>
        <DialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <NetworkIcon className="w-5 h-5" /> {t('tools.loopback.dialogTitle')}
            </DialogTitle>
            <DialogDescription>
              {t('tools.loopback.dialogDescription')}
            </DialogDescription>
          </DialogHeader>

          <div className="py-2">
            <LoopbackManager />
          </div>
        </DialogContent>
      </Dialog>

    </Layout>
  );
}
