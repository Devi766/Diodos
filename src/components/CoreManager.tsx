import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from './ConfirmDialog';

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
}

interface CoreDownloadProgress {
  coreType: CoreType;
  version?: string;
  progress: number;
  downloaded: number;
  total: number;
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
  const [extracting, setExtracting] = useState(false);
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

  const loadCurrentConfig = async () => {
    try {
      if (!window.electronAPI?.coreGetCurrentConfig) return;

      const result = await window.electronAPI.coreGetCurrentConfig();
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
      }
    } catch (error) {
      console.error('[CoreManager] 加载内核配置失败:', error);
    }
  };

  const loadInstalledCores = async () => {
    try {
      if (!window.electronAPI?.coreGetInstalledCores) return;

      const result = await window.electronAPI.coreGetInstalledCores();
      if (result.success && result.cores) {
        setInstalledCores(result.cores);
      }
    } catch (error) {
      console.error('[CoreManager] 加载内核列表失败:', error);
    }
  };

  const loadAvailableVersions = async (coreType: CoreType, forceRefresh = false) => {
    setLoadingVersions(true);
    try {
      if (!window.electronAPI?.coreGetAvailableVersions) return;

      if (forceRefresh && window.electronAPI?.coreClearVersionCache) {
        await window.electronAPI.coreClearVersionCache(coreType);
      }

      const result = await window.electronAPI.coreGetAvailableVersions(coreType, 100, forceRefresh);
      if (result.success && result.versions) {
        setAvailableVersions(result.versions);
      } else {
        setAvailableVersions([]);
      }
    } catch (error) {
      console.error('[CoreManager] 加载版本列表失败:', error);
      setToast({ type: 'error', message: t('core.loadVersionsFailed') });
    } finally {
      setLoadingVersions(false);
    }
  };

  const handleCheckUpdate = async () => {
    if (!currentConfig) return;

    setChecking(true);
    setUpdateInfo(null);
    try {
      if (!window.electronAPI?.coreCheckUpdate) return;

      const result = await window.electronAPI.coreCheckUpdate(currentConfig.coreType);
      if (result.success) {
        setUpdateInfo(result);
        if (!result.hasUpdate) {
          setToast({ type: 'success', message: t('core.upToDate') });
        }
      }
    } catch (error) {
      console.error('[CoreManager] 检查更新失败:', error);
      setToast({ type: 'error', message: t('core.checkUpdateFailed') });
    } finally {
      setChecking(false);
    }
  };

  const handleDownloadCore = async () => {
    setDownloading(true);
    setDownloadProgress(null);
    setExtracting(false);
    try {
      if (!window.electronAPI?.coreDownloadCore || !window.electronAPI?.coreDownloadSpecificVersion) return;

      // 稳定版选了具体版本时，内部使用 mihomo-specific
      const isSpecific = selectedCoreType === 'mihomo' && selectedVersion !== 'latest';
      const effectiveType = isSpecific ? 'mihomo-specific' as CoreType : selectedCoreType;

      const result = selectedVersion === 'latest'
        ? await window.electronAPI.coreDownloadCore(effectiveType)
        : await window.electronAPI.coreDownloadSpecificVersion(effectiveType, selectedVersion);

      if (result.success) {
        const downloadedVersion = normalizeVersion(result.version || selectedVersion);
        if (isSpecific && downloadedVersion) {
          setSelectedVersion(downloadedVersion);
        }

        setToast({ type: 'success', message: t('core.downloadSuccess') });
        await loadInstalledCores();
        await loadCurrentConfig();
      } else {
        setToast({ type: 'error', message: result.error || t('core.downloadFailed') });
      }
    } catch (error) {
      console.error('[CoreManager] 下载内核失败:', error);
      setToast({ type: 'error', message: String(error) });
    } finally {
      setDownloading(false);
      setDownloadProgress(null);
      setExtracting(false);
    }
  };

  const handleSwitchCore = async (coreType: CoreType, specificVersion?: string) => {
    const normalizedSpecificVersion = normalizeVersion(specificVersion);
    // 稳定版指定了版本时，内部使用 mihomo-specific
    const effectiveType = (coreType === 'mihomo' && normalizedSpecificVersion) ? 'mihomo-specific' as CoreType : coreType;

    if (effectiveType === 'mihomo-specific' && !normalizedSpecificVersion) {
      setToast({ type: 'info', message: t('core.selectSpecificVersionFirst') });
      return;
    }

    setLoading(true);
    try {
      if (!window.electronAPI?.coreSwitchCore) return;

      const result = await window.electronAPI.coreSwitchCore(effectiveType, normalizedSpecificVersion || undefined);
      if (result.success) {
        setToast({ type: 'success', message: t('core.switchSuccess') });
        await loadCurrentConfig();
      } else {
        setToast({ type: 'error', message: result.error || t('core.switchFailed') });
      }
    } catch (error) {
      console.error('[CoreManager] 切换内核失败:', error);
      setToast({ type: 'error', message: String(error) });
    } finally {
      setLoading(false);
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
      if (!window.electronAPI?.coreDeleteCore) return;

      const result = await window.electronAPI.coreDeleteCore(pendingDeletePath);
      if (result.success) {
        setToast({ type: 'success', message: t('core.deleteSuccess') });
        await loadInstalledCores();
      } else {
        setToast({ type: 'error', message: result.error || t('toast.operationFailed') });
      }
    } catch (error) {
      console.error('[CoreManager] 删除内核失败:', error);
      setToast({ type: 'error', message: String(error) });
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
    if (!window.electronAPI?.onCoreDownloadProgress) return;

    const unsubscribe = window.electronAPI.onCoreDownloadProgress((data) => {
      setDownloadProgress(data);
      if (data.progress >= 99.9) {
        setExtracting(true);
      }
    });

    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, []);

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
        <select
          className="w-full py-2 px-3 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200"
          value={selectedCoreType}
          onChange={(e) => {
            setSelectedCoreType(e.target.value as CoreType);
            setSelectedVersion('latest');
          }}
        >
          <option value="mihomo">{t('core.stable')}</option>
          <option value="mihomo-alpha">{t('core.alpha')}</option>
          <option value="mihomo-smart">{t('core.smart')}</option>
        </select>
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
          <select
            className="w-full py-2 px-3 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200"
            value={selectedVersion}
            onChange={(e) => setSelectedVersion(e.target.value)}
            disabled={loadingVersions}
          >
            <option value="latest">{t('core.latestVersion')}</option>
            {availableVersions.map((v) => (
              <option key={v.version} value={v.version}>
                v{v.version} ({formatDate(v.publishedAt)}){v.prerelease ? ' [Pre-release]' : ''}
              </option>
            ))}
          </select>
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
              {extracting ? t('core.extracting') : t('core.downloading')} {getCoreTypeName(downloadProgress.coreType)}
              {downloadProgress.version && ` v${downloadProgress.version}`}
            </span>
            <span className="text-sm text-blue-700 dark:text-blue-300">
              {extracting ? t('core.pleaseWait') : `${downloadProgress.progress.toFixed(1)}%`}
            </span>
          </div>
          <div className="w-full bg-blue-200 dark:bg-blue-800 rounded-full h-2">
            <div
              className={`bg-blue-500 h-2 rounded-full transition-all ${extracting ? 'animate-pulse' : ''}`}
              style={{ width: extracting ? '100%' : `${downloadProgress.progress}%` }}
            />
          </div>
          {!extracting && (
            <div className="mt-2 text-xs text-blue-700 dark:text-blue-300">
              {formatBytes(downloadProgress.downloaded)} / {formatBytes(downloadProgress.total)}
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
                    disabled={isCoreActive(core)}
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
