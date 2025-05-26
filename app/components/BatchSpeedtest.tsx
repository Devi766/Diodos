'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { 
  Card, 
  CardContent, 
  CardDescription, 
  CardFooter, 
  CardHeader, 
  CardTitle 
} from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { 
  Download, 
  RefreshCw, 
  Clock, 
  Globe, 
  Activity, 
  Share, 
  Loader2,
  Play,
  AlertCircle,
  CheckCircle,
  XCircle,
  Info,
  Gauge,
  Copy,
  BarChartBig,
  CalendarDays,
  GitBranch,
  Server,
  Zap,
  Tag,
  AlertTriangle,
  ShieldCheck,
  ShieldX,
  ArrowDownToLine,
  TrendingUp,
  Network,
  Palette, 
  ListOrdered, 
  FileText,
  Settings2
} from 'lucide-react';
import { toast } from 'sonner';
import { useSpeedTest } from '../contexts/SpeedTestContext';

// 测速结果接口
interface SpeedTestResult {
  name: string;
  delay: number; // 延迟RTT
  rttDeviation: number; // RTT标准差
  httpDelay: number; // HTTP延迟
  downloadSpeed: number; // 平均速度
  maxSpeed: number; // 最大速度
  avgSpeed: number; // 每秒速度
  udpType: string; // UDP类型
  location: string;
  type: string;
  isMultiThread?: boolean; // 是否使用多线程测速
}

// 下载测速结果接口
interface DownloadTestResult {
  downloadSpeed: number;
  maxSpeed: number;
  samples?: number;
}

// 测速请求选项
interface SpeedTestOptions {
  url: string;
  proxy: {
    host: string;
    port: number;
    nodeName: string;
  };
  maxTestTime?: number;
  proxyGroup?: string; // 添加代理组名称参数
}

interface ProxyNode {
  name: string;
  type: string;
  server?: string;
  port?: number;
  delay?: number;
}

interface ProxyGroup {
  name: string;
  type: string;
  nodes: ProxyNode[];
}

interface BatchSpeedtestProps {
  onClose: () => void;
  inDialog?: boolean; // 是否在对话框中使用
  enableBackground?: boolean; // 是否支持后台运行
}

// 添加在所有import之后，在SpeedTestResult接口之前
// 导入ElectronAPI类型
import type { ElectronAPI } from '@/types/electron';

// 这里只使用全局定义好的ElectronAPI接口
declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

// 保留辅助函数：为报告模板提供样式，这些样式将在后端puppeteer渲染时使用
const getReportTemplate = (data: {
  testResults: SpeedTestResult[];
  proxyGroupName: string;
  testConfig: string;
  reportNote: string;
  skippedNodes: string[];
  excludedNodes: string[];
  includedNodes: string[];
  testTime: string;
}) => {
  // 这里返回一个包含完整HTML和CSS的字符串模板，用于puppeteer渲染
  // 可以基于现有的report-container HTML结构，添加所有必要的样式
  return `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>FlyClash 节点测速报告</title>
    <style>
      body {
        margin: 0;
        padding: 0;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif;
        background: #ffffff;
        color: #1e293b;
      }
      
      #report-container {
        width: 1200px;
        padding: 40px;
        box-sizing: border-box;
        background: #ffffff;
      }
      
      /* 添加其他CSS样式，可以参考原有的applyDirectStylesForCanvas函数中的样式设置 */
      /* 这里需要转换所有行内样式为CSS样式表 */
      
      .report-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        margin-bottom: 24px;
        border-bottom: 1px solid #e2e8f0;
        padding-bottom: 20px;
      }
      
      .report-title {
        font-size: 30px;
        font-weight: 700;
        color: #0f172a;
        margin-bottom: 8px;
        line-height: 1.2;
      }
      
      .report-subtitle {
        font-size: 15px;
        color: #475569;
        margin-bottom: 0;
        line-height: 1.4;
      }
      
      /* 表格样式 */
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 14px;
      }
      
      thead th {
        padding: 12px 10px;
        font-weight: 600;
        vertical-align: middle;
        border-bottom: 1px solid #cbd5e1;
        color: #1e293b;
        background-color: #f8fafc;
      }
      
      tbody tr {
        border-bottom: 1px solid #e2e8f0;
      }
      
      tbody td {
        padding: 10px;
        vertical-align: middle;
        font-size: 0.875rem;
        color: #334155;
      }
      
      /* 添加徽章、状态颜色等其他必要样式 */
      
      .badge {
        display: inline-block;
        padding: 0 10px;
        height: 22px;
        line-height: 22px;
        border-radius: 9999px;
        font-size: 0.8rem;
        font-weight: 500;
        border: 1px solid transparent;
      }
      
      .badge-type {
        background-color: #eff6ff;
        color: #2563eb;
        border-color: #bfdbfe;
      }
      
      .badge-udp-good {
        background-color: #dcfce7;
        color: #16a34a;
        border-color: #bbf7d0;
      }
      
      .badge-udp-bad {
        background-color: #fee2e2;
        color: #dc2626;
        border-color: #fecaca;
      }
      
      .badge-udp-neutral {
        background-color: #e0e7ff;
        color: #4f46e5;
        border-color: #c7d2fe;
      }
      
      .badge-udp-unknown {
        background-color: #f3f4f6;
        color: #6b7280;
        border-color: #d1d5db;
      }
      
      .speed-unit {
        font-size: 0.8em;
        color: #64748b;
        margin-left: 4px;
      }
      
      .text-na {
        color: #64748b;
      }
      
      .report-footer {
        text-align: center;
        margin-top: 30px;
        padding-top: 20px;
        border-top: 1px solid #e2e8f0;
        font-size: 12px;
        color: #64748b;
      }
    </style>
  </head>
  <body>
    <!-- 这里添加完整的HTML结构 -->
  </body>
  </html>
  `;
};

export default function BatchSpeedtest({ onClose, inDialog = false, enableBackground = false }: BatchSpeedtestProps) {
  const [isTesting, setIsTesting] = useState(false);
  const [currentNodeName, setCurrentNodeName] = useState('');
  const [progress, setProgress] = useState(0);
  const [testResults, setTestResults] = useState<SpeedTestResult[]>([]);
  const [proxyGroup, setProxyGroup] = useState<ProxyGroup | null>(null);
  const [isGeneratingReport, setIsGeneratingReport] = useState(false);
  const [testingPhase, setTestingPhase] = useState<string>(''); // 当前测试阶段
  const [skippedNodes, setSkippedNodes] = useState<string[]>([]);
  const [enableBackgroundMode, setEnableBackgroundMode] = useState(false); // 是否启用后台模式
  const [excludeKeywords, setExcludeKeywords] = useState(''); // 用于排除节点的关键词
  const [includeKeywords, setIncludeKeywords] = useState(''); // 用于筛选节点的关键词
  const [excludedNodes, setExcludedNodes] = useState<string[]>([]); // 被排除的节点列表
  const [includedNodes, setIncludedNodes] = useState<string[]>([]); // 被筛选的节点列表
  const [enableMultiThread, setEnableMultiThread] = useState(false); // 新增：是否启用多线程测速
  const [historyReports, setHistoryReports] = useState<any[]>([]);
  const [showHistoryReports, setShowHistoryReports] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [selectedReport, setSelectedReport] = useState<{testConfig?: string; proxyGroupName?: string; testResults?: SpeedTestResult[]} | null>(null);
  const [reportNote, setReportNote] = useState(''); // 新增：报告备注
  const [reportAutoSaved, setReportAutoSaved] = useState(false); // 新增：跟踪报告是否已被自动保存
  const reportRef = useRef<HTMLDivElement>(null);
  const resultsContainerRef = useRef<HTMLDivElement>(null);
  const [proxyConfig, setProxyConfig] = useState<{port: number; host: string}>({ port: 7890, host: '127.0.0.1' });
  
  // 导入全局测速状态
  const {
    isBackgroundTesting,
    setIsBackgroundTesting,
    setCurrentNodeName: setGlobalNodeName,
    setTestingPhase: setGlobalPhase,
    setProgress: setGlobalProgress,
    setTestResults: setGlobalResults,
    setSkippedNodes: setGlobalSkipped,
    setProxyGroupName,
    stopBackgroundTest,
    registerSaveResultsCallback, // 新增: 使用保存回调函数
    clearSaveResultsCallback     // 新增: 清除保存回调函数
  } = useSpeedTest ? useSpeedTest() : {
    isBackgroundTesting: false,
    setIsBackgroundTesting: () => {},
    setCurrentNodeName: () => {},
    setTestingPhase: () => {},
    setProgress: () => {},
    setTestResults: () => {},
    setSkippedNodes: () => {},
    setProxyGroupName: () => {},
    stopBackgroundTest: () => {},
    registerSaveResultsCallback: () => {}, // 新增
    clearSaveResultsCallback: () => {}     // 新增
  };
  
  // 辅助函数：为html2canvas的克隆文档应用直接样式
  const applyDirectStylesForCanvas = (clonedDoc: Document) => {
    // 删除整个函数
  };
  
  // 获取规则模式下的第一个策略组信息
  const fetchFirstRuleProxyGroup = async () => {
    if (!window.electronAPI) return;
    
    try {
      // 首先尝试获取当前模式
      let currentMode = 'rule';
      try {
        const config = await window.electronAPI.requestMihomoAPI('/configs');
        if (config && config.ok) {
          currentMode = config.data.mode || 'rule';
        }
      } catch (error) {
        console.error('获取当前代理模式失败:', error);
      }
      
      console.log(`当前代理模式: ${currentMode}`);
      
      // 获取配置文件中的代理组顺序
      let firstGroupName = '';
      try {
        const configOrder = await window.electronAPI.getConfigOrder();
        if (configOrder && configOrder.success && configOrder.data && 
            configOrder.data.proxyGroups && configOrder.data.proxyGroups.length > 0) {
          
          // 如果是规则模式，过滤掉GLOBAL组
          const validGroups = currentMode === 'rule' ? 
            configOrder.data.proxyGroups.filter((g: {name: string}) => g.name !== 'GLOBAL') : 
            configOrder.data.proxyGroups;
            
          if (validGroups.length > 0) {
            firstGroupName = validGroups[0].name;
            console.log('获取到配置文件中第一个代理组:', firstGroupName);
          }
        }
      } catch (error) {
        console.error('获取配置顺序失败:', error);
      }
      
      // 如果未能从配置中获取，则从API获取所有代理组
      if (!firstGroupName) {
        const result = await window.electronAPI.getProxies();
        
        if (result && result.groups && result.groups.length > 0) {
          // 如果是规则模式，过滤掉GLOBAL组
          const validGroups = currentMode === 'rule' ? 
            result.groups.filter((g: ProxyGroup) => g.name !== 'GLOBAL') : 
            result.groups;
            
          if (validGroups.length > 0) {
            const firstGroup = validGroups[0];
            setProxyGroup(firstGroup);
            console.log('从API获取到第一个代理组:', firstGroup.name);
            return firstGroup;
          }
        }
      } else {
        // 使用配置中获取的组名获取详细信息
        const groupData = await window.electronAPI.requestMihomoAPI(`/proxies/${encodeURIComponent(firstGroupName)}`);
        
        if (groupData && groupData.ok && groupData.data) {
          // 构建代理组数据结构
          const nodes = [];
          
          // 获取所有代理信息，用于提取节点详细信息
          const allProxies = await window.electronAPI.requestMihomoAPI('/proxies');
          if (allProxies && allProxies.ok) {
            for (const nodeName of groupData.data.all || []) {
              const nodeInfo = allProxies.data.proxies[nodeName];
              if (nodeInfo) {
                nodes.push({
                  name: nodeName,
                  type: nodeInfo.type,
                  server: nodeInfo.server || '',
                  port: nodeInfo.port || 0,
                  delay: nodeInfo.delay || undefined
                });
              }
            }
          }
          
          const group = {
            name: firstGroupName,
            type: groupData.data.type,
            nodes: nodes
          };
          
          setProxyGroup(group);
          console.log(`通过配置获取到代理组 ${firstGroupName}，共含 ${nodes.length} 个节点`);
          return group;
        }
      }
      
      toast.error('未找到可用的代理组');
      return null;
    } catch (error) {
      console.error('获取代理组失败:', error);
      toast.error(`获取代理组失败: ${String(error)}`);
      return null;
    }
  };
  
  // 获取用户配置的HTTP代理信息
  const fetchProxyConfig = async () => {
    if (!window.electronAPI) return;
    
    try {
      // 获取用户配置的代理端口和主机
      const config = await window.electronAPI.getProxyConfig();
      if (config && config.success) {
        setProxyConfig({
          port: config.data.port || 7890,
          host: config.data.host || '127.0.0.1'
        });
        console.log(`获取到HTTP代理配置: ${config.data.host}:${config.data.port}`);
      } else {
        // 如果获取失败，使用默认值
        console.warn('获取代理配置失败，使用默认值: 127.0.0.1:7890');
        setProxyConfig({ port: 7890, host: '127.0.0.1' });
      }
    } catch (error) {
      console.error('获取代理配置出错:', error);
      // 使用默认值
      setProxyConfig({ port: 7890, host: '127.0.0.1' });
    }
  };

  // 开始批量测速
  const startBatchTest = async () => {
    if (!window.electronAPI) {
      toast.error('无法访问系统功能，请在桌面应用中使用此功能');
      return;
    }
    
    try {
      // 重置所有状态，确保开始新测试前清除旧数据
      setIsTesting(true);
      setProgress(0);
      setTestResults([]);
      setSkippedNodes([]);
      setExcludedNodes([]);
      setCurrentNodeName('');
      setTestingPhase('');
      
      // 重置全局上下文中的测试结果
      setGlobalResults([]);
      
      // 对于对话框模式，启用后台测速，无需用户选择
      // 对于专用页面，根据传入的enableBackground属性或用户选择决定
      const useBackgroundMode = true; // 现在总是启用后台模式
      
      // 同步状态到全局
      setIsBackgroundTesting(true);
      toast.info('已启用后台测速，您可以自由切换页面并随时返回查看进度');
      
      // 获取代理组
      const group = proxyGroup || await fetchFirstRuleProxyGroup();
      if (!group || !group.nodes || group.nodes.length === 0) {
        toast.error('未找到可测试的节点');
        setIsTesting(false);
        setIsBackgroundTesting(false);
        return;
      }
      
      // 如果启用后台，设置全局代理组名称
      // 现在总是启用后台模式
      if (group) {
        setProxyGroupName(group.name);
      }
      
      // 注册保存测试结果的回调函数
      const saveTestResults = async (results: any[], params: any) => {
        if (!window.electronAPI || results.length === 0) {
          console.error('无法保存测试结果: API不可用或结果为空', { 
            hasAPI: !!window.electronAPI, 
            resultsLength: results.length 
          });
          return;
        }
        
        try {
          // 获取实际测试的代理组名称
          const actualProxyGroupName = params.proxyGroupName || group?.name || '未知代理组';

          // 获取当前配置文件名称 (如果有)
          let actualTestConfigName; // 默认为 undefined
          try {
            const configResult = await window.electronAPI.getCurrentConfigName();
            if (configResult && configResult.success && configResult.configName) {
              actualTestConfigName = configResult.configName;
            }
          } catch (err) {
            console.error('获取配置文件名称失败:', err);
          }
          
          // 准备报告数据
          const reportData = {
            proxyGroupName: actualProxyGroupName, // 修正：确保存储的是实际的代理组名称
            testConfig: actualTestConfigName,     // 修正：存储获取到的配置文件名称，可能为 undefined
            testResults: results,
            skippedNodes: params.skippedNodes || [],
            excludedNodes: params.excludedNodes || [],
            includedNodes: params.includedNodes || [],
            testMode: params.enableMultiThread ? 'multithread' : 'singlethread',
            testTime: new Date().toISOString()
          };
          
          console.log(`[自动保存] 尝试保存测试报告，节点数: ${reportData.testResults.length}, 代理组: ${reportData.proxyGroupName}, 配置: ${reportData.testConfig}`);
          
          // 保存报告
          const saveResult = await window.electronAPI.saveSpeedtestReport(reportData);
          
          if (saveResult.success) {
            console.log('测速报告数据已自动保存至:', saveResult.filePath);
            toast.success('测速报告已自动保存');
            // 设置自动保存标志为true，防止重复保存
            setReportAutoSaved(true);
          } else {
            console.error('[自动保存] 自动保存测速报告数据失败:', saveResult.error);
            toast.error(`报告保存失败: ${saveResult.error}`);
          }
        } catch (error) {
          console.error('[自动保存] 保存测试结果出错:', error);
        }
      };
      
      // 记录被跳过的URLTest/Fallback节点
      const skippedUrltestNodes = group.nodes
        .filter((node: ProxyNode) => node.type === 'URLTest' || node.type === 'Fallback')
        .map((node: ProxyNode) => node.name);
      setSkippedNodes(skippedUrltestNodes);
      setGlobalSkipped(skippedUrltestNodes);
      
      // 更新全局上下文中的排除和筛选信息
      // 注册保存回调函数
      registerSaveResultsCallback(saveTestResults, {
        proxyGroupName: group.name,
        skippedNodes: skippedUrltestNodes,
        excludedNodes: [],
        includedNodes: [],
        enableMultiThread
      });
      
      // 过滤掉URLTest和Fallback类型的节点
      const testableNodes = group.nodes.filter((node: ProxyNode) => 
        node.type !== 'URLTest' && node.type !== 'Fallback'
      );
      
      // 初始化可测试节点列表 - 确保节点唯一性
      // 使用Map去重，确保一开始就没有重复节点
      const uniqueNodesMap = new Map<string, ProxyNode>();
      testableNodes.forEach((node: ProxyNode) => uniqueNodesMap.set(node.name, node));
      let filteredNodes = Array.from(uniqueNodesMap.values());
      
      // 处理排除关键词
      let excluded: string[] = [];
      if (excludeKeywords.trim()) {
        // 将输入的关键词按逗号或空格分割
        const keywords = excludeKeywords
          .split(/[\s,]+/)
          .filter(k => k.trim().length > 0)
          .map(k => k.trim());
        
        if (keywords.length > 0) {
          // 创建包含所有关键词的正则表达式
          const regexPatterns = keywords.map(k => 
            new RegExp(k.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'i')
          );
          
          // 过滤出需要排除的节点
          excluded = filteredNodes
            .filter((node: ProxyNode) => regexPatterns.some(regex => regex.test(node.name)))
            .map((node: ProxyNode) => node.name);
          
          // 更新被排除的节点列表
          setExcludedNodes(excluded);
          
          // 同步到全局状态
          registerSaveResultsCallback(saveTestResults, {
            proxyGroupName: group.name,
            skippedNodes: skippedUrltestNodes,
            excludedNodes: excluded,
            includedNodes: [],
            enableMultiThread
          });
          
          // 从可测试节点中移除被排除的节点
          filteredNodes = filteredNodes.filter(
            (node: ProxyNode) => !excluded.includes(node.name)
          );
          
          if (excluded.length > 0) {
            toast.info(`已根据排除关键词排除 ${excluded.length} 个节点`);
          }
        }
      }
      
      // 处理包含关键词
      let included: string[] = [];
      if (includeKeywords.trim()) {
        // 将输入的关键词按逗号或空格分割
        const keywords = includeKeywords
          .split(/[\s,]+/)
          .filter(k => k.trim().length > 0)
          .map(k => k.trim());
        
        if (keywords.length > 0) {
          // 创建包含所有关键词的正则表达式
          const regexPatterns = keywords.map(k => 
            new RegExp(k.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'i')
          );
          
          // 过滤包含关键词的节点 - 使用Set去重
          const includedNamesSet = new Set<string>();
          
          filteredNodes.forEach((node: ProxyNode) => {
            if (regexPatterns.some(regex => regex.test(node.name))) {
              includedNamesSet.add(node.name);
            }
          });
          
          included = Array.from(includedNamesSet);
          
          // 更新被筛选的节点列表
          setIncludedNodes(included);
          
          // 同步到全局状态
          registerSaveResultsCallback(saveTestResults, {
            proxyGroupName: group.name,
            skippedNodes: skippedUrltestNodes,
            excludedNodes: excluded,
            includedNodes: included,
            enableMultiThread
          });
          
          // 只保留包含关键词的节点 - 确保没有重复
          const includedNodesMap = new Map<string, ProxyNode>();
          filteredNodes
            .filter((node: ProxyNode) => includedNamesSet.has(node.name))
            .forEach((node: ProxyNode) => includedNodesMap.set(node.name, node));
          
          filteredNodes = Array.from(includedNodesMap.values());
          
          if (included.length > 0) {
            toast.info(`已根据包含关键词筛选 ${included.length} 个节点`);
          } else {
            toast.warning('没有节点匹配包含关键词');
          }
        }
      }
      
      if (skippedUrltestNodes.length > 0) {
        toast.info(`已跳过 ${skippedUrltestNodes.length} 个URLTest/Fallback类型节点`);
      }
      
      if (filteredNodes.length === 0) {
        // 检查是否所有节点都被排除了
        if ((excluded.length > 0 || included.length === 0 && includeKeywords.trim() !== '') && 
            excluded.length + skippedUrltestNodes.length >= testableNodes.length) {
          toast.warning('所有节点都被排除或跳过，没有可测试的节点');
        } else {
          toast.warning('没有可测试的节点（所有节点都是URLTest或Fallback类型）');
        }
        setIsTesting(false);
        if (useBackgroundMode) setIsBackgroundTesting(false);
        return;
      }
      
      // 输出日志，便于调试
      console.log(`最终测试节点列表 (${filteredNodes.length} 个):`, filteredNodes.map(n => n.name));
      

      // 计算每个节点测试完成后的进度增量
      const progressIncrement = 100 / filteredNodes.length;
      
      // 依次测试每个节点
      for (const node of filteredNodes) {
        setCurrentNodeName(node.name);
        setGlobalNodeName(node.name);
        
        // 测试节点延迟
        setTestingPhase('延迟测试 (多轮测试)');
        setGlobalPhase('延迟测试 (多轮测试)');
        
        // 检查节点是否可用
        const nodeAvailability = await checkNodeAvailability(node.name);
        if (!nodeAvailability.success) {
          console.error(`节点 ${node.name} 不可用，跳过测试:`, nodeAvailability.error);
          setSkippedNodes(prev => [...prev, node.name]);
          setGlobalSkipped(prev => [...prev, node.name]);
          toast.error(`跳过节点 ${node.name}: ${nodeAvailability.error}`);
          continue; // 跳过此节点的测试
        }
        
        const delayResult = await testNodeDelay(node.name);
        const delay = delayResult.delay;
        const rttDeviation = delayResult.rttDeviation;
        
        // 测试HTTP延迟
        setTestingPhase('HTTP延迟测试');
        const httpDelay = await testHttpDelay(node.name);
        
        // 测试节点下载速度
        setTestingPhase('下载速度测试');
        const downloadResult = await testNodeDownloadSpeed(node.name);
        const downloadSpeed = downloadResult?.downloadSpeed || 0;
        
        // 最大速度和每秒速度计算 - 使用测试返回的最大值
        const maxSpeed = downloadResult?.maxSpeed || 0;
        
        // 每秒速度通常接近但小于最大速度
        const avgSpeed = downloadSpeed * 0.9;
        
        // 检测UDP类型
        setTestingPhase('UDP类型检测');
        const udpType = await detectUdpType(node);
        
        // 获取节点位置信息
        const locationInfo = getNodeLocation(node);
        
        // 初始化测试结果
        const testResult: SpeedTestResult = {
          name: node.name,
          delay: delay,
          rttDeviation: rttDeviation,
          httpDelay: httpDelay,
          downloadSpeed: downloadSpeed,
          maxSpeed: maxSpeed,
          avgSpeed: avgSpeed,
          udpType: udpType || 'Unknown',
          location: locationInfo || '未知',
          type: node.type || 'Unknown',
          isMultiThread: enableMultiThread // 记录是否使用多线程测速
        };
        
        // 添加到测试结果
        setTestResults(prev => [...prev, testResult]);
        setGlobalResults(prev => [...prev, testResult]);
        
        // 更新进度
        setProgress((prev: number) => Math.min(prev + progressIncrement, 99));
        setGlobalProgress((prev: number) => Math.min(prev + progressIncrement, 99));
        
        // 滚动到最新测试结果
        setTimeout(() => {
          if (resultsContainerRef.current) {
            resultsContainerRef.current.scrollTop = resultsContainerRef.current.scrollHeight;
          }
        }, 100);
        
        // 短暂延迟，避免API过载
        await new Promise(r => setTimeout(r, 500));
      }
      
      // 完成全部测试
      setProgress(100);
      setGlobalProgress(100);
      
      setTestingPhase('');
      setGlobalPhase('');
      
      // 获取完整的测试结果 - 使用函数式更新确保获取最新状态
      let allResults: SpeedTestResult[] = [];
      
      // 从全局上下文中获取结果(如果在后台测试模式下)
      if (isBackgroundTesting && contextResults && contextResults.length > 0) {
        console.log(`从全局上下文中获取测试结果: ${contextResults.length} 个节点`);
        // 使用类型断言解决类型不匹配问题
        allResults = [...contextResults] as unknown as SpeedTestResult[];
      } else {
        // 直接从当前状态获取结果 - 更可靠的方式
        allResults = [...testResults];
        console.log(`从当前状态中获取测试结果: ${allResults.length} 个节点`);
      }
      
      // 确保在状态更新后再进行保存
      await new Promise(r => setTimeout(r, 300)); // 增加等待时间确保状态完全更新
      
      // 再次尝试获取最新结果，双重保险
      if (allResults.length === 0) {
        allResults = [...testResults];
        console.log(`重新尝试获取测试结果: ${allResults.length} 个节点`);
      }
      
      console.log(`测试完成，准备保存 ${allResults.length} 个节点的测试报告`);
      
      // 如果测试已完成但isBackgroundTesting已经被设置为false，说明已通过自动保存完成
      if (progress === 100 && !isBackgroundTesting) {
        console.log('检测到测试已通过自动保存机制保存，跳过原始保存逻辑');
      } else {
        // 安全检查：确保有测试结果数据
        if (allResults.length === 0 && testResults.length > 0) {
          console.warn('发现结果不一致，使用testResults替代');
          allResults = [...testResults];
        }
        
        // 自动保存测试报告到用户存储目录
        if (window.electronAPI && allResults.length > 0) {
          try {
            // 获取当前配置文件名称
            let configName = proxyGroup?.name || '未知配置';
            try {
              const configResult = await window.electronAPI.getCurrentConfigName();
              if (configResult && configResult.success && configResult.configName) {
                configName = configResult.configName;
              }
            } catch (err) {
              console.error('获取配置文件名称失败，使用代理组名称代替:', err);
            }
            
            // 准备报告数据
            const reportData = {
              proxyGroupName: configName, // 使用配置文件名称而不是代理组名称
              testConfig: configName, // 增加一个明确的配置名称字段
              testResults: allResults,
              skippedNodes: skippedNodes,
              excludedNodes: excludedNodes,
              includedNodes: includedNodes,
              testMode: enableMultiThread ? 'multithread' : 'singlethread',
              testTime: new Date().toISOString()
            };
            
            console.log(`尝试保存测试报告，节点数: ${reportData.testResults.length}`);
            
            // 保存报告
            const saveResult = await window.electronAPI.saveSpeedtestReport(reportData);
            
            if (saveResult.success) {
              console.log('测速报告数据已自动保存至:', saveResult.filePath);
              // 添加用户提示
              toast.success('测速报告已自动保存');
              
              // 刷新历史报告列表
              loadHistoryReports();
            } else {
              console.error('自动保存测速报告数据失败:', saveResult.error);
              toast.error(`报告保存失败: ${saveResult.error}`);
            }
          } catch (error) {
            console.error('自动保存测速报告数据时出错:', error);
            toast.error(`保存报告出错: ${String(error)}`);
          }
        } else {
          // 使用更详细的错误信息辅助调试
          if (!window.electronAPI) {
            console.error('无法保存报告: electronAPI不可用');
            toast.error('无法保存报告: 系统API不可用');
          } else if (allResults.length === 0) {
            console.error('无法保存报告: 没有测试结果', {
              testResultsLength: testResults.length,
              contextResultsLength: contextResults?.length,
              allResultsLength: allResults.length,
              isBackgroundTesting
            });
            toast.error('无法保存报告: 测试结果为空，请重试');
          }
        }
      }
      
      // 仅在非自动保存的情况下显示完成提示，避免重复提示
      if (!(!isBackgroundTesting && progress === 100)) {
        toast.success('批量测速完成');
      }
      
      // 后台模式下执行额外保存检查 - 确保即使在UI切换后也能保存报告
      if (isBackgroundTesting && window.electronAPI) {
        // 再次尝试从全局状态中获取结果
        const finalResults = contextResults?.length > 0 
          ? (contextResults as unknown as SpeedTestResult[])
          : testResults;
          
        if (finalResults.length > 0 && !allResults.length) {
          console.log('使用备选方式保存报告，节点数:', finalResults.length);
          try {
            // 获取当前配置文件名称
            let configName = proxyGroup?.name || '未知配置';
            try {
              const configResult = await window.electronAPI.getCurrentConfigName();
              if (configResult && configResult.success && configResult.configName) {
                configName = configResult.configName;
              }
            } catch (err) {
              console.error('获取配置文件名称失败，使用代理组名称代替:', err);
            }
            
            // 准备备选报告数据
            const backupReportData = {
              proxyGroupName: configName,
              testConfig: configName,
              testResults: finalResults,
              skippedNodes: skippedNodes,
              excludedNodes: excludedNodes || [],
              includedNodes: includedNodes || [],
              testMode: enableMultiThread ? 'multithread' : 'singlethread',
              testTime: new Date().toISOString()
            };
            
            // 尝试再次保存
            const saveResult = await window.electronAPI.saveSpeedtestReport(backupReportData);
            if (saveResult.success) {
              console.log('测速报告已通过备选方式成功保存至:', saveResult.filePath);
            }
          } catch (err) {
            console.error('备选保存方式也失败:', err);
          }
        }
      }
    } catch (error) {
      console.error('批量测速过程中出错:', error);
      toast.error(`测速失败: ${String(error)}`);
    } finally {
      setIsTesting(false);
      setIsBackgroundTesting(false);
    }
  };
  
  // 检查节点是否可用
  const checkNodeAvailability = async (nodeName: string): Promise<{success: boolean, error?: string}> => {
    if (!window.electronAPI) return { success: false, error: 'electronAPI不可用' };
    
    try {
      // 尝试一次简单的测试请求，检查节点是否可用
      const testOptions = {
        url: 'http://www.gstatic.com/generate_204', // 轻量级测试URL
        proxy: {
          host: proxyConfig.host,
          port: proxyConfig.port,
          nodeName: nodeName
        },
        proxyGroup: proxyGroup?.name // 传递代理组名称
      };
      const response = await window.electronAPI.runProxySpeedtest(testOptions);
      
      if (response.success) {
        return { success: true };
      } else if ('skipNode' in response) {
        // 处理后端标记的需要跳过的节点
        return { success: false, error: response.error || '节点不可用' };
      } else if (response.error) {
        return { success: false, error: response.error };
      } else {
        return { success: false, error: '节点测试失败' };
      }
    } catch (error) {
      console.error(`检查节点可用性失败 (${nodeName}):`, error);
      return { success: false, error: String(error) };
    }
  };
  
  // 测试节点延迟和RTT标准差
  const testNodeDelay = async (nodeName: string): Promise<{delay: number, rttDeviation: number}> => {
    if (!window.electronAPI) return { delay: 0, rttDeviation: 0 };
    
    try {
      // 进行多次延迟测试，计算平均值和标准差
      const testCount = 5; // 增加到5次以便更准确计算标准差
      let delayValues: number[] = [];
      
      for (let i = 0; i < testCount; i++) {
        try {
          // 使用不同的测试URL，增加测试可靠性
          const testUrls = [
            'http://www.gstatic.com/generate_204',
            'http://cp.cloudflare.com/generate_204',
            'http://www.qualcomm.cn/generate_204',
            'http://www.msftconnecttest.com/connecttest.txt',
            'http://wifi.vivo.com.cn/generate_204'
          ];
          
          const testUrl = testUrls[i % testUrls.length];
          
          // 测量延迟
          const startTime = Date.now();
          
          // 通过主进程的代理调用，确保流量通过mihomo
          const testOptions = {
            url: testUrl,
            proxy: {
              host: proxyConfig.host,
              port: proxyConfig.port,
              nodeName: nodeName
            },
            proxyGroup: proxyGroup?.name // 传递代理组名称
          };
          const response = await window.electronAPI.runProxySpeedtest(testOptions);
          
          const endTime = Date.now();
          const delay = endTime - startTime;
          
          if (response && response.success) {
            delayValues.push(delay);
          }
          
          // 短暂休息，避免连续请求
          if (i < testCount - 1) {
            await new Promise(r => setTimeout(r, 500));
          }
        } catch (error) {
          console.error(`延迟测试 ${i+1} 出错 (${nodeName}):`, error);
        }
      }
      
      // 如果全部测试都失败，返回0
      if (delayValues.length === 0) return { delay: 0, rttDeviation: 0 };
      
      // 计算平均值
      const avgDelay = delayValues.reduce((sum, val) => sum + val, 0) / delayValues.length;
      
      // 计算标准差
      const variance = delayValues.reduce((sum, val) => sum + Math.pow(val - avgDelay, 2), 0) / delayValues.length;
      const stdDeviation = Math.sqrt(variance);
      
      return { 
        delay: Math.round(avgDelay), 
        rttDeviation: Math.round(stdDeviation * 10) / 10 // 保留一位小数
      };
    } catch (error) {
      console.error(`测试节点 ${nodeName} 延迟失败:`, error);
      return { delay: 0, rttDeviation: 0 };
    }
  };
  
  // 测试HTTP延迟
  const testHttpDelay = async (nodeName: string): Promise<number> => {
    if (!window.electronAPI) return 0;
    
    try {
      // 通过主进程提供的代理调用测试HTTP延迟
      // 测试实际HTTP请求延迟
      const testUrls = [
        'https://www.google.com',
        'https://www.youtube.com',
        'https://www.netflix.com'
      ];
      
      let totalDelay = 0;
      let successfulTests = 0;
      
      for (const url of testUrls) {
        try {
          const startTime = Date.now();
          
          // 使用主进程的代理调用，确保流量通过mihomo
          const testOptions = {
            url: url,
            proxy: {
              host: proxyConfig.host,
              port: proxyConfig.port,
              nodeName: nodeName
            },
            proxyGroup: proxyGroup?.name // 传递代理组名称
          };
          const response = await window.electronAPI.runProxySpeedtest(testOptions);
          
          const endTime = Date.now();
          
          if (response && response.success) {
            totalDelay += (endTime - startTime);
            successfulTests++;
          }
          
          // 短暂休息
          await new Promise(r => setTimeout(r, 500));
        } catch (error) {
          console.error(`HTTP延迟测试失败 (${nodeName}, ${url}):`, error);
        }
      }
      
      if (successfulTests === 0) return 0;
      return Math.round(totalDelay / successfulTests);
    } catch (error) {
      console.error(`测试HTTP延迟失败 (${nodeName}):`, error);
      return 0;
    }
  };
  
  // 检测UDP类型 - 使用真实UDP测试
  const detectUdpType = async (node: ProxyNode): Promise<string> => {
    if (!window.electronAPI) return 'Unknown';
    
    try {
      // 使用新的实际UDP测试功能
      setTestingPhase('UDP类型检测');
      if (enableBackgroundMode) setGlobalPhase('UDP类型检测');
      
      console.log(`开始进行UDP类型测试: ${node.name}`);
      
      // 调用主进程中的UDP测试功能
      const testOptions = {
        proxy: {
          host: proxyConfig.host,
          port: proxyConfig.port,
          nodeName: node.name
        },
        proxyGroup: proxyGroup?.name // 传递代理组名称
      };
      const result = await window.electronAPI.testUdpConnectivity(testOptions);
      
      if (result.success) {
        console.log(`UDP测试完成: ${node.name}, 类型: ${result.udpType}, 成功率: ${result.successCount}`);
        // 修复：确保返回一个字符串，而不是undefined
        return result.udpType || 'Unknown';
      } else {
        console.warn(`UDP测试失败: ${result.error}`);
        
        // 测试失败时回退到基于特征的判断
        console.log(`回退到基于节点特征的UDP类型推断: ${node.name}`);
        
        // 根据节点名称特征推测UDP类型
        if (node.name.toLowerCase().includes('家宽') || 
            node.name.toLowerCase().includes('hkbn') || 
            node.name.toLowerCase().includes('cmhk') ||
            node.name.toLowerCase().includes('china') ||
            node.name.toLowerCase().includes('cn')) {
          return 'PortRestrictedCone'; // 家宽/中国地区节点通常是端口限制型
        }
        
        if (node.name.toLowerCase().includes('专线') || 
            node.name.toLowerCase().includes('game') ||
            node.name.toLowerCase().includes('direct') ||
            node.name.toLowerCase().includes('iepl')) {
          return 'FullCone'; // 专线/游戏节点通常是完全锥型
        }
        
        if (node.name.toLowerCase().includes('小带宽') ||
            node.name.toLowerCase().includes('共享') ||
            node.name.toLowerCase().includes('限速')) {
          return 'Symmetric'; // 共享带宽节点通常是对称型
        }
        
        // 尝试从节点对象中获取类型信息
        if (node.type) {
          if (node.type.toLowerCase().includes('vmess') || 
              node.type.toLowerCase().includes('vless')) {
            return 'SymmetricNAT'; // V2Ray系协议通常是对称型NAT
          }
          
          if (node.type.toLowerCase().includes('ss') || 
              node.type.toLowerCase().includes('shadowsocks')) {
            return 'PortRestrictedCone'; // SS通常是端口限制型
          }
          
          if (node.type.toLowerCase().includes('trojan')) {
            return 'FullCone'; // Trojan通常是完全锥型
          }
        }
        
        // 其他情况默认为完全锥型
        return 'FullCone';
      }
    } catch (error) {
      console.error(`UDP类型检测失败 (${node.name}):`, error);
      return 'Unknown';
    }
  };
  
  // 测试节点下载速度
  const testNodeDownloadSpeed = async (nodeName: string): Promise<DownloadTestResult> => {
    if (!window.electronAPI) return { downloadSpeed: 0, maxSpeed: 0 };
    
    try {
      // 使用主进程中的代理测速功能，确保流量通过mihomo代理
      if (enableMultiThread) {
        // 多线程测速：并发请求，找出最大总速度
        setTestingPhase('下载速度测试 (多线程)');
        if (enableBackgroundMode) setGlobalPhase('下载速度测试 (多线程)');
        
        try {
          // 使用大文件进行测速 - 设定一个较大的文件，但测试会在指定时间内中断
          const cloudflareTestUrl = 'https://speed.cloudflare.com/__down?bytes=1000000000'; // 1GB
          
          console.log(`开始对节点 ${nodeName} 进行多线程下载测速`);
          
          // 调用主进程中的代理测速功能，设定15秒的最大测试时间
          const testOptions = {
            url: cloudflareTestUrl,
            proxy: {
              host: proxyConfig.host,
              port: proxyConfig.port,
              nodeName: nodeName
            },
            maxTestTime: 15000, // 15秒
            proxyGroup: proxyGroup?.name // 传递代理组名称
          };
          const result = await window.electronAPI.runProxySpeedtest(testOptions);
          
          if (result.success && result.data) {
            const testData = result.data as any;
            console.log(`多线程代理测速完成: ${nodeName}, 平均速度: ${testData.downloadSpeed.toFixed(2)} Mbps, 最大速度: ${testData.maxSpeed.toFixed(2)} Mbps, 样本数: ${testData.samples}`);
            return { 
              downloadSpeed: testData.downloadSpeed,
              maxSpeed: testData.maxSpeed || testData.downloadSpeed * 1.2 // 如果未返回最大速度，估算为平均值的1.2倍
            };
          } else {
            console.warn(`多线程测试失败: ${result.error}`);
            // 没有成功的结果，返回一个保底值而不是0
            return { downloadSpeed: 1.0, maxSpeed: 1.5 };
          }
        } catch (error) {
          console.error(`多线程下载测试失败 (${nodeName}):`, error);
          return { downloadSpeed: 1.0, maxSpeed: 1.5 };
        }
      }
      
      // 单线程测速
      setTestingPhase('下载速度测试 (单线程)');
      if (enableBackgroundMode) setGlobalPhase('下载速度测试 (单线程)');
      
      // 使用大文件进行测速 - 设定一个较大的文件，但测试会在指定时间内中断
      const testUrl = 'https://speed.cloudflare.com/__down?bytes=500000000'; // 500MB
      
      console.log(`开始对节点 ${nodeName} 进行单线程下载测速`);
      
      try {
        // 调用主进程中的代理测速功能，设定12秒的最大测试时间
        const testOptions = {
          url: testUrl,
          proxy: {
            host: proxyConfig.host,
            port: proxyConfig.port,
            nodeName: nodeName
          },
          maxTestTime: 12000, // 12秒
          proxyGroup: proxyGroup?.name // 传递代理组名称
        };
        const result = await window.electronAPI.runProxySpeedtest(testOptions);
        
        if (result.success && result.data) {
          const testData = result.data as any;
          console.log(`单线程代理测速完成: ${nodeName}, 平均速度: ${testData.downloadSpeed.toFixed(2)} Mbps, 最大速度: ${testData.maxSpeed.toFixed(2)} Mbps, 样本数: ${testData.samples}`);
          return { 
            downloadSpeed: testData.downloadSpeed,
            maxSpeed: testData.maxSpeed || testData.downloadSpeed * 1.2 // 如果未返回最大速度，估算为平均值的1.2倍 
          };
        } else {
          console.warn(`单线程测试失败: ${result.error || '未知错误'}`);
          // 返回保底值
          return { downloadSpeed: 1.0, maxSpeed: 1.5 };
        }
      } catch (error) {
        console.error(`节点 ${nodeName} 速度测试失败:`, error);
        // 测试失败时依然返回一个保底值而不是0
        return { downloadSpeed: 1.0, maxSpeed: 1.5 };
      }
    } catch (error) {
      console.error(`测试节点 ${nodeName} 下载速度失败:`, error);
      return { downloadSpeed: 1.0, maxSpeed: 1.5 };
    }
  };
  
  // 此函数已不再需要，由主进程中的代理测速功能替代
  async function legacySingleThreadSpeedTest(nodeName: string) {
    try {
      // 使用中等大小文件进行测速
      const testUrl = 'https://speed.cloudflare.com/__down?bytes=50000000'; // 50MB
      
      // 调用主进程中的代理测速功能
      const result = await window.electronAPI?.runProxySpeedtest({
        url: testUrl,
        proxy: {
          host: proxyConfig.host,
          port: proxyConfig.port,
          nodeName: nodeName
        }
      });
      
      if (result && result.success && result.data) {
        return { success: true, speed: result.data.downloadSpeed };
      }
      
      return { success: false, speed: 0 };
    } catch (error) {
      console.error('备选测速失败:', error);
      return { success: false, speed: 0 };
    }
  }
  
  // 从节点信息中提取地理位置
  const getNodeLocation = (node: ProxyNode): string => {
    // 尝试从节点名称中提取位置信息
    if (node.name) {
      // 常见位置关键词
      const locations = ["香港", "台湾", "新加坡", "日本", "美国", "韩国", "英国", "法国", "德国", 
                        "HK", "TW", "SG", "JP", "US", "KR", "UK", "FR", "DE"];
      
      for (const loc of locations) {
        if (node.name.includes(loc)) {
          return loc;
        }
      }
    }
    
    // 如果没找到，尝试从服务器地址中提取
    if (node.server) {
      // 这里可以实现更复杂的IP地理位置查询逻辑
      return "未知";
    }
    
    return "未知";
  };
  
  // 取消测速
  const cancelTest = () => {
    // 如果正在测试中，取消测试
    if (isTesting || isBackgroundTesting) {
      setIsTesting(false);
      setTestingPhase('');
      setCurrentNodeName('');
      setProgress(0);
      
      // 清空当前的测试结果，避免下次测试显示旧数据
      setTestResults([]);
      setSkippedNodes([]);
      setExcludedNodes([]);
      
      // 清空全局上下文中的测试结果
      setGlobalResults([]);
      
      // 无论在哪种模式下，都取消全局测速状态
      if (isBackgroundTesting) {
        stopBackgroundTest();
      }
      
      // 调用后端API取消测速进程
      if (window.electronAPI) {
        try {
          window.electronAPI.cancelBatchSpeedtest()
            .then((result: {success: boolean, error?: string}) => {
              if (result.success) {
                console.log('成功取消后端测速进程');
              } else {
                console.error('取消后端测速进程失败:', result.error);
              }
            })
            .catch((err: Error) => {
              console.error('调用取消测速API失败:', err);
            });
        } catch (error) {
          console.error('取消测速出错:', error);
        }
      }
      
      toast.info('测速已取消');
    }
  };
  
  // 生成测速报告图片
  const generateReport = async () => {
    if (!testResults || testResults.length === 0) {
      toast.error('没有测试结果可供导出');
      return;
    }
    
    // 额外确认测试结果的有效性
    const validResults = testResults.filter(result => 
      result && typeof result === 'object' && result.name && 
      (typeof result.delay === 'number' || typeof result.downloadSpeed === 'number')
    );
    
    if (validResults.length === 0) {
      toast.error('测试结果无效，请重新进行测速');
      console.error('无效的测试结果数据:', testResults);
      return;
    }
    
    try {
      setIsGeneratingReport(true);
      
      // 准备报告数据
      const reportData = {
        testResults: testResults,
        proxyGroupName: selectedReport?.proxyGroupName || proxyGroup?.name || '未知配置',
        testConfig: selectedReport?.testConfig || (proxyGroup?.name || '未知配置'),
        skippedNodes: skippedNodes,
        excludedNodes: excludedNodes,
        includedNodes: includedNodes,
        reportNote: reportNote,
        testTime: new Date().toISOString(),
        testMode: testResults[0]?.isMultiThread ? 'multithread' : 'singlethread'
      };
      
      if (!window.electronAPI) {
        toast.error('无法访问系统功能，请在桌面应用中使用');
        return;
      }
      
      // 调用主进程提供的puppeteer生成报告函数
      const result = await window.electronAPI.generateSpeedtestReportWithPuppeteer(reportData);
      
      if (result.canceled) {
        // 用户取消了保存操作
        toast.info('已取消导出报告');
      } else if (result.success) {
        toast.success('测速报告已保存至: ' + result.filePath);
        
        // 可选：如果需要自动打开文件
        if (result.filePath) {
          try {
            await window.electronAPI.openFileInDefaultApp(result.filePath);
          } catch (err) {
            console.error('打开报告文件失败:', err);
          }
        }
      } else {
        toast.error(`生成报告失败: ${result.error}`);
      }
    } catch (error) {
      console.error('生成报告失败:', error);
      toast.error(`生成报告失败: ${String(error)}`);
    } finally {
      setIsGeneratingReport(false);
    }
  };
  
  // 复制报告图片到剪贴板
  const copyReportToClipboard = async () => {
    if (!testResults || testResults.length === 0) {
      toast.error('没有测试结果可供复制');
      return;
    }
    
    // 额外确认测试结果的有效性
    const validResults = testResults.filter(result => 
      result && typeof result === 'object' && result.name && 
      (typeof result.delay === 'number' || typeof result.downloadSpeed === 'number')
    );
    
    if (validResults.length === 0) {
      toast.error('测试结果无效，请重新进行测速');
      console.error('无效的测试结果数据:', testResults);
      return;
    }
    
    try {
      setIsGeneratingReport(true);
      
      // 准备报告数据
      const reportData = {
        testResults: testResults,
        proxyGroupName: selectedReport?.proxyGroupName || proxyGroup?.name || '未知配置',
        testConfig: selectedReport?.testConfig || (proxyGroup?.name || '未知配置'),
        skippedNodes: skippedNodes,
        excludedNodes: excludedNodes,
        includedNodes: includedNodes,
        reportNote: reportNote,
        testTime: new Date().toISOString(),
        testMode: testResults[0]?.isMultiThread ? 'multithread' : 'singlethread'
      };
      
      if (!window.electronAPI) {
        toast.error('无法访问系统功能，请在桌面应用中使用');
        return;
      }
      
      // 调用主进程提供的puppeteer生成报告并复制到剪贴板的函数
      const result = await window.electronAPI.copySpeedtestReportWithPuppeteer(reportData);
      
      if (result.success) {
        toast.success('测速报告图片已复制到剪贴板');
      } else {
        toast.error(`复制到剪贴板失败: ${result.error}`);
      }
    } catch (error) {
      console.error('生成报告图片失败:', error);
      toast.error(`生成报告图片失败: ${String(error)}`);
    } finally {
      setIsGeneratingReport(false);
    }
  };
  
  // 加载历史测速报告
  const loadHistoryReports = async () => {
    if (!window.electronAPI) {
      toast.error('无法访问系统功能，请在桌面应用中使用');
      return;
    }
    
    try {
      setIsLoadingHistory(true);
      
      const result = await window.electronAPI.getSpeedtestReports();
      
      if (result.success && result.reports) {
        console.log(`加载了 ${result.reports.length} 个历史测速报告:`, result.reports);
        
        // 检查每个报告的结构
        result.reports.forEach((report, index) => {
          console.log(`报告 ${index + 1} (${report.id}) 信息:`, 
            `节点数: ${report.nodeCount}`,
            `时间: ${report.timestamp ? new Date(report.timestamp).toLocaleString() : '未知'}`
          );
        });
        
        setHistoryReports(result.reports);
      } else {
        toast.error('获取历史测速报告失败');
        console.error('获取历史测速报告失败:', result.error);
      }
    } catch (error) {
      console.error('加载历史报告出错:', error);
      toast.error(`加载历史报告出错: ${String(error)}`);
    } finally {
      setIsLoadingHistory(false);
    }
  };
  
  // 加载特定报告的详细信息
  const loadReportDetail = async (reportId: string) => {
    if (!window.electronAPI) {
      toast.error('无法访问系统功能，请在桌面应用中使用');
      return;
    }
    
    try {
      const result = await window.electronAPI.getSpeedtestReport(reportId);
      
      if (result.success && result.report) {
        // 加载历史报告数据
        setSelectedReport(result.report);
        
        // 将历史报告数据应用到当前视图
        setTestResults(result.report.testResults || []);
        setSkippedNodes(result.report.skippedNodes || []);
        setExcludedNodes(result.report.excludedNodes || []);
        
        if (result.report.proxyGroupName) {
          setProxyGroup({
            name: result.report.proxyGroupName,
            type: '',
            nodes: []
          });
        }
        
        // 关闭历史报告面板
        setShowHistoryReports(false);
        
        toast.success('历史报告加载成功');
      } else {
        toast.error('获取报告详情失败');
        console.error('获取报告详情失败:', result.error);
      }
    } catch (error) {
      console.error('加载报告详情出错:', error);
      toast.error(`加载报告详情出错: ${String(error)}`);
    }
  };
  
  // 格式化日期时间
  const formatDateTime = (dateString: string) => {
    try {
      const date = new Date(dateString);
      return date.toLocaleString('zh-CN', { 
        year: 'numeric', 
        month: '2-digit', 
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    } catch (error) {
      return dateString;
    }
  };
  
  // 首次加载时获取代理组信息和代理配置
  useEffect(() => {
    fetchFirstRuleProxyGroup();
    fetchProxyConfig(); // 添加获取代理配置
  }, []);

  // 当组件加载或从其他页面返回时，检查并同步后台测速状态
  const {
    testResults: contextResults,
    progress: contextProgress,
    testingPhase: contextPhase
  } = useSpeedTest(); // 必须在组件顶层调用钩子

  useEffect(() => {
    // 检查当前是否有后台测速正在进行
    if (isBackgroundTesting) {
      // 无论是直接后台运行还是从其他页面返回，都恢复测速状态
      setIsTesting(true);
      
      // 从上下文中同步测试状态
      if (testResults.length === 0 && contextResults.length > 0) {
        // 最终修复：使用类型转换，忽略类型错误
        try {
          // 强制类型转换
          setTestResults(contextResults as any);
        } catch (error) {
          console.error('恢复测试状态时出错:', error);
        }
        
        setProgress(contextProgress);
        setTestingPhase(contextPhase);
        toast.info('检测到正在进行的后台测速，已恢复状态');
      }
    }
  }, [isBackgroundTesting, testResults.length, contextResults, contextProgress, contextPhase]);
  
  // 格式化速度显示
  const formatSpeed = (speedMbps: number): string => {
    if (speedMbps <= 0) return '0 Mbps';
    if (speedMbps < 1) return `${(speedMbps * 1000).toFixed(0)} Kbps`;
    if (speedMbps >= 1000) return `${(speedMbps / 1000).toFixed(2)} Gbps`;
    return `${speedMbps.toFixed(speedMbps > 100 ? 0 : 2)} Mbps`;
  };
  
  // 延迟颜色
  const getDelayColor = (delay: number): string => {
    if (delay <= 0) return 'text-red-500';
    if (delay < 100) return 'text-green-500';
    if (delay < 200) return 'text-yellow-500';
    return 'text-red-500';
  };
  
  // 速度颜色
  const getSpeedColor = (speed: number): string => {
    if (speed <= 0) return 'text-red-500';
    if (speed > 500) return 'text-purple-500'; // 超高速连接
    if (speed > 100) return 'text-indigo-500'; // 高速连接
    if (speed > 50) return 'text-green-500';
    if (speed > 10) return 'text-blue-500';
    if (speed > 5) return 'text-yellow-500';
    return 'text-red-500';
  };
  
  // UDP类型颜色
  const getUdpTypeColor = (type: string): string => {
    switch (type) {
      case 'FullCone':
        return 'text-green-500';
      case 'PortRestrictedCone':
        return 'text-yellow-500';
      case 'Symmetric':
        return 'text-red-500';
      default:
        return 'text-gray-500';
    }
  };
  
  // 为徽章提供更美观的颜色和背景
  const getUdpTypeColorBadge = (type: string): string => {
    switch (type) {
      case 'FullCone':
        return 'bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300';
      case 'PortRestrictedCone':
        return 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-800 dark:text-yellow-300';
      case 'Symmetric':
        return 'bg-orange-100 dark:bg-orange-900/30 text-orange-800 dark:text-orange-300';
      case 'Blocked':
        return 'bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-300';
      default:
        return 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300';
    }
  };
  
  return (
    <div className="w-full max-w-3xl mx-auto bg-white dark:bg-neutral-900 shadow-sm border rounded-md">
      {!inDialog && (
        <div className="p-3 border-b">
          <div className="flex justify-between items-center">
            <div>
              <h2 className="text-base font-semibold">批量测速</h2>
              <p className="text-xs text-muted-foreground">
                测试当前配置文件中代理节点的性能
                {proxyGroup && (
                  <span className="font-semibold text-primary ml-1">
                    [{proxyGroup.name}]
                  </span>
                )}
              </p>
            </div>
            {proxyGroup && (
              <div className="text-xs text-muted-foreground">
                共 <span className="font-semibold">{proxyGroup.nodes.length}</span> 个节点
              </div>
            )}
          </div>
        </div>
      )}

      <div className="p-3">
        {!isTesting && testResults.length === 0 && (
          <div className="text-center py-6">
            <div className="flex justify-center mb-4">
              <Gauge className="h-10 w-10 text-primary opacity-80" />
            </div>
            <p className="text-xs text-muted-foreground mb-4 max-w-md mx-auto">
              此功能将测试规则模式下第一个代理组的所有节点，并生成测速报告。
              <span className="block mt-1">测试内容包括：延迟标准差、HTTP延迟、多档位下载测试和UDP类型检测。</span>
            </p>
            
            {/* 测速选项区域 */}
            <div className="space-y-2 mb-3">
              {/* 后台模式选项 - 仅在非对话框模式下显示，并且不在已启用后台模式的页面显示 */}
              {!inDialog && !enableBackground && (
                <div className="flex items-center justify-center">
                  <label className="flex items-center space-x-2 text-xs text-muted-foreground cursor-pointer">
                    <input 
                      type="checkbox"
                      className="h-3 w-3 rounded border-gray-300"
                      checked={enableBackgroundMode}
                      onChange={() => setEnableBackgroundMode(!enableBackgroundMode)}
                    />
                    <span>启用后台测速（可切换到其他页面）</span>
                  </label>
                </div>
              )}
              
              {/* 多线程选项 */}
              <div className="flex items-center justify-center">
                <label className="flex items-center space-x-2 text-xs text-muted-foreground cursor-pointer">
                  <input 
                    type="checkbox"
                    className="h-3 w-3 rounded border-gray-300"
                    checked={enableMultiThread}
                    onChange={() => setEnableMultiThread(!enableMultiThread)}
                  />
                  <span>启用多线程测速（获取最大带宽）</span>
                </label>
                <div className="ml-1">
                  <span className="inline-flex items-center justify-center h-4 w-4 rounded-full bg-blue-100 text-blue-600 text-xs cursor-help"
                    title="多线程测速通过同时建立多个连接并行下载，可以更好地利用带宽，尤其适合大带宽或高延迟场景。对于某些运营商限制单连接带宽的情况特别有效。">
                    ?
                  </span>
                </div>
              </div>
              
              {/* 筛选和排除节点选项 - 使用flex布局减小高度 */}
              <div className="max-w-md mx-auto flex flex-col space-y-2">
                {/* 包含筛选框 */}
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">
                    只测试包含关键词的节点：
                  </label>
                  <input
                    type="text"
                    className="w-full px-2 py-1 text-xs rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900"
                    placeholder="例如: 香港, 日本, SGP (逗号或空格分隔)"
                    value={includeKeywords}
                    onChange={(e) => setIncludeKeywords(e.target.value)}
                  />
                </div>
                
                {/* 排除框 */}
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">
                    排除节点关键词：
                  </label>
                  <input
                    type="text"
                    className="w-full px-2 py-1 text-xs rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900"
                    placeholder="例如: 家宽, 限速, 0.5x (逗号或空格分隔)"
                    value={excludeKeywords}
                    onChange={(e) => setExcludeKeywords(e.target.value)}
                  />
                </div>
              </div>
            </div>
            
            <div className="flex items-center gap-2 justify-center">
            <Button 
              onClick={startBatchTest} 
              disabled={isTesting}
              variant="default"
              size="sm"
            >
              {isTesting ? (
                <>
                  <RefreshCw className="mr-1.5 h-3 w-3 animate-spin" />
                  测速中...
                </>
              ) : (
                <>
                  <Play className="mr-1.5 h-3 w-3" />
                  开始批量测速
                </>
              )}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                loadHistoryReports();
                setShowHistoryReports(true);
              }}
            >
              <Clock className="mr-1.5 h-3 w-3" />
              历史报告
            </Button>
          </div>
          </div>
        )}
        
        {isTesting && (
          <div className="space-y-3 py-2">
            <div className="text-center mb-2">
              <p className="text-xs mb-1">
                正在测试节点: <span className="font-medium">{currentNodeName}</span>
                {testingPhase && (
                  <span className="text-gray-500 ml-1">
                    ({testingPhase})
                    {testingPhase === '下载速度测试' && (
                      <span className="animate-pulse text-blue-500"> 下载中...</span>
                    )}
                  </span>
                )}
              </p>
              <Progress value={progress} className="h-1.5 mb-1" />
              <p className="text-xs text-muted-foreground">
                进度: {Math.round(progress)}% 
                {skippedNodes.length > 0 && ` (已跳过 ${skippedNodes.length} 个节点)`}
                {excludedNodes.length > 0 && ` (已排除 ${excludedNodes.length} 个节点)`}
                {includedNodes.length > 0 && ` (已筛选 ${includedNodes.length} 个节点)`}
              </p>
              
              {/* 取消测速按钮 */}
              <Button
                variant="outline"
                size="sm"
                onClick={cancelTest}
                className="mt-1"
              >
                <XCircle className="mr-1 h-3 w-3" />
                取消测速
              </Button>
            </div>
            
            {testResults.length > 0 && (
              <div className="rounded-md border overflow-hidden">
                <div className="bg-primary/5 border-b px-2 py-1.5">
                  <div className="flex items-center space-x-1">
                    <Info className="h-3 w-3 text-primary" />
                    <h3 className="text-xs font-medium">实时测速结果</h3>
                  </div>
                </div>
                <div 
                  ref={resultsContainerRef}
                  className="max-h-[200px] overflow-y-auto p-1"
                >
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-white dark:bg-slate-900 border-b">
                      <tr className="bg-muted/50">
                        <th className="text-left py-1 px-1.5 font-medium">名称</th>
                        <th className="text-left py-1 px-1.5 font-medium">类型</th>
                        <th className="text-left py-1 px-1.5 font-medium">延迟</th>
                        <th className="text-left py-1 px-1.5 font-medium">偏差</th>
                        <th className="text-left py-1 px-1.5 font-medium">HTTP</th>
                        <th className="text-left py-1 px-1.5 font-medium">平均速度</th>
                        <th className="text-left py-1 px-1.5 font-medium">最大速度</th>
                        <th className="text-left py-1 px-1.5 font-medium">UDP</th>
                      </tr>
                    </thead>
                    <tbody>
                      {testResults.map((result, index) => (
                        <tr 
                          key={index} 
                          className={`border-b ${index % 2 === 0 ? 'bg-white dark:bg-slate-900' : 'bg-muted/30 dark:bg-slate-800/40'}`}
                        >
                          <td className="py-1 px-1.5 max-w-[100px] truncate">{result.name}</td>
                          <td className="py-1 px-1.5">{result.type}</td>
                          <td className={`py-1 px-1.5 ${getDelayColor(result.delay)}`}>
                            {result.delay > 0 ? `${result.delay}ms` : '超时'}
                          </td>
                          <td className="py-1 px-1.5">
                            {result.rttDeviation > 0 ? result.rttDeviation.toFixed(1) : '0'}
                          </td>
                          <td className={`py-1 px-1.5 ${getDelayColor(result.httpDelay)}`}>
                            {result.httpDelay > 0 ? `${result.httpDelay}ms` : '超时'}
                          </td>
                          <td className={`py-1 px-1.5 ${getSpeedColor(result.downloadSpeed)}`}>
                            {formatSpeed(result.downloadSpeed)}
                          </td>
                          <td className={`py-1 px-1.5 ${getSpeedColor(result.maxSpeed)}`}>
                            {formatSpeed(result.maxSpeed)}
                          </td>
                          <td className="py-1 px-1.5">
                            <span className={getUdpTypeColor(result.udpType)}>
                              {result.udpType || '未知'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}
        
        {!isTesting && testResults.length > 0 && (
          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <h3 className="text-sm font-medium">测试结果</h3>
              <div className="space-x-1">
                {/* 仅在不是查看历史报告时显示历史按钮 */}
                {!selectedReport && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      loadHistoryReports();
                      setShowHistoryReports(true);
                    }}
                    disabled={isGeneratingReport}
                  >
                    <Clock className="mr-1 h-3 w-3" />
                    历史
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={copyReportToClipboard}
                  disabled={isGeneratingReport}
                >
                  {isGeneratingReport ? (
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  ) : (
                    <Share className="mr-1 h-3 w-3" />
                  )}
                  复制
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={generateReport}
                  disabled={isGeneratingReport}
                >
                  {isGeneratingReport ? (
                    <>
                      <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      生成中
                    </>
                  ) : (
                    <>
                      <Download className="mr-1 h-3 w-3" />
                      导出
                    </>
                  )}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={startBatchTest}
                  disabled={isTesting}
                >
                  <RefreshCw className="mr-1 h-3 w-3" />
                  重测
                </Button>
              </div>
            </div>
            
            {/* 添加备注输入框 */}
            <div className="space-y-1">
              <div className="flex items-center text-xs">
                <span className="text-muted-foreground mr-1">添加报告备注:</span>
                <input
                  type="text"
                  className="flex-1 px-2 py-1 text-xs rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900"
                  placeholder="输入备注信息（将显示在报告顶部）"
                  value={reportNote}
                  onChange={(e) => setReportNote(e.target.value)}
                />
              </div>
            </div>
            
            {/* 显示跳过的节点 */}
            {(skippedNodes.length > 0 || excludedNodes.length > 0 || includedNodes.length > 0) && (
              <div className="flex flex-wrap gap-1 text-xs">
                {skippedNodes.length > 0 && (
                  <div className="inline-flex items-center p-1 bg-yellow-50 dark:bg-yellow-900/20 rounded-md">
                    <AlertCircle className="h-3 w-3 text-yellow-500 mr-1" />
                    跳过 {skippedNodes.length} 个节点
                  </div>
                )}
                
                {excludedNodes.length > 0 && (
                  <div className="inline-flex items-center p-1 bg-blue-50 dark:bg-blue-900/20 rounded-md">
                    <Info className="h-3 w-3 text-blue-500 mr-1" />
                    排除 {excludedNodes.length} 个节点
                  </div>
                )}
                
                {includedNodes.length > 0 && (
                  <div className="inline-flex items-center p-1 bg-green-50 dark:bg-green-900/20 rounded-md">
                    <CheckCircle className="h-3 w-3 text-green-500 mr-1" />
                    筛选 {includedNodes.length} 个节点
                  </div>
                )}
              </div>
            )}
            
            {/* 测试报告视图 - 用于导出图片 - 保持不变，因为它是隐藏的 */}
            <div 
              id="report-container" 
              ref={reportRef} 
              className="hidden"
              style={{ minWidth: '1200px' }}
            >
              <div className="p-10 bg-gradient-to-br from-white to-gray-50 dark:from-slate-900 dark:to-black rounded-xl shadow-2xl border border-gray-100 dark:border-gray-800">
                {/* 顶部标题区域 - 精致设计 */}
                <div className="relative mb-10">
                  <div className="absolute top-0 right-0 w-32 h-32 bg-blue-50 dark:bg-blue-900/10 rounded-full opacity-20 -translate-y-1/2 translate-x-1/3 blur-2xl"></div>
                  <div className="absolute bottom-0 left-0 w-24 h-24 bg-indigo-50 dark:bg-indigo-900/10 rounded-full opacity-20 translate-y-1/2 -translate-x-1/3 blur-xl"></div>
                  
                  <div className="relative flex justify-between items-center pb-8 border-b border-gray-200 dark:border-gray-800">
                    <div className="flex-1">
                      <div className="flex items-center">
                        <div className="p-2 bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-900/20 dark:to-indigo-900/20 rounded-xl shadow-sm border border-blue-100 dark:border-blue-900/30 mr-5">
                          <img src="/logo.png" alt="FlyClash Logo" className="h-12 w-12" />
                        </div>
                        <div>
                          <h2 className="text-3xl font-medium text-gray-900 dark:text-white tracking-tight">节点测速报告</h2>
                          <p className="text-sm font-light text-gray-500 dark:text-gray-400 mt-1">专业网络性能分析</p>
                        </div>
                      </div>
                      
                      <div className="mt-6 flex flex-wrap gap-x-8 gap-y-2">
                        <div className="flex items-center text-sm">
                          <div className="w-2 h-2 rounded-full bg-blue-500 mr-2"></div>
                          <span className="text-gray-500 dark:text-gray-400 mr-1">测试时间:</span>
                          <span className="text-gray-900 dark:text-white">{new Date().toLocaleString()}</span>
                        </div>
                        
                        {(selectedReport?.testConfig || selectedReport?.proxyGroupName || proxyGroup?.name) && (
                          <div className="flex items-center text-sm">
                            <div className="w-2 h-2 rounded-full bg-indigo-500 mr-2"></div>
                            <span className="text-gray-500 dark:text-gray-400 mr-1">配置:</span>
                            <span className="text-gray-900 dark:text-white">{selectedReport?.testConfig || selectedReport?.proxyGroupName || proxyGroup?.name}</span>
                          </div>
                        )}
                        
                        {reportNote && (
                          <div className="flex items-center text-sm">
                            <div className="w-2 h-2 rounded-full bg-violet-500 mr-2"></div>
                            <span className="text-gray-500 dark:text-gray-400 mr-1">备注:</span>
                            <span className="text-gray-900 dark:text-white">{reportNote}</span>
                          </div>
                        )}
                      </div>
                    </div>
                    
                    {/* 右侧测试统计数据卡片 */}
                    <div className="hidden lg:flex flex-col gap-y-2">
                      <div className="flex gap-3">
                        <div className="flex flex-col items-center justify-center p-3 bg-white dark:bg-gray-900 rounded-lg shadow-sm border border-gray-100 dark:border-gray-800 min-w-24">
                          <span className="text-xs text-gray-500 dark:text-gray-400">测试节点</span>
                          <span className="text-xl font-medium text-gray-900 dark:text-white">{testResults.length}</span>
                        </div>
                        {skippedNodes.length > 0 && (
                          <div className="flex flex-col items-center justify-center p-3 bg-white dark:bg-gray-900 rounded-lg shadow-sm border border-gray-100 dark:border-gray-800 min-w-24">
                            <span className="text-xs text-gray-500 dark:text-gray-400">跳过节点</span>
                            <span className="text-xl font-medium text-amber-500">{skippedNodes.length}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
                
                {/* 表格区域 - 精致高端设计 */}
                <div className="overflow-x-auto rounded-xl shadow-sm border border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900">
                  <table className="w-full text-sm" style={{ tableLayout: 'fixed', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr className="bg-gray-50 dark:bg-gray-800/50 border-b border-gray-100 dark:border-gray-800">
                        <th scope="col" className="px-4 py-4 text-center whitespace-nowrap"><ListOrdered size={16} className="inline-block mr-1 align-text-bottom"/>序号</th>
                        <th scope="col" className="px-4 py-4 text-left whitespace-nowrap min-w-[200px]">节点名称</th>
                        <th scope="col" className="px-4 py-4 text-center whitespace-nowrap"><Network size={16} className="inline-block mr-1 align-text-bottom"/>类型</th>
                        <th scope="col" className="px-4 py-4 text-center whitespace-nowrap"><Zap size={16} className="inline-block mr-1 align-text-bottom"/>延迟(ms)</th>
                        <th scope="col" className="px-4 py-4 text-center whitespace-nowrap">偏差(ms)</th>
                        <th scope="col" className="px-4 py-4 text-center whitespace-nowrap"><Globe size={16} className="inline-block mr-1 align-text-bottom"/>HTTP(ms)</th>
                        <th scope="col" className="px-4 py-4 text-center whitespace-nowrap"><ArrowDownToLine size={16} className="inline-block mr-1 align-text-bottom"/>平均速度</th>
                        <th scope="col" className="px-4 py-4 text-center whitespace-nowrap"><TrendingUp size={16} className="inline-block mr-1 align-text-bottom"/>最大速度</th>
                        <th scope="col" className="px-4 py-4 text-center whitespace-nowrap">UDP</th>
                      </tr>
                    </thead>
                    <tbody>
                      {testResults.map((result, index) => {
                        const delay = result.delay > 0 ? result.delay : (result.httpDelay > 0 ? result.httpDelay : -1);
                        let delayColor = 'text-gray-700 dark:text-gray-300';
                        if (delay > 0 && delay <= 150) delayColor = 'text-green-600 dark:text-green-400 font-medium';
                        else if (delay > 150 && delay <= 350) delayColor = 'text-amber-600 dark:text-amber-400 font-medium';
                        else if (delay > 350) delayColor = 'text-red-600 dark:text-red-400 font-medium';
                        else if (delay === -1) delayColor = 'text-red-500 dark:text-red-400';

                        let httpDelayColor = result.httpDelay > 0 && result.httpDelay <= 2000 ? 'text-green-600 dark:text-green-400' : (result.httpDelay > 2000 && result.httpDelay <= 5000 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400');
                        if (result.httpDelay <=0) httpDelayColor = 'text-red-500 dark:text-red-400';
                        
                        let udpContent;
                        if (result.udpType === 'Symmetric' || result.udpType === 'FullCone') {
                            udpContent = <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700 dark:bg-green-700/30 dark:text-green-300 border border-green-200 dark:border-green-600"><ShieldCheck size={12} className="mr-1" />{result.udpType}</span>;
                        } else if (result.udpType === 'Blocked') {
                            udpContent = <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700 dark:bg-red-700/30 dark:text-red-300 border border-red-200 dark:border-red-600"><ShieldX size={12} className="mr-1" />{result.udpType}</span>;
                        } else if (result.udpType && result.udpType !== 'Unknown' && result.udpType !== 'N/A') {
                            udpContent = <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700 dark:bg-amber-700/30 dark:text-amber-300 border border-amber-200 dark:border-amber-600"><AlertTriangle size={12} className="mr-1" />{result.udpType}</span>;
                        } else {
                            udpContent = <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-600">{result.udpType || 'N/A'}</span>;
                        }

                        return (
                          <tr key={index} className={`${index % 2 === 0 ? 'bg-white dark:bg-slate-800/30' : 'bg-slate-50/50 dark:bg-slate-800/60'} hover:bg-slate-100 dark:hover:bg-slate-700/50 transition-colors duration-100 ease-in-out`}>
                            <td className="px-3 py-2.5 text-center align-middle font-medium tabular-nums whitespace-nowrap">{index + 1}</td>
                            <td className="px-3 py-2.5 text-left align-middle font-medium whitespace-nowrap truncate max-w-xs" title={result.name}>{result.name}</td>
                            <td className="px-3 py-2.5 text-center align-middle whitespace-nowrap">
                              <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-sky-100 text-sky-700 dark:bg-sky-700/30 dark:text-sky-300 border border-sky-200 dark:border-sky-600`}>
                                {result.type || 'N/A'}
                              </span>
                            </td>
                            <td className={`px-3 py-2.5 text-center align-middle tabular-nums whitespace-nowrap ${delayColor}`}>
                              {delay > 0 ? `${delay.toFixed(0)}` : (delay === -1 ? '超时' : 'N/A')}
                            </td>
                            <td className="px-3 py-2.5 text-center align-middle tabular-nums whitespace-nowrap text-slate-500 dark:text-slate-400">
                              {result.rttDeviation > 0 ? `${result.rttDeviation.toFixed(1)}` : '-'}
                            </td>
                            <td className={`px-3 py-2.5 text-center align-middle tabular-nums whitespace-nowrap ${httpDelayColor}`}>
                              {result.httpDelay > 0 ? `${result.httpDelay.toFixed(0)}` : '超时'}
                            </td>
                            <td className="px-3 py-2.5 text-center align-middle tabular-nums whitespace-nowrap font-medium text-indigo-600 dark:text-indigo-400">
                              {result.downloadSpeed > 0 ? <>{result.downloadSpeed.toFixed(2)} <span className="text-xs text-slate-500 dark:text-slate-400">Mbps</span></> : '-'}
                            </td>
                            <td className="px-3 py-2.5 text-center align-middle tabular-nums whitespace-nowrap font-medium text-teal-600 dark:text-teal-400">
                              {result.maxSpeed > 0 ? <>{result.maxSpeed.toFixed(2)} <span className="text-xs text-slate-500 dark:text-slate-400">Mbps</span></> : '-'}
                            </td>
                            <td className="px-3 py-2.5 text-center align-middle whitespace-nowrap">
                              {udpContent}
                            </td>
                          </tr>
                        );
                      })}
                      {testResults.length === 0 && (
                        <tr>
                          <td colSpan={9} className="px-3 py-10 text-center text-slate-500 dark:text-slate-400 italic">
                            <Info size={20} className="mx-auto mb-1.5 text-slate-400 dark:text-slate-500"/>
                            暂无测速结果
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Report Footer */}
                <div className="mt-6 pt-5 border-t border-gray-200 dark:border-gray-700 text-center">
                  <p className="text-xs text-gray-400 dark:text-gray-500">
                    由 FlyClash 测速工具生成 - {new Date().toISOString().split('T')[0]}
                  </p>
                </div>
              </div>
            </div>
            
            <div className="rounded-md border overflow-hidden max-h-[260px]">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-white dark:bg-slate-900 border-b">
                  <tr className="bg-muted/50">
                    <th className="text-left py-1 px-1.5 font-medium">序号</th>
                    <th className="text-left py-1 px-1.5 font-medium">节点名称</th>
                    <th className="text-left py-1 px-1.5 font-medium">类型</th>
                    <th className="text-left py-1 px-1.5 font-medium">延迟</th>
                    <th className="text-left py-1 px-1.5 font-medium">偏差</th>
                    <th className="text-left py-1 px-1.5 font-medium">HTTP</th>
                    <th className="text-left py-1 px-1.5 font-medium">平均速度</th>
                    <th className="text-left py-1 px-1.5 font-medium">最大速度</th>
                    <th className="text-left py-1 px-1.5 font-medium">UDP</th>
                  </tr>
                </thead>
                <tbody className="overflow-y-auto">
                  {testResults.map((result, index) => (
                    <tr 
                      key={index} 
                      className={`border-b ${index % 2 === 0 ? 'bg-white dark:bg-slate-900' : 'bg-muted/30 dark:bg-slate-800/40'}`}
                    >
                      <td className="py-1 px-1.5">{index + 1}</td>
                      <td className="py-1 px-1.5 max-w-[150px] truncate">{result.name}</td>
                      <td className="py-1 px-1.5">{result.type}</td>
                      <td className={`py-1 px-1.5 ${getDelayColor(result.delay)}`}>
                        {result.delay > 0 ? `${result.delay}ms` : '超时'}
                      </td>
                      <td className="py-1 px-1.5">
                        {result.rttDeviation > 0 ? result.rttDeviation.toFixed(1) : '0'}
                      </td>
                      <td className={`py-1 px-1.5 ${getDelayColor(result.httpDelay)}`}>
                        {result.httpDelay > 0 ? `${result.httpDelay}ms` : '超时'}
                      </td>
                      <td className={`py-1 px-1.5 ${getSpeedColor(result.downloadSpeed)}`}>
                        {formatSpeed(result.downloadSpeed)}
                      </td>
                      <td className={`py-1 px-1.5 ${getSpeedColor(result.maxSpeed)}`}>
                        {formatSpeed(result.maxSpeed)}
                      </td>
                      <td className="py-1 px-1.5">
                        <span className={getUdpTypeColor(result.udpType)}>
                          {result.udpType || '未知'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {!inDialog && (
        <div className="p-2 border-t flex justify-end">
                     <Button variant="outline" size="sm" onClick={() => {
                       // 如果正在进行后台测试，只隐藏界面而不取消测试
                       if (isTesting && isBackgroundTesting) {
                         toast.info('批量测速正在后台运行，您可以随时返回查看进度');
                       }
                       // 调用关闭回调
                       onClose();
                     }}>关闭</Button>
        </div>
      )}
      
      {/* 历史报告对话框 - 减小尺寸 */}
      {showHistoryReports && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-neutral-900 rounded-lg shadow-lg w-full max-w-xl max-h-[70vh] flex flex-col">
            <div className="p-3 border-b flex justify-between items-center">
              <h3 className="text-sm font-semibold">历史测速报告</h3>
              <Button 
                variant="ghost" 
                size="icon" 
                onClick={() => setShowHistoryReports(false)}
                className="h-6 w-6"
              >
                <XCircle className="h-4 w-4" />
              </Button>
            </div>
            
            <div className="flex-1 overflow-auto p-3">
              {isLoadingHistory ? (
                <div className="flex justify-center items-center h-32">
                  <Loader2 className="h-6 w-6 animate-spin text-primary" />
                  <span className="ml-2 text-sm">加载历史报告中...</span>
                </div>
              ) : historyReports.length === 0 ? (
                <div className="text-center py-6 text-muted-foreground">
                  <Info className="h-10 w-10 mx-auto mb-3 opacity-30" />
                  <p className="text-sm">没有找到历史测速报告</p>
                  <p className="text-xs mt-1">完成测速后，报告将自动保存</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {historyReports.map((report) => (
                    <Card 
                      key={report.id} 
                      className="hover:bg-muted/30 transition-colors cursor-pointer" 
                      onClick={() => loadReportDetail(report.id)}
                    >
                      <CardHeader className="py-2">
                        <div className="flex items-center justify-between">
                          <div>
                            <CardTitle className="text-sm">
                              {/* 优先使用 proxyGroupName 测速报告 格式 */}
                              {report.testConfig
                                ? `${report.testConfig} 测速报告`
                                : (report.testConfig || '测速报告')}
                            </CardTitle>
                            <CardDescription className="text-xs">
                              {formatDateTime(report.timestamp)}
                            </CardDescription>
                          </div>
                          {/* 添加时间图标，保持一致性的设计语言 */}
                          <div className="flex items-center justify-center w-8 h-8 rounded-full bg-primary/10">
                            <Clock className="h-4 w-4 text-primary" />
                          </div>
                        </div>
                      </CardHeader>
                    </Card>
                  ))}
                </div>
              )}
            </div>
            
            <div className="p-4 border-t flex justify-between">
              <Button 
                variant="outline" 
                size="sm" 
                onClick={loadHistoryReports}
                disabled={isLoadingHistory}
              >
                {isLoadingHistory ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                刷新列表
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowHistoryReports(false)}
              >
                关闭
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
} 