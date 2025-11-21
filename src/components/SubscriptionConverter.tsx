'use client';

import React, { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import * as Dialog from '@radix-ui/react-dialog';
import { Cross2Icon } from '@radix-ui/react-icons';
import {
  RefreshCw,
  Copy,
  Download,
  Upload,
  Link as LinkIcon,
  FileText,
  Settings,
  Play,
  Server,
  List,
  CheckCircle2,
  XCircle,
  Loader2
} from 'lucide-react';

export default function SubscriptionConverter() {
  const { t } = useTranslation();

  // 输入方式: 'url' | 'content'
  const [inputType, setInputType] = useState<'url' | 'content'>('url');
  
  // 输入内容
  const [urlInput, setUrlInput] = useState('');
  const [contentInput, setContentInput] = useState('');
  
  // 目标格式
  const [targetFormat, setTargetFormat] = useState('clash-meta');
  
  // 过滤正则
  const [filterRegex, setFilterRegex] = useState('');
  
  // 转换选项
  const [enableUdp, setEnableUdp] = useState(true);
  const [enableTcpFastOpen, setEnableTcpFastOpen] = useState(false);
  const [skipCertVerify, setSkipCertVerify] = useState(false);
  const [autoAddEmoji, setAutoAddEmoji] = useState(false);

  // 模板相关
  const [useTemplate, setUseTemplate] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [templates, setTemplates] = useState<any[]>([]);

  // 判断当前格式是否需要强制使用模板
  const requiresTemplate = () => {
    return ['clash', 'clash-meta', 'surge', 'quantumult-x', 'shadowrocket', 'sing-box'].includes(targetFormat);
  };

  // 判断当前格式是否支持添加到配置
  const canAddToConfig = () => {
    return ['clash', 'clash-meta'].includes(targetFormat);
  };

  // 当目标格式改变时,自动设置useTemplate
  useEffect(() => {
    if (requiresTemplate()) {
      setUseTemplate(true);
      // 如果还没有选择模板,选择第一个
      if (!selectedTemplate && templates.length > 0) {
        setSelectedTemplate(templates[0].id);
      }
    }
  }, [targetFormat, templates]);

  // 转换状态
  const [converting, setConverting] = useState(false);

  // 转换结果
  const [conversionResult, setConversionResult] = useState<any>(null);
  const [proxiesList, setProxiesList] = useState<any[]>([]);

  // 订阅服务器
  const [serverRunning, setServerRunning] = useState(false);
  const [subscriptionUrl, setSubscriptionUrl] = useState('');
  const [subscriptionId, setSubscriptionId] = useState('');

  // 设置对话框
  const [showSettings, setShowSettings] = useState(false);
  const [serverPort, setServerPort] = useState(59999);
  const [autoStart, setAutoStart] = useState(false);
  const [fetchUserAgent, setFetchUserAgent] = useState('FlyClash-Converter/1.0');

  // 添加成功对话框
  const [showAddSuccess, setShowAddSuccess] = useState(false);

  // 错误对话框
  const [showError, setShowError] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  // 检查服务器状态和加载设置
  useEffect(() => {
    checkServerStatus();
    loadTemplates();
    loadSettings();
  }, []);

  // 加载设置
  const loadSettings = async () => {
    if (!window.electronAPI?.converter) return;

    try {
      const result = await window.electronAPI.converter.getSettings();
      if (result.success) {
        setServerPort(result.settings.port || 59999);
        setAutoStart(result.settings.autoStart || false);
        setFetchUserAgent(result.settings.userAgent || 'FlyClash-Converter/1.0');
      }
    } catch (error) {
      console.error('加载设置失败:', error);
    }
  };

  // 保存设置
  const saveSettings = async () => {
    if (!window.electronAPI?.converter) return;

    try {
      const result = await window.electronAPI.converter.saveSettings({
        port: serverPort,
        autoStart: autoStart,
        userAgent: fetchUserAgent
      });

      if (result.success) {
        toast.success(t('converter.success.settingsSaved'));
        setShowSettings(false);

        // 如果端口改变且服务器正在运行,需要重启服务器
        if (serverRunning) {
          await window.electronAPI.converter.stopServer();
          await window.electronAPI.converter.startServer();
          await checkServerStatus();
        }
      } else {
        toast.error(t('converter.errors.saveSettingsFailed', { error: result.error }));
      }
    } catch (error: any) {
      console.error('保存设置失败:', error);
      toast.error(t('converter.errors.saveSettingsError'));
    }
  };

  const checkServerStatus = async () => {
    if (!window.electronAPI?.converter) return;

    try {
      const result = await window.electronAPI.converter.serverStatus();
      if (result.success) {
        setServerRunning(result.isRunning);
      }
    } catch (error) {
      console.error('检查服务器状态失败:', error);
    }
  };

  // 加载模板列表
  const loadTemplates = async () => {
    if (!window.electronAPI?.converter) return;

    try {
      const result = await window.electronAPI.converter.getTemplates();
      if (result.success) {
        setTemplates(result.templates);
        // 默认选择第一个模板
        if (result.templates.length > 0) {
          setSelectedTemplate(result.templates[0].id);
        }
      }
    } catch (error) {
      console.error('加载模板失败:', error);
    }
  };

  // 格式选项
  const formatOptions = [
    { value: 'clash', label: 'Clash' },
    { value: 'clash-meta', label: 'Clash Meta' },
    { value: 'sing-box', label: 'Sing-box' },
    { value: 'surge', label: 'Surge' },
    { value: 'quantumult-x', label: 'Quantumult X' },
    { value: 'shadowrocket', label: 'Shadowrocket' },
    { value: 'v2ray', label: 'V2Ray' },
    { value: 'uri', label: 'URI' },
    { value: 'base64', label: 'Base64' }
  ];



  // 解析代理列表
  const parseProxies = async (input: string) => {
    if (!window.electronAPI?.converter) return;
    
    try {
      const result = await window.electronAPI.converter.parseProxies(input);
      
      if (result.success) {
        setProxiesList(result.proxies);
      }
    } catch (error) {
      console.error('解析代理失败:', error);
    }
  };

  // 执行转换
  const handleConvert = async () => {
    let sourceContent = '';

    // 处理输入
    if (inputType === 'url') {
      // URL模式: 支持多个URL, 每行一个；如果输入看起来不是 URL 而是 Base64，则直接当作内容处理
      const lines = urlInput
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));

      if (lines.length === 0) {
        toast.error(t('converter.errors.emptyUrl'));
        return;
      }

      const urlLines = lines.filter(line => /^https?:\/\//i.test(line));

      // 如果没有任何 http(s) 开头的行，而且整体看起来像 Base64，则直接作为内容处理（兼容 SIP003 这类订阅字符串）
      const looksLikeBase64 = (str: string) => {
        const compact = str.replace(/\s+/g, '');
        if (compact.length < 16) return false;
        if (!/^[A-Za-z0-9+/=]+$/.test(compact)) return false;
        return true;
      };

      if (urlLines.length === 0 && looksLikeBase64(urlInput)) {
        console.log(
          '[Converter] URL 模式检测到 Base64 风格输入，直接按内容处理'
        );
        sourceContent = urlInput;
        setContentInput(sourceContent);
        setConverting(true);
        setConversionResult(null);
        setSubscriptionUrl('');
      } else {
        // 正常 URL 模式: 下载所有 URL 的内容
        const urls = urlLines;

        if (urls.length === 0) {
          toast.error(t('converter.errors.emptyUrl'));
          return;
        }

        setConverting(true);
        setConversionResult(null);
        setSubscriptionUrl('');

        try {
          if (urls.length === 1) {
            const result = await window.electronAPI.converter.fetchUrl(urls[0]);
            if (!result.success) {
              throw new Error(result.error);
            }
            sourceContent = result.content;
            console.log('[Converter] 下载内容长度:', sourceContent.length);
            console.log('[Converter] 下载内容预览:', sourceContent.substring(0, 500));
          } else {
            const contents: string[] = [];
            for (let i = 0; i < urls.length; i++) {
              const result = await window.electronAPI.converter.fetchUrl(urls[i]);
              if (result.success) {
                contents.push(result.content);
                console.log(`[Converter] URL ${i + 1} 下载内容长度:`, result.content.length);
              }
            }
            sourceContent = contents.join('\n');
            console.log('[Converter] 合并后内容长度:', sourceContent.length);
          }
          setContentInput(sourceContent);
        } catch (error: any) {
          toast.error(t('converter.errors.fetchFailed', { error: error.message }));
          setConverting(false);
          return;
        }
      }
    } else {
      // 内容模式
      sourceContent = contentInput;
      if (!sourceContent.trim()) {
        toast.error(t('converter.errors.emptyInput'));
        return;
      }
      setConverting(true);
      setConversionResult(null);
      setSubscriptionUrl('');
    }

    // 添加转换动画延迟
    await new Promise(resolve => setTimeout(resolve, 300));

    try {
      console.log('[Converter] 开始转换, 内容长度:', sourceContent.length);
      console.log('[Converter] 目标格式:', targetFormat);
      console.log('[Converter] 过滤正则:', filterRegex);
      console.log('[Converter] 使用模板:', useTemplate);
      console.log('[Converter] 选择的模板:', selectedTemplate);

      // 执行转换
      let result;
      if (useTemplate && selectedTemplate) {
        // 使用模板转换
        result = await window.electronAPI.converter.convertWithTemplate({
          input: sourceContent,
          targetFormat,
          templateId: selectedTemplate,
          filterRegex,
          options: {
            enableUdp,
            enableTcpFastOpen,
            skipCertificateVerify: skipCertVerify,
            autoAddEmoji
          }
        });
      } else {
        // 不使用模板,仅转换节点
        result = await window.electronAPI.converter.convert({
          input: sourceContent,
          targetFormat,
          filterRegex: filterRegex.trim() || null,
          options: {
            enableUdp,
            enableTcpFastOpen,
            skipCertificateVerify: skipCertVerify,
            autoAddEmoji
          },
          // 处理流水线（预留扩展，目前前端未开放配置时传空）
          processors: null
        });
      }

      console.log('[Converter] 转换结果:', result);

      if (result.success) {
        setConversionResult(result);
        console.log('[Converter] 设置转换结果:', result);
        toast.success(t('converter.success.converted', {
          input: result.inputProxyCount,
          output: result.outputProxyCount
        }));

        // 自动生成配置链接
        await createSubscriptionAuto(sourceContent, result.outputProxyCount);
      } else {
        console.error('[Converter] 转换失败:', result.errorMessage);
        setErrorMessage(result.errorMessage || t('converter.errors.convertError'));
        setShowError(true);
      }
    } catch (error: any) {
      console.error('转换失败:', error);
      setErrorMessage(error.message || t('converter.errors.convertError'));
      setShowError(true);
    } finally {
      setConverting(false);
    }
  };

  // 自动生成配置链接
  const createSubscriptionAuto = async (sourceContent: string, proxyCount: number) => {
    try {
      // 启动服务器
      await window.electronAPI.converter.startServer();

      // 创建配置
      const result = await window.electronAPI.converter.createSubscription({
        name: `FlyClash_${targetFormat}_${Math.floor(Date.now() / 1000)}`,
        sourceUrl: inputType === 'url' ? urlInput : null,
        sourceContent: inputType === 'content' ? sourceContent : null,
        targetFormat,
        filterRegex: filterRegex.trim() || null,
        templateId: useTemplate && selectedTemplate ? selectedTemplate : null,
        options: {
          enableUdp,
          enableTcpFastOpen,
          skipCertificateVerify: skipCertVerify,
          autoAddEmoji
        }
      });

      if (result.success) {
        setSubscriptionId(result.id);
        setSubscriptionUrl(result.url);
        setServerRunning(true);
      }
    } catch (error: any) {
      console.error('自动生成配置链接失败:', error);
    }
  };



  // 复制订阅URL
  const handleCopyUrl = () => {
    if (!subscriptionUrl) return;
    
    navigator.clipboard.writeText(subscriptionUrl);
    toast.success(t('converter.success.urlCopied'));
  };

  // 导出配置
  const handleExport = () => {
    if (!conversionResult || !conversionResult.output) {
      toast.error(t('converter.errors.noResult'));
      return;
    }

    const blob = new Blob([conversionResult.output], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;

    const ext = targetFormat === 'sing-box' ? 'json' :
                targetFormat === 'clash' || targetFormat === 'clash-meta' ? 'yaml' : 'txt';
    a.download = `flyclash_${targetFormat}_${Date.now()}.${ext}`;

    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    toast.success(t('converter.success.exported'));
  };

  // 添加到配置
  const handleAddToConfig = async () => {
    if (!subscriptionUrl) {
      toast.error(t('converter.errors.noSubscriptionUrl'));
      return;
    }

    if (!canAddToConfig()) {
      toast.error(t('converter.errors.formatNotSupported'));
      return;
    }

    try {
      // 生成配置名称
      const configName = `Converter_${targetFormat}_${Math.floor(Date.now() / 1000)}`;

      // 将订阅URL转换为127.0.0.1的内网地址
      const localUrl = subscriptionUrl.replace(/http:\/\/[^:]+:/, 'http://127.0.0.1:');

      // 调用后端API添加配置(只传递URL)
      const result = await window.electronAPI.converter.addToConfig({
        name: configName,
        url: localUrl
      });

      if (result.success) {
        // 显示成功对话框
        setShowAddSuccess(true);
        // 广播配置更新事件(让配置管理页面刷新列表)
        window.dispatchEvent(new Event('profile-updated'));

        // 提示用户需要先更新配置
        toast.success(t('converter.success.addedToConfig'));
      } else {
        toast.error(t('converter.errors.addToConfigFailed', { error: result.error }));
      }
    } catch (error: any) {
      console.error('添加到配置失败:', error);
      toast.error(t('converter.errors.addToConfigError'));
    }
  };

  return (
    <div className="space-y-5">
      {/* 设置按钮和状态 */}
      <div className="rounded-2xl bg-white px-4 py-3 shadow-sm dark:bg-[#2a2a2a]">
        <div className="flex items-center justify-between">
          <button
            onClick={() => setShowSettings(true)}
            className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200 hover:text-blue-500 dark:hover:text-blue-400 transition"
          >
            <Settings className="h-4 w-4" />
            {t('converter.settings.converterSettings')}
          </button>

          {/* 服务状态badge和开关 */}
          <div className="flex items-center gap-3">
            {serverRunning ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-3 py-1 text-xs text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-300">
                <CheckCircle2 className="h-3 w-3" />
                {t('converter.server.running')} · {serverPort}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-600 dark:bg-gray-500/10 dark:text-gray-400">
                <XCircle className="h-3 w-3" />
                {t('converter.server.stopped')}
              </span>
            )}

            {/* 启动/停止按钮 */}
            <button
              onClick={async () => {
                if (serverRunning) {
                  await window.electronAPI.converter.stopServer();
                } else {
                  await window.electronAPI.converter.startServer();
                }
                await checkServerStatus();
              }}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                serverRunning
                  ? 'bg-red-100 text-red-600 hover:bg-red-200 dark:bg-red-500/10 dark:text-red-400 dark:hover:bg-red-500/20'
                  : 'bg-blue-100 text-blue-600 hover:bg-blue-200 dark:bg-blue-500/10 dark:text-blue-400 dark:hover:bg-blue-500/20'
              }`}
            >
              {serverRunning ? t('converter.server.stop') : t('converter.server.start')}
            </button>
          </div>
        </div>
      </div>

      {/* 输入方式切换 */}
      <div className="rounded-2xl bg-white px-4 py-4 shadow-sm dark:bg-[#2a2a2a]">
        <div className="flex items-center gap-4">
          <button
            onClick={() => setInputType('url')}
            className={`flex-1 rounded-lg px-4 py-2 text-sm font-medium transition ${
              inputType === 'url'
                ? 'bg-blue-500 text-white'
                : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
            }`}
          >
            <LinkIcon className="inline-block mr-2 h-4 w-4" />
            {t('converter.input.url')}
          </button>
          <button
            onClick={() => setInputType('content')}
            className={`flex-1 rounded-lg px-4 py-2 text-sm font-medium transition ${
              inputType === 'content'
                ? 'bg-blue-500 text-white'
                : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
            }`}
          >
            <FileText className="inline-block mr-2 h-4 w-4" />
            {t('converter.input.content')}
          </button>
        </div>
      </div>

      {/* URL 输入 */}
      {inputType === 'url' && (
        <div className="rounded-2xl bg-white px-4 py-4 shadow-sm dark:bg-[#2a2a2a] space-y-2">
          <label className="text-xs text-gray-600 dark:text-gray-400">{t('converter.input.urlPlaceholder')}</label>
          <textarea
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="https://example.com/config1&#10;https://example.com/config2&#10;# 支持多个URL，每行一个"
            className="min-h-[120px] w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      )}

      {/* 内容输入 */}
      {inputType === 'content' && (
        <div className="rounded-2xl bg-white px-4 py-4 shadow-sm dark:bg-[#2a2a2a] space-y-2">
          <label className="text-xs text-gray-600 dark:text-gray-400">{t('converter.input.contentPlaceholder')}</label>
          <textarea
            value={contentInput}
            onChange={(e) => {
              setContentInput(e.target.value);
              if (e.target.value) {
                parseProxies(e.target.value);
              }
            }}
            placeholder={t('converter.input.contentPlaceholder')}
            className="min-h-[200px] w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      )}

      {/* 转换设置 */}
      <div className="rounded-2xl bg-white px-4 py-4 shadow-sm dark:bg-[#2a2a2a] space-y-4">
        {/* 目标格式 */}
        <div className="space-y-2">
          <label className="text-xs text-gray-600 dark:text-gray-400">{t('converter.settings.targetFormat')}</label>
          <select
            value={targetFormat}
            onChange={(e) => setTargetFormat(e.target.value)}
            className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {formatOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        {/* 过滤正则 */}
        <div className="space-y-2">
          <label className="text-xs text-gray-600 dark:text-gray-400">{t('converter.settings.filterRegex')}</label>
          <input
            type="text"
            value={filterRegex}
            onChange={(e) => setFilterRegex(e.target.value)}
            placeholder={t('converter.settings.filterPlaceholder')}
            className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {/* 使用模板 */}
        <div className="space-y-3">
          {/* 如果格式需要强制使用模板,则隐藏checkbox */}
          {!requiresTemplate() && (
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={useTemplate}
                onChange={(e) => setUseTemplate(e.target.checked)}
                className="h-4 w-4 rounded"
              />
              <span className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('converter.settings.useTemplate')}</span>
            </label>
          )}

          {/* 当使用模板时显示模板选择 */}
          {(useTemplate || requiresTemplate()) && (
            <div className="space-y-2">
              <label className="text-xs text-gray-600 dark:text-gray-400">{t('converter.settings.template')}</label>
              <select
                value={selectedTemplate}
                onChange={(e) => setSelectedTemplate(e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name} - {template.description}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* 转换选项 */}
        <div className="space-y-3">
          <label className="text-xs text-gray-600 dark:text-gray-400">{t('converter.settings.options')}</label>

          <div className="space-y-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={enableUdp}
                onChange={(e) => setEnableUdp(e.target.checked)}
                className="h-4 w-4 rounded"
              />
              <span className="text-sm text-gray-700 dark:text-gray-200">{t('converter.options.enableUdp')}</span>
            </label>

            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={enableTcpFastOpen}
                onChange={(e) => setEnableTcpFastOpen(e.target.checked)}
                className="h-4 w-4 rounded"
              />
              <span className="text-sm text-gray-700 dark:text-gray-200">{t('converter.options.enableTcpFastOpen')}</span>
            </label>

            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={skipCertVerify}
                onChange={(e) => setSkipCertVerify(e.target.checked)}
                className="h-4 w-4 rounded"
              />
              <span className="text-sm text-gray-700 dark:text-gray-200">{t('converter.options.skipCertVerify')}</span>
            </label>

            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={autoAddEmoji}
                onChange={(e) => setAutoAddEmoji(e.target.checked)}
                className="h-4 w-4 rounded"
              />
              <span className="text-sm text-gray-700 dark:text-gray-200">{t('converter.options.autoAddEmoji')}</span>
            </label>
          </div>
        </div>

        {/* 分隔线 */}
        <div className="border-t border-gray-200 dark:border-gray-700"></div>

        {/* 转换按钮 */}
        <button
          onClick={handleConvert}
          disabled={converting || (inputType === 'url' ? !urlInput.trim() : !contentInput.trim())}
          className="w-full rounded-lg bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300 dark:disabled:bg-gray-700 px-4 py-3 text-sm font-medium text-white transition"
        >
          {converting ? (
            <>
              <Loader2 className="inline-block mr-2 h-4 w-4 animate-spin" />
              {t('converter.actions.converting')}
            </>
          ) : (
            <>
              <Play className="inline-block mr-2 h-4 w-4" />
              {t('converter.actions.convert')}
            </>
          )}
        </button>
      </div>

      {/* 代理列表预览 */}
      {proxiesList.length > 0 && (
        <div className="rounded-2xl bg-white px-4 py-4 shadow-sm dark:bg-[#2a2a2a]">
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-3">
            <List className="inline-block h-4 w-4 mr-2" />
            {t('converter.proxies.title')} ({proxiesList.length})
          </h3>
          <div className="max-h-[300px] overflow-y-auto space-y-2">
            {proxiesList.slice(0, 50).map((proxy, index) => (
              <div
                key={index}
                className="flex items-center gap-3 rounded-lg bg-gray-50 dark:bg-gray-800 p-3"
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400">
                  <Server className="h-4 w-4" />
                </div>
                <div className="flex-1">
                  <div className="text-sm font-medium text-gray-700 dark:text-gray-200">{proxy.name}</div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {proxy.type.toUpperCase()} • {proxy.server}:{proxy.port}
                  </div>
                </div>
              </div>
            ))}
            {proxiesList.length > 50 && (
              <div className="text-center text-sm text-gray-500 dark:text-gray-400 py-2">
                {t('converter.proxies.more', { count: proxiesList.length - 50 })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 转换结果 */}
      {conversionResult && (
        <div className="rounded-2xl bg-white px-4 py-4 shadow-sm dark:bg-[#2a2a2a] space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-300">
          <div className="flex items-center gap-2">
            {conversionResult.success ? (
              <CheckCircle2 className="h-5 w-5 text-green-500" />
            ) : (
              <XCircle className="h-5 w-5 text-red-500" />
            )}
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200">
              {t('converter.result.title')}
            </h3>
          </div>

          <p className="text-xs text-gray-600 dark:text-gray-400">
            {conversionResult.success
              ? t('converter.result.success', {
                  input: conversionResult.inputProxyCount,
                  output: conversionResult.outputProxyCount
                })
              : conversionResult.errorMessage}
          </p>

          {conversionResult.success && (
            <>
              <div className="space-y-2">
                <label className="text-xs text-gray-600 dark:text-gray-400">{t('converter.result.output')}</label>
                <textarea
                  value={conversionResult.output}
                  readOnly
                  className="min-h-[300px] w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-800 px-3 py-2 text-xs font-mono text-gray-700 dark:text-gray-200"
                />
              </div>

              {/* 导出按钮 */}
              <button
                onClick={handleExport}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 transition"
              >
                <Download className="inline-block mr-2 h-4 w-4" />
                {t('converter.actions.export')}
              </button>
            </>
          )}
        </div>
      )}

      {/* 配置URL */}
      {subscriptionUrl && (
        <div className="rounded-2xl bg-white px-4 py-4 shadow-sm dark:bg-[#2a2a2a] space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-300">
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200">
            <LinkIcon className="inline-block h-4 w-4 mr-2" />
            {t('converter.subscription.title')}
          </h3>

          <p className="text-xs text-gray-600 dark:text-gray-400">
            {t('converter.subscription.description')}
          </p>

          <div className="flex gap-2">
            <input
              type="text"
              value={subscriptionUrl}
              readOnly
              className="flex-1 rounded-lg border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-800 px-3 py-2 text-xs font-mono text-gray-700 dark:text-gray-200"
            />
            <button
              onClick={handleCopyUrl}
              className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 px-3 py-2 text-gray-700 dark:text-gray-200 transition"
            >
              <Copy className="h-4 w-4" />
            </button>
          </div>

          <div className="rounded-lg bg-blue-50 dark:bg-blue-900/20 p-3 text-xs text-blue-900 dark:text-blue-100">
            <p>{t('converter.subscription.hint')}</p>
          </div>

          {/* 添加到配置按钮(仅当格式是clash/clash-meta时显示) */}
          {canAddToConfig() && (
            <button
              onClick={handleAddToConfig}
              className="w-full rounded-lg bg-blue-500 hover:bg-blue-600 px-4 py-2 text-sm font-medium text-white transition"
            >
              <CheckCircle2 className="inline-block mr-2 h-4 w-4" />
              {t('converter.actions.addToConfig')}
            </button>
          )}
        </div>
      )}

      {/* 设置对话框 */}
      <Dialog.Root open={showSettings} onOpenChange={setShowSettings}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[90] bg-slate-900/50 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-[95] w-[min(420px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white/95 p-6 shadow-2xl outline-none transition-all dark:bg-[#2a2a2a] backdrop-blur-xl">
            <Dialog.Title className="mb-4 text-lg font-semibold text-slate-900 dark:text-white">
              {t('converter.settings.converterSettings')}
            </Dialog.Title>

            <div className="space-y-4">
              {/* 服务器端口 */}
              <div className="space-y-2">
                <label className="text-sm font-medium text-gray-700 dark:text-gray-200">
                  {t('converter.settings.serverPort')}
                </label>
                <input
                  type="number"
                  value={serverPort}
                  onChange={(e) => setServerPort(parseInt(e.target.value) || 59999)}
                  min="1024"
                  max="65535"
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {t('converter.settings.serverPortHint')}
                </p>
              </div>

              {/* 自动启动 */}
              <div className="flex items-center justify-between">
                <div>
                  <label className="text-sm font-medium text-gray-700 dark:text-gray-200">
                    {t('converter.settings.autoStart')}
                  </label>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {t('converter.settings.autoStartHint')}
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={autoStart}
                    onChange={(e) => setAutoStart(e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
                </label>
              </div>

              {/* 请求 UA */}
              <div className="space-y-2">
                <label className="text-sm font-medium text-gray-700 dark:text-gray-200">
                  {t('converter.settings.fetchUserAgent')}
                </label>
                <input
                  type="text"
                  value={fetchUserAgent}
                  onChange={(e) => setFetchUserAgent(e.target.value)}
                  placeholder="FlyClash-Converter/1.0"
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {t('converter.settings.fetchUserAgentHint')}
                </p>
                <div className="flex flex-wrap gap-2 mt-1">
                  {[
                    { label: '默认 (FlyClash)', value: 'FlyClash-Converter/1.0' },
                    { label: 'Clash Meta', value: 'ClashMeta' },
                    { label: 'Clash Verge', value: 'Clash-Verge' }
                  ].map(preset => (
                    <button
                      key={preset.value}
                      type="button"
                      onClick={() => setFetchUserAgent(preset.value)}
                      className="rounded-full border border-gray-300 dark:border-gray-600 px-2.5 py-0.5 text-[11px] text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 transition"
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* 按钮 */}
            <div className="mt-6 flex gap-3">
              <Dialog.Close asChild>
                <button
                  className="flex-1 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 transition"
                >
                  {t('common.cancel')}
                </button>
              </Dialog.Close>
              <button
                onClick={saveSettings}
                className="flex-1 rounded-lg bg-blue-500 hover:bg-blue-600 px-4 py-2 text-sm font-medium text-white transition"
              >
                {t('common.save')}
              </button>
            </div>

            <Dialog.Close asChild>
              <button
                aria-label="Close"
                className="absolute right-4 top-4 rounded-full bg-slate-100/70 p-1.5 text-slate-500 transition-colors hover:bg-slate-200 hover:text-slate-700 dark:bg-slate-700/60 dark:text-slate-200 dark:hover:bg-slate-700"
              >
                <Cross2Icon />
              </button>
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* 添加成功对话框 */}
      <Dialog.Root open={showAddSuccess} onOpenChange={setShowAddSuccess}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[90] bg-slate-900/50 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-[95] w-[min(420px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white/95 p-6 shadow-2xl outline-none transition-all dark:bg-[#2a2a2a] backdrop-blur-xl">
            <div className="flex flex-col items-center text-center space-y-4">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30">
                <CheckCircle2 className="h-8 w-8 text-green-600 dark:text-green-400" />
              </div>

              <Dialog.Title className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {t('converter.success.addedToConfig')}
              </Dialog.Title>

              <p className="text-sm text-gray-600 dark:text-gray-400">
                {t('converter.success.addedToConfigHint')}
              </p>

              <Dialog.Close asChild>
                <button
                  className="w-full rounded-lg bg-blue-500 hover:bg-blue-600 px-4 py-2 text-sm font-medium text-white transition"
                >
                  {t('common.ok')}
                </button>
              </Dialog.Close>
            </div>

            <Dialog.Close asChild>
              <button
                aria-label="Close"
                className="absolute right-4 top-4 rounded-full bg-slate-100/70 p-1.5 text-slate-500 transition-colors hover:bg-slate-200 hover:text-slate-700 dark:bg-slate-700/60 dark:text-slate-200 dark:hover:bg-slate-700"
              >
                <Cross2Icon />
              </button>
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* 错误对话框 */}
      <Dialog.Root open={showError} onOpenChange={setShowError}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[90] bg-slate-900/50 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-[95] w-[min(420px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white/95 p-6 shadow-2xl outline-none transition-all dark:bg-[#2a2a2a] backdrop-blur-xl">
            <div className="flex flex-col items-center text-center space-y-4">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/30">
                <XCircle className="h-8 w-8 text-red-600 dark:text-red-400" />
              </div>

              <Dialog.Title className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {t('converter.errors.convertFailed', { error: '' })}
              </Dialog.Title>

              <p className="text-sm text-gray-600 dark:text-gray-400 break-words max-w-full">
                {errorMessage}
              </p>

              <Dialog.Close asChild>
                <button
                  className="w-full rounded-lg bg-red-500 hover:bg-red-600 px-4 py-2 text-sm font-medium text-white transition"
                >
                  {t('common.ok')}
                </button>
              </Dialog.Close>
            </div>

            <Dialog.Close asChild>
              <button
                aria-label="Close"
                className="absolute right-4 top-4 rounded-full bg-slate-100/70 p-1.5 text-slate-500 transition-colors hover:bg-slate-200 hover:text-slate-700 dark:bg-slate-700/60 dark:text-slate-200 dark:hover:bg-slate-700"
              >
                <Cross2Icon />
              </button>
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

