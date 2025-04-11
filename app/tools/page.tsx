'use client';

import React, { useState, useEffect, useRef } from 'react';
import Layout from '@/components/Layout';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { NetworkIcon, Gauge, Upload, Download, Radio, Globe, Clock, Activity, AlertCircle, Terminal, Share, Play } from 'lucide-react';
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

export default function ToolsPage() {
  const [speedtestDialogOpen, setSpeedtestDialogOpen] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [mediaTestDialogOpen, setMediaTestDialogOpen] = useState(false);
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
      // 第一步：获取配置文件中的代理组信息
      let firstProxyGroup = "PROXY"; // 默认尝试PROXY组
      
      try {
        const result = await window.electronAPI.getConfigOrder();
        
        if (result.success && result.data && result.data.proxyGroups.length > 0) {
          // 获取配置文件中的第一个代理组名
          firstProxyGroup = result.data.proxyGroups[0].name;
        }
      } catch (error) {
        console.error('获取配置顺序出错:', error);
      }
      
      // 第二步：尝试请求第一个代理组的信息
      try {
        const response = await fetch(`http://127.0.0.1:9090/proxies/${firstProxyGroup}`);
        
        if (response.ok) {
          const data = await response.json();
          if (data && data.name && data.now) {
            setCurrentNode(data.now);
            return;
          }
        }
      } catch (error) {
        console.error(`请求${firstProxyGroup}组信息出错:`, error);
      }
      
      // 如果第一个组获取失败，尝试使用默认的PROXY组
      if (firstProxyGroup !== "PROXY") {
        try {
          const response = await fetch('http://127.0.0.1:9090/proxies/PROXY');
          
          if (response.ok) {
            const data = await response.json();
            if (data && data.now) {
              setCurrentNode(data.now);
              return;
            }
          }
        } catch (error) {
          console.error('请求默认PROXY组信息出错:', error);
        }
      }
      
      // 如果还是获取失败，尝试获取所有代理组信息
      try {
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
                setCurrentNode(nodeName);
                return;
              }
            }
          }
        }
      } catch (error) {
        console.error('获取所有代理组信息出错:', error);
      }
      
      // 最后尝试使用电子API获取代理信息（这将是备用方法）
      const proxies = await window.electronAPI.getProxies();
      if (proxies && proxies.proxies) {
        // 查找当前选择的全局代理
        const selectedProxy = Object.values(proxies.proxies).find(
          (proxy: any) => proxy.name === proxies.global
        );
        
        if (selectedProxy && (selectedProxy as any).name) {
          setCurrentNode((selectedProxy as any).name);
          return;
        }
      }
      
      // 如果所有尝试都失败，保持默认值
    } catch (error) {
      console.error("获取节点信息失败:", error);
    }
  };

  // 在组件加载时获取当前节点信息
  useEffect(() => {
    fetchCurrentNode();
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

  const openEnableLoopbackTool = async () => {
    try {
      if (window.electronAPI) {
        const result = await window.electronAPI.openToolsApp('EnableLoopback.exe');
        if (result.success) {
          toast.success('成功启动 EnableLoopback 工具');
        } else {
          toast.error(`启动工具失败: ${result.error}`);
        }
      } else {
        toast.error('无法访问系统功能，请在桌面应用中使用此功能');
      }
    } catch (error) {
      console.error('启动工具出错:', error);
      toast.error('启动工具时发生错误');
    }
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
      toast.error('请先完成测速才能分享结果');
      return;
    }
    setShareDialogOpen(true);
  };

  const openMediaTestDialog = () => {
    setMediaTestDialogOpen(true);
  };

  const runSpeedtest = async () => {
    if (!window.electronAPI) {
      toast.error('无法访问系统功能，请在桌面应用中使用此功能');
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
      toast.info('正在启动测速工具...');
      
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
            toast.success('测速完成');
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
            setSpeedtestError(data.message || '测速过程中出现错误');
            toast.error(`测速失败: ${data.message || '未知错误'}`);
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
        const errorMsg = result.error || '未知错误';
        if (!speedtestError) {
          setSpeedtestError(errorMsg);
          toast.error(`测速失败: ${errorMsg}`);
        }
        
        // 确保测速失败后停止所有动画
        setSpeedtestRunning(false);
        setAnimateDownload(false);
        setAnimateUpload(false);
        setCurrentTestPhase('idle');
      }
    } catch (error) {
      console.error('测速出错:', error);
      toast.error('执行测速时发生错误');
      setSpeedtestError('执行测速时发生错误，请查看控制台日志');
    } finally {
      setSpeedtestRunning(false);
    }
  };

  return (
    <Layout>
      <div className="container py-6">
        <h1 className="text-2xl font-bold mb-4 text-blue-500">实用工具</h1>
        <p className="text-gray-600 dark:text-gray-400 mb-6">
          这里提供了一些实用的系统工具，帮助你解决各种问题
        </p>
        
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-2 gap-6">
          <Card className="overflow-hidden border border-gray-200 dark:border-gray-800 hover:shadow-sm transition-shadow">
            <CardHeader className="bg-white dark:bg-gray-950 pb-6">
              <div className="flex items-center space-x-3 mb-2">
                <NetworkIcon className="w-5 h-5 text-gray-600 dark:text-gray-300" />
                <CardTitle>EnableLoopback</CardTitle>
              </div>
              <CardDescription className="text-gray-500 dark:text-gray-400">
                解决 Windows UWP 应用网络回环问题
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                此工具可以为UWP应用启用网络回环功能，让UWP应用能够连接到本地代理服务器。
              </p>
              <Button 
                onClick={openEnableLoopbackTool}
                className="w-full bg-blue-500 hover:bg-blue-600 text-white"
                variant="default"
              >
                启动工具
              </Button>
            </CardContent>
          </Card>

          <Card className="overflow-hidden border border-gray-200 dark:border-gray-800 hover:shadow-sm transition-shadow">
            <CardHeader className="bg-white dark:bg-gray-950 pb-6">
              <div className="flex items-center space-x-3 mb-2">
                <Gauge className="w-5 h-5 text-gray-600 dark:text-gray-300" />
                <CardTitle>网络测速</CardTitle>
              </div>
              <CardDescription className="text-gray-500 dark:text-gray-400">
                测试网络连接速度和延迟
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                使用Speedtest CLI测试您的网络下载和上传速度以及延迟。
              </p>
              <Button 
                onClick={openSpeedtestDialog}
                className="w-full bg-blue-500 hover:bg-blue-600 text-white"
                variant="default"
              >
                开始测速
              </Button>
            </CardContent>
          </Card>

          <Card className="overflow-hidden border border-gray-200 dark:border-gray-800 hover:shadow-sm transition-shadow">
            <CardHeader className="bg-white dark:bg-gray-950 pb-6">
              <div className="flex items-center space-x-3 mb-2">
                <Play className="w-5 h-5 text-gray-600 dark:text-gray-300" />
                <CardTitle>媒体服务检测</CardTitle>
              </div>
              <CardDescription className="text-gray-500 dark:text-gray-400">
                检测流媒体平台可用性和支持区域
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                测试您当前线路能否访问Netflix、Disney+等各大流媒体服务，并检测支持的解锁级别。
              </p>
              <Button 
                onClick={openMediaTestDialog}
                className="w-full bg-blue-500 hover:bg-blue-600 text-white"
                variant="default"
              >
                开始检测
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
              <Gauge className="w-5 h-5" /> 网络测速
            </DialogTitle>
            <DialogDescription>
              测试您的网络下载和上传速度以及延迟
            </DialogDescription>
          </DialogHeader>

          <div className="py-4">
            {!speedtestRunning && !speedtestResult && !speedtestError && (
              <div className="space-y-4">
                <p className="text-center text-gray-600 dark:text-gray-400">
                  点击下方按钮开始测试您的网络速度
                </p>
                <div className="flex justify-center my-8">
                  <Gauge className="w-20 h-20 text-blue-500 opacity-20" />
                </div>
                <Button 
                  onClick={runSpeedtest}
                  className="w-full bg-blue-500 hover:bg-blue-600 text-white"
                  variant="default"
                >
                  开始测速
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
                      <h4 className="font-medium text-red-800 dark:text-red-300">测速失败</h4>
                      <p className="text-sm text-red-700 dark:text-red-400 mt-1">{speedtestError}</p>
                    </div>
                  </div>
                </div>
                
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  请确保您的电脑已连接网络，并且tools目录中已正确放置speedtest.exe文件。
                </p>
                
                <Button 
                  onClick={runSpeedtest}
                  className="w-full bg-blue-500 hover:bg-blue-600 text-white mt-4"
                  variant="default"
                >
                  重试
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
                        {currentTestPhase === 'preparing' && '正在准备测速...'}
                        {currentTestPhase === 'ping' && '测试延迟中...'}
                        {currentTestPhase === 'download' && '测试下载速度中...'}
                        {currentTestPhase === 'upload' && '测试上传速度中...'}
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
                    <span className="text-xs text-gray-500 dark:text-gray-400">下载速度</span>
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
                    <span className="text-xs text-gray-500 dark:text-gray-400">上传速度</span>
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
                    <span className="text-xs text-gray-500 dark:text-gray-400">Ping延迟</span>
                    <span className={cn(
                      "text-lg font-bold",
                      currentTestPhase === 'ping' && speedtestRunning && "text-purple-600 dark:text-purple-400"
                    )}>
                      {speedtestResult?.ping || 0} ms
                    </span>
                  </div>
                  <div className="flex flex-col items-center p-3 bg-gray-50 dark:bg-gray-900 rounded-md transition-all duration-500">
                    <Radio className="w-5 h-5 text-purple-500 mb-1" />
                    <span className="text-xs text-gray-500 dark:text-gray-400">抖动</span>
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
                      <span className="text-xs text-gray-500 dark:text-gray-400 block">测速服务器</span>
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
                    {showLogs ? '隐藏原始输出' : '显示原始输出'}
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
                      重新测速
                    </Button>
                    
                    <Button 
                      onClick={openShareDialog}
                      className="bg-green-500 hover:bg-green-600 text-white"
                      variant="default"
                    >
                      <Share className="mr-2 h-4 w-4" />
                      分享结果
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
              <Share className="w-5 h-5" /> 分享测速结果
            </DialogTitle>
            <DialogDescription>
              生成并分享您的网络测速结果
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
              <Play className="w-5 h-5" /> 媒体服务检测
            </DialogTitle>
            <DialogDescription>
              检测各大流媒体平台的可用性和解锁情况
            </DialogDescription>
          </DialogHeader>
          
          <div className="py-4">
            <MediaStreamingTest currentNode={currentNode} />
          </div>
        </DialogContent>
      </Dialog>
    </Layout>
  );
} 