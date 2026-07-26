'use client';

import React, { useCallback, useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { NetworkIcon, Play, RefreshCw } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import MediaStreamingTest from '../components/MediaStreamingTest';
import LoopbackManager from '@/components/LoopbackManager';
import { useTranslation } from 'react-i18next';
import { getRuntimePlatform } from '@/utils/platform';

export default function ToolsPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const [mediaTestDialogOpen, setMediaTestDialogOpen] = useState(false);
  const [loopbackDialogOpen, setLoopbackDialogOpen] = useState(false);
  const [platform, setPlatform] = useState<string>('unknown');
  const [currentNode, setCurrentNode] = useState(t('tools.unknownNode'));

  // 获取当前节点信息（供媒体检测使用）
  const fetchCurrentNode = useCallback(async () => {
    if (!window.electronAPI) {
      setCurrentNode(t('tools.unknownNode'));
      return;
    }

    try {
      try {
        const connectionsInfo = await window.electronAPI.fetchConnectionsInfo();
        if (connectionsInfo && connectionsInfo.currentNode) {
          setCurrentNode(connectionsInfo.currentNode);
          return;
        }
      } catch (error) {
        console.error('通过connections获取节点信息失败:', error);
      }

      try {
        const apiConfig = await window.electronAPI.getApiConfig();
        if (apiConfig && apiConfig.success) {
          const response = await window.electronAPI.requestMihomoAPI('/proxies/PROXY');
          if (response && response.ok && response.data && response.data.now) {
            setCurrentNode(response.data.now);
            return;
          }
        }
      } catch (error) {
        console.error('请求PROXY组信息失败:', error);
      }

      try {
        const configOrder = await window.electronAPI.getConfigOrder();
        if (configOrder && configOrder.success && configOrder.data &&
            configOrder.data.proxyGroups && configOrder.data.proxyGroups.length > 0) {
          const visibleGroups = configOrder.data.proxyGroups.filter((g: any) => g?.hidden !== true);
          const firstGroupName = visibleGroups[0]?.name;
          if (firstGroupName) {
            const groupResponse = await window.electronAPI.requestMihomoAPI(`/proxies/${encodeURIComponent(firstGroupName)}`);
            if (groupResponse && groupResponse.ok && groupResponse.data && groupResponse.data.now) {
              setCurrentNode(groupResponse.data.now);
              return;
            }
          }
        }
      } catch (error) {
        console.error('请求特定代理组信息失败:', error);
      }

      try {
        const proxiesResponse = await window.electronAPI.requestMihomoAPI('/proxies');
        if (proxiesResponse && proxiesResponse.ok && proxiesResponse.data) {
          if (proxiesResponse.data.proxies && proxiesResponse.data.proxies.PROXY && proxiesResponse.data.proxies.PROXY.now) {
            setCurrentNode(proxiesResponse.data.proxies.PROXY.now);
            return;
          }
          const proxyGroups = Object.entries(proxiesResponse.data.proxies || {})
            .filter(([_, proxy]) => proxy && typeof proxy === 'object' && (proxy as any).type === 'Selector');
          if (proxyGroups.length > 0) {
            const [, groupInfo] = proxyGroups[0];
            const nodeName = (groupInfo as any).now;
            if (nodeName) {
              setCurrentNode(nodeName);
              return;
            }
          }
        }
      } catch (error) {
        console.error('获取所有代理信息失败:', error);
      }
    } catch (error) {
      console.error('获取节点信息失败:', error);
    }
    setCurrentNode(t('tools.unknownNode'));
  }, [t]);

  const detectPlatform = useCallback(async () => {
    try {
      setPlatform(await getRuntimePlatform());
    } catch (error) {
      console.error('检测平台失败:', error);
      setPlatform('unknown');
    }
  }, []);

  useEffect(() => {
    fetchCurrentNode();
    void detectPlatform();
  }, [detectPlatform, fetchCurrentNode]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const refreshCurrentNode = () => {
      setCurrentNode(t('tools.unknownNode'));
      void fetchCurrentNode();
    };

    window.addEventListener('profile-updated', refreshCurrentNode);
    window.addEventListener('backup-restored', refreshCurrentNode);
    window.addEventListener('subscription-auto-updated', refreshCurrentNode);

    const unsubscribeActiveConfig = window.electronAPI?.onActiveConfigChanged?.(() => {
      refreshCurrentNode();
    });
    const unsubscribeAutoUpdated = window.electronAPI?.onSubscriptionAutoUpdated?.(() => {
      refreshCurrentNode();
    });
    const unsubscribeNodeChanged = window.electronAPI?.onNodeChanged?.(() => {
      refreshCurrentNode();
    });

    return () => {
      window.removeEventListener('profile-updated', refreshCurrentNode);
      window.removeEventListener('backup-restored', refreshCurrentNode);
      window.removeEventListener('subscription-auto-updated', refreshCurrentNode);
      unsubscribeActiveConfig?.();
      unsubscribeAutoUpdated?.();
      unsubscribeNodeChanged?.();
    };
  }, [fetchCurrentNode, t]);

  const openLoopbackManager = () => {
    setLoopbackDialogOpen(true);
  };

  const openMediaTestDialog = () => {
    setMediaTestDialogOpen(true);
  };

  const isWindows = platform === 'win32';

  return (
    <>
      <div className="space-y-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-foreground">{t('tools.title')}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t('tools.subtitle')}</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-2 gap-6">
          {/* UWP 回环豁免管理 - 仅在 Windows 上显示 */}
          {isWindows && (
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

          {/* 媒体服务检测 */}
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
                {t('tools.converter.detail')}
              </p>
              <Button
                onClick={() => router.push('/converter')}
                className="w-full bg-blue-500 hover:bg-blue-600 text-white"
                variant="default"
              >
                {t('tools.converter.open')}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>

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
        <DialogContent className="flex h-[min(85vh,720px)] w-[min(680px,calc(100vw-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-[680px]">
          <DialogHeader className="flex-shrink-0 px-6 pb-2 pt-6">
            <DialogTitle className="flex items-center gap-2">
              <NetworkIcon className="h-5 w-5" /> {t('tools.loopback.dialogTitle')}
            </DialogTitle>
            <DialogDescription>
              {t('tools.loopback.dialogDescription')}
            </DialogDescription>
          </DialogHeader>

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-6 pb-6">
            <LoopbackManager />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
