import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from './ConfirmDialog';
import { StyledSelect } from './ui/styled-select';
import { showToast as showGlobalToast } from '@/components/ui/toast';

type CoreType = 'mihomo' | 'mihomo-alpha' | 'mihomo-smart' | 'mihomo-specific';

interface CoreConfig {
  coreType: CoreType;
  specificVersion?: string | null;
  customPath?: string | null;
}

interface InstalledCore {
  type: CoreType;
  version?: string | null;
  path: string;
  size: number;
  modifiedAt: Date;
  managed?: boolean;
  source?: 'managed' | 'bundled' | string;
}

type ProgressPhase =
  | 'downloading'
  | 'verifying'
  | 'extracting'
  | 'switching'
  | 'tun-sync'
  | 'restarting'
  | 'starting'
  | 'waiting-api'
  | 'done'
  | 'error';

interface CoreDownloadProgress {
  coreType: CoreType;
  version?: string;
  progress: number;
  downloaded?: number;
  total?: number;
  phase?: ProgressPhase;
  error?: string;
}

interface CoreVersion {
  version: string;
  tagName: string;
  name: string;
  publishedAt: string;
  prerelease: boolean;
  body: string;
}

interface UpdateInfo {
  success: boolean;
  hasUpdate: boolean;
  currentVersion?: string;
  latestVersion?: string;
}

interface CoreResourceStatusItem {
  available?: boolean;
  required?: boolean;
  path?: string | null;
  error?: string | null;
}

interface CoreDataResourceStatus {
  available?: boolean;
  synced?: boolean;
  sourceDir?: string | null;
  targetDir?: string | null;
  syncedFiles?: string[];
  missingFiles?: string[];
}

interface CoreRuntimeState {
  success?: boolean;
  runningMode?: 'service' | 'sidecar' | 'notRunning';
  activeConfig?: string | null;
  pid?: number | null;
  socketPath?: string | null;
  socketArg?: string | null;
  controllerAvailable?: boolean;
  controllerError?: string | null;
  coreVersion?: string | null;
  coreMeta?: boolean | null;
  corePremium?: boolean | null;
  coreRunning?: boolean;
  corePid?: number | null;
  resources?: {
    core?: CoreResourceStatusItem;
    helper?: CoreResourceStatusItem;
    data?: CoreDataResourceStatus;
  };
}

const TAURI_RUNTIME_UNAVAILABLE = 'Tauri runtime is not available';

const getCoreApi = () => {
  if (typeof window === 'undefined') return undefined;
  return window.electronAPI;
};

const hasMethod = <K extends string>(api: unknown, method: K): api is Record<K, (...args: any[]) => any> => {
  try {
    return !!api && typeof (api as Record<string, unknown>)[method] === 'function';
  } catch {
    return false;
  }
};

const errorToMessage = (error: unknown) => {
  if (!error) return undefined;
  return error instanceof Error ? error.message : String(error);
};

const notifyCoreConfigChanged = (detail: Record<string, unknown> = {}) => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('core-config-changed', { detail }));
  window.dispatchEvent(new CustomEvent('profile-updated', { detail: { source: 'core-manager', ...detail } }));
};

// 阶段标签：先尝试 i18n，若 key 未配置则回退到中文兜底文案
function getPhaseLabel(phase: ProgressPhase, t: (k: string) => string): string {
  const map: Record<ProgressPhase, { key: string; fallback: string }> = {
    'downloading':  { key: 'core.phaseDownloading',  fallback: '下载' },
    'verifying':    { key: 'core.phaseVerifying',    fallback: '校验中' },
    'extracting':   { key: 'core.phaseExtracting',   fallback: '解压中' },
    'switching':    { key: 'core.phaseSwitching',    fallback: '切换中' },
    'tun-sync':     { key: 'core.phaseTunSync',      fallback: '同步 TUN 内核' },
    'restarting':   { key: 'core.phaseRestarting',   fallback: '重启内核' },
    'starting':     { key: 'core.phaseStarting',     fallback: '启动内核' },
    'waiting-api':  { key: 'core.phaseWaitingApi',   fallback: '等待内核就绪' },
    'done':         { key: 'core.phaseDone',         fallback: '完成' },
    'error':        { key: 'core.phaseError',        fallback: '出错' }
  };
  const cfg = map[phase] || map.downloading;
  const translated = t(cfg.key);
  return translated && translated !== cfg.key ? translated : cfg.fallback;
}

export default function CoreManager() {
  const { t } = useTranslation();
  const [currentConfig, setCurrentConfig] = useState<CoreConfig | null>(null);
  const [currentVersion, setCurrentVersion] = useState<string>('');
  const [installedCores, setInstalledCores] = useState<InstalledCore[]>([]);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<CoreDownloadProgress | null>(null);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [runtimeState, setRuntimeState] = useState<CoreRuntimeState | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [progressPhase, setProgressPhase] = useState<ProgressPhase>('downloading');
  const [slowWarning, setSlowWarning] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);

  const [selectedCoreType, setSelectedCoreType] = useState<CoreType>('mihomo');
  const [availableVersions, setAvailableVersions] = useState<CoreVersion[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<string>('latest');
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [pendingDeletePath, setPendingDeletePath] = useState<string | null>(null);

  const normalizeVersion = (value?: string | null) => {
    if (!value) return '';
    return value.replace(/^v/i, '').trim();
  };

  const unknownError = () => t('core.unknownError');
  const displayError = (message?: string) => {
    const normalized = message?.trim();
    if (!normalized) return unknownError();
    return normalized.includes(TAURI_RUNTIME_UNAVAILABLE) ? t('core.apiUnavailable') : normalized;
  };
  const resultError = (result: { error?: string } | undefined) => displayError(result?.error);
  const caughtError = (error: unknown) => displayError(errorToMessage(error));
  const withErrorDetail = (label: string, detail: string) => `${label}: ${detail}`;
  const showToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    setToast({ type, message });
    showGlobalToast({ type, message });
  };

  const notifyApiUnavailable = () => {
    showToast(t('core.apiUnavailable'), 'error');
  };

  const loadRuntimeState = async () => {
    try {
      const api = getCoreApi();
      if (!hasMethod(api, 'coreGetRuntimeState')) {
        return;
      }

      const result = await api.coreGetRuntimeState();
      if (result?.success !== false) {
        setRuntimeState(result);
      }
    } catch (error) {
      console.debug('[CoreManager] 加载运行态失败:', error);
    }
  };

  const loadCurrentConfig = async () => {
    try {
      const api = getCoreApi();
      if (!hasMethod(api, 'coreGetCurrentConfig')) {
        notifyApiUnavailable();
        return;
      }

      const result = await api.coreGetCurrentConfig();
      if (result.success) {
        setCurrentConfig(result.config || null);
        setCurrentVersion(result.version || t('core.unknown'));
        if (result.config) {
          // mihomo-specific 在 UI 上合并到 mihomo（稳定版）
          if (result.config.coreType === 'mihomo-specific') {
            setSelectedCoreType('mihomo');
            if (result.config.specificVersion) {
              setSelectedVersion(normalizeVersion(result.config.specificVersion));
            }
          } else {
            setSelectedCoreType(result.config.coreType);
          }
        }
      } else {
        showToast(withErrorDetail(t('core.loadCurrentConfigFailed'), resultError(result)), 'error');
      }
    } catch (error) {
      console.error('[CoreManager] 加载内核配置失败:', error);
      showToast(withErrorDetail(t('core.loadCurrentConfigFailed'), caughtError(error)), 'error');
    }
  };

  const loadInstalledCores = async () => {
    try {
      const api = getCoreApi();
      if (!hasMethod(api, 'coreGetInstalledCores')) {
        notifyApiUnavailable();
        return;
      }

      const result = await api.coreGetInstalledCores();
      if (result.success && result.cores) {
        setInstalledCores(result.cores);
      } else if (!result.success) {
        setInstalledCores([]);
        showToast(withErrorDetail(t('core.loadInstalledCoresFailed'), resultError(result)), 'error');
      }
    } catch (error) {
      console.error('[CoreManager] 加载内核列表失败:', error);
      setInstalledCores([]);
      showToast(withErrorDetail(t('core.loadInstalledCoresFailed'), caughtError(error)), 'error');
    }
  };

  const loadAvailableVersions = async (coreType: CoreType, forceRefresh = false) => {
    setLoadingVersions(true);
    try {
      const api = getCoreApi();
      if (!hasMethod(api, 'coreGetAvailableVersions')) {
        setAvailableVersions([]);
        notifyApiUnavailable();
        return;
      }

      if (forceRefresh && hasMethod(api, 'coreClearVersionCache')) {
        const clearResult = await api.coreClearVersionCache(coreType);
        if (clearResult?.success === false) {
          showToast(withErrorDetail(t('core.loadVersionsFailed'), resultError(clearResult)), 'error');
        }
      }

      const result = await api.coreGetAvailableVersions(coreType, 100, forceRefresh);
      if (result.success && result.versions) {
        setAvailableVersions(result.versions);
      } else {
        setAvailableVersions([]);
        showToast(withErrorDetail(t('core.loadVersionsFailed'), resultError(result)), 'error');
      }
    } catch (error) {
      console.error('[CoreManager] 加载版本列表失败:', error);
      setAvailableVersions([]);
      showToast(withErrorDetail(t('core.loadVersionsFailed'), caughtError(error)), 'error');
    } finally {
      setLoadingVersions(false);
    }
  };

  const handleCheckUpdate = async () => {
    if (!currentConfig) {
      showToast(t('core.noCurrentCore'), 'info');
      return;
    }

    setChecking(true);
    setUpdateInfo(null);
    try {
      const api = getCoreApi();
      if (!hasMethod(api, 'coreCheckUpdate')) {
        notifyApiUnavailable();
        return;
      }

      const result = await api.coreCheckUpdate(currentConfig.coreType);
      if (result.success) {
        setUpdateInfo({
          success: true,
          hasUpdate: Boolean(result.hasUpdate),
          currentVersion: result.currentVersion,
          latestVersion: result.latestVersion,
        });
        if (!result.hasUpdate) {
          showToast(t('core.upToDate'), 'success');
        }
      } else {
        showToast(withErrorDetail(t('core.checkUpdateFailed'), resultError(result)), 'error');
      }
    } catch (error) {
      console.error('[CoreManager] 检查更新失败:', error);
      showToast(withErrorDetail(t('core.checkUpdateFailed'), caughtError(error)), 'error');
    } finally {
      setChecking(false);
    }
  };

  const handleDownloadCore = async () => {
    setDownloading(true);
    setDownloadProgress(null);
    setExtracting(false);
    setProgressPhase('downloading');
    setSlowWarning(false);
    try {
      const api = getCoreApi();
      if (!hasMethod(api, 'coreDownloadCore') || !hasMethod(api, 'coreDownloadSpecificVersion')) {
        notifyApiUnavailable();
        return;
      }

      // 稳定版选了具体版本时，内部使用 mihomo-specific
      const isSpecific = selectedCoreType === 'mihomo' && selectedVersion !== 'latest';
      const effectiveType = isSpecific ? 'mihomo-specific' as CoreType : selectedCoreType;

      const result = selectedVersion === 'latest'
        ? await api.coreDownloadCore(effectiveType)
        : await api.coreDownloadSpecificVersion(effectiveType, selectedVersion);

      if (result.success) {
        const downloadedVersion = normalizeVersion(result.version || selectedVersion);
        if (isSpecific && downloadedVersion) {
          setSelectedVersion(downloadedVersion);
        }

        showToast(t('core.downloadSuccess'), 'success');
        await loadInstalledCores();
        await loadCurrentConfig();
        notifyCoreConfigChanged({ action: 'download', coreType: effectiveType, version: downloadedVersion || undefined });
      } else {
        showToast(withErrorDetail(t('core.downloadFailed'), resultError(result)), 'error');
      }
    } catch (error) {
      console.error('[CoreManager] 下载内核失败:', error);
      showToast(withErrorDetail(t('core.downloadFailed'), caughtError(error)), 'error');
    } finally {
      setDownloading(false);
      setDownloadProgress(null);
      setExtracting(false);
      setProgressPhase('downloading');
      setSlowWarning(false);
    }
  };

  const handleSwitchCore = async (coreType: CoreType, specificVersion?: string) => {
    const normalizedSpecificVersion = normalizeVersion(specificVersion);
    // 稳定版指定了版本时，内部使用 mihomo-specific
    const effectiveType = (coreType === 'mihomo' && normalizedSpecificVersion) ? 'mihomo-specific' as CoreType : coreType;

    if (effectiveType === 'mihomo-specific' && !normalizedSpecificVersion) {
      showToast(t('core.selectSpecificVersionFirst'), 'info');
      return;
    }

    setLoading(true);
    setDownloadProgress({ coreType: effectiveType, version: normalizedSpecificVersion || undefined, progress: 100, downloaded: 0, total: 0, phase: 'switching' });
    setExtracting(true);
    setProgressPhase('switching');
    setSlowWarning(false);
    try {
      const api = getCoreApi();
      if (!hasMethod(api, 'coreSwitchCore')) {
        notifyApiUnavailable();
        return;
      }

      const result = await api.coreSwitchCore(effectiveType, normalizedSpecificVersion || undefined);
      if (result.success) {
        showToast(t('core.switchSuccess'), 'success');
        await loadCurrentConfig();
        notifyCoreConfigChanged({ action: 'switch', coreType: effectiveType, version: normalizedSpecificVersion || undefined });
      } else {
        showToast(withErrorDetail(t('core.switchFailed'), resultError(result)), 'error');
      }
    } catch (error) {
      console.error('[CoreManager] 切换内核失败:', error);
      showToast(withErrorDetail(t('core.switchFailed'), caughtError(error)), 'error');
    } finally {
      setLoading(false);
      setDownloadProgress(null);
      setExtracting(false);
      setProgressPhase('downloading');
      setSlowWarning(false);
    }
  };

  const handleDeleteCore = async (corePath: string) => {
    setPendingDeletePath(corePath);
    setDeleteConfirmOpen(true);
  };

  const confirmDeleteCore = async () => {
    setDeleteConfirmOpen(false);
    if (!pendingDeletePath) return;

    try {
      const api = getCoreApi();
      if (!hasMethod(api, 'coreDeleteCore')) {
        notifyApiUnavailable();
        return;
      }

      const result = await api.coreDeleteCore(pendingDeletePath);
      if (result.success) {
        showToast(t('core.deleteSuccess'), 'success');
        await loadInstalledCores();
        notifyCoreConfigChanged({ action: 'delete', path: pendingDeletePath });
      } else {
        showToast(withErrorDetail(t('core.deleteFailed'), resultError(result)), 'error');
      }
    } catch (error) {
      console.error('[CoreManager] 删除内核失败:', error);
      showToast(withErrorDetail(t('core.deleteFailed'), caughtError(error)), 'error');
    } finally {
      setPendingDeletePath(null);
    }
  };

  const handleRefreshVersions = async () => {
    await loadAvailableVersions(selectedCoreType, true);
  };

  useEffect(() => {
    if (selectedCoreType === 'mihomo') {
      loadAvailableVersions(selectedCoreType);
    }
  }, [selectedCoreType]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const refreshAfterCoreChange = () => {
      void loadInstalledCores();
      void loadCurrentConfig();
      void loadRuntimeState();
    };

    window.addEventListener('core-config-changed', refreshAfterCoreChange);

    return () => {
      window.removeEventListener('core-config-changed', refreshAfterCoreChange);
    };
  }, []);

  useEffect(() => {
    const api = getCoreApi();
    if (!hasMethod(api, 'onCoreDownloadProgress')) return;

    const unsubscribe = api.onCoreDownloadProgress((data: CoreDownloadProgress) => {
      setDownloadProgress(data);
      const phase: ProgressPhase = (data.phase as ProgressPhase) || (data.progress >= 100 ? 'extracting' : 'downloading');
      setProgressPhase(phase);
      // 非下载阶段统一视为 "处理中"，沿用 extracting 这个旧字段做兼容
      setExtracting(phase !== 'downloading');
    });

    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, []);

  // 30s watchdog：进入非下载阶段后，若超时未结束，提示耗时较久
  useEffect(() => {
    if (!extracting) {
      setSlowWarning(false);
      return;
    }
    const timer = setTimeout(() => setSlowWarning(true), 30_000);
    return () => clearTimeout(timer);
  }, [extracting, progressPhase]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => {
      setToast(null);
    }, 5000);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    loadCurrentConfig();
    loadInstalledCores();
    loadRuntimeState();
    const timer = window.setInterval(loadRuntimeState, 5000);
    return () => window.clearInterval(timer);
  }, []);

  const getCoreTypeName = (type: CoreType) => {
    switch (type) {
      case 'mihomo':
        return t('core.stable');
      case 'mihomo-alpha':
        return t('core.alpha');
      case 'mihomo-smart':
        return t('core.smart');
      case 'mihomo-specific':
        return t('core.specific');
      default:
        return type;
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString();
  };

  const getRunningModeName = (mode?: CoreRuntimeState['runningMode']) => {
    switch (mode) {
      case 'service':
        return t('core.modeService');
      case 'sidecar':
        return t('core.modeSidecar');
      case 'notRunning':
        return t('core.modeNotRunning');
      default:
        return t('core.unknown');
    }
  };

  const runtimeMode = runtimeState?.runningMode || 'notRunning';
  const runtimeReady = runtimeMode !== 'notRunning' && runtimeState?.controllerAvailable === true;
  const runtimeStatusLabel = runtimeReady
    ? t('core.controllerReady')
    : runtimeMode === 'notRunning'
      ? t('core.modeNotRunning')
      : t('core.controllerUnavailable');
  const runtimePid = runtimeState?.pid ?? runtimeState?.corePid ?? null;
  const resources = runtimeState?.resources;
  const resourceReady = Boolean(
    resources?.core?.available &&
    (resources?.helper?.available || resources?.helper?.required === false) &&
    resources?.data?.available
  );
  const dataMissingFiles = resources?.data?.missingFiles || [];

  const resourceBadgeClass = (available?: boolean, warning = false) => {
    if (available && !warning) {
      return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300';
    }
    if (available && warning) {
      return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300';
    }
    return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300';
  };

  const resourceBadgeLabel = (available?: boolean, warning = false) => {
    if (available && !warning) return t('core.resourceReady');
    if (available && warning) return t('core.resourcePendingSync');
    return t('core.resourceMissing');
  };

  const currentSpecificVersion = useMemo(() => {
    if (!currentConfig) return '';
    if (currentConfig.coreType !== 'mihomo-specific' && currentConfig.coreType !== 'mihomo') return '';
    return normalizeVersion(currentConfig.specificVersion || currentVersion);
  }, [currentConfig, currentVersion]);

  const selectedSpecificVersion = selectedVersion === 'latest' ? '' : normalizeVersion(selectedVersion);
  const isStableWithVersion = selectedCoreType === 'mihomo' && selectedSpecificVersion;
  const hasSelectedTypeInstalled = installedCores.some((core) =>
    isStableWithVersion ? core.type === 'mihomo-specific' : core.type === selectedCoreType
  );
  const hasSelectedSpecificInstalled = !isStableWithVersion || installedCores.some(
    (core) => core.type === 'mihomo-specific' && normalizeVersion(core.version) === selectedSpecificVersion
  );

  const isCurrentSelection = (() => {
    if (!currentConfig) return false;
    if (isStableWithVersion) {
      // 稳定版选了具体版本，对比 mihomo-specific
      if (currentConfig.coreType !== 'mihomo-specific') return false;
      return selectedSpecificVersion === currentSpecificVersion;
    }
    if (selectedCoreType === 'mihomo' && selectedVersion === 'latest') {
      return currentConfig.coreType === 'mihomo';
    }
    if (currentConfig.coreType !== selectedCoreType) return false;
    return true;
  })();

  const canSwitchSelected = hasSelectedTypeInstalled && hasSelectedSpecificInstalled && !isCurrentSelection;

  const isCoreActive = (core: InstalledCore) => {
    if (!currentConfig || currentConfig.coreType !== core.type) {
      return false;
    }

    if (core.type !== 'mihomo-specific') {
      return true;
    }

    const coreVersion = normalizeVersion(core.version);
    if (!coreVersion) return false;
    return coreVersion === currentSpecificVersion;
  };

  const isCoreManaged = (core: InstalledCore) => {
    if (typeof core.managed === 'boolean') return core.managed;
    if (core.source) return core.source !== 'bundled';
    return true;
  };

  const canDeleteCore = (core: InstalledCore) => isCoreManaged(core) && !isCoreActive(core);

  const coreDeleteTitle = (core: InstalledCore) => {
    if (!isCoreManaged(core)) return t('core.bundledCoreCannotDelete');
    if (isCoreActive(core)) return t('core.activeCoreCannotDelete');
    return t('core.delete');
  };

  const renderResourceRow = (
    label: string,
    available?: boolean,
    path?: string | null,
    options: { warning?: boolean; error?: string | null; detail?: string | null } = {},
  ) => (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-gray-600 dark:text-gray-400">{label}</span>
        <span className={`text-xs px-2 py-1 rounded ${resourceBadgeClass(available, options.warning)}`}>
          {resourceBadgeLabel(available, options.warning)}
        </span>
      </div>
      {(path || options.detail || options.error) && (
        <div className="text-xs text-gray-500 dark:text-gray-400 break-all">
          {path || options.detail || options.error}
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-6">
      {toast && (
        <div className={`rounded-lg p-4 border ${
          toast.type === 'success'
            ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800'
            : toast.type === 'error'
            ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800'
            : 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800'
        }`}>
          <div className="flex justify-between items-start">
            <span className={`text-sm ${
              toast.type === 'success'
                ? 'text-green-900 dark:text-green-100'
                : toast.type === 'error'
                ? 'text-red-900 dark:text-red-100'
                : 'text-blue-900 dark:text-blue-100'
            }`}>
              {toast.message}
            </span>
            <button
              onClick={() => setToast(null)}
              className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      <div className="bg-white dark:bg-[#1e1e1e] rounded-lg p-4 border border-gray-200 dark:border-gray-700">
        <div className="flex justify-between items-start mb-3">
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200">
            {t('core.currentCore')}
          </h3>
          <button
            className="py-1 px-3 text-xs rounded bg-blue-500 hover:bg-blue-600 text-white transition-colors disabled:opacity-50"
            onClick={handleCheckUpdate}
            disabled={checking || !currentConfig}
          >
            {checking ? t('core.checking') : t('core.checkUpdate')}
          </button>
        </div>
        <div className="space-y-2">
          <div className="flex justify-between items-center">
            <span className="text-sm text-gray-600 dark:text-gray-400">{t('core.type')}:</span>
            <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {currentConfig ? getCoreTypeName(currentConfig.coreType) : '-'}
            </span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-sm text-gray-600 dark:text-gray-400">{t('core.version')}:</span>
            <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {currentVersion || '-'}
            </span>
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-[#1e1e1e] rounded-lg p-4 border border-gray-200 dark:border-gray-700">
        <div className="flex items-start justify-between gap-3 mb-3">
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200">
            {t('core.runtimeStatus')}
          </h3>
          <span className={`text-xs px-2 py-1 rounded ${
            runtimeReady
              ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
              : runtimeMode === 'notRunning'
              ? 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300'
              : 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300'
          }`}>
            {runtimeStatusLabel}
          </span>
        </div>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between gap-4">
            <span className="text-gray-600 dark:text-gray-400">{t('core.runningMode')}:</span>
            <span className="text-gray-900 dark:text-gray-100">{getRunningModeName(runtimeMode)}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-gray-600 dark:text-gray-400">{t('core.processId')}:</span>
            <span className="text-gray-900 dark:text-gray-100">{runtimePid || '-'}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-gray-600 dark:text-gray-400">{t('core.runtimeVersion')}:</span>
            <span className="text-gray-900 dark:text-gray-100">{runtimeState?.coreVersion || '-'}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-gray-600 dark:text-gray-400">{t('core.activeConfig')}:</span>
            <span className="max-w-[65%] break-all text-right text-gray-900 dark:text-gray-100">
              {runtimeState?.activeConfig || '-'}
            </span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-gray-600 dark:text-gray-400">{t('core.controllerSocket')}:</span>
            <span className="max-w-[65%] break-all text-right text-gray-900 dark:text-gray-100">
              {runtimeState?.socketPath || '-'}
            </span>
          </div>
          {runtimeState?.controllerError && runtimeMode !== 'notRunning' && (
            <div className="text-xs text-yellow-700 dark:text-yellow-300 break-words">
              {runtimeState.controllerError}
            </div>
          )}
        </div>
      </div>

      {resources && (
        <div className="bg-white dark:bg-[#1e1e1e] rounded-lg p-4 border border-gray-200 dark:border-gray-700">
          <div className="flex items-start justify-between gap-3 mb-3">
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200">
              {t('core.resourceStatus')}
            </h3>
            <span className={`text-xs px-2 py-1 rounded ${resourceBadgeClass(resourceReady)}`}>
              {resourceReady ? t('core.resourceReady') : t('core.resourceMissing')}
            </span>
          </div>
          <div className="space-y-3">
            {renderResourceRow(
              t('core.resourceCore'),
              resources.core?.available,
              resources.core?.path,
              { error: resources.core?.error }
            )}
            {resources.helper?.required !== false && renderResourceRow(
              t('core.resourceHelper'),
              resources.helper?.available,
              resources.helper?.path,
              { error: resources.helper?.error }
            )}
            {renderResourceRow(
              t('core.resourceGeodata'),
              resources.data?.available,
              resources.data?.targetDir || resources.data?.sourceDir,
              {
                warning: Boolean(resources.data?.available && !resources.data?.synced),
                detail: dataMissingFiles.length
                  ? t('core.resourceMissingFiles', { files: dataMissingFiles.join(', ') })
                  : undefined,
              }
            )}
          </div>
        </div>
      )}

      {updateInfo && updateInfo.hasUpdate && (
        <div className="bg-yellow-50 dark:bg-yellow-900/20 rounded-lg p-4 border border-yellow-200 dark:border-yellow-800">
          <h4 className="text-sm font-medium mb-2 text-yellow-900 dark:text-yellow-100">
            {t('core.updateAvailable')}
          </h4>
          <div className="space-y-2">
            <div className="text-sm text-yellow-800 dark:text-yellow-200">
              {t('core.currentVersion')}: {updateInfo.currentVersion}
            </div>
            <div className="text-sm text-yellow-800 dark:text-yellow-200">
              {t('core.latestVersion')}: {updateInfo.latestVersion}
            </div>
          </div>
        </div>
      )}

      <div>
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-3">
          {t('core.selectCoreType')}
        </h3>
        <StyledSelect
          value={selectedCoreType}
          onChange={(v) => {
            setSelectedCoreType(v as CoreType);
            setSelectedVersion('latest');
          }}
          options={[
            { value: 'mihomo', label: t('core.stable') },
            { value: 'mihomo-alpha', label: t('core.alpha') },
            { value: 'mihomo-smart', label: t('core.smart') },
          ]}
        />
      </div>

      {selectedCoreType === 'mihomo' && (
        <div>
          <div className="flex justify-between items-center mb-3">
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200">
              {t('core.selectVersion')}
            </h3>
            <button
              className="py-1 px-2 text-xs rounded bg-gray-100 hover:bg-gray-200 dark:bg-[#2a2a2a] dark:hover:bg-[#333333] text-gray-700 dark:text-gray-200 transition-colors"
              onClick={handleRefreshVersions}
              disabled={loadingVersions}
              title={t('core.refreshVersions')}
            >
              {loadingVersions ? t('core.loadingVersions') : '↻'}
            </button>
          </div>
          <StyledSelect
            value={selectedVersion}
            onChange={(v) => setSelectedVersion(v)}
            disabled={loadingVersions}
            options={[
              { value: 'latest', label: t('core.latestVersion') },
              ...availableVersions.map((v) => ({
                value: v.version,
                label: `v${v.version} (${formatDate(v.publishedAt)})${v.prerelease ? ' [Pre-release]' : ''}`,
              })),
            ]}
          />
          {!loadingVersions && availableVersions.length === 0 && (
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
              {t('core.noVersionsFound')}
            </p>
          )}
        </div>
      )}

      {downloadProgress && (
        <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4 border border-blue-200 dark:border-blue-800">
          <div className="flex justify-between items-center mb-2">
            <span className="text-sm font-medium text-blue-900 dark:text-blue-100">
              {getPhaseLabel(progressPhase, t)} {getCoreTypeName(downloadProgress.coreType)}
              {downloadProgress.version && ` v${downloadProgress.version}`}
            </span>
            <span className="text-sm text-blue-700 dark:text-blue-300">
              {progressPhase === 'downloading'
                ? `${(downloadProgress.progress ?? 0).toFixed(1)}%`
                : t('core.pleaseWait')}
            </span>
          </div>
          <div className="w-full bg-blue-200 dark:bg-blue-800 rounded-full h-2 overflow-hidden">
            {progressPhase === 'downloading' ? (
              <div
                className="bg-blue-500 h-2 rounded-full transition-all"
                style={{ width: `${downloadProgress.progress ?? 0}%` }}
              />
            ) : (
              <div className="h-2 rounded-full bg-blue-500/40 relative overflow-hidden">
                <div className="absolute inset-y-0 left-0 w-1/3 bg-blue-500 animate-shimmer" />
              </div>
            )}
          </div>
          {progressPhase === 'downloading' && (
            <div className="mt-2 text-xs text-blue-700 dark:text-blue-300">
              {formatBytes(downloadProgress.downloaded || 0)} / {formatBytes(downloadProgress.total || 0)}
            </div>
          )}
          {slowWarning && progressPhase !== 'downloading' && (
            <div className="mt-2 text-xs text-orange-700 dark:text-orange-300">
              {t('core.slowSwitchHint') || '当前操作耗时较久，可继续等待或在日志中查看进展。如长时间无响应，请重启应用后重试。'}
            </div>
          )}
        </div>
      )}

      <div className="flex gap-3">
        <button
          className="flex-1 py-2 px-4 rounded-lg bg-blue-500 hover:bg-blue-600 text-white transition-colors disabled:opacity-50"
          onClick={handleDownloadCore}
          disabled={downloading}
        >
          {downloading ? t('core.downloading') : t('core.downloadAndInstall')}
        </button>

        {canSwitchSelected && (
          <button
            className="flex-1 py-2 px-4 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white transition-colors disabled:opacity-50"
            onClick={() => handleSwitchCore(selectedCoreType, isStableWithVersion ? selectedSpecificVersion : undefined)}
            disabled={loading}
          >
            {loading ? t('core.switching') : t('core.switchToThisCore')}
          </button>
        )}

        {isCurrentSelection && (
          <div className="flex-1 py-2 px-4 rounded-lg bg-green-100 dark:bg-green-900/20 border border-green-500 text-green-700 dark:text-green-300 text-center">
            {t('core.currentlyUsing')}
          </div>
        )}
      </div>

      {installedCores.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-3">
            {t('core.installedCores')}
          </h3>
          <div className="space-y-2">
            {installedCores.map((core) => (
              <div
                key={core.path}
                className="flex items-center justify-between p-3 bg-white dark:bg-[#1e1e1e] rounded-lg border border-gray-200 dark:border-gray-700"
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                      {getCoreTypeName(core.type)}
                    </span>
                    {isCoreActive(core) && (
                      <span className="text-xs bg-blue-500 text-white px-2 py-0.5 rounded">
                        {t('core.active')}
                      </span>
                    )}
                    <span className={`text-xs px-2 py-0.5 rounded ${
                      isCoreManaged(core)
                        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
                        : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300'
                    }`}>
                      {isCoreManaged(core) ? t('core.managedCore') : t('core.bundledCore')}
                    </span>
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    {t('core.version')}: {core.version || t('core.unknown')} • {formatBytes(core.size)}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    className="py-1 px-3 text-xs rounded bg-blue-500 hover:bg-blue-600 text-white transition-colors disabled:opacity-50"
                    onClick={() => handleSwitchCore(core.type, core.type === 'mihomo-specific' ? normalizeVersion(core.version) : undefined)}
                    disabled={loading || isCoreActive(core)}
                  >
                    {t('core.switch')}
                  </button>
                  <button
                    className="py-1 px-3 text-xs rounded bg-red-500 hover:bg-red-600 text-white transition-colors disabled:opacity-50"
                    onClick={() => handleDeleteCore(core.path)}
                    disabled={!canDeleteCore(core)}
                    title={coreDeleteTitle(core)}
                  >
                    {t('core.delete')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={deleteConfirmOpen}
        title={t('core.confirmDeleteTitle', 'Delete Kernel')}
        description={t('core.confirmDelete')}
        confirmText={t('core.delete')}
        cancelText={t('core.cancel', 'Cancel')}
        onConfirm={confirmDeleteCore}
        onCancel={() => { setDeleteConfirmOpen(false); setPendingDeletePath(null); }}
      />
    </div>
  );
}
