import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ImagePlus, RefreshCw, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { showToast } from '@/components/ui/toast';
import { DASHBOARD_CARD_ICONS } from '@/lib/dashboard-icons';
import {
  getCachedDashboardImage,
  loadDashboardImage,
  pickDashboardImage,
  removeDashboardImage,
} from '@/lib/dashboard-images';

interface ImageCardProps {
  cardId: string;
  variant?: string;
  // 小组件库预览：只显示占位
  preview?: boolean;
}

// 大尺寸与全宽大卡片同高；中尺寸为半宽，与指标卡片同高
const HEIGHT_CLASS: Record<string, string> = {
  large: 'dashboard-large-card',
  medium: 'dashboard-half-card',
};

export function ImageCard({ cardId, variant = 'large', preview = false }: ImageCardProps) {
  const { t } = useTranslation();
  const cached = preview ? null : getCachedDashboardImage(cardId);
  const [image, setImage] = useState<string | null>(cached ?? null);
  const [loading, setLoading] = useState(!preview && cached === undefined);
  const [busy, setBusy] = useState(false);

  // 先显示缓存，再从磁盘刷新
  useEffect(() => {
    if (preview) return;
    let disposed = false;
    loadDashboardImage(cardId)
      .then((dataUrl) => {
        if (!disposed) setImage(dataUrl);
      })
      .catch(() => {})
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [cardId, preview]);

  const handlePick = async (event?: React.MouseEvent) => {
    event?.stopPropagation();
    if (preview || busy) return;
    setBusy(true);
    try {
      const dataUrl = await pickDashboardImage(cardId);
      if (dataUrl) setImage(dataUrl);
    } catch (error) {
      console.error('Failed to set dashboard image:', error);
      showToast({ message: t('dashboard.imageCard.saveFailed'), type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (event: React.MouseEvent) => {
    event.stopPropagation();
    try {
      await removeDashboardImage(cardId);
      setImage(null);
    } catch {
      showToast({ message: t('dashboard.imageCard.removeFailed'), type: 'error' });
    }
  };

  const compact = variant === 'medium';
  const ImageIcon = DASHBOARD_CARD_ICONS.image;

  return (
    <div
      className={cn(
        'dashboard-card group/image relative overflow-hidden',
        HEIGHT_CLASS[variant] ?? HEIGHT_CLASS.large,
        !preview && 'cursor-pointer',
      )}
      onClick={() => {
        if (!image) void handlePick();
      }}
    >
      <div className="pointer-events-none absolute left-card top-card z-10 rounded-control bg-white/75 p-1.5 text-muted-foreground backdrop-blur-sm dark:bg-[#2a2a2a]/75" title={t('dashboard.cardMeta.image.title')}>
        <ImageIcon aria-hidden className="size-card-icon" strokeWidth={1.7} />
        <span className="sr-only">{t('dashboard.cardMeta.image.title')}</span>
      </div>
      {loading ? (
        <div className="absolute inset-0 animate-pulse bg-gray-100 dark:bg-white/5" />
      ) : image ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={image} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover" />
          {!preview && (
            <div className="absolute right-2 top-2 flex gap-1.5 opacity-0 transition-opacity group-hover/image:opacity-100">
              <button
                type="button"
                onClick={handlePick}
                title={t('dashboard.imageCard.change')}
                className="rounded-control bg-black/45 p-1.5 text-white backdrop-blur transition-colors hover:bg-black/60"
              >
                <RefreshCw className={cn('size-card-icon', busy && 'animate-spin')} />
              </button>
              <button
                type="button"
                onClick={handleRemove}
                title={t('dashboard.imageCard.remove')}
                className="rounded-control bg-black/45 p-1.5 text-white backdrop-blur transition-colors hover:bg-black/60"
              >
                <Trash2 className="size-card-icon" />
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-[#3a3a3c] dark:text-white">
          <ImagePlus className={cn(compact ? 'size-6' : 'size-9', busy && 'animate-pulse')} strokeWidth={1.6} />
          {!compact && (
            <span className="text-xs text-muted-foreground">{t('dashboard.imageCard.pick')}</span>
          )}
        </div>
      )}
    </div>
  );
}
