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
  Download,
  Send,
  Radio,
  Laptop,
  Smartphone,
  Wifi,
  ShieldCheck,
  Delete as DeleteIcon,
  RotateCcw
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { showToast as showGlobalToast } from '@/components/ui/toast';
import { ConfirmDialog } from './ConfirmDialog';
import { restoreAiSettingsFromBackup, syncAiSettingsForBackup } from '@/stores/ai-store';

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

interface LanDevice {
  id: string;
  name: string;
  hostName?: string;
  deviceType?: string;
  platform?: string;
  address: string;
  port: number;
  sessionKey: string;
}

type LanStatus = {
  state: 'idle' | 'waiting' | 'receiving' | 'received' | 'error';
  senderName?: string;
  senderDeviceType?: string;
  senderPlatform?: string;
  progress?: number;
  size?: number;
  error?: string;
};

const isMobileLanDevice = (device: Pick<LanDevice, 'name' | 'deviceType' | 'platform'>) => {
  if (device.deviceType === 'phone' || device.deviceType === 'tablet') return true;
  if (device.deviceType === 'desktop') return false;
  if (device.platform === 'android' || device.platform === 'ios') return true;
  if (device.platform === 'windows' || device.platform === 'macos' || device.platform === 'linux') return false;
  return /android|iphone|ipad|phone|mobile/i.test(device.name);
};

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
  const [lanMode, setLanMode] = useState<'closed' | 'role' | 'sender' | 'pairing' | 'receiver'>('closed');
  const [lanBusy, setLanBusy] = useState(false);
  const [lanDevices, setLanDevices] = useState<LanDevice[]>([]);
  const [lanReceiverInfo, setLanReceiverInfo] = useState<{ port: number; pairingCode: string } | null>(null);
  const [lanStatus, setLanStatus] = useState<LanStatus>({ state: 'idle' });
  const [lanSelectedDevice, setLanSelectedDevice] = useState<LanDevice | null>(null);
  const [lanPairingCode, setLanPairingCode] = useState('');
  const [lanPairingError, setLanPairingError] = useState('');

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
    void restoreAiSettingsFromBackup(true);
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
      await syncAiSettingsForBackup();
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
      await syncAiSettingsForBackup();
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

  const discoverLanDevices = async () => {
    setLanMode('sender');
    setLanBusy(true);
    setLanDevices([]);
    try {
      const api = getBackupApi();
      if (!hasMethod(api, 'backupLanDiscover')) {
        notifyApiUnavailable();
        return;
      }
      const result = await api.backupLanDiscover();
      if (!result.success) throw new Error(resultError(result));
      setLanDevices(result.devices || []);
    } catch (error) {
      showToast(`${t('backup.lanFailed')}: ${caughtError(error)}`, 'error');
    } finally {
      setLanBusy(false);
    }
  };

  const startLanReceiver = async () => {
    setLanBusy(true);
    try {
      const api = getBackupApi();
      if (!hasMethod(api, 'backupLanStartReceiver')) {
        notifyApiUnavailable();
        return;
      }
      const result = await api.backupLanStartReceiver();
      if (!result.success || !result.port || !result.pairingCode) throw new Error(resultError(result));
      setLanReceiverInfo({ port: result.port, pairingCode: result.pairingCode });
      setLanStatus({ state: 'waiting' });
      setLanMode('receiver');
    } catch (error) {
      showToast(`${t('backup.lanFailed')}: ${caughtError(error)}`, 'error');
    } finally {
      setLanBusy(false);
    }
  };

  const closeLanPanel = async () => {
    if (lanMode === 'receiver') {
      const api = getBackupApi();
      if (hasMethod(api, 'backupLanStopReceiver')) {
        await api.backupLanStopReceiver().catch(() => undefined);
      }
    }
    setLanMode('closed');
    setLanReceiverInfo(null);
    setLanStatus({ state: 'idle' });
    setLanSelectedDevice(null);
    setLanPairingCode('');
    setLanPairingError('');
  };

  const sendLanBackup = async (device: LanDevice, pairingCode: string) => {
    setLanBusy(true);
    try {
      const api = getBackupApi();
      if (!hasMethod(api, 'backupLanSend')) {
        notifyApiUnavailable();
        return;
      }
      const backupType = isBackupTypeFullBackup ? 'FULL_BACKUP' : 'CONFIG_ONLY';
      await syncAiSettingsForBackup();
      const result = await api.backupLanSend(device, backupType, pairingCode);
      if (!result.success) throw new Error(resultError(result));
      showToast(t('backup.lanSendSuccess'), 'success');
      setLanMode('closed');
    } catch (error) {
      const message = caughtError(error);
      setLanPairingError(message);
      setLanPairingCode('');
      showToast(`${t('backup.lanFailed')}: ${message}`, 'error');
    } finally {
      setLanBusy(false);
    }
  };

  const confirmLanSend = (device: LanDevice, pairingCode: string) => {
    setConfirmDialog({
      open: true,
      title: t('backup.lanSendConfirmTitle'),
      description: t('backup.lanSendConfirmMessage', { name: device.name }),
      onConfirm: async () => {
        setConfirmDialog((current) => ({ ...current, open: false }));
        await sendLanBackup(device, pairingCode);
      }
    });
  };

  const selectLanDevice = (device: LanDevice) => {
    setLanSelectedDevice(device);
    setLanPairingCode('');
    setLanPairingError('');
    setLanMode('pairing');
  };

  const pressPairingKey = (key: string) => {
    setLanPairingError('');
    setLanPairingCode((current) => {
      if (key === 'clear') return '';
      if (key === 'delete') return current.slice(0, -1);
      return current.length < 6 ? `${current}${key}` : current;
    });
  };

  const importReceivedLanBackup = () => {
    setConfirmDialog({
      open: true,
      title: t('backup.restoreConfirm'),
      description: t('backup.restoreConfirmDesc'),
      onConfirm: async () => {
        setConfirmDialog((current) => ({ ...current, open: false }));
        setLanBusy(true);
        try {
          const api = getBackupApi();
          if (!hasMethod(api, 'backupLanRestoreReceived')) {
            notifyApiUnavailable();
            return;
          }
          const result = await api.backupLanRestoreReceived();
          if (!result.success) throw new Error(resultError(result));
          notifyBackupRestored(result);
          showToast(t('backup.lanImportSuccess'), 'success');
          setLanMode('closed');
        } catch (error) {
          showToast(`${t('backup.restoreFailed')}: ${caughtError(error)}`, 'error');
        } finally {
          setLanBusy(false);
        }
      }
    });
  };

  useEffect(() => {
    if (lanMode !== 'receiver') return;
    let disposed = false;
    const poll = async () => {
      const api = getBackupApi();
      if (!hasMethod(api, 'backupLanStatus')) return;
      try {
        const result = await api.backupLanStatus();
        if (!disposed && result.success && result.status) setLanStatus(result.status);
      } catch {
        // A transient polling error should not stop the receiver UI.
      }
    };
    poll();
    const timer = window.setInterval(poll, 700);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [lanMode]);

  return (
    <>
      <ConfirmDialog
        open={confirmDialog.open}
        title={confirmDialog.title}
        description={confirmDialog.description}
        onConfirm={confirmDialog.onConfirm}
        onCancel={() => setConfirmDialog({ ...confirmDialog, open: false })}
      />
      {lanMode !== 'closed' && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/35 p-5 backdrop-blur-[10px]">
          <div
            className="max-h-[calc(100vh-2rem)] w-full max-w-[560px] overflow-y-auto rounded-[30px] border border-white/80 bg-white/95 shadow-[0_32px_100px_-28px_rgba(15,23,42,0.48)] ring-1 ring-slate-900/5 animate-in fade-in-0 zoom-in-95 duration-200 dark:border-white/10 dark:bg-[#18191c]/95 dark:ring-white/10"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-4 px-7 pb-5 pt-7">
              <div className="flex min-w-0 items-center gap-3.5">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-blue-500 text-white shadow-[0_10px_25px_-10px_rgba(59,130,246,0.8)]">
                  <Wifi className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <h3 className="text-[19px] font-semibold tracking-[-0.02em] text-slate-950 dark:text-white">{t('backup.lanTitle')}</h3>
                  <p className="mt-0.5 truncate text-[13px] text-slate-500 dark:text-slate-400">{t('backup.lanSameNetwork')}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={closeLanPanel}
                aria-label={t('backup.lanClose')}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 active:bg-slate-200 dark:hover:bg-white/10 dark:hover:text-white"
              >
                <X className="h-[18px] w-[18px]" />
              </button>
            </div>

            <div className="px-7 pb-7">

            {lanMode === 'role' && (
              <div className="grid gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={discoverLanDevices}
                  className="group flex items-center gap-4 rounded-[20px] border border-slate-200/80 bg-slate-50/70 p-5 text-left transition-all duration-200 motion-standard hover:border-blue-300 hover:bg-blue-50/70 hover:shadow-[0_14px_35px_-22px_rgba(59,130,246,0.55)] active:scale-[0.99] dark:border-white/10 dark:bg-white/[0.035] dark:hover:border-blue-500/50 dark:hover:bg-blue-500/10"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-blue-500/10 text-blue-500"><Send className="h-5 w-5" /></span>
                  <span><strong className="block text-gray-900 dark:text-gray-100">{t('backup.lanSender')}</strong><small className="text-gray-500 dark:text-gray-400">{t('backup.lanSenderDesc')}</small></span>
                </button>
                <button
                  type="button"
                  onClick={startLanReceiver}
                  className="group flex items-center gap-4 rounded-[20px] border border-slate-200/80 bg-slate-50/70 p-5 text-left transition-all duration-200 motion-standard hover:border-emerald-300 hover:bg-emerald-50/70 hover:shadow-[0_14px_35px_-22px_rgba(16,185,129,0.55)] active:scale-[0.99] dark:border-white/10 dark:bg-white/[0.035] dark:hover:border-emerald-500/50 dark:hover:bg-emerald-500/10"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-500"><Radio className="h-5 w-5" /></span>
                  <span><strong className="block text-gray-900 dark:text-gray-100">{t('backup.lanReceiver')}</strong><small className="text-gray-500 dark:text-gray-400">{t('backup.lanReceiverDesc')}</small></span>
                </button>
              </div>
            )}

            {lanMode === 'sender' && (
              <div className="space-y-4">
                {lanBusy ? (
                  <div className="flex items-center justify-center gap-3 py-10 text-gray-500"><Loader2 className="h-5 w-5 animate-spin" />{t('backup.lanSearching')}</div>
                ) : lanDevices.length === 0 ? (
                  <div className="rounded-lg bg-gray-50 p-5 text-center dark:bg-[#171717]">
                    <p className="text-sm text-gray-500 dark:text-gray-400">{t('backup.lanNoDevices')}</p>
                    <Button className="mt-3" variant="outline" onClick={discoverLanDevices}><RefreshCw className="mr-2 h-4 w-4" />{t('backup.lanRefresh')}</Button>
                  </div>
                ) : (
                  <div className="max-h-52 space-y-2 overflow-y-auto">
                    {lanDevices.map((device) => (
                      <button
                        key={device.id}
                        type="button"
                        onClick={() => selectLanDevice(device)}
                        disabled={lanBusy}
                        className="flex w-full items-center gap-3 rounded-lg border border-gray-200 p-3 text-left transition hover:border-blue-500 hover:bg-blue-50 disabled:opacity-60 dark:border-gray-700 dark:hover:bg-blue-950/20"
                      >
                        {isMobileLanDevice(device) ? <Smartphone className="h-5 w-5" /> : <Laptop className="h-5 w-5" />}
                        <span className="flex-1"><strong className="block text-sm text-gray-800 dark:text-gray-100">{device.name}</strong><small className="text-gray-500">{device.address}:{device.port}</small></span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {lanMode === 'pairing' && lanSelectedDevice && (
              <div className="mx-auto max-w-[420px] text-center">
                <div className="mx-auto flex w-fit max-w-full items-center gap-2.5 rounded-full border border-slate-200 bg-slate-50 px-3.5 py-2 dark:border-white/10 dark:bg-white/[0.045]">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-500/10 text-blue-500">
                    {isMobileLanDevice(lanSelectedDevice) ? <Smartphone className="h-3.5 w-3.5" /> : <Laptop className="h-3.5 w-3.5" />}
                  </span>
                  <span className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">{lanSelectedDevice.name}</span>
                  <span className="h-1 w-1 shrink-0 rounded-full bg-emerald-500" />
                </div>
                <p className="mx-auto mt-3 max-w-sm text-sm leading-6 text-slate-500 dark:text-slate-400">{t('backup.lanPairingHint')}</p>

                <div className="mt-5">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400 dark:text-slate-500">{t('backup.lanPairingCodeLabel')}</p>
                  <div className="mt-3 flex items-center justify-center gap-2">
                    {Array.from({ length: 6 }, (_, index) => (
                      <React.Fragment key={index}>
                        {index === 3 && <span className="mx-0.5 h-px w-3 bg-slate-300 dark:bg-slate-600" />}
                        <span
                          className={`flex h-14 w-12 items-center justify-center rounded-[14px] border font-mono text-2xl font-semibold transition-all duration-200 motion-standard ${
                            lanPairingCode[index]
                              ? 'border-blue-300 bg-blue-50 text-blue-600 shadow-[0_8px_22px_-15px_rgba(37,99,235,0.75)] dark:border-blue-400/30 dark:bg-blue-400/10 dark:text-blue-300'
                              : 'border-slate-200 bg-slate-50/80 text-slate-300 dark:border-white/10 dark:bg-white/[0.035] dark:text-slate-600'
                          }`}
                        >
                          {lanPairingCode[index] || '·'}
                        </span>
                      </React.Fragment>
                    ))}
                  </div>
                </div>

                <div className="mt-5 grid grid-cols-3 gap-2.5">
                  {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'delete'].map((key) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => pressPairingKey(key)}
                      aria-label={key === 'clear' ? 'Clear' : key === 'delete' ? 'Delete' : key}
                      className="flex h-12 items-center justify-center rounded-[14px] border border-slate-200/90 bg-slate-50/80 text-base font-semibold text-slate-800 shadow-sm transition-all duration-200 motion-standard hover:border-blue-200 hover:bg-blue-50 hover:text-blue-600 active:scale-[0.97] dark:border-white/10 dark:bg-white/[0.045] dark:text-slate-100 dark:shadow-none dark:hover:border-blue-400/30 dark:hover:bg-blue-400/10 dark:hover:text-blue-300"
                    >
                      {key === 'clear' ? <RotateCcw className="h-[18px] w-[18px]" /> : key === 'delete' ? <DeleteIcon className="h-5 w-5" /> : key}
                    </button>
                  ))}
                </div>
                {lanPairingError && <p className="mt-3 rounded-xl bg-red-50 px-4 py-2.5 text-sm text-red-600 dark:bg-red-500/10 dark:text-red-400">{lanPairingError}</p>}
                <Button
                  className="mt-4 h-12 w-full rounded-[14px]"
                  variant="primary"
                  disabled={lanBusy || lanPairingCode.length !== 6}
                  onClick={() => confirmLanSend(lanSelectedDevice, lanPairingCode)}
                >
                  {lanBusy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {t('backup.lanPairingContinue')}
                </Button>
                <Button
                  className="mt-2 text-slate-500 dark:text-slate-400"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setLanMode('sender');
                    setLanSelectedDevice(null);
                    setLanPairingCode('');
                    setLanPairingError('');
                  }}
                >
                  {t('backup.lanPairingBack')}
                </Button>
              </div>
            )}

            {lanMode === 'receiver' && lanReceiverInfo && (
              <div className="relative overflow-hidden rounded-[24px] border border-slate-200/80 bg-gradient-to-b from-slate-50/90 to-white p-6 text-center dark:border-white/10 dark:from-white/[0.055] dark:to-white/[0.025]">
                <div className="pointer-events-none absolute -right-16 -top-20 h-52 w-52 rounded-full bg-blue-400/10 blur-3xl" />
                <div className="relative">
                  <div className="mx-auto flex w-fit items-center gap-2 rounded-full border border-emerald-200/80 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 dark:border-emerald-400/20 dark:bg-emerald-400/10 dark:text-emerald-300">
                    <span className="relative flex h-2 w-2">
                      {lanStatus.state === 'waiting' && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />}
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                    </span>
                    {lanStatus.state === 'received' ? t('backup.lanReceived', { name: lanStatus.senderName }) : lanStatus.state === 'receiving' ? t('backup.lanReceiving', { name: lanStatus.senderName }) : t('backup.lanWaiting')}
                  </div>
                  {lanStatus.state === 'waiting' && <p className="mx-auto mt-3 max-w-sm text-sm leading-6 text-slate-500 dark:text-slate-400">{t('backup.lanWaitingDesc')}</p>}
                </div>
                {lanStatus.state === 'waiting' && (
                  <div className="relative mt-6">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400 dark:text-slate-500">{t('backup.lanPairingCodeLabel')}</p>
                    <div className="mt-3 flex items-center justify-center gap-2">
                      {lanReceiverInfo.pairingCode.split('').map((digit, index) => (
                        <React.Fragment key={`${digit}-${index}`}>
                          {index === 3 && <span className="mx-0.5 h-px w-3 bg-slate-300 dark:bg-slate-600" />}
                          <span className="flex h-14 w-12 items-center justify-center rounded-[14px] border border-blue-200/90 bg-white font-mono text-2xl font-semibold text-blue-600 shadow-[0_8px_22px_-15px_rgba(37,99,235,0.75)] dark:border-blue-400/20 dark:bg-blue-400/10 dark:text-blue-300">
                            {digit}
                          </span>
                        </React.Fragment>
                      ))}
                    </div>
                  </div>
                )}
                <div className="mt-6 flex items-center justify-center gap-2 text-[11px] text-slate-400 dark:text-slate-500">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  <span>{t('backup.lanSameNetwork')}</span>
                  <span className="h-3 w-px bg-slate-300 dark:bg-slate-600" />
                  <span className="font-mono">TCP {lanReceiverInfo.port}</span>
                </div>
                {lanStatus.state === 'receiving' && <div className="mx-auto mt-5 h-1.5 max-w-sm overflow-hidden rounded-full bg-slate-200 dark:bg-white/10"><div className="h-full rounded-full bg-blue-500 transition-all duration-300" style={{ width: `${lanStatus.progress || 0}%` }} /></div>}
                {lanStatus.state === 'received' && <Button className="mt-5" variant="primary" disabled={lanBusy} onClick={importReceivedLanBackup}>{lanBusy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{t('backup.lanImport')}</Button>}
                {lanStatus.state === 'error' && <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600 dark:bg-red-500/10 dark:text-red-400">{lanStatus.error}</p>}
              </div>
            )}
            </div>
          </div>
        </div>
      )}
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

      {/* 局域网跨设备备份 */}
      <div className="border border-gray-200 dark:border-gray-600 rounded-lg p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-base font-medium text-gray-700 dark:text-gray-200">{t('backup.lanTitle')}</h3>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t('backup.lanDesc')}</p>
          </div>
          <Button variant="outline" onClick={() => setLanMode('role')} className="shrink-0">
            <Settings className="mr-2 h-4 w-4" />{t('backup.lanChooseRole')}
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
