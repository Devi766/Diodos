import React, { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { useIsDarkMode } from '@/hooks/useIsDarkMode';
import { useElementVisible } from '@/hooks/useElementVisible';
import { SpeedLinesRenderer, SpeedLinesSample } from '@/lib/speed-lines';
import { formatBytes } from '@/utils/formatters';
import { CardHeading } from './CardHeading';

interface SpeedLinesCardProps {
  samples: SpeedLinesSample[];
  fullWidth?: boolean;
  // 小组件库预览：静态展示，没有数据时使用示例曲线
  preview?: boolean;
}

// 与指标卡片同高，曲线铺满标题下方，数值叠在曲线下部
const INSET_TOP = 44;
const INSET_BOTTOM = 10;
const CARD_SURFACE = { light: '#ffffff', dark: '#2a2a2a' };

const formatSpeed = (value: number) => `${formatBytes(Math.max(0, Math.round(value)))}/s`;

const PREVIEW_SAMPLES: SpeedLinesSample[] = Array.from({ length: 40 }, (_, i) => ({
  downSpeed: (1.6 + Math.sin(i / 3.2) * 0.9 + Math.sin(i / 1.3) * 0.35) * 1024 * 1024,
  upSpeed: (0.35 + Math.sin(i / 2.4 + 1) * 0.18) * 1024 * 1024,
}));

export function SpeedLinesCard({ samples, preview = false, fullWidth = false }: SpeedLinesCardProps) {
  const { t } = useTranslation();
  const isDark = useIsDarkMode();
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<SpeedLinesRenderer | null>(null);
  const frameRef = useRef<number>(0);
  const visible = useElementVisible(containerRef);

  const data = preview && samples.length < 2 ? PREVIEW_SAMPLES : samples;
  const latest = data[data.length - 1];
  const colors = useMemo(
    () => ({
      line: isDark ? '255, 255, 255' : '0, 0, 0',
      haloBase: isDark ? CARD_SURFACE.dark : CARD_SURFACE.light,
      dark: isDark,
    }),
    [isDark],
  );

  if (!rendererRef.current) rendererRef.current = new SpeedLinesRenderer();

  // 绘制一帧；需要时继续逐帧刷新，数据停止或卡片不可见时停下
  const drawRef = useRef<() => void>(() => {});
  drawRef.current = () => {
    cancelAnimationFrame(frameRef.current);
    const canvas = canvasRef.current;
    const renderer = rendererRef.current;
    if (!canvas || !renderer) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const keepGoing = renderer.draw(ctx, width, height, INSET_TOP, INSET_BOTTOM, colors, performance.now());
    if (keepGoing && visible && !preview) {
      frameRef.current = requestAnimationFrame(() => drawRef.current());
    }
  };

  useEffect(() => {
    rendererRef.current?.setSamples(data, !preview && visible, performance.now());
    drawRef.current();
  }, [data, preview, visible]);

  useEffect(() => {
    drawRef.current();
  }, [colors]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => drawRef.current());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => cancelAnimationFrame(frameRef.current), []);

  return (
    <div ref={containerRef} className={`dashboard-card ${fullWidth ? 'dashboard-standard-full-card' : 'dashboard-half-card'} relative overflow-hidden`}>
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />

      {/* 标题区：半透遮罩，曲线从下方淡出 */}
      <div className="absolute inset-x-0 top-0 flex items-center gap-1.5 bg-gradient-to-b from-white/95 via-white/70 to-white/0 px-card pb-3 pt-card dark:from-[#2a2a2a]/95 dark:via-[#2a2a2a]/70 dark:to-[#2a2a2a]/0 [&>svg]:my-1 [&>span]:leading-6">
        <CardHeading type="traffic-chart" className="h-6">{t('dashboard.speedLines.title')}</CardHeading>
      </div>

      {/* 数值区：自下而上的半透遮罩，保证文字清晰又能透出曲线 */}
      <div className="absolute inset-x-0 bottom-0 top-[44px] flex flex-col justify-center bg-gradient-to-t from-white/85 via-white/45 to-white/0 px-card pb-card dark:from-[#2a2a2a]/85 dark:via-[#2a2a2a]/45 dark:to-[#2a2a2a]/0">
        <div className="flex items-center gap-1 text-foreground">
          <ArrowDown className="size-card-icon shrink-0" />
          <span className="truncate text-2xl leading-7 font-semibold tabular-nums">{formatSpeed(latest?.downSpeed ?? 0)}</span>
        </div>
        <div className="mt-1 flex items-center gap-1 text-xs leading-4 text-muted-foreground">
          <ArrowUp className="size-3 shrink-0" />
          <span className="truncate tabular-nums">{formatSpeed(latest?.upSpeed ?? 0)}</span>
        </div>
      </div>
    </div>
  );
}
