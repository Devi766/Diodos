import React, { useState, useEffect } from 'react';
import { Button } from './ui/button';
import { Switch } from './ui/switch';
import {
  CloudUpload,
  CloudDownload,
  HardDriveDownload,
  HardDriveUpload,
  Settings,
  Check,
  X,
  Loader2,
  RefreshCw,
  Trash2,
  Download
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { showToast as showGlobalToast } from '@/components/ui/toast';
import { ConfirmDialog } from './ConfirmDialog';

interface WebDAVConfig {
  uri: string;
  username: string;
  password: string;
  backupDirectory: string;
  fileName: string;
}

interface BackupFile {
  name: string;
  size: number;
  lastModified: string;
  path?: string;
}

type RestoreResultLike = {
  stats?: unknown;
  activeConfig?: string | null;
  runtimeReload?: {
    reloaded?: boolean;
    skipped?: boolean;
    reason?: string;
    error?: string;
  };
};

const getBackupApi = () => {
  if (typeof window === 'undefined') return undefined;
  return window.electronAPI;
};

const hasMethod = (api: unknown, method: string): api is Record<string, (...args: any[]) => any> =>
  !!api
  && method in Object(api)
  && typeof (api as Record<string, unknown>)[method] === 'function';

const errorToMessage = (error: unknown) => {
  return error instanceof Error ? error.message : String(error || 'Unknown error');
};

const TAURI_RUNTIME_UNAVAILABLE = 'Tauri runtime is not available';

export default function BackupSettings() {
  const { t } = useTranslation();
  const showToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    showGlobalToast({ message, type });
  };
  const [isLoading, setIsLoading] = useState(false);
  const [showWebDAVSettings, setShowWebDAVSettings] = useState(false);
  const [webdavConfig, setWebdavConfig] = useState<WebDAVConfig>({
    uri: '',
    username: '',
    password: '',
    backupDirectory: 'FlyClash',
    fileName: 'flyclash_backup.zip'
  });
  const [testConnectionStatus, setTestConnectionStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [backupProgress, setBackupProgress] = useState<number>(0);
  const [isBackupTypeFullBackup, setIsBackupTypeFullBackup] = useState(false);
  const [backupList, setBackupList] = useState<BackupFile[]>([]);
  const [showBackupList, setShowBackupList] = useState(false);
  const [isLoadingBackupList, setIsLoadingBackupList] = useState(false);
  const [backupListError, setBackupListError] = useState<string | null>(null);

  // 确认对话框状态
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean;
    title: string;
    description: string;
    onConfirm: () => void;
  }>({
    open: false,
    title: '',
    description: '',
    onConfirm: () => {}
  });

  const isUserCanceled = (result: any) => result?.canceled || result?.error === '用户取消';
  const unknownError = () => t('backup.unknownError');
  const displayError = (message?: string) =>
    message === TAURI_RUNTIME_UNAVAILABLE ? t('backup.apiUnavailable') : (message || unknownError());
  const resultError = (result: { error?: string } | undefined) => displayError(result?.error);
  const caughtError = (error: unknown) => displayError(errorToMessage(error));

  const notifyApiUnavailable = () => {
    showToast(t('backup.apiUnavailable'), 'error');
  };

  const notifyBackupRestored = (result?: RestoreResultLike) => {
    if (typeof window === 'undefined') return;
    const detail = {
      source: 'backup-restore',
      activeConfig: result?.activeConfig ?? null,
      runtimeReload: result?.runtimeReload,
    };
    window.dispatchEvent(new CustomEvent('profile-updated', { detail }));
    window.dispatchEvent(new CustomEvent('backup-restored', { detail: result || {} }));
  };

  const restoreSuccessMessage = (result: RestoreResultLike) => {
    if (result.runtimeReload?.reloaded) {
      return t('backup.restoreSuccessReloaded');
    }

    if (result.activeConfig && result.runtimeReload?.skipped) {
      return t('backup.restoreSuccessPending');
    }

    return t('backup.restoreSuccess');
  };

  // 加载WebDAV配置
  useEffect(() => {
    const loadWebDAVConfig = async () => {
      try {
        const api = getBackupApi();
        if (!hasMethod(api, 'backupWebDAVGetConfig')) {
          notifyApiUnavailable();
          return;
        }

        const result = await api.backupWebDAVGetConfig();
        if (result.success && result.config) {
          setWebdavConfig(result.config);
        } else if (!result.success) {
          showToast(t('backup.loadConfigFailed') + ': ' + resultError(result), 'error');
        }
      } catch (error) {
        showToast(t('backup.loadConfigFailed') + ': ' + caughtError(error), 'error');
      }
    };

    loadWebDAVConfig();
  }, []);

  // 测试WebDAV连接
  const handleTestConnection = async () => {
    setTestConnectionStatus('testing');

    try {
      const api = getBackupApi();
      if (!hasMethod(api, 'backupWebDAVTest')) {
        notifyApiUnavailable();
        setTestConnectionStatus('error');
        setTimeout(() => setTestConnectionStatus('idle'), 3000);
        return;
      }

      const result = await api.backupWebDAVTest(webdavConfig);

      if (result.success) {
        setTestConnectionStatus('success');
        showToast(t('backup.connectionSuccess'), 'success');
        setTimeout(() => setTestConnectionStatus('idle'), 3000);
      } else {
        setTestConnectionStatus('error');
        showToast(t('backup.connectionFailed') + ': ' + resultError(result), 'error');
        setTimeout(() => setTestConnectionStatus('idle'), 3000);
      }
    } catch (error) {
      setTestConnectionStatus('error');
      showToast(t('backup.connectionFailed') + ': ' + caughtError(error), 'error');
      setTimeout(() => setTestConnectionStatus('idle'), 3000);
    }
  };

  // 保存WebDAV配置
  const handleSaveWebDAVConfig = async () => {
    try {
      const api = getBackupApi();
      if (!hasMethod(api, 'backupWebDAVSaveConfig')) {
        notifyApiUnavailable();
        return;
      }

      const result = await api.backupWebDAVSaveConfig(webdavConfig);

      if (result.success) {
        showToast(t('backup.configSaved'), 'success');
      } else {
        showToast(t('backup.configSaveFailed') + ': ' + resultError(result), 'error');
      }
    } catch (error) {
      showToast(t('backup.configSaveFailed') + ': ' + caughtError(error), 'error');
    }
  };

  // 创建本地备份
  const handleCreateLocalBackup = async () => {
    setIsLoading(true);

    try {
      const api = getBackupApi();
      if (!hasMethod(api, 'backupCreateLocal')) {
        notifyApiUnavailable();
        return;
      }

      const backupType = isBackupTypeFullBackup ? 'FULL_BACKUP' : 'CONFIG_ONLY';
      const result = await api.backupCreateLocal(backupType);

      if (result.success) {
        showToast(t('backup.localBackupSuccess') + (result.filePath ? '\n' + result.filePath : ''), 'success');
      } else if (isUserCanceled(result)) {
        return;
      } else {
        showToast(t('backup.localBackupFailed') + ': ' + resultError(result), 'error');
      }
    } catch (error) {
      showToast(t('backup.localBackupFailed') + ': ' + caughtError(error), 'error');
    } finally {
      setIsLoading(false);
    }
  };

  // 还原本地备份
  const handleRestoreLocalBackup = async () => {
    setConfirmDialog({
      open: true,
      title: t('backup.restoreConfirm'),
      description: t('backup.restoreConfirmDesc') || '此操作将覆盖当前配置，是否继续？',
      onConfirm: async () => {
        setConfirmDialog({ ...confirmDialog, open: false });
        setIsLoading(true);

        try {
          const api = getBackupApi();
          if (!hasMethod(api, 'backupRestoreLocal')) {
            notifyApiUnavailable();
            return;
          }

          const result = await api.backupRestoreLocal();

          if (result.success) {
            showToast(restoreSuccessMessage(result), 'success');
            notifyBackupRestored(result);
          } else if (isUserCanceled(result)) {
            return;
          } else {
            showToast(t('backup.restoreFailed') + ': ' + resultError(result), 'error');
          }
        } catch (error) {
          showToast(t('backup.restoreFailed') + ': ' + caughtError(error), 'error');
        } finally {
          setIsLoading(false);
        }
      }
    });
  };

  // 上传到WebDAV
  const handleWebDAVUpload = async () => {
    setIsLoading(true);
    setBackupProgress(0);

    let removeListener: (() => void) | undefined;
    try {
      const api = getBackupApi();
      if (!hasMethod(api, 'backupWebDAVUpload')) {
        notifyApiUnavailable();
        return;
      }

      if (hasMethod(api, 'onBackupUploadProgress')) {
        removeListener = api.onBackupUploadProgress((progress: any) => {
          setBackupProgress(progress.percentage);
        });
      }

      const backupType = isBackupTypeFullBackup ? 'FULL_BACKUP' : 'CONFIG_ONLY';
      const result = await api.backupWebDAVUpload(backupType);

      if (result.success) {
        showToast(t('backup.webdavUploadSuccess'), 'success');
        // 如果备份列表正在显示，刷新列表
        if (showBackupList) {
          await loadBackupList();
        }
      } else {
        showToast(t('backup.webdavUploadFailed') + ': ' + resultError(result), 'error');
      }
    } catch (error) {
      showToast(t('backup.webdavUploadFailed') + ': ' + caughtError(error), 'error');
    } finally {
      removeListener?.();
      setIsLoading(false);
      setBackupProgress(0);
    }
  };

  // 从WebDAV下载并还原
  const handleWebDAVDownload = async () => {
    setConfirmDialog({
      open: true,
      title: t('backup.restoreConfirm'),
      description: t('backup.restoreConfirmDesc') || '此操作将覆盖当前配置，是否继续？',
      onConfirm: async () => {
        setConfirmDialog({ ...confirmDialog, open: false });
        setIsLoading(true);
        setBackupProgress(0);

        let removeListener: (() => void) | undefined;
        try {
          const api = getBackupApi();
          if (!hasMethod(api, 'backupWebDAVDownload')) {
            notifyApiUnavailable();
            return;
          }

          // 监听下载进度
          if (hasMethod(api, 'onBackupDownloadProgress')) {
            removeListener = api.onBackupDownloadProgress((progress: any) => {
              setBackupProgress(progress.percentage);
            });
          }

          const result = await api.backupWebDAVDownload();

          if (result.success) {
            showToast(restoreSuccessMessage(result), 'success');
            notifyBackupRestored(result);
          } else {
            showToast(t('backup.restoreFailed') + ': ' + resultError(result), 'error');
          }
        } catch (error) {
          showToast(t('backup.restoreFailed') + ': ' + caughtError(error), 'error');
        } finally {
          removeListener?.();
          setIsLoading(false);
          setBackupProgress(0);
        }
      }
    });
  };

  // 加载备份列表
  const loadBackupList = async () => {
    if (!webdavConfig.uri || !webdavConfig.username || !webdavConfig.password) {
      const message = t('backup.missingWebDAVConfig');
      setBackupList([]);
      setBackupListError(message);
      showToast(message, 'error');
      return;
    }

    setIsLoadingBackupList(true);
    setBackupListError(null);
    try {
      const api = getBackupApi();
      if (!hasMethod(api, 'backupWebDAVList')) {
        setBackupList([]);
        setBackupListError(t('backup.apiUnavailable'));
        notifyApiUnavailable();
        return;
      }

      const result = await api.backupWebDAVList();
      if (result.success && result.backups) {
        setBackupList(result.backups);
        setBackupListError(null);
      } else {
        const message = t('backup.loadListFailed') + ': ' + resultError(result);
        setBackupList([]);
        setBackupListError(message);
        showToast(message, 'error');
      }
    } catch (error) {
      console.error('Failed to load backup list:', error);
      const message = t('backup.loadListFailed') + ': ' + caughtError(error);
      setBackupList([]);
      setBackupListError(message);
      showToast(message, 'error');
    } finally {
      setIsLoadingBackupList(false);
    }
  };

  // 删除备份
  const handleDeleteBackup = async (fileName: string) => {
    setConfirmDialog({
      open: true,
      title: t('backup.deleteConfirm'),
      description: t('backup.deleteConfirmDesc', { fileName }) || `确定要删除备份文件 ${fileName} 吗？`,
      onConfirm: async () => {
        setConfirmDialog({ ...confirmDialog, open: false });

        try {
          const api = getBackupApi();
          if (!hasMethod(api, 'backupWebDAVDelete')) {
            notifyApiUnavailable();
            return;
          }

          const result = await api.backupWebDAVDelete(fileName);

          if (result.success) {
            showToast(t('backup.deleteSuccess'), 'success');
            // 重新加载列表
            await loadBackupList();
          } else {
            showToast(t('backup.deleteFailed') + ': ' + resultError(result), 'error');
          }
        } catch (error) {
          showToast(t('backup.deleteFailed') + ': ' + caughtError(error), 'error');
        }
      }
    });
  };

  // 从指定备份还原
  const handleRestoreFromBackup = async (fileName: string) => {
    setConfirmDialog({
      open: true,
      title: t('backup.restoreConfirm'),
      description: t('backup.restoreConfirmDesc') || '此操作将覆盖当前配置，是否继续？',
      onConfirm: async () => {
        setConfirmDialog({ ...confirmDialog, open: false });
        setIsLoading(true);
        setBackupProgress(0);

        let removeListener: (() => void) | undefined;
        try {
          const api = getBackupApi();
          if (!hasMethod(api, 'backupWebDAVDownload')) {
            notifyApiUnavailable();
            return;
          }

          // 监听下载进度
          if (hasMethod(api, 'onBackupDownloadProgress')) {
            removeListener = api.onBackupDownloadProgress((progress: any) => {
              setBackupProgress(progress.percentage);
            });
          }

          // 下载并还原指定的备份文件
          const result = await api.backupWebDAVDownload(fileName);

          if (result.success) {
            showToast(restoreSuccessMessage(result), 'success');
            notifyBackupRestored(result);
          } else {
            showToast(t('backup.restoreFailed') + ': ' + resultError(result), 'error');
          }
        } catch (error) {
          showToast(t('backup.restoreFailed') + ': ' + caughtError(error), 'error');
        } finally {
          removeListener?.();
          setIsLoading(false);
          setBackupProgress(0);
        }
      }
    });
  };

  // 当WebDAV配置改变或显示备份列表时，加载备份列表
  useEffect(() => {
    if (showBackupList) {
      loadBackupList();
    }
  }, [showBackupList]);

  return (
    <>
      <ConfirmDialog
        open={confirmDialog.open}
        title={confirmDialog.title}
        description={confirmDialog.description}
        onConfirm={confirmDialog.onConfirm}
        onCancel={() => setConfirmDialog({ ...confirmDialog, open: false })}
      />
      <div className="space-y-6">
      {/* 备份类型选择 */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200">
            {t('backup.fullBackup')}
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-300 mt-1">
            {t('backup.fullBackupDesc')}
          </p>
        </div>
        <Switch
          checked={isBackupTypeFullBackup}
          onCheckedChange={setIsBackupTypeFullBackup}
        />
      </div>

      {/* 本地备份 */}
      <div className="border border-gray-200 dark:border-gray-600 rounded-lg p-4">
        <h3 className="text-base font-medium text-gray-700 dark:text-gray-200 mb-3">
          {t('backup.localBackup')}
        </h3>

        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          {t('backup.localBackupDesc')}
        </p>

        <div className="flex gap-3">
          <Button
            onClick={handleCreateLocalBackup}
            disabled={isLoading}
            variant="primary"
            className="flex items-center gap-2"
          >
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <HardDriveDownload className="h-4 w-4" />
            )}
            {t('backup.createBackup')}
          </Button>

          <Button
            onClick={handleRestoreLocalBackup}
            disabled={isLoading}
            variant="outline"
            className="flex items-center gap-2"
          >
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <HardDriveUpload className="h-4 w-4" />
            )}
            {t('backup.restoreBackup')}
          </Button>
        </div>
      </div>

      {/* WebDAV备份 */}
      <div className="border border-gray-200 dark:border-gray-600 rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-base font-medium text-gray-700 dark:text-gray-200">
            {t('backup.webdavBackup')}
          </h3>
          <Button
            onClick={() => setShowWebDAVSettings(!showWebDAVSettings)}
            variant="ghost"
            size="sm"
            className="flex items-center gap-2"
          >
            <Settings className="h-4 w-4" />
            {t('backup.settings')}
          </Button>
        </div>

        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          {t('backup.webdavBackupDesc')}
        </p>

        {/* WebDAV设置 */}
        {showWebDAVSettings && (
          <div className="space-y-3 mb-4 p-3 bg-gray-50 dark:bg-[#1a1a1a] rounded-md">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                {t('backup.webdavUri')}
              </label>
              <input
                type="text"
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="https://dav.example.com"
                value={webdavConfig.uri}
                onChange={(e) => setWebdavConfig({ ...webdavConfig, uri: e.target.value })}
                autoComplete="off"
                spellCheck="false"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                  {t('backup.username')}
                </label>
                <input
                  type="text"
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  value={webdavConfig.username}
                  onChange={(e) => setWebdavConfig({ ...webdavConfig, username: e.target.value })}
                  autoComplete="off"
                  spellCheck="false"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                  {t('backup.password')}
                </label>
                <input
                  type="password"
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  value={webdavConfig.password}
                  onChange={(e) => setWebdavConfig({ ...webdavConfig, password: e.target.value })}
                  autoComplete="off"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                  {t('backup.backupDirectory')}
                </label>
                <input
                  type="text"
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="FlyClash"
                  value={webdavConfig.backupDirectory}
                  onChange={(e) => setWebdavConfig({ ...webdavConfig, backupDirectory: e.target.value })}
                  autoComplete="off"
                  spellCheck="false"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                  {t('backup.backupFileName')}
                </label>
                <input
                  type="text"
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="flyclash_backup.zip"
                  value={webdavConfig.fileName}
                  onChange={(e) => setWebdavConfig({ ...webdavConfig, fileName: e.target.value })}
                  autoComplete="off"
                  spellCheck="false"
                />
              </div>
            </div>

            <div className="flex gap-2">
              <Button
                onClick={handleTestConnection}
                disabled={testConnectionStatus === 'testing'}
                variant="outline"
                size="sm"
                className="flex items-center gap-2"
              >
                {testConnectionStatus === 'testing' && <Loader2 className="h-3 w-3 animate-spin" />}
                {testConnectionStatus === 'success' && <Check className="h-3 w-3 text-green-500" />}
                {testConnectionStatus === 'error' && <X className="h-3 w-3 text-red-500" />}
                {t('backup.testConnection')}
              </Button>

              <Button
                onClick={handleSaveWebDAVConfig}
                variant="primary"
                size="sm"
              >
                {t('backup.saveConfig')}
              </Button>
            </div>
          </div>
        )}

        {/* 进度条 */}
        {backupProgress > 0 && (
          <div className="mb-4">
            <div className="w-full bg-gray-200 dark:bg-[#3a3a3a] rounded-full h-2">
              <div
                className="bg-blue-500 h-2 rounded-full transition-all"
                style={{ width: `${backupProgress}%` }}
              />
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 text-center">
              {backupProgress}%
            </p>
          </div>
        )}

        <div className="flex gap-3 mb-4">
          <Button
            onClick={handleWebDAVUpload}
            disabled={isLoading}
            variant="primary"
            className="flex items-center gap-2"
          >
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CloudUpload className="h-4 w-4" />
            )}
            {t('backup.uploadToCloud')}
          </Button>

          <Button
            onClick={handleWebDAVDownload}
            disabled={isLoading}
            variant="outline"
            className="flex items-center gap-2"
          >
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CloudDownload className="h-4 w-4" />
            )}
            {t('backup.downloadFromCloud')}
          </Button>

          <Button
            onClick={() => setShowBackupList(!showBackupList)}
            variant="ghost"
            className="flex items-center gap-2"
          >
            {showBackupList ? t('backup.hideBackupList') : t('backup.showBackupList')}
          </Button>
        </div>

        {/* 备份列表 */}
        {showBackupList && (
          <div className="mt-4 p-3 bg-gray-50 dark:bg-[#1a1a1a] rounded-md">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-sm font-medium text-gray-700 dark:text-gray-200">
                {t('backup.backupList')}
              </h4>
              <Button
                onClick={loadBackupList}
                disabled={isLoadingBackupList}
                variant="ghost"
                size="sm"
                className="flex items-center gap-2"
              >
                <RefreshCw className={`h-3 w-3 ${isLoadingBackupList ? 'animate-spin' : ''}`} />
                {t('common.refresh')}
              </Button>
            </div>

            {isLoadingBackupList ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
              </div>
            ) : backupListError ? (
              <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <span>{backupListError}</span>
                  <Button
                    onClick={loadBackupList}
                    variant="outline"
                    size="sm"
                    className="flex items-center gap-2"
                  >
                    <RefreshCw className="h-3 w-3" />
                    {t('common.refresh')}
                  </Button>
                </div>
              </div>
            ) : backupList.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-4">
                {t('backup.noBackups')}
              </p>
            ) : (
              <div className="space-y-2">
                {backupList.map((backup) => (
                  <div
                    key={backup.name}
                    className="flex items-center justify-between p-3 bg-white dark:bg-[#2a2a2a] rounded border border-gray-200 dark:border-gray-700"
                  >
                    <div className="flex-1">
                      <p className="text-sm font-medium text-gray-700 dark:text-gray-200">
                        {backup.name}
                      </p>
                      <div className="flex gap-4 mt-1">
                        <span className="text-xs text-gray-500 dark:text-gray-400">
                          {(backup.size / 1024 / 1024).toFixed(2)} MB
                        </span>
                        <span className="text-xs text-gray-500 dark:text-gray-400">
                          {new Date(backup.lastModified).toLocaleString()}
                        </span>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        onClick={() => handleRestoreFromBackup(backup.name)}
                        disabled={isLoading}
                        variant="outline"
                        size="sm"
                        className="flex items-center gap-1"
                      >
                        <Download className="h-3 w-3" />
                        {t('backup.restore')}
                      </Button>
                      <Button
                        onClick={() => handleDeleteBackup(backup.name)}
                        variant="ghost"
                        size="sm"
                        className="flex items-center gap-1 text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20"
                      >
                        <Trash2 className="h-3 w-3" />
                        {t('common.delete')}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 兼容性说明 */}
      <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
        <h4 className="text-sm font-medium text-blue-900 dark:text-blue-200 mb-2">
          {t('backup.compatibilityTitle')}
        </h4>
        <p className="text-sm text-blue-700 dark:text-blue-300">
          {t('backup.compatibilityDesc')}
        </p>
      </div>
    </div>
    </>
  );
}
