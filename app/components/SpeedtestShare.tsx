'use client';

import React, { useRef, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Download, Share2, Copy, Check } from 'lucide-react';
import { toast } from 'sonner';

interface SpeedtestShareProps {
  downloadSpeed: number;
  uploadSpeed: number;
  ping: number;
  jitter: number;
  location: string;
  server: string;
  nodeName: string;
  logo: string;
}

export default function SpeedtestShare({
  downloadSpeed,
  uploadSpeed,
  ping,
  jitter,
  location,
  server,
  nodeName,
  logo
}: SpeedtestShareProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // 根据下载速度生成评论
  const getSpeedComment = (speed: number): string => {
    if (speed >= 100) return "网速超快！观看4K视频无压力";
    if (speed >= 50) return "网速优秀，流畅观看高清视频";
    if (speed >= 25) return "网速良好，满足日常浏览需求";
    if (speed >= 10) return "网速一般，基本满足标清视频";
    return "网速较慢，建议提升网络质量";
  };

  // 根据下载速度生成评分
  const getSpeedRating = (speed: number): string => {
    if (speed >= 100) return "S+";
    if (speed >= 70) return "S";
    if (speed >= 50) return "A";
    if (speed >= 30) return "B";
    if (speed >= 15) return "C";
    return "D";
  };

  // 生成图片
  useEffect(() => {
    const generateImage = async () => {
      setIsGenerating(true);
      setError(null);
      
      const canvas = canvasRef.current;
      if (!canvas) {
        setError("无法创建画布");
        setIsGenerating(false);
        return;
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        setError("无法获取画布上下文");
        setIsGenerating(false);
        return;
      }

      // 设置画布尺寸
      canvas.width = 1200;
      canvas.height = 630;

      try {
        // 准备加载所需资源
        const logoImg = new Image();
        logoImg.crossOrigin = 'anonymous';
        
        // 绘制速度卡片的方法
        const drawSpeedCard = (
          x: number,
          y: number,
          width: number, 
          height: number, 
          color: string, 
          label: string, 
          value: string,
          type: string
        ) => {
          // 卡片背景
          ctx.fillStyle = '#F8FAFC';  // 非常浅的灰蓝色
          ctx.beginPath();
          ctx.roundRect(x, y, width, height, 12);
          ctx.fill();
          
          // 卡片边框
          ctx.strokeStyle = '#E2E8F0';  // 浅灰蓝色
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.roundRect(x, y, width, height, 12);
          ctx.stroke();
          
          // 卡片顶部装饰条
          ctx.fillStyle = color;
          ctx.beginPath();
          // 使用标准参数来避免linter错误
          ctx.roundRect(x, y, width, 5, 0);
          ctx.fill();
          
          // 卡片标题
          ctx.font = '18px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
          ctx.fillStyle = '#64748B';  // 灰蓝色
          ctx.textAlign = 'left';
          ctx.fillText(label, x + 20, y + 35);
          
          // 卡片值
          ctx.font = 'bold 36px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
          ctx.fillStyle = '#1E293B';  // 深蓝灰色
          ctx.fillText(value, x + 20, y + 90);
          
          // 绘制图标
          const iconSize = 24;
          const iconX = x + width - iconSize - 20;
          const iconY = y + 35;
          ctx.fillStyle = color;
          
          // 为每种类型绘制简单图标
          switch(type) {
            case 'download':
              // 下载图标 - 简单向下箭头
              ctx.beginPath();
              ctx.moveTo(iconX + iconSize/2, iconY + iconSize);
              ctx.lineTo(iconX + iconSize, iconY);
              ctx.lineTo(iconX, iconY);
              ctx.closePath();
              ctx.fill();
              break;
            case 'upload':
              // 上传图标 - 简单向上箭头
              ctx.beginPath();
              ctx.moveTo(iconX + iconSize/2, iconY);
              ctx.lineTo(iconX + iconSize, iconY + iconSize);
              ctx.lineTo(iconX, iconY + iconSize);
              ctx.closePath();
              ctx.fill();
              break;
            case 'ping':
              // 延迟图标 - 简单圆点
              ctx.beginPath();
              ctx.arc(iconX + iconSize/2, iconY + iconSize/2, iconSize/2, 0, Math.PI * 2);
              ctx.fill();
              break;
            case 'jitter':
              // 抖动图标 - 简单波浪线
              ctx.beginPath();
              ctx.moveTo(iconX, iconY + iconSize/2);
              ctx.lineTo(iconX + iconSize/3, iconY);
              ctx.lineTo(iconX + iconSize*2/3, iconY + iconSize);
              ctx.lineTo(iconX + iconSize, iconY + iconSize/2);
              ctx.strokeStyle = color;
              ctx.lineWidth = 2;
              ctx.stroke();
              break;
          }
        };
        
        // 绘制整个分享卡片
        const drawShareCard = () => {
          // 清空画布
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          
          // 绘制背景 - 简洁的白色背景
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          
          // 顶部装饰条
          const headerGradient = ctx.createLinearGradient(0, 0, canvas.width, 0);
          headerGradient.addColorStop(0, '#3B82F6');  // 蓝色
          headerGradient.addColorStop(1, '#6366F1');  // 靛蓝色
          ctx.fillStyle = headerGradient;
          ctx.fillRect(0, 0, canvas.width, 8);
          
          // Logo 和标题区域
          const logoSize = 80;
          ctx.drawImage(logoImg, 70, 50, logoSize, logoSize);
          
          // 绘制标题
          ctx.textAlign = 'left';
          ctx.font = 'bold 44px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
          ctx.fillStyle = '#1E293B';  // 深蓝灰色
          ctx.fillText('FlyClash 网络测速', 180, 85);
          
          // 绘制副标题
          ctx.font = '24px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
          ctx.fillStyle = '#64748B';  // 灰蓝色
          ctx.fillText('简洁优雅的代理工具', 180, 125);
          
          // 绘制节点信息
          ctx.font = '18px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
          ctx.fillStyle = '#64748B';
          ctx.fillText(`节点: ${nodeName}`, 70, 180);
          
          // 绘制时间
          const now = new Date();
          const timeString = `${now.getFullYear()}-${(now.getMonth()+1).toString().padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')} ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
          ctx.textAlign = 'right';
          ctx.fillText(timeString, canvas.width - 70, 180);
          
          // 重置文本对齐
          ctx.textAlign = 'left';
          
          // 主要数据区域
          const mainArea = {
            x: 70,
            y: 220,
            width: canvas.width - 140,
            height: 300
          };
          
          // 绘制分隔线
          ctx.strokeStyle = '#E2E8F0';  // 浅灰蓝色
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(mainArea.x, 200);
          ctx.lineTo(canvas.width - mainArea.x, 200);
          ctx.stroke();
          
          // 网速卡片区域
          const cardMargin = 30;
          const cardWidth = (mainArea.width - cardMargin) / 2;
          const cardHeight = 130;
          
          // 下载和上传速度卡片
          drawSpeedCard(
            mainArea.x,
            mainArea.y,
            cardWidth,
            cardHeight,
            '#3B82F6',  // 蓝色
            '下载速度',
            `${downloadSpeed.toFixed(2)} Mbps`,
            'download'
          );
          
          drawSpeedCard(
            mainArea.x + cardWidth + cardMargin,
            mainArea.y,
            cardWidth,
            cardHeight,
            '#10B981',  // 绿色
            '上传速度',
            `${uploadSpeed.toFixed(2)} Mbps`,
            'upload'
          );
          
          // 延迟和抖动卡片
          drawSpeedCard(
            mainArea.x,
            mainArea.y + cardHeight + cardMargin,
            cardWidth,
            cardHeight,
            '#8B5CF6',  // 紫色
            '延迟',
            `${ping.toFixed(2)} ms`,
            'ping'
          );
          
          drawSpeedCard(
            mainArea.x + cardWidth + cardMargin,
            mainArea.y + cardHeight + cardMargin,
            cardWidth,
            cardHeight,
            '#EC4899',  // 粉色
            '抖动',
            `${jitter.toFixed(2)} ms`,
            'jitter'
          );
          
          // 评分和评论区域
          const ratingAreaY = mainArea.y + mainArea.height + 40;
          
          // 绘制评分区域
          // 获取评级信息
          const rating = getSpeedRating(downloadSpeed);
          const comment = getSpeedComment(downloadSpeed);
          
          // 评级圆圈
          const ratingColors: {[key: string]: string} = {
            'S+': '#3B82F6',  // 蓝色
            'S': '#3B82F6',   // 蓝色
            'A': '#10B981',   // 绿色
            'B': '#F59E0B',   // 橙色
            'C': '#F97316',   // 深橙色
            'D': '#EF4444'    // 红色
          };
          
          const selectedColor = ratingColors[rating] || ratingColors['D'];
          
          // 绘制评分圆圈
          const ratingCenterX = mainArea.x + 35;
          const ratingCenterY = ratingAreaY + 25;
          const ratingRadius = 30;
          
          ctx.fillStyle = selectedColor;
          ctx.beginPath();
          ctx.arc(ratingCenterX, ratingCenterY, ratingRadius, 0, Math.PI * 2);
          ctx.fill();
          
          // 评分文字
          ctx.font = 'bold 28px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
          ctx.fillStyle = '#FFFFFF';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(rating, ratingCenterX, ratingCenterY);
          
          // 重置文本基线
          ctx.textBaseline = 'alphabetic';
          
          // 评分说明
          ctx.textAlign = 'left';
          ctx.font = 'bold 22px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
          ctx.fillStyle = '#1E293B';
          ctx.fillText('网络评分', mainArea.x + 80, ratingAreaY + 20);
          
          // 评分描述
          ctx.font = '18px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
          ctx.fillStyle = '#64748B';
          ctx.fillText(comment, mainArea.x + 80, ratingAreaY + 50);
          
          // 底部信息
          ctx.font = '14px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
          ctx.textAlign = 'center';
          
          // 确保底部服务器信息不被截断
          const serverInfo = `测速服务器: ${location}`;
          const serverInfoY = ratingAreaY + 80;
          const textMetrics = ctx.measureText(serverInfo);
          
          if (textMetrics.width > mainArea.width) {
            // 如果文本太长，缩短显示
            const shortenedLocation = location.length > 40 
              ? location.substring(0, 40) + '...' 
              : location;
            ctx.fillText(`测速服务器: ${shortenedLocation}`, canvas.width / 2, serverInfoY);
          } else {
            ctx.fillText(serverInfo, canvas.width / 2, serverInfoY);
          }
          
          // 底部版权信息
          ctx.font = '14px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
          ctx.fillStyle = '#94A3B8';
          ctx.fillText(`FlyClash © ${new Date().getFullYear()}`, canvas.width / 2, canvas.height - 30);
        };
        
        // 加载Logo
        logoImg.onload = () => {
          drawShareCard();
          
          // 创建图片URL
          const dataUrl = canvas.toDataURL('image/png');
          setShareUrl(dataUrl);
          setIsGenerating(false);
        };
        
        logoImg.onerror = () => {
          console.error('加载Logo失败');
          
          // 即使Logo加载失败，也继续渲染
          drawShareCard();
          
          // 创建图片URL
          const dataUrl = canvas.toDataURL('image/png');
          setShareUrl(dataUrl);
          setIsGenerating(false);
        };
        
        // 设置Logo源
        logoImg.src = logo;
        
      } catch (err) {
        console.error('生成图片出错:', err);
        setError('生成分享图片时出错');
        setIsGenerating(false);
      }
    };

    generateImage();
  }, [downloadSpeed, uploadSpeed, ping, jitter, location, logo, nodeName]);

  // 复制图片到剪贴板
  const copyImageToClipboard = async () => {
    if (!shareUrl) return;
    
    try {
      // 先将数据URL转换为Blob
      const response = await fetch(shareUrl);
      const blob = await response.blob();
      
      // 使用Clipboard API复制图片到剪贴板
      const item = new ClipboardItem({ 'image/png': blob });
      await navigator.clipboard.write([item]);
      
      // 显示成功提示
      toast.success('测速结果图片已复制到剪贴板');
      setCopied(true);
      
      // 3秒后重置复制状态
      setTimeout(() => setCopied(false), 3000);
    } catch (err) {
      console.error('复制图片失败:', err);
      toast.error('复制图片失败，请尝试使用下载按钮');
      
      // 尝试退回到复制文本
      const shareText = `FlyClash测速结果\n节点: ${nodeName}\n下载: ${downloadSpeed.toFixed(2)} Mbps\n上传: ${uploadSpeed.toFixed(2)} Mbps\n延迟: ${ping.toFixed(2)} ms\n抖动: ${jitter.toFixed(2)} ms\n${getSpeedComment(downloadSpeed)}`;
      
      try {
        await navigator.clipboard.writeText(shareText);
        toast.info('已复制测速结果文本到剪贴板');
      } catch (textErr) {
        console.error('复制文本也失败:', textErr);
      }
    }
  };

  // 原始分享功能
  const handleShare = async () => {
    try {
      if (!shareUrl) {
        throw new Error('未生成分享图片');
      }

      if (navigator.share && navigator.canShare) {
        // 转换为Blob
        const response = await fetch(shareUrl);
        const blob = await response.blob();
        
        // 创建File对象
        const file = new File([blob], 'speedtest-result.png', { type: 'image/png' });
        
        // 检查是否支持分享文件
        const shareData = {
          title: 'FlyClash测速结果',
          text: `下载: ${downloadSpeed.toFixed(2)} Mbps, 上传: ${uploadSpeed.toFixed(2)} Mbps, 延迟: ${ping.toFixed(2)} ms`,
          files: [file]
        };
        
        if (navigator.canShare(shareData)) {
          await navigator.share(shareData);
          return;
        }
      }
      
      // 如果无法使用原生分享，就复制到剪贴板
      await copyImageToClipboard();
    } catch (err) {
      console.error('分享失败:', err);
      toast.error('分享失败，请尝试手动分享');
    }
  };

  // 下载功能
  const handleDownload = () => {
    if (!shareUrl) return;
    
    const link = document.createElement('a');
    link.href = shareUrl;
    link.download = 'FlyClash-测速结果.png';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast.success('测速结果图片已下载');
  };

  return (
    <div className="flex flex-col items-center w-full">
      {error && (
        <div className="mb-4 p-3 bg-red-100 text-red-800 rounded-md w-full">
          {error}
        </div>
      )}
      
      <div className="relative w-full max-w-[900px] aspect-[1200/630] bg-[#F8FAFC] rounded-xl overflow-hidden mb-6 border border-[#E2E8F0] shadow-lg">
        {isGenerating && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/80 backdrop-blur-sm">
            <div className="flex flex-col items-center gap-3">
              <div className="w-16 h-16 relative">
                <div className="absolute inset-0 rounded-full border-4 border-blue-500 opacity-20 animate-ping"></div>
                <div className="absolute inset-0 rounded-full border-4 border-t-transparent border-blue-500 animate-spin"></div>
              </div>
              <p className="text-blue-600 text-sm font-medium">生成测速结果图片中...</p>
            </div>
          </div>
        )}
        
        <canvas
          ref={canvasRef}
          className="w-full h-full object-contain"
          style={{ display: isGenerating ? 'none' : 'block' }}
        />
      </div>
      
      <div className="grid grid-cols-2 gap-4 w-full max-w-[900px]">
        <Button
          onClick={copyImageToClipboard}
          disabled={isGenerating || !shareUrl}
          className="bg-blue-600 hover:bg-blue-700 text-white h-12 text-base"
        >
          <span className="flex items-center justify-center">
            {!copied ? (
              <>
                <Copy className="mr-2 h-5 w-5" />
                复制图片
              </>
            ) : (
              <>
                <Check className="mr-2 h-5 w-5" />
                已复制
              </>
            )}
          </span>
        </Button>
        
        <Button
          onClick={handleDownload}
          disabled={isGenerating || !shareUrl}
          variant="outline"
          className="h-12 text-base border-slate-300 hover:bg-slate-100 text-slate-700"
        >
          <span className="flex items-center justify-center">
            <Download className="mr-2 h-5 w-5" />
            下载图片
          </span>
        </Button>
      </div>
    </div>
  );
}