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
    device: process.platform === 'darwin' ? 'utun1500' : 'Mihomo',
    stack: 'mixed',
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

  // Toast 状态
  const [toastOpen, setToastOpen] = useState(false);
  const [toastTitle, setToastTitle] = useState('');
  const [toastDescription, setToastDescription] = useState('');
  const [toastType, setToastType] = useState<'success' | 'error'>('success');

  useEffect(() => {
    loadConfig();
  }, []);

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
      } else {
        showToast(t('tunSettings.error'), result.error || t('tunSettings.unknownError'), 'error');
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

  const isMac = process.platform === 'darwin';
  const isLinux = process.platform === 'linux';
  const isWindows = process.platform === 'win32';

  return (
    <Toast.Provider swipeDirection="right">
      <div className="space-y-6">
        {/* 权限设置 */}
        {!isWindows && (
          <div>
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">
              {t('tunSettings.tunPermission')}
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-300 mb-3">
              {isMac && t('tunSettings.tunPermissionDescMac')}
              {isLinux && t('tunSettings.tunPermissionDescLinux')}
            </p>
            <button
              className="py-1.5 px-3 text-sm rounded-lg bg-blue-500 hover:bg-blue-600 text-white transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={handleGrantPermissions}
              disabled={loading}
            >
              {t('tunSettings.grantPermission')}
            </button>
          </div>
        )}

        {isWindows && (
          <div className="p-3 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
            <p className="text-xs text-yellow-800 dark:text-yellow-200">
              {t('tunSettings.windowsAdminRequired')}
            </p>
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
        className={`fixed bottom-4 right-4 p-4 rounded-md shadow-md ${
          toastType === 'success'
            ? 'bg-green-500 text-white'
            : 'bg-red-500 text-white'
        }`}
      >
        <Toast.Title className="font-medium">{toastTitle}</Toast.Title>
        <Toast.Description>{toastDescription}</Toast.Description>
        <Toast.Close asChild>
          <button
            className="absolute top-2 right-2 text-white"
            aria-label="Close"
          >
            <Cross2Icon />
          </button>
        </Toast.Close>
      </Toast.Root>

      <Toast.Viewport />
    </Toast.Provider>
  );
};

export default TunSettings;
