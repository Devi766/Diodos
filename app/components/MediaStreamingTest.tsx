'use client';

import React, { useState, useEffect, useRef } from 'react';
import { 
  Check, 
  X, 
  AlertTriangle, 
  RefreshCw,
  Loader2,
  FileText,
  Globe,
  Clock,
  MonitorPlay,
  Share2,
  Download,
  Copy
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { 
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '@/components/ui/tooltip';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/dialog';

// 定义媒体流测试API返回的结果类型
interface MediaStreamingTestResult {
  available: boolean;
  fullSupport?: boolean;
  message?: string;
  region?: string;
  checkTime?: number;
  dnsStatus?: { resolved: boolean; ip?: string };
  ipInfo?: { ip: string; country?: string; region?: string; city?: string; org?: string };
  logPath?: string;
}

// 定义流媒体服务类型
type StreamingServiceStatus = 'checking' | 'success' | 'partial' | 'error' | 'timeout' | 'idle';

interface StreamingService {
  name: string;
  status: StreamingServiceStatus;
  message: string;
  checkUrl?: string;
  region?: string;
  checkTime?: number;
  dnsStatus?: { resolved: boolean; ip?: string };
  ipInfo?: { ip: string; country?: string; region?: string; city?: string; org?: string };
  logContent?: string;
}

interface MediaStreamingTestProps {
  currentNode: string;
  onTestComplete?: (results: StreamingService[]) => void;
}

// 扩展默认服务列表，添加更多流媒体服务
const DEFAULT_SERVICES: StreamingService[] = [
  // 主流国际服务
  {
    name: 'Netflix',
    status: 'idle',
    message: '',
    checkUrl: 'https://www.netflix.com/title/80018499',
  },
  {
    name: 'Disney+',
    status: 'idle',
    message: '',
    checkUrl: 'https://www.disneyplus.com',
  },
  {
    name: 'YouTube Premium',
    status: 'idle',
    message: '',
    checkUrl: 'https://www.youtube.com/premium',
  },
  {
    name: 'HBO Max',
    status: 'idle',
    message: '',
    checkUrl: 'https://www.max.com',
  },
  {
    name: 'Amazon Prime Video',
    status: 'idle',
    message: '',
    checkUrl: 'https://www.primevideo.com',
  },
  {
    name: 'Hulu',
    status: 'idle',
    message: '',
    checkUrl: 'https://www.hulu.com',
  },
  {
    name: 'Paramount+',
    status: 'idle',
    message: '',
    checkUrl: 'https://www.paramountplus.com',
  },
  // 英国服务
  {
    name: 'BBC iPlayer',
    status: 'idle',
    message: '',
    checkUrl: 'https://www.bbc.co.uk/iplayer',
  },
  {
    name: 'ITV',
    status: 'idle',
    message: '',
    checkUrl: 'https://www.itv.com',
  },
  {
    name: 'Channel 4',
    status: 'idle',
    message: '',
    checkUrl: 'https://www.channel4.com',
  },
  {
    name: 'BritBox',
    status: 'idle',
    message: '',
    checkUrl: 'https://www.britbox.com',
  },
  // AI服务
  {
    name: 'ChatGPT',
    status: 'idle',
    message: '',
    checkUrl: 'https://chat.openai.com',
  },
  {
    name: 'Meta AI',
    status: 'idle',
    message: '',
    checkUrl: 'https://www.meta.ai',
  },
  {
    name: 'Bing区域',
    status: 'idle',
    message: '',
    checkUrl: 'https://www.bing.com',
  },
  // 亚洲服务
  {
    name: 'TVB Anywhere+',
    status: 'idle',
    message: '',
    checkUrl: 'https://www.tvbanywhere.com',
  },
  {
    name: 'Viu',
    status: 'idle',
    message: '',
    checkUrl: 'https://www.viu.com',
  },
  {
    name: 'U-NEXT',
    status: 'idle',
    message: '',
    checkUrl: 'https://video.unext.jp',
  },
  {
    name: 'WOWOW',
    status: 'idle',
    message: '',
    checkUrl: 'https://www.wowow.co.jp',
  },
  {
    name: 'AbemaTV',
    status: 'idle',
    message: '',
    checkUrl: 'https://abema.tv',
  },
  {
    name: 'Niconico',
    status: 'idle',
    message: '',
    checkUrl: 'https://www.nicovideo.jp',
  },
  {
    name: 'Peacock TV',
    status: 'idle',
    message: '',
    checkUrl: 'https://www.peacocktv.com',
  },
  {
    name: 'Hotstar',
    status: 'idle',
    message: '',
    checkUrl: 'https://www.hotstar.com',
  },
  {
    name: 'Viaplay',
    status: 'idle',
    message: '',
    checkUrl: 'https://viaplay.com',
  },
  {
    name: 'Dazn',
    status: 'idle',
    message: '',
    checkUrl: 'https://www.dazn.com',
  },
  {
    name: 'Showmax',
    status: 'idle',
    message: '',
    checkUrl: 'https://www.showmax.com',
  },
  {
    name: 'KKTV',
    status: 'idle',
    message: '',
    checkUrl: 'https://www.kktv.me',
  },
  {
    name: 'Hami Video',
    status: 'idle',
    message: '',
    checkUrl: 'https://hamivideo.hinet.net',
  },
  {
    name: 'myTVSuper',
    status: 'idle',
    message: '',
    checkUrl: 'https://www.mytvsuper.com',
  },
  {
    name: 'Bilibili港澳台',
    status: 'idle',
    message: '',
    checkUrl: 'https://www.bilibili.com',
  },
  {
    name: 'Bilibili台湾',
    status: 'idle',
    message: '',
    checkUrl: 'https://www.bilibili.com',
  }
];

// 将服务按区域分类
type RegionKey = '热门国际' | '北美' | '英国' | '亚洲' | '欧洲' | '日本' | '港台' | 'AI服务';

const SERVICES_BY_REGION: Record<RegionKey, string[]> = {
  '热门国际': ['Netflix', 'Disney+', 'YouTube Premium', 'HBO Max', 'Amazon Prime Video'],
  '北美': ['Hulu', 'Paramount+', 'Peacock TV'],
  '英国': ['BBC iPlayer', 'ITV', 'Channel 4', 'BritBox'],
  '亚洲': ['TVB Anywhere+', 'Viu', 'Hotstar'],
  '欧洲': ['Viaplay', 'Dazn', 'Showmax'],
  '日本': ['U-NEXT', 'WOWOW', 'AbemaTV', 'Niconico'],
  '港台': ['KKTV', 'Hami Video', 'myTVSuper', 'Bilibili港澳台', 'Bilibili台湾'],
  'AI服务': ['ChatGPT', 'Meta AI', 'Bing区域']
};

const MediaStreamingTest: React.FC<MediaStreamingTestProps> = ({ currentNode, onTestComplete }) => {
  const [services, setServices] = useState<StreamingService[]>(DEFAULT_SERVICES);
  const [isTestRunning, setIsTestRunning] = useState(false);
  const [testProgress, setTestProgress] = useState(0);
  const [testStartTime, setTestStartTime] = useState<Date | null>(null);
  const [testEndTime, setTestEndTime] = useState<Date | null>(null);
  const [selectedServiceLog, setSelectedServiceLog] = useState<string | null>(null);
  const [logContent, setLogContent] = useState<string>('');
  const [activeTab, setActiveTab] = useState<'全部' | RegionKey>('全部');
  const [showShareButton, setShowShareButton] = useState(false);
  const [isGeneratingImage, setIsGeneratingImage] = useState(false);
  const [reportImage, setReportImage] = useState<string | null>(null);
  const [showShareDialog, setShowShareDialog] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);

  // 开始测试流媒体服务
  const startTest = async () => {
    setIsTestRunning(true);
    setTestProgress(0);
    setTestStartTime(new Date());
    setTestEndTime(null);
    setShowShareButton(false);
    setReportImage(null);

    // 获取当前要测试的服务列表
    const servicesToTest = getFilteredServices();
    
    // 重置要测试的服务状态
    setServices(prev => {
      const newServices = [...prev];
      // 只重置当前要测试的服务
      servicesToTest.forEach(service => {
        const index = newServices.findIndex(s => s.name === service.name);
        if (index !== -1) {
          newServices[index] = {
            ...newServices[index],
            status: 'checking',
            message: '检测中...',
            region: undefined,
            checkTime: undefined,
            dnsStatus: undefined,
            ipInfo: undefined
          };
        }
      });
      return newServices;
    });

    // 只测试当前标签页中的服务
    const testQueue = [...servicesToTest];
    let completed = 0;
    
    console.log(`开始检测${activeTab === '全部' ? '所有' : activeTab}服务(共${testQueue.length}个)，当前节点:`, currentNode);
    console.log('是否存在API:', window.electronAPI && typeof window.electronAPI.testMediaStreaming === 'function' ? '是' : '否');

    // 依次测试每个服务
    for (let index = 0; index < testQueue.length; index++) {
      const service = testQueue[index];
      
      try {
        let result: MediaStreamingTestResult;
        
        // 尝试使用Electron API
        if (window.electronAPI && typeof window.electronAPI.testMediaStreaming === 'function') {
          try {
            console.log(`尝试检测 ${service.name}，URL: ${service.checkUrl || '未指定'}`);
            
            // 特别记录特定服务的调用
            if (service.name === 'AbemaTV' || service.name === 'myTVSuper' || 
                service.name === 'Bilibili港澳台' || service.name === 'Bilibili台湾') {
              console.log(`特殊服务检测: ${service.name}，确保名称匹配后端case语句`);
            }
            
            result = await window.electronAPI.testMediaStreaming(service.name, service.checkUrl);
            console.log(`${service.name} 检测结果:`, result);
            
            if (!result) {
              throw new Error('API返回空结果');
            }
          } catch (apiError: any) {
            console.error(`API调用失败(${service.name}):`, apiError);
            
            // 显示错误状态而不是使用模拟数据
            setServices(prev => {
              const newServices = [...prev];
              const serviceIndex = newServices.findIndex(s => s.name === service.name);
              if (serviceIndex !== -1) {
                newServices[serviceIndex] = {
                  ...newServices[serviceIndex],
                  status: 'error',
                  message: `API调用失败: ${apiError.message || '未知错误'}`
                };
              }
              return newServices;
            });
            
            // 更新进度并继续下一个服务
            completed++;
            setTestProgress(Math.floor((completed / testQueue.length) * 100));
            continue; // 跳过后续处理，继续下一个服务
          }
        } else {
          console.error(`无法调用媒体检测API(${service.name})`);
          setServices(prev => {
            const newServices = [...prev];
            const serviceIndex = newServices.findIndex(s => s.name === service.name);
            if (serviceIndex !== -1) {
              newServices[serviceIndex] = {
                ...newServices[serviceIndex],
                status: 'error',
                message: 'API不可用，请重新启动应用'
              };
            }
            return newServices;
          });
          
          // 更新进度并继续下一个服务
          completed++;
          setTestProgress(Math.floor((completed / testQueue.length) * 100));
          continue; // 跳过后续处理，继续下一个服务
        }
        
        // 更新服务状态
        setServices(prev => {
          const newServices = [...prev];
          
          // 找到当前测试的服务并更新结果
          const serviceIndex = newServices.findIndex(s => s.name === service.name);
          if (serviceIndex !== -1) {
            newServices[serviceIndex] = {
              ...newServices[serviceIndex],
              status: result.available ? (result.fullSupport ? 'success' : 'partial') : 'error',
              message: result.message || (result.available ? (result.fullSupport ? '完全支持' : '部分支持') : '不支持'),
              region: result.region || undefined,
              checkTime: result.checkTime || undefined,
              dnsStatus: result.dnsStatus || undefined,
              ipInfo: result.ipInfo || undefined,
              logContent: ''  // 初始化日志内容为空字符串
            };
            
            // 如果有日志路径，尝试读取日志内容
            if (result.logPath) {
              // 假设日志路径就是日志内容
              newServices[serviceIndex].logContent = `当前节点: ${currentNode}\n日志路径: ${result.logPath}\n\n检测结果: ${JSON.stringify(result, null, 2)}`;
            }
          }
          
          return newServices;
        });
      } catch (error: any) {
        console.error(`测试过程中出错(${service.name}):`, error);
        // 处理测试过程中的错误
        setServices(prev => {
          const newServices = [...prev];
          const serviceIndex = newServices.findIndex(s => s.name === service.name);
          if (serviceIndex !== -1) {
            newServices[serviceIndex] = {
              ...newServices[serviceIndex],
              status: 'timeout',
              message: '检测超时或出错: ' + (error.message || '未知错误')
            };
          }
          return newServices;
        });
      }
      
      // 添加一小段延迟，避免请求过快
      await new Promise(resolve => setTimeout(resolve, 300));
      
      // 更新进度
      completed++;
      setTestProgress(Math.floor((completed / testQueue.length) * 100));
    }

    // 测试完成
    setIsTestRunning(false);
    setTestEndTime(new Date());
    
    // 如果是在"全部"标签下完成了测试，显示分享按钮
    if (activeTab === '全部') {
      setShowShareButton(true);
    }
    
    if (onTestComplete) {
      onTestComplete(services);
    }
  };

  // 获取状态对应的颜色和图标
  const getStatusInfo = (status: StreamingServiceStatus, service: StreamingService) => {
    // 根据服务名称和状态返回更详细的文本信息
    const getDetailedStatusText = (service: StreamingService) => {
      if (status === 'success') {
        // 特定服务显示自定义文本
        if (service.name === 'Netflix' || service.name === 'HBO Max' || 
            service.name === 'Disney+' || service.name === 'Amazon Prime Video') {
          return service.region ? `解锁(${service.region})` : '已解锁';
        }
        // 其他服务直接显示已解锁
        return service.region ? `已解锁(${service.region})` : '已解锁';
      } else if (status === 'partial') {
        // 针对特定服务返回更详细的部分支持信息
        if (service.name === 'Netflix') {
          return '自制剧';
        } else if (service.name === 'Disney+') {
          return '部分地区';
        } else if (service.name === 'HBO Max') {
          return '部分内容';
        } else if (service.name === 'Amazon Prime Video') {
          return '部分内容';
        } else {
          return '部分支持';
        }
      } else if (status === 'error') {
        return '不可用';
      } else if (status === 'checking') {
        return '检测中';
      } else if (status === 'timeout') {
        return '超时';
      }
      return '';
    };

    switch (status) {
      case 'success':
        return { color: 'text-green-500 bg-green-50 dark:bg-green-900/20', icon: <Check className="w-4 h-4" />, text: getDetailedStatusText(service) };
      case 'partial':
        return { color: 'text-yellow-500 bg-yellow-50 dark:bg-yellow-900/20', icon: <AlertTriangle className="w-4 h-4" />, text: getDetailedStatusText(service) };
      case 'error':
        return { color: 'text-red-500 bg-red-50 dark:bg-red-900/20', icon: <X className="w-4 h-4" />, text: getDetailedStatusText(service) };
      case 'checking':
        return { color: 'text-blue-500 bg-blue-50 dark:bg-blue-900/20', icon: <Loader2 className="w-4 h-4 animate-spin" />, text: getDetailedStatusText(service) };
      case 'timeout':
        return { color: 'text-gray-500 bg-gray-50 dark:bg-gray-900/20', icon: <AlertTriangle className="w-4 h-4" />, text: getDetailedStatusText(service) };
      default:
        return { color: 'text-gray-400 bg-gray-50 dark:bg-gray-900/20', icon: <AlertTriangle className="w-4 h-4" />, text: getDetailedStatusText(service) };
    }
  };

  // 过滤特定区域的服务
  const getFilteredServices = () => {
    if (activeTab === '全部') {
      return services;
    }
    
    const regionServices = SERVICES_BY_REGION[activeTab];
    return services.filter(service => regionServices.includes(service.name));
  };

  const viewServiceLog = (service: StreamingService) => {
    setSelectedServiceLog(service.name);
    setLogContent(service.logContent || '');
  };

  // 生成测试报告图片
  const generateReportImage = async () => {
    setIsGeneratingImage(true);
    
    try {
      // 预先准备报告数据
      const successCount = services.filter(s => s.status === 'success').length;
      const partialCount = services.filter(s => s.status === 'partial').length;
      const errorCount = services.filter(s => s.status === 'error').length;
      
      // 获取所有需要显示的服务
      const servicesForReport = services.filter(s => 
        s.status !== 'idle' && s.status !== 'checking'
      );
      
      // 预加载logo
      await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = resolve;
        img.onerror = reject;
        img.src = '/logo.png';
      }).catch(() => {
        console.warn('Logo加载失败，继续生成报告');
      });
      
      // 构建服务卡片HTML
      const serviceCardsHtml = servicesForReport.reduce((acc, service, index) => {
        const statusColor = 
          service.status === 'success' ? '#10b981' : 
          service.status === 'partial' ? '#f59e0b' : 
          service.status === 'error' ? '#ef4444' : '#6b7280';
        
        const statusBg = 
          service.status === 'success' ? '#ecfdf5' : 
          service.status === 'partial' ? '#fffbeb' : 
          service.status === 'error' ? '#fef2f2' : '#f9fafb';
          
        const statusText = 
          service.status === 'success' ? '解锁' : 
          service.status === 'partial' ? '部分' : 
          service.status === 'error' ? '未解锁' : '未知';
        
        // 创建服务卡片HTML
        const cardHtml = `
          <div style="border:1px solid #e5e7eb;border-radius:16px;padding:12px 16px;display:flex;justify-content:space-between;align-items:center;background:white;">
            <div style="font-size:14px;font-weight:500;color:#1f2937;">${service.name}</div>
            <div style="display:flex;align-items:center;gap:6px;">
              <div style="height:20px;line-height:20px;display:inline-block;background:${statusBg};border-radius:6px;padding:0 8px;color:${statusColor};font-size:12px;font-weight:600;">
                ${service.status === 'success' ? '✓ ' : service.status === 'partial' ? '! ' : '✕ '}
                ${service.region ? `${service.region} ` : ''}${statusText}
              </div>
            </div>
          </div>
        `;
        
        // 如果是偶数索引，创建新的行开始
        if (index % 2 === 0) {
          acc.push(`<div style="display:flex;gap:12px;margin-bottom:12px;">`);
        }
        
        // 添加卡片到当前行
        acc[acc.length - 1] += `<div style="flex:1;">${cardHtml}</div>`;
        
        // 如果是奇数索引或是最后一个元素，关闭当前行
        if (index % 2 === 1 || index === servicesForReport.length - 1) {
          // 如果是最后一个元素且是偶数索引，添加一个空的占位div保持对齐
          if (index === servicesForReport.length - 1 && index % 2 === 0) {
            acc[acc.length - 1] += `<div style="flex:1;"></div>`;
          }
          acc[acc.length - 1] += `</div>`;
        }
        
        return acc;
      }, [] as string[]).join('');

      // 创建一个容器元素
      const container = document.createElement('div');
      container.style.cssText = 'position:fixed;left:-9999px;top:0;width:720px;background:white;';
      document.body.appendChild(container);

      // 设置容器内容
      container.innerHTML = `
        <div style="padding:24px;font-family:system-ui,-apple-system,sans-serif;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;">
            <div style="display:flex;align-items:center;">
              <img src="/logo.png" alt="FlyClash Logo" style="width:44px;height:44px;margin-right:12px;" />
              <div>
                <h1 style="margin:0;font-size:22px;font-weight:600;color:#1f2937;">FlyClash</h1>
                <p style="margin:2px 0 0;font-size:13px;color:#6b7280;">简洁美观的代理工具</p>
              </div>
            </div>
            <div style="font-size:16px;font-weight:700;color:#3b82f6;">
              流媒体解锁测试报告
            </div>
          </div>
          
          <div style="background:white;border:1px solid #e5e7eb;border-radius:16px;padding:16px;margin-bottom:16px;">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;">
              <div>
                <div style="font-size:13px;color:#4b5563;margin-bottom:6px;display:flex;align-items:center;height:16px;">
                  <span style="color:#6b7280;margin-right:6px;line-height:16px;display:inline-block;">⦿</span>
                  <span style="line-height:16px;">节点: <b>${currentNode || '默认'}</b></span>
                </div>
                <div style="font-size:13px;color:#4b5563;display:flex;align-items:center;height:16px;">
                  <span style="color:#6b7280;margin-right:6px;line-height:16px;display:inline-block;">⧖</span>
                  <span style="line-height:16px;">测试时间: ${testEndTime ? new Date(testEndTime).toLocaleString() : '未知'}</span>
                </div>
              </div>
              <div style="text-align:right;">
                <div style="display:flex;align-items:center;justify-content:flex-end;margin-bottom:6px;height:16px;">
                  <span style="color:#10b981;margin-right:6px;line-height:16px;display:inline-block;">✓</span>
                  <span style="font-size:13px;color:#4b5563;line-height:16px;">已解锁: <b>${successCount}</b></span>
                </div>
                <div style="display:flex;align-items:center;justify-content:flex-end;margin-bottom:6px;height:16px;">
                  <span style="color:#f59e0b;margin-right:6px;line-height:16px;display:inline-block;">!</span>
                  <span style="font-size:13px;color:#4b5563;line-height:16px;">部分解锁: <b>${partialCount}</b></span>
                </div>
                <div style="display:flex;align-items:center;justify-content:flex-end;height:16px;">
                  <span style="color:#ef4444;margin-right:6px;line-height:16px;display:inline-block;">✕</span>
                  <span style="font-size:13px;color:#4b5563;line-height:16px;">未解锁: <b>${errorCount}</b></span>
                </div>
              </div>
            </div>
          </div>
          
          <div style="margin-bottom:24px;">
            ${serviceCardsHtml}
          </div>
          
          <div style="text-align:center;margin-top:24px;">
            <div style="font-size:12px;color:#9ca3af;margin-bottom:12px;">
              结果仅供参考，不同节点的解锁方案测试结果可能存在差异
            </div>
            <div style="border-top:1px solid #e5e7eb;padding-top:12px;font-size:12px;color:#9ca3af;display:flex;align-items:center;justify-content:center;">
              <span>Powered by FlyClash</span>
              <span style="margin:0 8px;">•</span>
              <span>${new Date().toISOString().split('T')[0]}</span>
            </div>
          </div>
        </div>
      `;

      // 等待内容渲染
      await new Promise(resolve => setTimeout(resolve, 500));

      try {
        // 动态导入html2canvas
        const html2canvasModule = await import('html2canvas');
        const html2canvas = html2canvasModule.default;
        
        // 捕获DOM生成图片
        const canvas = await html2canvas(container.firstElementChild as HTMLElement, {
          backgroundColor: '#ffffff',
          scale: 2,
          logging: true,
          useCORS: true,
          allowTaint: true,
          onclone: (clonedDoc) => {
            const clonedElement = clonedDoc.querySelector('div');
            if (clonedElement) {
              (clonedElement as HTMLElement).style.position = 'static';
            }
          }
        });

        // 生成图片
        const imageUrl = canvas.toDataURL('image/png', 1.0);
        setReportImage(imageUrl);
        setShowShareDialog(true);
      } finally {
        // 清理容器
        document.body.removeChild(container);
      }
    } catch (error) {
      console.error('生成报告图片失败:', error);
      alert('生成报告图片失败: ' + (error instanceof Error ? error.message : String(error)));
    } finally {
      setIsGeneratingImage(false);
    }
  };
  
  // 下载报告图片
  const downloadReportImage = () => {
    if (!reportImage) return;
    
    const link = document.createElement('a');
    link.href = reportImage;
    link.download = `FlyClash流媒体测试报告_${new Date().toISOString().split('T')[0]}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };
  
  // 复制报告图片到剪贴板
  const copyReportImageToClipboard = async () => {
    if (!reportImage) return;
    
    try {
      // 尝试使用现代API复制
      const response = await fetch(reportImage);
      const blob = await response.blob();
      
      try {
        // 尝试使用现代Clipboard API
        await navigator.clipboard.write([
          new ClipboardItem({
            [blob.type]: blob
          })
        ]);
        // 设置复制成功状态
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch (clipboardError) {
        console.error('现代剪贴板API失败:', clipboardError);
        
        // 回退策略：创建一个临时图片元素
        const img = document.createElement('img');
        img.src = reportImage;
        
        // 将图片添加到DOM
        document.body.appendChild(img);
        
        try {
          // 创建一个选区并尝试复制
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNode(img);
          selection?.removeAllRanges();
          selection?.addRange(range);
          
          const success = document.execCommand('copy');
          if (success) {
            // 设置复制成功状态
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          } else {
            throw new Error('execCommand失败');
          }
        } catch (execCommandError) {
          console.error('execCommand复制失败:', execCommandError);
          setCopyError(true);
          setTimeout(() => setCopyError(false), 2000);
        } finally {
          // 移除临时元素
          document.body.removeChild(img);
          window.getSelection()?.removeAllRanges();
        }
      }
    } catch (error) {
      console.error('复制到剪贴板失败:', error);
      setCopyError(true);
      setTimeout(() => setCopyError(false), 2000);
    }
  };

  return (
    <div className="flex flex-col h-[500px] max-h-[90vh] overflow-hidden">
      {/* 区域分类标签页和进度条 */}
      <div className="flex flex-col gap-1 mb-2 flex-shrink-0">
        {isTestRunning && (
          <div className="flex items-center justify-between mb-1">
            <div className="flex-1 mr-2">
              <div className="h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                <div 
                  className="h-full bg-blue-500 rounded-full transition-all duration-300"
                  style={{ width: `${testProgress}%` }}
                />
              </div>
            </div>
            <span className="text-xs font-medium">{testProgress}%</span>
          </div>
        )}

        {/* 显示当前节点 */}
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs text-gray-500 dark:text-gray-400 flex items-center">
            <span className="font-medium mr-1">当前节点:</span>
            <Badge variant="outline" className="text-xs py-0 h-5 bg-gray-50 dark:bg-gray-800">
              {currentNode || '未选择'}
            </Badge>
          </div>
        </div>

        <div className="flex flex-wrap gap-1 mb-1">
          <Button
            variant={activeTab === '全部' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setActiveTab('全部')}
            className={cn(
              "h-6 text-xs px-2",
              activeTab === '全部' ? 'bg-blue-500 hover:bg-blue-600 text-white' : ''
            )}
          >
            全部
          </Button>
          {Object.keys(SERVICES_BY_REGION).map(region => (
            <Button
              key={region}
              variant={activeTab === region ? 'default' : 'outline'}
              size="sm"
              onClick={() => setActiveTab(region as RegionKey)}
              className={cn(
                "h-6 text-xs px-2",
                activeTab === region ? 'bg-blue-500 hover:bg-blue-600 text-white' : ''
              )}
            >
              {region}
            </Button>
          ))}
        </div>
      </div>

      {/* 滚动内容区域 */}
      <div className="flex-grow overflow-y-auto pr-2">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pb-2">
          {getFilteredServices().map((service, index) => {
            const { color, icon, text } = getStatusInfo(service.status, service);
            return (
              <div 
                key={index}
                className={cn(
                  "p-2.5 rounded-lg border flex items-center space-x-2 transition-colors shadow-sm",
                  service.status === 'checking' ? 'border-blue-200 dark:border-blue-800' : 'border-gray-200 dark:border-gray-800',
                  service.status === 'success' && 'border-green-200 dark:border-green-800',
                  service.status === 'partial' && 'border-yellow-200 dark:border-yellow-800',
                  service.status === 'error' && 'border-red-200 dark:border-red-800'
                )}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center">
                      <p className="text-sm font-medium mr-2">
                        {service.name}
                      </p>
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Badge 
                              variant="outline" 
                              className={cn("flex items-center space-x-1 text-xs py-0.5", color)}
                            >
                              {icon}
                              <span>{text}</span>
                            </Badge>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs">
                            <div className="text-sm font-medium mb-1">
                              {service.name} {text ? `(${text})` : ''}
                            </div>
                            <p className="text-xs">{service.message}</p>
                            {service.region && <p className="text-xs mt-1 font-medium">解锁区域: {service.region}</p>}
                            {service.checkTime && <p className="text-xs">检测耗时: {service.checkTime}ms</p>}
                            {service.dnsStatus && (
                              <div className="mt-1 text-xs">
                                <p>DNS解析: {service.dnsStatus.resolved ? '已解析' : '解析失败'}</p>
                                {service.dnsStatus.resolved && (
                                  <p>解析IP: {service.dnsStatus.ip}</p>
                                )}
                              </div>
                            )}
                            {service.ipInfo && (
                              <div className="mt-1 border-t pt-1 border-gray-200 dark:border-gray-700 text-xs">
                                <p>代理IP: {service.ipInfo.ip}</p>
                                {service.ipInfo.country && (
                                  <p>位置: {service.ipInfo.country} {service.ipInfo.region} {service.ipInfo.city}</p>
                                )}
                                {service.ipInfo.org && (
                                  <p>ISP提供商: {service.ipInfo.org}</p>
                                )}
                              </div>
                            )}
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </div>
                    
                    {service.status !== 'idle' && service.status !== 'checking' && (
                      <Dialog>
                        <DialogTrigger asChild>
                          <Button 
                            variant="ghost" 
                            size="icon" 
                            className="h-6 w-6"
                            onClick={() => viewServiceLog(service)}
                          >
                            <FileText className="h-4 w-4" />
                          </Button>
                        </DialogTrigger>
                        <DialogContent className="w-[80vw] max-w-[500px] h-[400px] max-h-[80vh] flex flex-col">
                          <DialogHeader className="flex-shrink-0 pb-2">
                            <DialogTitle className="text-base">
                              {service.name} 检测日志
                              <div className="text-xs font-normal text-gray-500 mt-1">节点: {currentNode}</div>
                            </DialogTitle>
                          </DialogHeader>
                          <div className="flex-grow overflow-auto border rounded">
                            <pre className="text-xs p-3 bg-gray-900 text-white whitespace-pre-wrap overflow-x-auto h-full">
                              {logContent || '加载中...'}
                            </pre>
                          </div>
                        </DialogContent>
                      </Dialog>
                    )}
                  </div>
                  
                  <div className="flex items-center mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                    {service.region && (
                      <span className="font-medium">{service.region}</span>
                    )}
                    {service.checkTime && (
                      <>
                        {service.region && <span className="text-gray-300 mx-1">•</span>}
                        <span>{service.checkTime}ms</span>
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        
        {getFilteredServices().length > 6 && (
          <div className="text-center text-xs text-gray-400 mt-2 mb-1 animate-pulse">
            上下滚动查看更多服务
          </div>
        )}
      </div>

      {/* 底部按钮区域 */}
      <div className="flex justify-end items-center border-t border-gray-100 dark:border-gray-800 pt-2 mt-auto pb-1 flex-shrink-0">
        {showShareButton && !isTestRunning && (
          <Button
            onClick={generateReportImage}
            disabled={isGeneratingImage}
            className="bg-green-500 hover:bg-green-600 text-white h-8 px-4 mr-2"
            variant="default"
          >
            {isGeneratingImage ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                生成报告...
              </>
            ) : (
              <>
                <Share2 className="mr-2 h-4 w-4" />
                分享测试结果
              </>
            )}
          </Button>
        )}
        <Button
          onClick={startTest}
          disabled={isTestRunning}
          className="bg-blue-500 hover:bg-blue-600 text-white h-8 px-4"
          variant="default"
        >
          {isTestRunning ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              检测中...
            </>
          ) : (
            <>
              <RefreshCw className="mr-2 h-4 w-4" />
              {services.some(s => s.status !== 'idle') ? '重新检测' : '开始检测'}
            </>
          )}
        </Button>
      </div>
      
      {/* 隐藏的报告生成区域 - 移除ref */}
      <div id="reportContainer" style={{ display: 'none', position: 'fixed', left: '-9999px' }}></div>
      
      {/* 分享对话框 */}
      <Dialog open={showShareDialog} onOpenChange={setShowShareDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>测试报告</DialogTitle>
          </DialogHeader>
          
          {reportImage && (
            <div className="mt-4 flex flex-col items-center">
              <div className="border rounded-lg overflow-hidden shadow-sm mb-4 max-h-[60vh]">
                <div className="relative">
                  {/* 预览图片容器 */}
                  <div className="max-h-[60vh] overflow-hidden">
                    <img 
                      src={reportImage} 
                      alt="测试报告" 
                      className="w-full h-auto"
                    />
                  </div>
                  {/* 渐变遮罩 */}
                  <div className="absolute bottom-0 left-0 right-0 h-20 bg-gradient-to-t from-white to-transparent pointer-events-none" />
                </div>
              </div>
              
              <div className="flex flex-col gap-3 w-full">
                <p className="text-center text-sm text-gray-500">
                  点击下方按钮获取完整报告
                </p>
                <div className="flex justify-center space-x-4">
                  <Button 
                    variant="outline" 
                    onClick={downloadReportImage}
                    className="w-32"
                  >
                    <Download className="h-4 w-4 mr-2" />
                    下载图片
                  </Button>
                  <Button 
                    variant="default" 
                    onClick={copyReportImageToClipboard}
                    className="w-32"
                    disabled={copied || copyError}
                  >
                    {copied ? (
                      <>
                        <Check className="h-4 w-4 mr-2" />
                        已复制
                      </>
                    ) : copyError ? (
                      <>
                        <X className="h-4 w-4 mr-2" />
                        复制失败
                      </>
                    ) : (
                      <>
                        <Copy className="h-4 w-4 mr-2" />
                        复制图片
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default MediaStreamingTest; 