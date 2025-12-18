import React, { useState, useEffect } from 'react';
import { Switch } from '@/components/ui/switch';
import * as Toast from '@radix-ui/react-toast';
import { Cross2Icon } from '@radix-ui/react-icons';
import { useTranslation } from 'react-i18next';

interface TunConfig {
  device: string;
  stack: 'gvisor' | 'mixed' | 'system';
  autoRoute: boolean;
  autoRedirect: boolean;
  autoDetectInterface: boolean;
  dnsHijack: string[];
  strictRoute: boolean;
  routeExcludeAddress: string[];
  mtu: number;
  autoSetDNS?: boolean;
}

const TunSettings: React.FC = () => {
  const { t } = useTranslation();
  const [config, setConfig] = useState<TunConfig>({
    device: process.platform === 'darwin' ? 'utun' : 'mihomo',
    stack: 'system',
    autoRoute: true,
    autoRedirect: false,
    autoDetectInterface: true,
    dnsHijack: ['any:53'],
    strictRoute: false,
    routeExcludeAddress: [],
    mtu: 1500,
    autoSetDNS: process.platform === 'darwin',
  });
  const [loading, setLoading] = useState(false);
  const [changed, setChanged] = useState(false);
  const [permissionStatus, setPermissionStatus] = useState<string>('unknown');

  const [toastOpen, setToastOpen] = useState(false);
  const [toastTitle, setToastTitle] = useState('');
  const [toastDescription, setToastDescription] = useState('');
  const [toastType, setToastType] = useState<'success' | 'error'>('success');
  const [platform, setPlatform] = useState<string>('');

  // Windows 服务模式相关状态
  const [elevationMode, setElevationMode] = useState<'service' | 'task'>('service');
  const [serviceStatus, setServiceStatus] = useState<{ installed: boolean; running: boolean }>({ installed: false, running: false });
  const [serviceLoading, setServiceLoading] = useState(false);

  useEffect(() => {
    loadConfig();
    checkPermissionStatus();
    getPlatformInfo();
    loadElevationMode();
  }, []);

  const getPlatformInfo = async () => {
    if (!window.electronAPI) return;

    try {
      const platformInfo = await window.electronAPI.getPlatform?.() || process.platform;
      setPlatform(platformInfo);
      console.log('[TunSettings] Platform info:', platformInfo);
    } catch (error) {
      console.error('Failed to get platform info:', error);
      setPlatform(process.platform);
    }
  };

  const loadElevationMode = async () => {
    if (!window.electronAPI) return;

    try {
      const currentPlatform = await window.electronAPI.getPlatform?.() || process.platform;
      if (currentPlatform !== 'win32') return;

      // 获取提升模式
      if (window.electronAPI.getTunElevationMode) {
        const result = await window.electronAPI.getTunElevationMode();
        if (result.success && result.mode) {
          setElevationMode(result.mode);
        }
      }

      // 获取服务状态
      if (window.electronAPI.getTunServiceStatus) {
        const status = await window.electronAPI.getTunServiceStatus();
        if (status.success) {
          setServiceStatus({
            installed: status.installed || false,
            running: status.running || false
          });
        }
      }
    } catch (error) {
      console.error('[TunSettings] Failed to load elevation mode:', error);
    }
  };

  const handleElevationModeChange = async (mode: 'service' | 'task') => {
    if (!window.electronAPI) return;

    setServiceLoading(true);
    try {
      if (window.electronAPI.setTunElevationMode) {
        const result = await window.electronAPI.setTunElevationMode(mode);
        if (result.success) {
          setElevationMode(mode);
          showToast('成功', `已切换到${mode === 'service' ? '服务' : '计划任务'}模式`, 'success');
        } else {
          showToast('错误', result.error || '切换模式失败', 'error');
        }
      }
    } catch (error) {
      showToast('错误', String(error), 'error');
    } finally {
      setServiceLoading(false);
    }
  };

  const handleInstallService = async () => {
    if (!window.electronAPI) return;

    setServiceLoading(true);
    try {
      if (window.electronAPI.installTunService) {
        const result = await window.electronAPI.installTunService();
        if (result.success) {
          if (result.needRestart) {
            showToast('成功', result.message || '正在请求管理员权限安装服务，应用将重新启动', 'success');
          } else {
            showToast('成功', result.message || '服务安装成功', 'success');
          }
          await loadElevationMode();
          await checkPermissionStatus();
        } else {
          showToast('错误', result.error || '服务安装失败', 'error');
        }
      }
    } catch (error) {
      showToast('错误', String(error), 'error');
    } finally {
      setServiceLoading(false);
    }
  };

  const handleUninstallService = async () => {
    if (!window.electronAPI) return;

    setServiceLoading(true);
    try {
      if (window.electronAPI.uninstallTunService) {
        const result = await window.electronAPI.uninstallTunService();
        if (result.success) {
          showToast('成功', result.message || '服务卸载成功', 'success');
          await loadElevationMode();
          await checkPermissionStatus();
        } else {
          showToast('错误', result.error || '服务卸载失败', 'error');
        }
      }
    } catch (error) {
      showToast('错误', String(error), 'error');
    } finally {
      setServiceLoading(false);
    }
  };

  const handleStartService = async () => {
    if (!window.electronAPI) return;

    setServiceLoading(true);
    try {
      if (window.electronAPI.startTunService) {
        const result = await window.electronAPI.startTunService();
        if (result.success) {
          showToast('成功', result.message || '服务已启动', 'success');
          await loadElevationMode();
        } else {
          showToast('错误', result.error || '服务启动失败', 'error');
        }
      }
    } catch (error) {
      showToast('错误', String(error), 'error');
    } finally {
      setServiceLoading(false);
    }
  };

  const handleStopService = async () => {
    if (!window.electronAPI) return;

    setServiceLoading(true);
    try {
      if (window.electronAPI.stopTunService) {
        const result = await window.electronAPI.stopTunService();
        if (result.success) {
          showToast('成功', result.message || '服务已停止', 'success');
          await loadElevationMode();
        } else {
          showToast('错误', result.error || '服务停止失败', 'error');
        }
      }
    } catch (error) {
      showToast('错误', String(error), 'error');
    } finally {
      setServiceLoading(false);
    }
  };

  const checkPermissionStatus = async () => {
    if (!window.electronAPI) return;

    try {
      // 统一通过 checkCorePermission 查询权限状态
      if (window.electronAPI.checkCorePermission) {
        const result = await window.electronAPI.checkCorePermission();
        console.log('[TunSettings] checkCorePermission result:', result);
        if (result && typeof result.hasPermission === 'boolean') {
          setPermissionStatus(result.hasPermission ? 'granted' : 'not_granted');
        } else {
          setPermissionStatus('unknown');
        }
      } else {
        console.warn('[TunSettings] checkCorePermission API not available');
        setPermissionStatus('unknown');
      }
    } catch (error) {
      console.error('Failed to check permission:', error);
      setPermissionStatus('unknown');
    }
  };

  const showToast = (title: string, description: string, type: 'success' | 'error') => {
    setToastTitle(title);
    setToastDescription(description);
    setToastType(type);
    setToastOpen(true);
  };

  const loadConfig = async () => {
    if (!window.electronAPI) return;

    try {
      const result = await window.electronAPI.getTunConfig();
      if (result.success && result.config) {
        setConfig(result.config);
      }
    } catch (error) {
      console.error(t('tunSettings.loadTunConfigFailed'), error);
    }
  };

  const handleSave = async () => {
    if (!window.electronAPI) return;

    setLoading(true);
    try {
      const result = await window.electronAPI.saveTunConfig(config);
      if (result.success) {
        showToast(t('tunSettings.success'), t('tunSettings.tunConfigSaved'), 'success');
        setChanged(false);
      } else {
        showToast(t('tunSettings.error'), result.error || t('tunSettings.unknownError'), 'error');
      }
    } catch (error) {
      showToast(t('tunSettings.error'), String(error), 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleGrantPermissions = async () => {
    if (!window.electronAPI) return;

    setLoading(true);
    try {
      const result = await window.electronAPI.grantTunPermissions();
      if (result.success) {
        showToast(t('tunSettings.success'), result.message || t('tunSettings.tunPermissionGranted'), 'success');
        await checkPermissionStatus();
      } else {
        showToast(t('tunSettings.error'), result.error || t('tunSettings.unknownError'), 'error');
      }
    } catch (error) {
      showToast(t('tunSettings.error'), String(error), 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleRevokePermissions = async () => {
    if (!window.electronAPI) return;

    setLoading(true);
    try {
      const currentPlatform = await window.electronAPI.getPlatform?.() || process.platform;
      const isWindows = currentPlatform === 'win32';

      if (isWindows && window.electronAPI.deleteElevateTask) {
        const result = await window.electronAPI.deleteElevateTask();
        if (result.success) {
          showToast(t('tunSettings.success'), 'Permission task removed', 'success');
          await checkPermissionStatus();
        } else {
          showToast(t('tunSettings.error'), result.error || 'Failed to remove task', 'error');
        }
      } else if (window.electronAPI.revokeCorePermission) {
        const result = await window.electronAPI.revokeCorePermission();
        if (result.success) {
          showToast(t('tunSettings.success'), 'Permissions revoked', 'success');
          await checkPermissionStatus();
        } else {
          showToast(t('tunSettings.error'), result.error || 'Failed to revoke permissions', 'error');
        }
      }
    } catch (error) {
      showToast(t('tunSettings.error'), String(error), 'error');
    } finally {
      setLoading(false);
    }
  };

  const updateConfig = (updates: Partial<TunConfig>) => {
    setConfig({ ...config, ...updates });
    setChanged(true);
  };

  const handleExcludeAddressChange = (index: number, value: string) => {
    const newAddresses = [...config.routeExcludeAddress];
    if (value.trim() === '') {
      newAddresses.splice(index, 1);
    } else {
      newAddresses[index] = value;
    }
    updateConfig({ routeExcludeAddress: newAddresses });
  };

  const handleAddExcludeAddress = () => {
    updateConfig({
      routeExcludeAddress: [...config.routeExcludeAddress, ''],
    });
  };

  const isMac = platform === 'darwin';
  const isLinux = platform === 'linux';
  const isWindows = platform === 'win32';

  return (
    <Toast.Provider swipeDirection="right">
      <div className="space-y-6">
        <div>
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">
            TUN 模式权限
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-300 mb-3">
            {isMac && 'macOS 需要授予内核 root 权限才能启用 TUN 模式。'}
            {isLinux && 'Linux 需要授予内核 root 权限才能启用 TUN 模式。'}
            {isWindows && 'Windows 需要创建计划任务以管理员权限运行，首次授权后应用会自动重启。'}
          </p>

          <div className="flex items-center gap-3">
            <div className="flex-1">
              {permissionStatus === 'granted' && (
                <div className="flex items-center gap-2 text-green-600 dark:text-green-400">
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                  </svg>
                  <span className="text-xs">
                    {isWindows && '已授权管理员权限'}
                    {isMac && '已授权（内核已获得 root 权限）'}
                    {isLinux && '已授权（内核已获得 root 权限）'}
                  </span>
                </div>
              )}
              {permissionStatus === 'not_granted' && (
                <div className="flex items-center gap-2 text-yellow-600 dark:text-yellow-400">
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                  </svg>
                  <span className="text-xs">
                    {isWindows && '未授权 TUN 模式权限，请退出应用，然后用管理员权限启动'}
                    {isMac && '未授权（需要授予内核 root 权限）'}
                    {isLinux && '未授权（需要授予内核 root 权限）'}
                  </span>
                </div>
              )}
              {permissionStatus === 'unknown' && (
                <div className="text-xs text-gray-500 dark:text-gray-400">正在检查授权状态...</div>
              )}
            </div>


          </div>
        </div>

        {/* Windows 权限提升模式 */}
        {isWindows && (
          <div>
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">
              TUN 权限提升方式
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-300 mb-3">
              选择 TUN 模式的权限提升方式。服务模式只需一次安装，后续无需每次确认；计划任务模式每次需要 UAC 确认。
            </p>

            <div className="flex gap-2 mb-4">
              <button
                className={`py-1.5 px-3 text-sm rounded-lg transition-colors ${
                  elevationMode === 'service'
                    ? 'bg-blue-500 text-white shadow-sm'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-[#1f1f1f] dark:text-gray-200 dark:hover:bg-[#2a2a2a]'
                }`}
                onClick={() => handleElevationModeChange('service')}
                disabled={serviceLoading}
              >
                服务模式（推荐）
              </button>
              <button
                className={`py-1.5 px-3 text-sm rounded-lg transition-colors ${
                  elevationMode === 'task'
                    ? 'bg-blue-500 text-white shadow-sm'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-[#1f1f1f] dark:text-gray-200 dark:hover:bg-[#2a2a2a]'
                }`}
                onClick={() => handleElevationModeChange('task')}
                disabled={serviceLoading}
              >
                计划任务模式
              </button>
            </div>

            {/* 服务模式状态和操作 */}
            {elevationMode === 'service' && (
              <div className="bg-gray-50 dark:bg-[#1a1a1a] rounded-lg p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-gray-600 dark:text-gray-300">服务状态</span>
                  <span className={`text-xs font-medium ${
                    serviceStatus.running
                      ? 'text-green-600 dark:text-green-400'
                      : serviceStatus.installed
                        ? 'text-yellow-600 dark:text-yellow-400'
                        : 'text-gray-500 dark:text-gray-400'
                  }`}>
                    {serviceStatus.running ? '运行中' : serviceStatus.installed ? '已安装但未运行' : '未安装'}
                  </span>
                </div>

                <div className="flex gap-2 flex-wrap">
                  {!serviceStatus.installed && (
                    <button
                      className="py-1 px-2.5 text-xs rounded-md bg-blue-500 hover:bg-blue-600 text-white transition-colors disabled:opacity-50"
                      onClick={handleInstallService}
                      disabled={serviceLoading}
                    >
                      {serviceLoading ? '处理中...' : '安装服务'}
                    </button>
                  )}
                  {serviceStatus.installed && !serviceStatus.running && (
                    <>
                      <button
                        className="py-1 px-2.5 text-xs rounded-md bg-green-500 hover:bg-green-600 text-white transition-colors disabled:opacity-50"
                        onClick={handleStartService}
                        disabled={serviceLoading}
                      >
                        {serviceLoading ? '处理中...' : '启动服务'}
                      </button>
                      <button
                        className="py-1 px-2.5 text-xs rounded-md bg-gray-200 hover:bg-gray-300 text-gray-700 dark:bg-gray-700 dark:hover:bg-gray-600 dark:text-gray-200 transition-colors disabled:opacity-50"
                        onClick={handleUninstallService}
                        disabled={serviceLoading}
                      >
                        {serviceLoading ? '处理中...' : '卸载服务'}
                      </button>
                    </>
                  )}
                  {serviceStatus.running && (
                    <>
                      <button
                        className="py-1 px-2.5 text-xs rounded-md bg-blue-500 hover:bg-blue-600 text-white transition-colors disabled:opacity-50"
                        onClick={handleStopService}
                        disabled={serviceLoading}
                      >
                        {serviceLoading ? '处理中...' : '停止服务'}
                      </button>
                      <button
                        className="py-1 px-2.5 text-xs rounded-md bg-gray-200 hover:bg-gray-300 text-gray-700 dark:bg-gray-700 dark:hover:bg-gray-600 dark:text-gray-200 transition-colors disabled:opacity-50"
                        onClick={handleUninstallService}
                        disabled={serviceLoading}
                      >
                        {serviceLoading ? '处理中...' : '卸载服务'}
                      </button>
                    </>
                  )}
                </div>

                <p className="text-xs text-gray-400 dark:text-gray-500 mt-2">
                  服务模式需要管理员权限安装，安装后可在后台运行 TUN 核心。
                </p>
              </div>
            )}

            {/* 计划任务模式说明 */}
            {elevationMode === 'task' && (
              <div className="bg-gray-50 dark:bg-[#1a1a1a] rounded-lg p-3">
                <p className="text-xs text-gray-600 dark:text-gray-300">
                  计划任务模式使用 Windows 计划任务在后台以管理员权限运行应用。每次切换 TUN 模式时可能需要 UAC 确认。
                </p>
              </div>
            )}
          </div>
        )}

        {/* macOS DNS 设置 */}
        {isMac && (
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('tunSettings.autoDns')}</h3>
              <p className="text-xs text-gray-500 dark:text-gray-300 mt-1">
                {t('tunSettings.autoDnsDesc')}
              </p>
            </div>
            <Switch
              checked={config.autoSetDNS}
              onCheckedChange={(checked) => updateConfig({ autoSetDNS: checked })}
            />
          </div>
        )}

        {/* 网络栈 */}
        <div>
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">{t('tunSettings.stack')}</h3>
          <p className="text-xs text-gray-500 dark:text-gray-300 mb-3">
            {t('tunSettings.stackDesc')}
          </p>
          <div className="flex gap-2">
            <button
              className={`py-1.5 px-3 text-sm rounded-lg transition-colors ${
                config.stack === 'gvisor'
                  ? 'bg-blue-500 text-white shadow-sm'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-[#1f1f1f] dark:text-gray-200 dark:hover:bg-[#2a2a2a]'
              }`}
              onClick={() => updateConfig({ stack: 'gvisor' })}
            >
              gVisor
            </button>
            <button
              className={`py-1.5 px-3 text-sm rounded-lg transition-colors ${
                config.stack === 'mixed'
                  ? 'bg-blue-500 text-white shadow-sm'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-[#1f1f1f] dark:text-gray-200 dark:hover:bg-[#2a2a2a]'
              }`}
              onClick={() => updateConfig({ stack: 'mixed' })}
            >
              {t('tunSettings.mixedRecommended')}
            </button>
            <button
              className={`py-1.5 px-3 text-sm rounded-lg transition-colors ${
                config.stack === 'system'
                  ? 'bg-blue-500 text-white shadow-sm'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-[#1f1f1f] dark:text-gray-200 dark:hover:bg-[#2a2a2a]'
              }`}
              onClick={() => updateConfig({ stack: 'system' })}
            >
              System
            </button>
          </div>
        </div>

        {/* 设备名称 */}
        <div>
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">{t('tunSettings.deviceName')}</h3>
          <p className="text-xs text-gray-500 dark:text-gray-300 mb-3">
            {t('tunSettings.deviceNameDesc')}
          </p>
          <input
            type="text"
            className="w-full py-2 px-3 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200"
            value={config.device}
            placeholder={isMac ? 'utun1500' : 'Mihomo'}
            onChange={(e) => updateConfig({ device: e.target.value })}
          />
        </div>

        {/* MTU */}
        <div>
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">{t('tunSettings.mtu')}</h3>
          <p className="text-xs text-gray-500 dark:text-gray-300 mb-3">
            {t('tunSettings.mtuDesc')}
          </p>
          <input
            type="number"
            className="w-full py-2 px-3 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200"
            value={config.mtu}
            onChange={(e) => updateConfig({ mtu: parseInt(e.target.value) || 1500 })}
          />
        </div>

        {/* DNS 劫持 */}
        <div>
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">{t('tunSettings.dnsHijack')}</h3>
          <p className="text-xs text-gray-500 dark:text-gray-300 mb-3">
            {t('tunSettings.dnsHijackDesc')}
          </p>
          <input
            type="text"
            className="w-full py-2 px-3 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200"
            value={config.dnsHijack.join(', ')}
            placeholder="any:53"
            onChange={(e) =>
              updateConfig({
                dnsHijack: e.target.value.split(',').map((s) => s.trim()).filter(s => s),
              })
            }
          />
        </div>

        {/* 路由选项 */}
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('tunSettings.strictRoute')}</h3>
            <p className="text-xs text-gray-500 dark:text-gray-300 mt-1">{t('tunSettings.strictRouteDesc')}</p>
          </div>
          <Switch
            checked={config.strictRoute}
            onCheckedChange={(checked) => updateConfig({ strictRoute: checked })}
          />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('tunSettings.autoRoute')}</h3>
            <p className="text-xs text-gray-500 dark:text-gray-300 mt-1">{t('tunSettings.autoRouteDesc')}</p>
          </div>
          <Switch
            checked={config.autoRoute}
            onCheckedChange={(checked) => updateConfig({ autoRoute: checked })}
          />
        </div>

        {isLinux && (
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('tunSettings.autoRedirect')}</h3>
              <p className="text-xs text-gray-500 dark:text-gray-300 mt-1">
                {t('tunSettings.autoRedirectDesc')}
              </p>
            </div>
            <Switch
              checked={config.autoRedirect}
              onCheckedChange={(checked) => updateConfig({ autoRedirect: checked })}
            />
          </div>
        )}

        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200">{t('tunSettings.autoDetectInterface')}</h3>
            <p className="text-xs text-gray-500 dark:text-gray-300 mt-1">{t('tunSettings.autoDetectInterfaceDesc')}</p>
          </div>
          <Switch
            checked={config.autoDetectInterface}
            onCheckedChange={(checked) => updateConfig({ autoDetectInterface: checked })}
          />
        </div>

        {/* 排除地址 */}
        <div>
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">{t('tunSettings.excludeAddress')}</h3>
          <p className="text-xs text-gray-500 dark:text-gray-300 mb-3">
            {t('tunSettings.excludeAddressDesc')}
          </p>
          <div className="space-y-2">
            {config.routeExcludeAddress.map((address, index) => (
              <div key={index} className="flex gap-2">
                <input
                  type="text"
                  className="flex-1 py-2 px-3 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2a2a2a] text-gray-700 dark:text-gray-200"
                  value={address}
                  placeholder={t('tunSettings.excludeAddressPlaceholder')}
                  onChange={(e) => handleExcludeAddressChange(index, e.target.value)}
                />
                <button
                  className="py-1.5 px-3 text-sm rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-[#2a2a2a] dark:text-gray-200 dark:hover:bg-[#333333] transition-colors"
                  onClick={() => handleExcludeAddressChange(index, '')}
                >
                  {t('tunSettings.delete')}
                </button>
              </div>
            ))}
            <button
              className="w-full py-1.5 px-3 text-sm rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-[#2a2a2a] dark:text-gray-200 dark:hover:bg-[#333333] transition-colors"
              onClick={handleAddExcludeAddress}
            >
              {t('tunSettings.addExcludeAddress')}
            </button>
          </div>
        </div>

        {/* 保存按钮 */}
        {changed && (
          <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
            <button
              className="py-2 px-4 text-sm rounded-lg bg-blue-500 hover:bg-blue-600 text-white transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={handleSave}
              disabled={loading}
            >
              {loading ? t('tunSettings.saving') : t('tunSettings.saveConfig')}
            </button>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
              {t('tunSettings.configNeedRestart')}
            </p>
          </div>
        )}
      </div>

      <Toast.Root
        open={toastOpen}
        onOpenChange={setToastOpen}
        duration={3000}
        className="fixed bottom-6 right-6 w-80 rounded-2xl shadow-lg backdrop-blur-sm z-[9999] transition-all bg-white/95 dark:bg-[#2a2a2a]/95"
      >
        <div className="p-4">
          <div className="flex items-start gap-3">
            {/* 图标 */}
            <div className={`flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center ${
              toastType === 'success'
                ? 'bg-green-500/10 text-green-600 dark:text-green-400'
                : 'bg-red-500/10 text-red-600 dark:text-red-400'
            }`}>
              {toastType === 'success' ? (
                <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
              ) : (
                <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                </svg>
              )}
            </div>

            {/* 内容 */}
            <div className="flex-1 min-w-0">
              <Toast.Title className="text-sm font-semibold text-foreground mb-1">
                {toastTitle}
              </Toast.Title>
              <Toast.Description className="text-xs text-muted-foreground">
                {toastDescription}
              </Toast.Description>
            </div>

            {/* 关闭按钮 */}
            <Toast.Close asChild>
              <button
                className="flex-shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Close"
              >
                <Cross2Icon className="w-4 h-4" />
              </button>
            </Toast.Close>
          </div>
        </div>
      </Toast.Root>

      <Toast.Viewport />
    </Toast.Provider>
  );
};

export default TunSettings;
