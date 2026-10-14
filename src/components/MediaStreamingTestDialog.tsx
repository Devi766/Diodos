'use client';

import React, { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { Play } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { readCachedProxyEntry } from '@/lib/proxy-entry';
import { applyMediaToolResults } from '@/lib/media-checker';

function LoadingMediaTest() {
  const { t } = useTranslation();
  return <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">{t('common.loading')}</div>;
}
const MediaStreamingTest = dynamic(() => import('../../app/components/MediaStreamingTest'), { ssr: false, loading: LoadingMediaTest });

export default function MediaStreamingTestDialog({ open, onOpenChange, currentNode }: {
  open: boolean; onOpenChange: (open: boolean) => void; currentNode?: string;
}) {
  const { t } = useTranslation();
  const [resolvedNode, setResolvedNode] = useState<string | null>(null);
  useEffect(() => {
    if (!open || currentNode) return;
    let disposed = false;
    const refresh = async () => {
      if (disposed) return;
      const cached = readCachedProxyEntry()?.node || null;
      setResolvedNode(cached);
      try {
        const info = await window.electronAPI?.fetchConnectionsInfo?.();
        if (!disposed && typeof info?.currentNode === 'string' && info.currentNode.trim()) setResolvedNode(info.currentNode.trim());
      } catch { /* 保留缓存的节点名称，不阻挡弹框加载 */ }
    };
    void refresh();
    const offNode = window.electronAPI?.onNodeChanged?.(() => void refresh());
    const offConfig = window.electronAPI?.onActiveConfigChanged?.(() => void refresh());
    return () => { disposed = true; offNode?.(); offConfig?.(); };
  }, [open, currentNode]);

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="flex max-h-[85vh] flex-col rounded-dialog sm:max-w-[700px]">
      <DialogHeader className="shrink-0">
        <DialogTitle className="flex items-center gap-2"><Play className="size-5" />{t('tools.mediaTest.dialogTitle')}</DialogTitle>
        <DialogDescription>{t('tools.mediaTest.dialogDescription')}</DialogDescription>
      </DialogHeader>
      <div className="h-[min(500px,calc(85vh-140px))] min-h-0 [&>div]:h-full">
        {open && <MediaStreamingTest currentNode={currentNode || resolvedNode || t('tools.unknownNode')} onTestComplete={applyMediaToolResults} />}
      </div>
    </DialogContent>
  </Dialog>;
}
