import React, { useState, useEffect, useCallback } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useTranslation } from 'react-i18next';
import { RefreshCw, Copy, Check } from 'lucide-react';
import { showToast } from '@/components/ui/toast';
import { fetchIpInfo, type IpInfo } from '@/utils/ip-info';

interface IpInfoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function IpInfoDialog({ open, onOpenChange }: IpInfoDialogProps) {
  const { t } = useTranslation();
  const [ipInfo, setIpInfo] = useState<IpInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const loadIpInfo = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      setIpInfo(await fetchIpInfo());
      setLoading(false);
    } catch {
      setError(t('ipInfoDialog.fetchError'));
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (open) {
      loadIpInfo();
    }
  }, [open, loadIpInfo]);

  useEffect(() => {
    if (!open || typeof window === 'undefined') return;

    const refreshIpInfo = () => {
      void loadIpInfo();
    };

    window.addEventListener('profile-updated', refreshIpInfo);
    window.addEventListener('backup-restored', refreshIpInfo);
    window.addEventListener('subscription-auto-updated', refreshIpInfo);

    const unsubscribeActiveConfig = window.electronAPI?.onActiveConfigChanged?.(() => {
      refreshIpInfo();
    });
    const unsubscribeAutoUpdated = window.electronAPI?.onSubscriptionAutoUpdated?.(() => {
      refreshIpInfo();
    });
    const unsubscribeNodeChanged = window.electronAPI?.onNodeChanged?.(() => {
      refreshIpInfo();
    });

    return () => {
      window.removeEventListener('profile-updated', refreshIpInfo);
      window.removeEventListener('backup-restored', refreshIpInfo);
      window.removeEventListener('subscription-auto-updated', refreshIpInfo);
      unsubscribeActiveConfig?.();
      unsubscribeAutoUpdated?.();
      unsubscribeNodeChanged?.();
    };
  }, [loadIpInfo, open]);

  const copyToClipboard = useCallback(async (text: string, fieldName: string) => {
    if (!text || text === '--') return;

    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(fieldName);
      showToast({
        message: t('ipInfoDialog.copied', { value: text }),
        type: 'success',
        duration: 2000,
      });
      setTimeout(() => setCopiedField(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }, [t]);

  const InfoRow = ({ label, value, fieldName }: { label: string; value?: string; fieldName: string }) => {
    if (!value) return null;

    const isCopied = copiedField === fieldName;

    return (
      <div
        className="flex items-center justify-between py-2 px-2 cursor-pointer hover:bg-muted/50 rounded-lg transition-colors group"
        onClick={() => copyToClipboard(value, fieldName)}
        title={t('ipInfoDialog.clickToCopy')}
      >
        <span className="text-sm text-muted-foreground">{label}</span>
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{value}</span>
          {isCopied ? (
            <Check className="h-3.5 w-3.5 text-green-500" />
          ) : (
            <Copy className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
          )}
        </div>
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between">
            <span>{t('ipInfoDialog.title')}</span>
            <button
              onClick={loadIpInfo}
              disabled={loading}
              className="rounded-lg p-1.5 transition-colors hover:bg-muted disabled:opacity-50"
              title={t('common.refresh')}
            >
              <RefreshCw className={`h-4 w-4 text-muted-foreground ${loading ? 'animate-spin' : ''}`} />
            </button>
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t('ipInfoDialog.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="mt-2">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-8 gap-3">
              <RefreshCw className="h-8 w-8 animate-spin text-primary" />
              <span className="text-sm text-muted-foreground">{t('ipInfoDialog.loading')}</span>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center py-8 gap-3">
              <span className="text-sm text-destructive">{error}</span>
              <button
                onClick={loadIpInfo}
                className="text-sm text-primary hover:underline"
              >
                {t('ipInfoDialog.retry')}
              </button>
            </div>
          ) : ipInfo ? (
            <div className="space-y-1">
              {/* Exit IP Section */}
              <div className="mb-4">
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
                  {t('ipInfoDialog.exitIp')}
                </h3>
                <div className="bg-muted/30 rounded-xl p-2">
                  <InfoRow
                    label={t('ipInfoDialog.ipAddress')}
                    value={ipInfo.ip}
                    fieldName="ip"
                  />
                  <InfoRow
                    label={t('ipInfoDialog.source')}
                    value={
                      ipInfo.source === 'proxy'
                        ? t('dashboard.proxyExit')
                        : ipInfo.source === 'direct'
                          ? t('dashboard.directExit')
                          : t('dashboard.browserExit')
                    }
                    fieldName="source"
                  />
                  <InfoRow
                    label={t('ipInfoDialog.country')}
                    value={ipInfo.country}
                    fieldName="country"
                  />
                  <InfoRow
                    label={t('ipInfoDialog.region')}
                    value={ipInfo.region}
                    fieldName="region"
                  />
                  <InfoRow
                    label={t('ipInfoDialog.city')}
                    value={ipInfo.city}
                    fieldName="city"
                  />
                  <InfoRow
                    label={t('ipInfoDialog.isp')}
                    value={ipInfo.isp}
                    fieldName="isp"
                  />
                  {ipInfo.org && ipInfo.org !== ipInfo.isp && (
                    <InfoRow
                      label={t('ipInfoDialog.org')}
                      value={ipInfo.org}
                      fieldName="org"
                    />
                  )}
                  <InfoRow
                    label={t('ipInfoDialog.asn')}
                    value={ipInfo.asn}
                    fieldName="asn"
                  />
                  <InfoRow
                    label={t('ipInfoDialog.timezone')}
                    value={ipInfo.timezone}
                    fieldName="timezone"
                  />
                </div>
              </div>

              {/* Hint */}
              <p className="text-xs text-muted-foreground text-center pt-2">
                {t('ipInfoDialog.clickToCopyHint')}
              </p>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
