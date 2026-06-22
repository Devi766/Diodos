'use client';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Activity, AlertCircle, Gauge, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

type SpeedtestData = {
  download?: number;
  downloadSpeed?: number;
  upload?: number;
  uploadSpeed?: number;
  ping?: number;
  jitter?: number;
  server?: {
    host?: string;
    name?: string;
    country?: string;
  };
};

const TAURI_RUNTIME_UNAVAILABLE = 'Tauri runtime is not available';

export default function SpeedtestPage() {
  const { t } = useTranslation();
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<SpeedtestData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runTest = async () => {
    setRunning(true);
    setProgress(12);
    setError(null);
    setResult(null);

    let progressTimer: number | undefined;

    try {
      progressTimer = window.setInterval(() => {
        setProgress((value) => Math.min(value + 12, 88));
      }, 350);

      const api = window.electronAPI;
      if (!api?.runSpeedtestDirect) {
        throw new Error(TAURI_RUNTIME_UNAVAILABLE);
      }

      const response = await api.runSpeedtestDirect();

      if (!response?.success) {
        throw new Error(response?.error || t('tools.speedtest.unknownError'));
      }

      if (!response.data) {
        throw new Error(t('tools.speedtest.noResult'));
      }

      setProgress(100);
      setResult(response.data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err || '');
      setProgress(0);
      setError(
        message === TAURI_RUNTIME_UNAVAILABLE
          ? t('tools.speedtest.unavailable')
          : message || t('tools.speedtest.unknownError'),
      );
    } finally {
      if (progressTimer) {
        window.clearInterval(progressTimer);
      }
      setRunning(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">{t('tools.speedtest.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('tools.speedtest.description')}</p>
        </div>
        <Button onClick={runTest} disabled={running} className="gap-2">
          {running ? <Activity className="h-4 w-4 animate-pulse" /> : <Gauge className="h-4 w-4" />}
          {running ? t('tools.speedtest.testingDownload') : t('tools.speedtest.start')}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('tools.speedtest.dialogTitle')}</CardTitle>
          <CardDescription>{t('tools.speedtest.dialogDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <Progress value={progress} className="h-2" />

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
              <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <Metric label={t('tools.speedtest.downloadSpeed')} value={`${formatNumber(speedValue(result?.download, result?.downloadSpeed))} Mbps`} />
            <Metric label={t('tools.speedtest.uploadSpeed')} value={`${formatNumber(speedValue(result?.upload, result?.uploadSpeed))} Mbps`} />
            <Metric label={t('tools.speedtest.ping')} value={`${formatNumber(result?.ping, 0)} ms`} />
            <Metric label={t('tools.speedtest.jitter')} value={`${formatNumber(result?.jitter, 0)} ms`} />
          </div>

          {result?.server && (
            <div className="rounded-lg bg-muted/40 p-4 text-sm text-muted-foreground">
              {result.server.name || result.server.host || 'Unknown'}
              {result.server.country ? `, ${result.server.country}` : ''}
            </div>
          )}

          {result && (
            <Button variant="outline" onClick={runTest} className="gap-2">
              <RotateCcw className="h-4 w-4" />
              {t('tools.speedtest.retest')}
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-background p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-2 text-xl font-semibold text-foreground">{value}</div>
    </div>
  );
}

function formatNumber(value?: number, digits = 2) {
  if (!Number.isFinite(value)) return '0';
  return Number(value).toFixed(digits);
}

function speedValue(primary?: number, fallback?: number) {
  return Number.isFinite(primary) ? primary : fallback;
}
