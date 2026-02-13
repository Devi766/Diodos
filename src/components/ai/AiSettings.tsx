'use client';

import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'next/navigation';
import { useAiStore } from '@/stores/ai-store';
import { testConnection, type AiApiConfig, type ApiFormat } from '@/services/ai/ai-api-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { showToast } from '@/components/ui/toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { OpenAIMark, ClaudeMark, OpenAIIcon, ClaudeIcon } from './AiIcons';
import { ArrowLeft, Plus, Trash2, Check, ChevronRight, Loader2, Bot, MessageSquare, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';

type SettingsView = 'main' | 'add' | 'edit' | 'conversation';

export default function AiSettings() {
  const { t } = useTranslation();
  const router = useRouter();
  const store = useAiStore();
  const [view, setView] = useState<SettingsView>('main');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean; title: string; description: string; onConfirm: () => void;
  }>({ open: false, title: '', description: '', onConfirm: () => {} });

  // Form state
  const [format, setFormat] = useState<ApiFormat>('openai');
  const [alias, setAlias] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1');
  const [model, setModel] = useState('gpt-4o');
  const [compatMode, setCompatMode] = useState(false);
  const [testing, setTesting] = useState(false);

  const resetForm = () => {
    setEditingId(null);
    setFormat('openai');
    setAlias('');
    setApiKey('');
    setBaseUrl('https://api.openai.com/v1');
    setModel('gpt-4o');
    setCompatMode(false);
  };

  const openEdit = (config: AiApiConfig) => {
    setEditingId(config.id);
    setFormat(config.format);
    setAlias(config.alias);
    setApiKey(config.apiKey);
    setBaseUrl(config.baseUrl);
    setModel(config.model);
    setCompatMode(config.compatMode);
    setView('edit');
  };

  const openAdd = () => {
    resetForm();
    setView('add');
  };

  const handleFormatChange = (f: ApiFormat) => {
    setFormat(f);
    if (f === 'openai') {
      setBaseUrl('https://api.openai.com/v1');
      setModel('gpt-4o');
    } else {
      setBaseUrl('https://api.anthropic.com');
      setModel('claude-sonnet-4-5-20250514');
    }
  };

  const handleSave = () => {
    if (!apiKey.trim() || !baseUrl.trim() || !model.trim()) {
      showToast({ message: t('ai.fillRequired'), type: 'error' });
      return;
    }
    const config: AiApiConfig = {
      id: editingId || `cfg_${Date.now()}`,
      alias: alias.trim() || model,
      format,
      apiKey: apiKey.trim(),
      baseUrl: baseUrl.trim().replace(/\/+$/, ''),
      model: model.trim(),
      compatMode,
      active: store.apiConfigs.length === 0 && !editingId,
    };
    if (editingId) {
      store.updateApiConfig(editingId, config);
    } else {
      store.addApiConfig(config);
      if (store.apiConfigs.length === 1) store.setActiveConfig(config.id);
    }
    showToast({ message: t('common.success'), type: 'success' });
    setView('main');
  };

  const handleTest = async () => {
    setTesting(true);
    const config: AiApiConfig = {
      id: 'test', alias: '', format,
      apiKey: apiKey.trim(), baseUrl: baseUrl.trim().replace(/\/+$/, ''),
      model: model.trim(), compatMode,
      active: false,
    };
    const result = await testConnection(config);
    setTesting(false);
    showToast({
      message: result.success ? t('ai.testSuccess') : `${t('ai.testFailed')}: ${result.error}`,
      type: result.success ? 'success' : 'error',
    });
  };

  const handleBack = () => {
    if (view === 'main') {
      router.push('/ai-assistant');
    } else {
      setView('main');
    }
  };

  // --- Main view: config list + conversation settings ---
  const renderMain = () => (
    <div className="space-y-5">
      {/* Description card */}
      <div className="rounded-2xl bg-white dark:bg-[#2a2a2a] shadow-sm px-5 py-4 flex items-center gap-4">
        <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
          <Bot className="w-6 h-6 text-primary" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-foreground">{t('ai.title')}</div>
          <div className="text-xs text-muted-foreground mt-0.5">{t('ai.settingsDesc')}</div>
        </div>
      </div>

      {/* Config list section */}
      <div>
        <div className="flex items-center justify-between mb-2 px-1">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{t('ai.apiConfigs')}</span>
          <Button variant="ghost" size="sm" onClick={openAdd} className="gap-1 h-7 text-xs">
            <Plus className="w-3.5 h-3.5" />
            {t('common.add')}
          </Button>
        </div>

        <div className="rounded-2xl bg-white dark:bg-[#2a2a2a] shadow-sm overflow-hidden">
          {store.apiConfigs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 px-4">
              <div className="w-12 h-12 rounded-xl bg-muted/60 flex items-center justify-center mb-3">
                <Bot className="w-6 h-6 text-muted-foreground" />
              </div>
              <div className="text-sm text-muted-foreground">{t('ai.noConfigs')}</div>
              <Button variant="outline" size="sm" onClick={openAdd} className="mt-3 gap-1">
                <Plus className="w-3.5 h-3.5" />
                {t('ai.addConfig')}
              </Button>
            </div>
          ) : (
            <div className="space-y-0">
              {store.apiConfigs.map((config) => (
                <div
                  key={config.id}
                  onClick={() => openEdit(config)}
                  className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-muted/30 transition-colors"
                >
                  {/* Radio */}
                  <button
                    onClick={(e) => { e.stopPropagation(); store.setActiveConfig(config.id); }}
                    className={cn(
                      'w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors',
                      config.active ? 'border-primary bg-primary' : 'border-muted-foreground/40'
                    )}
                  >
                    {config.active && <div className="w-2 h-2 rounded-full bg-white" />}
                  </button>
                  {/* Provider icon */}
                  {config.format === 'claude' ? <ClaudeIcon size={32} /> : <OpenAIIcon size={32} />}
                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-foreground truncate">{config.alias || config.model}</div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="text-xs text-muted-foreground">{config.format === 'claude' ? 'Claude' : 'OpenAI'}</span>
                      {config.active && (
                        <>
                          <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                          <span className="text-xs text-green-600 dark:text-green-400">{t('ai.enabled')}</span>
                        </>
                      )}
                    </div>
                  </div>
                  {/* Delete */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmDialog({
                        open: true,
                        title: t('ai.deleteConfig'),
                        description: t('ai.deleteConfigDesc'),
                        onConfirm: () => {
                          store.deleteApiConfig(config.id);
                          setConfirmDialog((prev) => ({ ...prev, open: false }));
                          showToast({ message: t('common.success'), type: 'success' });
                        },
                      });
                    }}
                    className="p-1.5 rounded-lg text-muted-foreground hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors shrink-0"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Conversation settings section */}
      <div>
        <div className="px-1 mb-2">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{t('ai.chatSettings')}</span>
        </div>
        <div className="rounded-2xl bg-white dark:bg-[#2a2a2a] shadow-sm overflow-hidden">
          <button
            onClick={() => setView('conversation')}
            className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/30 transition-colors"
          >
            <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center shrink-0">
              <MessageSquare className="w-4 h-4 text-blue-500" />
            </div>
            <div className="flex-1 text-left min-w-0">
              <div className="text-sm font-medium text-foreground">{t('ai.chatSettings')}</div>
              <div className="text-xs text-muted-foreground">{t('ai.chatSettingsDesc')}</div>
            </div>
            <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
          </button>
        </div>
      </div>
    </div>
  );

  // --- Add/Edit form view ---
  const renderForm = () => (
    <div className="space-y-5">
      {/* Provider selector */}
      <div>
        <div className="px-1 mb-2">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{t('ai.apiFormat')}</span>
        </div>
        <div className="rounded-2xl bg-white dark:bg-[#2a2a2a] shadow-sm p-3">
          <div className="grid grid-cols-2 gap-3">
            {/* Claude card */}
            <button
              onClick={() => handleFormatChange('claude')}
              className={cn(
                'flex flex-col items-center justify-center gap-2 rounded-xl py-4 px-3 border-2 transition-all',
                format === 'claude'
                  ? 'border-primary bg-primary/5'
                  : 'border-border/40 hover:border-border'
              )}
            >
              <ClaudeMark className="w-7 h-7" style={{ color: '#d97757' }} />
              <span className="text-sm font-semibold text-foreground">Claude</span>
              <span className="text-[10px] text-muted-foreground">Anthropic</span>
            </button>
            {/* OpenAI card */}
            <button
              onClick={() => handleFormatChange('openai')}
              className={cn(
                'flex flex-col items-center justify-center gap-2 rounded-xl py-4 px-3 border-2 transition-all',
                format === 'openai'
                  ? 'border-primary bg-primary/5'
                  : 'border-border/40 hover:border-border'
              )}
            >
              <OpenAIMark className="w-7 h-7" style={{ color: '#10a37f' }} />
              <span className="text-sm font-semibold text-foreground">OpenAI</span>
              <span className="text-[10px] text-muted-foreground">OpenAI</span>
            </button>
          </div>
        </div>
      </div>

      {/* Form fields */}
      <div>
        <div className="px-1 mb-2">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{t('ai.endpointSettings')}</span>
        </div>
        <div className="rounded-2xl bg-white dark:bg-[#2a2a2a] shadow-sm p-4 space-y-4">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">{t('ai.alias')}</label>
            <Input value={alias} onChange={(e) => setAlias(e.target.value)} placeholder={t('ai.aliasPlaceholder')} />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">API Key</label>
            <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-..." />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Base URL</label>
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">{t('ai.model')}</label>
            <Input value={model} onChange={(e) => setModel(e.target.value)} />
          </div>

          {/* Compat mode */}
          <div className="flex items-center justify-between pt-2">
            <div>
              <div className="text-sm font-medium text-foreground">{t('ai.compatMode')}</div>
              <div className="text-xs text-muted-foreground mt-0.5">{t('ai.compatModeDesc')}</div>
            </div>
            <Switch checked={compatMode} onCheckedChange={setCompatMode} />
          </div>
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex gap-3">
        <Button variant="outline" onClick={handleTest} disabled={testing || !apiKey || !baseUrl} className="flex-1 h-10">
          {testing ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : null}
          {t('ai.testConnection')}
        </Button>
        <Button variant="primary" onClick={handleSave} className="flex-1 h-10">
          {t('common.save')}
        </Button>
      </div>
    </div>
  );

  // --- Conversation settings view ---
  const renderConversation = () => (
    <div className="space-y-5">
      {/* Retry settings */}
      <div>
        <div className="px-1 mb-2">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{t('ai.retrySettings')}</span>
        </div>
        <div className="rounded-2xl bg-white dark:bg-[#2a2a2a] shadow-sm overflow-hidden">
          <div className="flex items-center gap-3 px-4 py-3">
            <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center shrink-0">
              <RefreshCw className="w-4 h-4 text-blue-500" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-foreground">{t('ai.autoRetry')}</div>
              <div className="text-xs text-muted-foreground">{t('ai.autoRetryDesc')}</div>
            </div>
            <Switch
              checked={store.settings.autoRetry}
              onCheckedChange={(v) => store.updateSettings({ autoRetry: v })}
            />
          </div>
          <div className="mx-4" />
          <div className={cn('flex items-center gap-3 px-4 py-3', !store.settings.autoRetry && 'opacity-50')}>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-foreground">{t('ai.maxRetries')}</div>
            </div>
            <select
              disabled={!store.settings.autoRetry}
              value={store.settings.maxRetries}
              onChange={(e) => store.updateSettings({ maxRetries: Number(e.target.value) })}
              className="text-sm bg-muted/50 border border-border/50 rounded-lg px-2 py-1 text-foreground"
            >
              {[1, 2, 3, 5, 10].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Data management */}
      <div>
        <div className="px-1 mb-2">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{t('ai.dataManagement')}</span>
        </div>
        <div className="rounded-2xl bg-white dark:bg-[#2a2a2a] shadow-sm overflow-hidden">
          <button
            onClick={() => {
              setConfirmDialog({
                open: true,
                title: t('ai.deleteAllConversations'),
                description: t('ai.deleteAllConversationsDesc'),
                onConfirm: () => {
                  store.clearAllConversations();
                  setConfirmDialog((prev) => ({ ...prev, open: false }));
                  showToast({ message: t('common.success'), type: 'success' });
                },
              });
            }}
            className="w-full flex items-center gap-3 px-4 py-3 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors"
          >
            <div className="w-8 h-8 rounded-lg bg-red-500/10 flex items-center justify-center shrink-0">
              <Trash2 className="w-4 h-4 text-red-500" />
            </div>
            <div className="flex-1 text-left min-w-0">
              <div className="text-sm font-medium text-red-600 dark:text-red-400">{t('ai.deleteAllConversations')}</div>
              <div className="text-xs text-muted-foreground">{t('ai.deleteAllConversationsDesc')}</div>
            </div>
          </button>
        </div>
      </div>
    </div>
  );

  const viewTitle = {
    main: t('ai.settingsTitle'),
    add: t('ai.addConfig'),
    edit: t('ai.editConfig'),
    conversation: t('ai.chatSettings'),
  }[view];

  return (
    <div className="space-y-4 min-w-0">
      {/* Header with back button */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleBack}
          className="p-1.5 rounded-lg hover:bg-muted/60 transition-colors text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1 className="text-2xl font-semibold text-foreground">{viewTitle}</h1>
      </div>

      {view === 'main' && renderMain()}
      {(view === 'add' || view === 'edit') && renderForm()}
      {view === 'conversation' && renderConversation()}

      <ConfirmDialog
        open={confirmDialog.open}
        title={confirmDialog.title}
        description={confirmDialog.description}
        confirmText={t('common.confirm')}
        cancelText={t('common.cancel')}
        onConfirm={confirmDialog.onConfirm}
        onCancel={() => setConfirmDialog((prev) => ({ ...prev, open: false }))}
      />
    </div>
  );
}

