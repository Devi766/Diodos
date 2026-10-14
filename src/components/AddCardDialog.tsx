import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion, type PanInfo } from 'motion/react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { DASHBOARD_CARD_ICONS as CARD_ICONS } from '@/lib/dashboard-icons';
import {
  DASHBOARD_CARD_DEFINITIONS,
  DashboardCard,
  DashboardCardDefinition,
  DashboardCardType,
  DashboardCardVariant,
} from '@/types/dashboard';
import { cn } from '@/lib/utils';

interface AddCardDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // 仪表盘上已启用的卡片，用于标记「已添加」
  cards: DashboardCard[];
  onAddCard: (type: DashboardCardType, variantId: string) => void;
  renderCardPreview: (type: DashboardCardType, variantId?: string) => React.ReactNode;
}

// 预览区宽度：全宽卡片与仪表盘上两列宽度接近，半宽卡片约为其一半
const GALLERY_WIDTH = 560;
const GALLERY_GAP = 16;
const HALF_PREVIEW_WIDTH = (GALLERY_WIDTH - GALLERY_GAP) / 2;
const SWIPE_THRESHOLD = 60;

const previewWidthOf = (variant: DashboardCardVariant) =>
  variant.width === 'full' ? GALLERY_WIDTH : HALF_PREVIEW_WIDTH;

// 半宽卡片尽量两两相邻，避免单独一张半宽卡片后面空出半行；全宽卡片保持原有先后顺序
const arrangeForGrid = (definitions: DashboardCardDefinition[]) => {
  const result: DashboardCardDefinition[] = [];
  const deferredFull: DashboardCardDefinition[] = [];
  let pendingHalf: DashboardCardDefinition | null = null;
  for (const definition of definitions) {
    if (definition.variants[0].width === 'half') {
      if (!pendingHalf) {
        pendingHalf = definition;
      } else {
        result.push(pendingHalf, definition, ...deferredFull);
        deferredFull.length = 0;
        pendingHalf = null;
      }
    } else if (pendingHalf) {
      deferredFull.push(definition);
    } else {
      result.push(definition);
    }
  }
  if (pendingHalf) result.push(pendingHalf);
  result.push(...deferredFull);
  return result;
};

// 只读预览：屏蔽指针与键盘焦点，卡片内的按钮不会被误触
function PreviewFrame({ children, className }: { children: React.ReactNode; className?: string }) {
  const setRef = useCallback((node: HTMLDivElement | null) => {
    node?.setAttribute('inert', '');
  }, []);
  return (
    <div ref={setRef} aria-hidden className={cn('pointer-events-none select-none', className)}>
      {children}
    </div>
  );
}

// 弹框背景与标题区遮罩使用同一底色，标题区向下渐隐
const SURFACE_BG = 'bg-[#f2f2f7]/85 dark:bg-[#1c1c1e]/85';
const HEADER_FADE =
  'bg-gradient-to-b from-[#f2f2f7]/95 via-[#f2f2f7]/75 to-[#f2f2f7]/0 dark:from-[#1c1c1e]/95 dark:via-[#1c1c1e]/75 dark:to-[#1c1c1e]/0';

const viewTransition = { duration: 0.24, ease: [0.25, 1, 0.5, 1] as const };

export function AddCardDialog({
  open,
  onOpenChange,
  cards,
  onAddCard,
  renderCardPreview,
}: AddCardDialogProps) {
  const { t } = useTranslation();
  const [selectedType, setSelectedType] = useState<DashboardCardType | null>(null);

  // 关闭后回到画廊列表
  useEffect(() => {
    if (open) return;
    const timer = window.setTimeout(() => setSelectedType(null), 200);
    return () => window.clearTimeout(timer);
  }, [open]);

  const galleryItems = useMemo(() => arrangeForGrid(DASHBOARD_CARD_DEFINITIONS), []);
  const addedTypes = useMemo(() => new Set(cards.map((card) => card.type)), [cards]);
  const selectedDefinition = selectedType
    ? DASHBOARD_CARD_DEFINITIONS.find((definition) => definition.type === selectedType) ?? null
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(760px,86vh)] max-w-[680px] flex-col gap-0 overflow-hidden rounded-dialog p-0">
        <div className={cn('pointer-events-none absolute inset-0', SURFACE_BG)} />
        <DialogTitle className="sr-only">{t('dashboard.widgetLibrary.title')}</DialogTitle>
        <DialogDescription className="sr-only">{t('dashboard.widgetLibrary.subtitle')}</DialogDescription>

        <AnimatePresence initial={false} mode="popLayout">
          {selectedDefinition ? (
            <motion.div
              key="detail"
              className="relative flex min-h-0 flex-1 flex-col"
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 24 }}
              transition={viewTransition}
            >
              <WidgetDetail
                definition={selectedDefinition}
                renderCardPreview={renderCardPreview}
                onBack={() => setSelectedType(null)}
                onAdd={(variantId) => onAddCard(selectedDefinition.type, variantId)}
              />
            </motion.div>
          ) : (
            <motion.div
              key="gallery"
              className="relative flex min-h-0 flex-1 flex-col"
              initial={{ opacity: 0, x: -24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -24 }}
              transition={viewTransition}
            >
              <div className={cn('absolute inset-x-0 top-0 z-10 px-8 pb-8 pt-7', HEADER_FADE)}>
                <h2 className="text-xl font-semibold text-foreground">{t('dashboard.widgetLibrary.title')}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{t('dashboard.widgetLibrary.subtitle')}</p>
              </div>

              <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto">
                <div
                  className="mx-auto grid grid-cols-2 gap-x-4 gap-y-6 px-2 pb-10 pt-28"
                  style={{ width: GALLERY_WIDTH + 16, maxWidth: '100%' }}
                >
                  {galleryItems.map((definition) => {
                    const Icon = CARD_ICONS[definition.type];
                    const isFull = definition.variants[0].width === 'full';
                    return (
                      <button
                        key={definition.type}
                        type="button"
                        onClick={() => setSelectedType(definition.type)}
                        className={cn(
                          'group flex min-w-0 flex-col items-stretch gap-2.5 rounded-card p-2 text-left outline-none transition-transform duration-200 hover:scale-[1.015] focus-visible:ring-2 focus-visible:ring-primary/60',
                          isFull ? 'col-span-2' : 'col-span-1',
                        )}
                      >
                        <PreviewFrame className="transition-shadow duration-200 group-hover:[&>*]:shadow-md">
                          {renderCardPreview(definition.type)}
                        </PreviewFrame>
                        <div className="flex items-center justify-center gap-1.5 text-sm font-medium text-foreground">
                          <Icon className="size-card-icon text-muted-foreground" />
                          <span className="truncate">{t(definition.titleKey)}</span>
                          {addedTypes.has(definition.type) && (
                            <span className="rounded-pill bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary dark:bg-primary/20">
                              {t('dashboard.widgetLibrary.onDashboard')}
                            </span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  );
}

interface WidgetDetailProps {
  definition: DashboardCardDefinition;
  renderCardPreview: (type: DashboardCardType, variantId?: string) => React.ReactNode;
  onBack: () => void;
  onAdd: (variantId: string) => void;
}

function WidgetDetail({ definition, renderCardPreview, onBack, onAdd }: WidgetDetailProps) {
  const { t } = useTranslation();
  const { variants } = definition;
  const [[index, direction], setPage] = useState<[number, number]>([0, 0]);
  const variant = variants[index];
  const hasMultiple = variants.length > 1;

  const paginate = useCallback(
    (step: number) => {
      setPage(([current]) => {
        const next = current + step;
        if (next < 0 || next >= variants.length) return [current, 0];
        return [next, step];
      });
    },
    [variants.length],
  );

  // 左右方向键切换尺寸
  useEffect(() => {
    if (!hasMultiple) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        paginate(-1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        paginate(1);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [hasMultiple, paginate]);

  const handleDragEnd = (_event: unknown, info: PanInfo) => {
    if (info.offset.x <= -SWIPE_THRESHOLD || info.velocity.x < -400) paginate(1);
    else if (info.offset.x >= SWIPE_THRESHOLD || info.velocity.x > 400) paginate(-1);
  };

  const sizeKey = variant.size === 'large-full' ? 'sizeExtraLargeFull' : variant.size === 'full' ? 'sizeFull' : 'sizeHalf';
  const widthLabel = t(`dashboard.widgetLibrary.${sizeKey}`);
  const variantLabel = t(variant.nameKey);
  const sizeLabel = hasMultiple && variantLabel !== widthLabel ? `${variantLabel} · ${widthLabel}` : widthLabel;

  return (
    <>
      <div className={cn('absolute inset-x-0 top-0 z-10 flex items-start gap-3 px-6 pb-8 pt-6', HEADER_FADE)}>
        <button
          type="button"
          onClick={onBack}
          aria-label={t('dashboard.widgetLibrary.back')}
          className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-pill bg-black/5 text-foreground transition-colors hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/15"
        >
          <ChevronLeft className="size-4" />
        </button>
        <div className="min-w-0">
          <h2 className="truncate text-xl font-semibold text-foreground">{t(definition.titleKey)}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t(definition.descriptionKey)}</p>
        </div>
      </div>

      {/* 预览区：卡片在剩余空间内水平、垂直居中 */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden px-16 pt-24">
        <AnimatePresence initial={false} custom={direction} mode="popLayout">
          <motion.div
            key={variant.id}
            custom={direction}
            variants={{
              enter: (dir: number) => ({ opacity: 0, x: dir * 80, scale: 0.96 }),
              center: { opacity: 1, x: 0, scale: 1 },
              exit: (dir: number) => ({ opacity: 0, x: dir * -80, scale: 0.96 }),
            }}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ duration: 0.28, ease: [0.25, 1, 0.5, 1] }}
            drag={hasMultiple ? 'x' : false}
            dragConstraints={{ left: 0, right: 0 }}
            dragElastic={0.18}
            onDragEnd={handleDragEnd}
            className={cn('max-w-full', hasMultiple && 'cursor-grab active:cursor-grabbing')}
            style={{ width: previewWidthOf(variant) }}
          >
            <PreviewFrame>{renderCardPreview(definition.type, variant.id)}</PreviewFrame>
          </motion.div>
        </AnimatePresence>

        {hasMultiple && (
          <>
            <SizeArrow
              side="left"
              disabled={index === 0}
              label={t('dashboard.widgetLibrary.previousSize')}
              onClick={() => paginate(-1)}
            />
            <SizeArrow
              side="right"
              disabled={index === variants.length - 1}
              label={t('dashboard.widgetLibrary.nextSize')}
              onClick={() => paginate(1)}
            />
          </>
        )}
      </div>

      <div className="relative flex flex-col items-center gap-3 px-8 pb-7 pt-4">
        {definition.type === 'network-info' && (
          <div className="flex flex-wrap justify-center gap-1.5" role="group" aria-label={t('dashboard.widgetLibrary.networkVariants')}>
            {variants.map((item, itemIndex) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={itemIndex === index}
                onClick={() => setPage([itemIndex, itemIndex > index ? 1 : -1])}
                className={cn('rounded-pill px-3 py-1.5 text-xs transition-colors', itemIndex === index
                  ? 'bg-primary text-primary-foreground' : 'bg-black/5 text-muted-foreground hover:bg-primary/10 dark:bg-white/5')}
              >
                {t(item.nameKey)}
              </button>
            ))}
          </div>
        )}
        <div className="text-sm font-medium text-foreground">{sizeLabel}</div>
        {hasMultiple && definition.type !== 'network-info' && (
          <div className="flex items-center gap-1.5">
            {variants.map((item, dotIndex) => (
              <button
                key={item.id}
                type="button"
                aria-label={t(item.nameKey)}
                onClick={() => setPage([dotIndex, dotIndex > index ? 1 : -1])}
                className={cn(
                  'size-1.5 rounded-pill bg-foreground transition-opacity duration-200',
                  dotIndex === index ? 'opacity-100' : 'opacity-25 hover:opacity-50',
                )}
              />
            ))}
          </div>
        )}
        <Button
          variant="primary"
          className="mt-1 h-11 w-full max-w-[320px] rounded-pill"
          onClick={() => onAdd(variant.id)}
        >
          <Plus className="mr-1.5 size-4" />
          {t('dashboard.widgetLibrary.addToDashboard')}
        </Button>
      </div>
    </>
  );
}

function SizeArrow({
  side,
  disabled,
  label,
  onClick,
}: {
  side: 'left' | 'right';
  disabled: boolean;
  label: string;
  onClick: () => void;
}) {
  const Icon = side === 'left' ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'absolute top-[calc(50%+3rem)] flex size-9 -translate-y-1/2 items-center justify-center rounded-pill bg-white/80 text-foreground shadow-sm transition-opacity hover:bg-white disabled:pointer-events-none disabled:opacity-0 dark:bg-white/10 dark:hover:bg-white/15',
        side === 'left' ? 'left-4' : 'right-4',
      )}
    >
      <Icon className="size-4" />
    </button>
  );
}
