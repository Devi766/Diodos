import React, { useState, useEffect, useCallback } from 'react';
import { 
  ReloadIcon, 
  Cross1Icon,
  MagnifyingGlassIcon,
  ClockIcon,
  UploadIcon,
  DownloadIcon,
  GlobeIcon,
  ChevronUpIcon,
  ChevronDownIcon,
  ActivityLogIcon
} from '@radix-ui/react-icons';
import { Badge } from "../src/components/ui/badge";
import { Button } from "../src/components/ui/button";
import { Input } from "../src/components/ui/input";
import { Card } from "../src/components/ui/card";
import { Progress } from "../src/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../src/components/ui/tabs";
import { formatBytes, formatDuration } from '../src/utils/formatters';

// 定义连接类型
type Connection = {
  id: string;
  metadata: {
    network: string;
    type: string;
    sourceIP: string;
    destinationIP: string;
    sourcePort: number;
    destinationPort: number;
    host: string;
    dnsMode?: string;
    processPath?: string;
  };
  upload: number;
  download: number;
  start: string; // ISO字符串
  chains: string[];
  rule: string;
  rulePayload?: string;
};

// 排序键类型
type SortKey = keyof Connection | 'duration';

export default function ConnectionTable() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [activeTab, setActiveTab] = useState('all');
  const [stats, setStats] = useState({
    totalConnections: 0,
    activeConnections: 0,
    totalUpload: 0,
    totalDownload: 0
  });
  const [sortConfig, setSortConfig] = useState<{
    key: SortKey; 
    direction: 'asc' | 'desc'
  }>({
    key: 'start', 
    direction: 'desc'
  });

  // 格式化连接时间（计算持续时间）
  const formatConnectionDuration = (startTimeISO: string) => {
    const startTime = new Date(startTimeISO).getTime();
    const now = new Date().getTime();
    const duration = now - startTime;
    return formatDuration(duration);
  };

  // 排序连接
  const sortedConnections = useCallback(() => {
    const sortableItems = [...connections];
    if (sortConfig.key === 'duration') {
      return sortableItems.sort((a, b) => {
        const aDuration = new Date().getTime() - new Date(a.start).getTime();
        const bDuration = new Date().getTime() - new Date(b.start).getTime();
        return sortConfig.direction === 'asc' 
          ? aDuration - bDuration 
          : bDuration - aDuration;
      });
    }
    
    return sortableItems.sort((a, b) => {
      // 断言sortConfig.key为keyof Connection (不包括'duration')
      const key = sortConfig.key as Exclude<SortKey, 'duration'>;
      
      // 检查可能的嵌套属性
      if (key === 'metadata') {
        // 对于metadata对象，我们比较host属性
        const aValue = a.metadata?.host || '';
        const bValue = b.metadata?.host || '';
        return sortConfig.direction === 'asc'
          ? aValue.localeCompare(bValue)
          : bValue.localeCompare(aValue);
      }
      
      // 对于其他属性，直接比较
      const aValue = a[key];
      const bValue = b[key];
      
      if (aValue === undefined && bValue === undefined) return 0;
      if (aValue === undefined) return sortConfig.direction === 'asc' ? -1 : 1;
      if (bValue === undefined) return sortConfig.direction === 'asc' ? 1 : -1;
      
      if (aValue < bValue) {
        return sortConfig.direction === 'asc' ? -1 : 1;
      }
      if (aValue > bValue) {
        return sortConfig.direction === 'asc' ? 1 : -1;
      }
      return 0;
    });
  }, [connections, sortConfig]);

  // 请求排序
  const requestSort = (key: SortKey) => {
    let direction: 'asc' | 'desc' = 'asc';
    if (sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    }
    setSortConfig({ key, direction });
  };

  // 过滤连接
  const filteredConnections = sortedConnections().filter(connection => {
    // 根据搜索词过滤
    if (searchTerm && !connection.metadata.host.toLowerCase().includes(searchTerm.toLowerCase()) && 
        !connection.metadata.sourceIP.includes(searchTerm) && 
        !connection.rule.toLowerCase().includes(searchTerm.toLowerCase())) {
      return false;
    }
    
    // 根据活动标签过滤
    if (activeTab === 'http' && connection.metadata.type !== 'HTTP') return false;
    if (activeTab === 'https' && connection.metadata.type !== 'HTTPS') return false;
    if (activeTab === 'tcp' && connection.metadata.network !== 'tcp') return false;
    if (activeTab === 'udp' && connection.metadata.network !== 'udp') return false;
    
    return true;
  });

  // 获取连接数据
  const fetchConnections = async () => {
    setIsLoading(true);
    setError(null);
    
    try {
      // 检查Mihomo是否运行
      try {
        const response = await fetch('http://127.0.0.1:9090/version');
        if (!response.ok) {
          throw new Error('Mihomo未运行');
        }
      } catch (error) {
        console.error('Mihomo未运行:', error);
        setIsLoading(false);
        setError('Mihomo服务未运行，请先启动服务');
        return;
      }
      
      // 获取连接信息
      const response = await fetch('http://127.0.0.1:9090/connections');
      if (!response.ok) {
        throw new Error(`获取连接失败: ${response.statusText}`);
      }
      
      const data = await response.json();
      
      // 计算统计信息
      let totalUpload = 0;
      let totalDownload = 0;
      
      if (data.connections && Array.isArray(data.connections)) {
        data.connections.forEach((conn: Connection) => {
          totalUpload += conn.upload;
          totalDownload += conn.download;
        });
        
        setStats({
          totalConnections: data.connections.length,
          activeConnections: data.connections.length,
          totalUpload,
          totalDownload
        });
        
        setConnections(data.connections);
      } else {
        setConnections([]);
        setStats({
          totalConnections: 0,
          activeConnections: 0,
          totalUpload: 0,
          totalDownload: 0
        });
      }
    } catch (error) {
      console.error('获取连接数据失败:', error);
      setError(`获取连接数据失败: ${String(error)}`);
    } finally {
      setIsLoading(false);
    }
  };

  // 断开所有连接
  const closeAllConnections = async () => {
    try {
      const response = await fetch('http://127.0.0.1:9090/connections', {
        method: 'DELETE',
      });
      
      if (!response.ok) {
        throw new Error(`断开连接失败: ${response.statusText}`);
      }
      
      // 重新获取连接列表
      fetchConnections();
    } catch (error) {
      console.error('断开所有连接失败:', error);
      setError(`断开所有连接失败: ${String(error)}`);
    }
  };

  // 断开单个连接
  const closeConnection = async (id: string) => {
    try {
      const response = await fetch(`http://127.0.0.1:9090/connections/${id}`, {
        method: 'DELETE',
      });
      
      if (!response.ok) {
        throw new Error(`断开连接失败: ${response.statusText}`);
      }
      
      // 更新本地连接列表（从UI上立即移除这个连接）
      setConnections(prevConnections => prevConnections.filter(conn => conn.id !== id));
      
      // 更新统计信息
      setStats(prevStats => ({
        ...prevStats,
        activeConnections: prevStats.activeConnections - 1
      }));
    } catch (error) {
      console.error(`断开连接 ${id} 失败:`, error);
      setError(`断开连接失败: ${String(error)}`);
    }
  };

  // 初始加载和定时刷新
  useEffect(() => {
    fetchConnections();
    
    // 定时刷新连接列表（每5秒）
    const intervalId = setInterval(fetchConnections, 5000);
    
    return () => {
      clearInterval(intervalId);
    };
  }, []);

  // 渲染连接类型Badge
  const renderTypeBadge = (type: string, network: string) => {
    let badgeClass = "";
    let icon = null;
    
    if (type === "HTTP") {
      badgeClass = "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400 border-blue-200 dark:border-blue-800/30";
      icon = <GlobeIcon className="w-2.5 h-2.5 mr-0.5" />;
    } else if (type === "HTTPS") {
      badgeClass = "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400 border-green-200 dark:border-green-800/30";
      icon = <GlobeIcon className="w-2.5 h-2.5 mr-0.5" />;
    } else if (network === "tcp") {
      badgeClass = "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400 border-purple-200 dark:border-purple-800/30";
      icon = <ActivityLogIcon className="w-2.5 h-2.5 mr-0.5" />;
    } else if (network === "udp") {
      badgeClass = "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400 border-orange-200 dark:border-orange-800/30";
      icon = <ActivityLogIcon className="w-2.5 h-2.5 mr-0.5" />;
    }
    
    return (
      <Badge className={`${badgeClass} py-0.5 px-1.5 flex items-center border text-[10px]`}>
        {icon}
        {type || network.toUpperCase()}
      </Badge>
    );
  };

  return (
    <div className="space-y-4">
      {/* 统计卡片 - 优化高度和布局 */}
      <div className="grid grid-cols-4 gap-3">
        <Card className="p-3 shadow-sm rounded-xl bg-white dark:bg-[#1e1e1e] border border-gray-100 dark:border-gray-800 overflow-hidden relative">
          <div className="absolute top-0 left-0 w-1 h-full bg-blue-500 dark:bg-blue-600"></div>
          <div className="flex flex-col ml-2">
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400">活跃连接</span>
            <div className="flex items-center">
              <GlobeIcon className="h-3.5 w-3.5 mr-1.5 text-blue-500 dark:text-blue-400" />
              <span className="text-xl font-bold text-gray-800 dark:text-gray-200">{stats.activeConnections}</span>
            </div>
          </div>
        </Card>
        <Card className="p-3 shadow-sm rounded-xl bg-white dark:bg-[#1e1e1e] border border-gray-100 dark:border-gray-800 overflow-hidden relative">
          <div className="absolute top-0 left-0 w-1 h-full bg-green-500 dark:bg-green-600"></div>
          <div className="flex flex-col ml-2">
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400">上传流量</span>
            <div className="flex items-center">
              <UploadIcon className="h-3.5 w-3.5 mr-1.5 text-green-500 dark:text-green-400" />
              <span className="text-xl font-bold text-gray-800 dark:text-gray-200">{formatBytes(stats.totalUpload)}</span>
            </div>
            {stats.totalUpload > 0 && (
              <div className="flex text-[10px] text-gray-500 dark:text-gray-400 mt-1">
                <Progress 
                  className="h-1 flex-1 mt-0.5" 
                  value={stats.totalUpload / (stats.totalUpload + stats.totalDownload) * 100}
                  indicatorColor="green"
                />
              </div>
            )}
          </div>
        </Card>
        <Card className="p-3 shadow-sm rounded-xl bg-white dark:bg-[#1e1e1e] border border-gray-100 dark:border-gray-800 overflow-hidden relative">
          <div className="absolute top-0 left-0 w-1 h-full bg-blue-500 dark:bg-blue-600"></div>
          <div className="flex flex-col ml-2">
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400">下载流量</span>
            <div className="flex items-center">
              <DownloadIcon className="h-3.5 w-3.5 mr-1.5 text-blue-500 dark:text-blue-400" />
              <span className="text-xl font-bold text-gray-800 dark:text-gray-200">{formatBytes(stats.totalDownload)}</span>
            </div>
            {stats.totalDownload > 0 && (
              <div className="flex text-[10px] text-gray-500 dark:text-gray-400 mt-1">
                <Progress 
                  className="h-1 flex-1 mt-0.5" 
                  value={stats.totalDownload / (stats.totalUpload + stats.totalDownload) * 100}
                  indicatorColor="blue"
                />
              </div>
            )}
          </div>
        </Card>
        <Card className="p-3 shadow-sm rounded-xl bg-white dark:bg-[#1e1e1e] border border-gray-100 dark:border-gray-800 overflow-hidden relative">
          <div className="absolute top-0 left-0 w-1 h-full bg-purple-500 dark:bg-purple-600"></div>
          <div className="flex flex-col ml-2">
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400">总流量</span>
            <div className="flex items-center">
              <ClockIcon className="h-3.5 w-3.5 mr-1.5 text-purple-500 dark:text-purple-400" />
              <span className="text-xl font-bold text-gray-800 dark:text-gray-200">
                {formatBytes(stats.totalUpload + stats.totalDownload)}
              </span>
            </div>
            <div className="flex text-[10px] text-gray-500 dark:text-gray-400 mt-1">
              {stats.totalUpload + stats.totalDownload > 0 && (
                <>
                  <span className="flex items-center">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500 mr-1"></span>
                    上传 {Math.round(stats.totalUpload / (stats.totalUpload + stats.totalDownload) * 100)}%
                  </span>
                  <span className="mx-1">|</span>
                  <span className="flex items-center">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 mr-1"></span>
                    下载 {Math.round(stats.totalDownload / (stats.totalUpload + stats.totalDownload) * 100)}%
                  </span>
                </>
              )}
            </div>
          </div>
        </Card>
      </div>
      
      {/* 主内容区 - 使用flex布局，固定高度 */}
      <div className="bg-white dark:bg-[#1e1e1e] border border-gray-100 dark:border-gray-800 rounded-xl shadow-sm flex flex-col h-[calc(100vh-240px)]">
        <Tabs defaultValue={activeTab} value={activeTab} onValueChange={setActiveTab} className="flex flex-col h-full">
          {/* 标签栏和工具栏 */}
          <div className="p-3 border-b border-gray-100 dark:border-gray-800">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-3">
              <TabsList className="grid grid-cols-5 sm:w-[400px] bg-gray-100 dark:bg-[#282828] p-1 rounded-lg">
                <TabsTrigger value="all" className="rounded-md data-[state=active]:bg-white dark:data-[state=active]:bg-[#333]">全部</TabsTrigger>
                <TabsTrigger value="http" className="rounded-md data-[state=active]:bg-white dark:data-[state=active]:bg-[#333]">HTTP</TabsTrigger>
                <TabsTrigger value="https" className="rounded-md data-[state=active]:bg-white dark:data-[state=active]:bg-[#333]">HTTPS</TabsTrigger>
                <TabsTrigger value="tcp" className="rounded-md data-[state=active]:bg-white dark:data-[state=active]:bg-[#333]">TCP</TabsTrigger>
                <TabsTrigger value="udp" className="rounded-md data-[state=active]:bg-white dark:data-[state=active]:bg-[#333]">UDP</TabsTrigger>
              </TabsList>
            
              <div className="flex items-center w-full sm:w-auto">
                <div className="relative w-full sm:w-56">
                  <Input
                    placeholder="搜索连接..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="pl-9 py-1 h-8 bg-gray-100 dark:bg-[#282828] border-0"
                  />
                  <MagnifyingGlassIcon className="absolute left-3 top-1/2 transform -translate-y-1/2 h-3.5 w-3.5 text-gray-500" />
                </div>
              </div>
            </div>
            
            <div className="flex justify-between items-center">
              <div className="text-xs text-gray-500 dark:text-gray-400">
                {filteredConnections.length > 0 ? (
                  <span>共显示 <strong>{filteredConnections.length}</strong> 个连接</span>
                ) : (
                  <span>没有连接</span>
                )}
              </div>
              
              <div className="flex gap-2 w-full sm:w-auto justify-end">
                <Button
                  variant="outline"
                  onClick={fetchConnections}
                  className="border-gray-200 dark:border-gray-700 h-7 px-2 text-xs"
                  disabled={isLoading}
                  size="sm"
                >
                  {isLoading ? (
                    <ReloadIcon className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  ) : (
                    <ReloadIcon className="h-3.5 w-3.5 mr-1.5" />
                  )}
                  刷新
                </Button>
                
                <Button
                  variant="destructive"
                  onClick={() => closeAllConnections()}
                  disabled={connections.length === 0 || isLoading}
                  size="sm"
                  className="h-7 px-2 text-xs bg-red-500 hover:bg-red-600 dark:bg-red-600 dark:hover:bg-red-700"
                >
                  <Cross1Icon className="h-3.5 w-3.5 mr-1.5" />
                  断开所有连接
                </Button>
              </div>
            </div>
          </div>
        
          {/* 错误提示 */}
          {error && (
            <div className="px-3 py-2 mx-3 my-2 text-red-700 bg-red-100/60 dark:bg-red-900/20 dark:text-red-400 rounded-lg border border-red-200 dark:border-red-900/30 text-xs">
              <div className="flex items-center">
                <Cross1Icon className="h-3.5 w-3.5 mr-1.5 text-red-500" />
                {error}
              </div>
            </div>
          )}
          
          {/* 连接表格 - 固定表头，使内容部分可滚动 */}
          <div className="flex-1 flex flex-col min-h-0">
            <div className="overflow-hidden flex-1">
              <div className="h-full flex flex-col">
                <div className="bg-gray-50 dark:bg-[#282828] text-gray-600 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                  <table className="w-full text-xs">
                    <thead>
                      <tr>
                        <th 
                          className="px-3 py-2 text-left cursor-pointer hover:bg-gray-100 dark:hover:bg-[#333] font-medium sticky top-0"
                          onClick={() => requestSort('metadata')}
                          style={{width: '25%'}}
                        >
                          <div className="flex items-center">
                            主机/IP
                            {sortConfig.key === 'metadata' && (
                              <span className="ml-1">
                                {sortConfig.direction === 'asc' 
                                  ? <ChevronUpIcon className="h-3.5 w-3.5" /> 
                                  : <ChevronDownIcon className="h-3.5 w-3.5" />}
                              </span>
                            )}
                          </div>
                        </th>
                        <th className="px-3 py-2 text-left font-medium sticky top-0" style={{width: '10%'}}>类型</th>
                        <th 
                          className="px-3 py-2 text-left cursor-pointer hover:bg-gray-100 dark:hover:bg-[#333] font-medium sticky top-0"
                          onClick={() => requestSort('upload')}
                          style={{width: '12%'}}
                        >
                          <div className="flex items-center">
                            上传
                            {sortConfig.key === 'upload' && (
                              <span className="ml-1">
                                {sortConfig.direction === 'asc' 
                                  ? <ChevronUpIcon className="h-3.5 w-3.5" /> 
                                  : <ChevronDownIcon className="h-3.5 w-3.5" />}
                              </span>
                            )}
                          </div>
                        </th>
                        <th 
                          className="px-3 py-2 text-left cursor-pointer hover:bg-gray-100 dark:hover:bg-[#333] font-medium sticky top-0"
                          onClick={() => requestSort('download')}
                          style={{width: '12%'}}
                        >
                          <div className="flex items-center">
                            下载
                            {sortConfig.key === 'download' && (
                              <span className="ml-1">
                                {sortConfig.direction === 'asc' 
                                  ? <ChevronUpIcon className="h-3.5 w-3.5" /> 
                                  : <ChevronDownIcon className="h-3.5 w-3.5" />}
                              </span>
                            )}
                          </div>
                        </th>
                        <th 
                          className="px-3 py-2 text-left cursor-pointer hover:bg-gray-100 dark:hover:bg-[#333] font-medium sticky top-0"
                          onClick={() => requestSort('duration')}
                          style={{width: '12%'}}
                        >
                          <div className="flex items-center">
                            连接时长
                            {sortConfig.key === 'duration' && (
                              <span className="ml-1">
                                {sortConfig.direction === 'asc' 
                                  ? <ChevronUpIcon className="h-3.5 w-3.5" /> 
                                  : <ChevronDownIcon className="h-3.5 w-3.5" />}
                              </span>
                            )}
                          </div>
                        </th>
                        <th className="px-3 py-2 text-left font-medium sticky top-0" style={{width: '20%'}}>代理链</th>
                        <th className="px-3 py-2 text-right font-medium sticky top-0" style={{width: '9%'}}>操作</th>
                      </tr>
                    </thead>
                  </table>
                </div>
                <div className="overflow-y-auto flex-1 scrollbar">
                  <table className="w-full text-xs">
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                      {filteredConnections.length > 0 ? (
                        filteredConnections.map((connection) => (
                          <tr 
                            key={connection.id} 
                            className="hover:bg-gray-50 dark:hover:bg-[#282828] transition-colors"
                          >
                            <td className="px-3 py-2" style={{width: '25%'}}>
                              <div className="flex flex-col">
                                <span className="font-medium text-gray-800 dark:text-gray-200 truncate max-w-[200px]">
                                  {connection.metadata.host || connection.metadata.destinationIP}
                                </span>
                                <span className="text-[10px] text-gray-500 dark:text-gray-400 mt-0.5">
                                  {connection.metadata.sourceIP}:{connection.metadata.sourcePort} 
                                  <span className="mx-1 inline-block transform rotate-90">⟶</span>
                                  {connection.metadata.destinationIP}:{connection.metadata.destinationPort}
                                </span>
                              </div>
                            </td>
                            <td className="px-3 py-2" style={{width: '10%'}}>
                              {renderTypeBadge(connection.metadata.type, connection.metadata.network)}
                            </td>
                            <td className="px-3 py-2" style={{width: '12%'}}>
                              <div className="flex flex-col">
                                <span className="text-green-600 dark:text-green-400 font-medium">
                                  {formatBytes(connection.upload)}
                                </span>
                                {connection.upload > 0 && (
                                  <div className="w-full mt-0.5 flex text-[10px] text-gray-500 dark:text-gray-400">
                                    <Progress 
                                      className="h-1 flex-1" 
                                      value={connection.upload / (connection.upload + connection.download || 1) * 100}
                                      indicatorColor="green"
                                    />
                                  </div>
                                )}
                              </div>
                            </td>
                            <td className="px-3 py-2" style={{width: '12%'}}>
                              <div className="flex flex-col">
                                <span className="text-blue-600 dark:text-blue-400 font-medium">
                                  {formatBytes(connection.download)}
                                </span>
                                {connection.download > 0 && (
                                  <div className="w-full mt-0.5 flex text-[10px] text-gray-500 dark:text-gray-400">
                                    <Progress 
                                      className="h-1 flex-1" 
                                      value={connection.download / (connection.upload + connection.download || 1) * 100}
                                      indicatorColor="blue"
                                    />
                                  </div>
                                )}
                              </div>
                            </td>
                            <td className="px-3 py-2 text-gray-800 dark:text-gray-200" style={{width: '12%'}}>
                              {formatConnectionDuration(connection.start)}
                            </td>
                            <td className="px-3 py-2" style={{width: '20%'}}>
                              <div className="flex flex-col">
                                <span className="font-medium text-gray-800 dark:text-gray-200 truncate">
                                  {connection.chains?.join(' → ') || '-'}
                                </span>
                                <span className="text-[10px] text-gray-500 dark:text-gray-400 mt-0.5 inline-flex items-center">
                                  <Badge variant="outline" className="h-4 px-1 border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 bg-transparent text-[10px]">
                                    {connection.rule}
                                  </Badge>
                                </span>
                              </div>
                            </td>
                            <td className="px-3 py-2 text-right" style={{width: '9%'}}>
                              <Button 
                                variant="ghost" 
                                size="sm"
                                onClick={() => closeConnection(connection.id)}
                                className="text-red-500 hover:text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20 h-6 w-6 p-0"
                              >
                                <Cross1Icon className="h-3.5 w-3.5" />
                              </Button>
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={7} className="px-3 py-6 text-center text-gray-500 dark:text-gray-400">
                            {isLoading ? (
                              <div className="flex justify-center items-center">
                                <ReloadIcon className="animate-spin h-4 w-4 mr-2" />
                                加载中...
                              </div>
                            ) : error ? (
                              <span>出错了，请尝试刷新</span>
                            ) : (
                              <div className="flex flex-col items-center">
                                <ActivityLogIcon className="h-8 w-8 text-gray-300 dark:text-gray-600 mb-2" />
                                <span>没有找到符合条件的连接</span>
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        </Tabs>
      </div>
    </div>
  );
} 