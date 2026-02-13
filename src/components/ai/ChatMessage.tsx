'use client';

import React, { useState } from 'react';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';
import type { AiMessage } from '@/stores/ai-store';
import type { ToolCallInfo } from '@/services/ai/ai-api-client';
import { ChevronDown, ChevronRight, Copy, Check, Wrench, AlertCircle, Loader2 } from 'lucide-react';

interface ChatMessageProps {
  message: AiMessage;
}

const toolNameMap: Record<string, string> = {
  control_service: '服务控制',
  switch_mode: '切换模式',
  switch_proxy: '切换节点',
  health_check: '延迟测试',
  query_proxies: '查询代理',
  query_connections: '查询连接',
  query_traffic: '查询流量',
  query_settings: '查询设置',
  manage_profiles: '配置管理',
  modify_settings: '修改设置',
  read_config: '读取配置',
  edit_config: '编辑配置',
  validate_config: '验证配置',
  manage_overrides: '覆写管理',
  read_override: '读取覆写',
  edit_override: '编辑覆写',
  manage_proxy_icon_rules: '图标规则',
};

/* ---- Diff preview renderer ---- */

function DiffPreview({ preview }: { preview: string }) {
  const lines = preview.split('\n');
  return (
    <div className="overflow-x-auto text-xs font-mono leading-relaxed selectable-text">
      {lines.map((line, i) => {
        let bg = '';
        let textColor = 'text-foreground/70';
        if (line.startsWith('+ ')) {
          bg = 'bg-green-500/10 dark:bg-green-500/15';
          textColor = 'text-green-700 dark:text-green-400';
        } else if (line.startsWith('- ')) {
          bg = 'bg-red-500/10 dark:bg-red-500/15';
          textColor = 'text-red-700 dark:text-red-400';
        } else if (line.startsWith('@@')) {
          bg = 'bg-blue-500/10 dark:bg-blue-500/15';
          textColor = 'text-blue-600 dark:text-blue-400';
        }
        return (
          <div key={i} className={cn('px-2 min-h-[1.25rem] whitespace-pre', bg, textColor)}>
            {line || ' '}
          </div>
        );
      })}
    </div>
  );
}

/* ---- Tool call item (pill or diff card) ---- */

function ToolCallItem({ tc }: { tc: ToolCallInfo }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const hasDiff = !!tc.preview;

  const statusIcon = tc.status === 'executing'
    ? <Loader2 className="w-3 h-3 animate-spin text-blue-500" />
    : tc.status === 'completed'
      ? <Check className="w-3 h-3 text-green-500" />
      : tc.status === 'failed'
        ? <AlertCircle className="w-3 h-3 text-red-500" />
        : <Wrench className="w-3 h-3 text-muted-foreground" />;

  const statusText = tc.status === 'completed' ? t('ai.toolCompleted')
    : tc.status === 'failed' ? t('ai.toolFailed')
      : tc.status === 'executing' ? t('ai.toolExecuting') : '';

  if (!hasDiff) {
    return (
      <div className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 dark:bg-slate-800/60 px-2.5 py-1 text-xs">
        {statusIcon}
        <span className="font-medium text-foreground/80">{toolNameMap[tc.name] || tc.name}</span>
        {tc.status !== 'pending' && <span className="text-muted-foreground">{statusText}</span>}
      </div>
    );
  }

  return (
    <div className="rounded-lg bg-slate-100 dark:bg-slate-800/60 overflow-hidden text-xs">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 w-full px-2.5 py-1.5 hover:bg-slate-200/60 dark:hover:bg-slate-700/60 transition-colors"
      >
        {statusIcon}
        <span className="font-medium text-foreground/80">{toolNameMap[tc.name] || tc.name}</span>
        {tc.status !== 'pending' && <span className="text-muted-foreground">{statusText}</span>}
        <span className="ml-auto">
          {expanded ? <ChevronDown className="w-3 h-3 text-muted-foreground" /> : <ChevronRight className="w-3 h-3 text-muted-foreground" />}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-slate-200 dark:border-slate-700/50 max-h-64 overflow-y-auto">
          <DiffPreview preview={tc.preview!} />
        </div>
      )}
    </div>
  );
}

/* ---- Main message component ---- */

function ChatMessageInner({ message }: ChatMessageProps) {
  const { t } = useTranslation();
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const isUser = message.role === 'user';
  const isTool = message.role === 'tool';

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* empty */ }
  };

  if (isTool) return null;

  const hasDiffTools = message.toolCalls?.some((tc) => !!tc.preview);

  return (
    <div className={cn('flex gap-3 py-3', isUser ? 'justify-end' : 'justify-start')}>
      <div className={cn('max-w-[85%] min-w-0', isUser ? 'order-1' : 'order-1')}>
        {/* Thinking block */}
        {!isUser && message.thinking && (
          <button
            onClick={() => setThinkingOpen(!thinkingOpen)}
            className="flex items-center gap-1 text-xs text-muted-foreground mb-1 hover:text-foreground transition-colors"
          >
            {thinkingOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            {t('ai.thinking')}
          </button>
        )}
        {!isUser && message.thinking && thinkingOpen && (
          <div className="mb-2 rounded-lg bg-slate-100 dark:bg-slate-800/60 p-3 text-xs text-muted-foreground whitespace-pre-wrap selectable-text">
            {message.thinking}
          </div>
        )}

        {/* Message bubble */}
        <div
          className={cn(
            'rounded-2xl px-4 py-2.5 text-sm leading-relaxed',
            isUser
              ? 'bg-primary text-primary-foreground rounded-br-md'
              : 'bg-muted/60 text-foreground rounded-bl-md'
          )}
        >
          <div className="whitespace-pre-wrap break-words selectable-text">
            {!isUser && !message.content && !message.toolCalls?.length ? (
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <span className="animate-bounce [animation-delay:-0.3s]">.</span>
                <span className="animate-bounce [animation-delay:-0.15s]">.</span>
                <span className="animate-bounce">.</span>
              </span>
            ) : message.content}
          </div>
        </div>

        {/* Tool calls */}
        {!isUser && message.toolCalls && message.toolCalls.length > 0 && (
          <div className={cn('mt-2', hasDiffTools ? 'flex flex-col gap-1.5' : 'flex flex-wrap gap-1.5')}>
            {message.toolCalls.map((tc) => (
              <ToolCallItem key={tc.id} tc={tc} />
            ))}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2 mt-1">
          <span className="text-[10px] text-muted-foreground">
            {new Date(message.timestamp).toLocaleTimeString()}
          </span>
          {!isUser && (
            <button
              onClick={handleCopy}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const ChatMessage = React.memo(ChatMessageInner);
export default ChatMessage;
