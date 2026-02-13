'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';
import { useAiStore, type AiMessage } from '@/stores/ai-store';
import { useMihomoAPI } from '@/services/mihomo-api';
import { streamChat, type ChatMessage as ApiChatMessage } from '@/services/ai/ai-api-client';
import { aiToolDefinitions, executeTool } from '@/services/ai/ai-tools';
import ChatMessage from './ChatMessage';
import ConversationList from './ConversationList';
import { Bot, Send, Square, Settings, MessageSquarePlus, List, Activity, Globe, BarChart3, FileCode } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { OpenAIIcon, ClaudeIcon } from './AiIcons';

const SYSTEM_PROMPT = `You are FlyClash AI Assistant, helping users manage their proxy service and configuration.

## Config File Editing (Core Feature)

Use Claude Code-style Edit mode to edit config files:

### 1. read_config - Read config
Read config file content, supports pagination (offset/limit) and reading by section (section: proxies/proxy-groups/rules/dns/general).
**You must read the config before modifying it to understand the current content and format.**

### 2. edit_config - Edit config
Edit config file using exact string replacement:
- old_string: original text to replace (must exactly match the config, including indentation)
- new_string: replacement text (can be empty to delete)
- Compatibility: use anchor instead of old_string (anchor must also uniquely match); or use mode=insert_before/insert_after + anchor + insert to insert before/after anchor
- YAML format is validated after edit, invalid format will be rolled back

### 3. validate_config - Validate config
Validate YAML format of config file.

## Config Editing Workflow

1. First use read_config to read the config file
2. Find the part to modify, copy the original text as old_string
   - If old_string is hard to match, use anchor instead (must also be exact and unique)
3. Write the modified text as new_string
4. Call edit_config to perform the replacement

## Editing Examples

Change port:
old_string: "mixed-port: 7890"
new_string: "mixed-port: 7891"

Add rule (insert before existing rule):
old_string: "rules:\\n  - DOMAIN-SUFFIX,google.com,PROXY"
new_string: "rules:\\n  - DOMAIN-SUFFIX,github.com,PROXY\\n  - DOMAIN-SUFFIX,google.com,PROXY"

Delete node:
old_string: "  - name: old-node\\n    type: ss\\n    server: 1.2.3.4\\n    port: 443"
new_string: ""

### Handling Empty Lists (Important!)

When adding content to an empty list (e.g. empty proxy-groups):
1. Find the empty list key as anchor (e.g. "proxy-groups: []" or "proxy-groups:\\n")
2. Use anchor as old_string, add content as new_string

Example - Add group to empty proxy-groups:
old_string: "proxy-groups: []"
new_string: "proxy-groups:\\n  - name: Gemini\\n    type: select\\n    proxies: []"

## Service Control Tools

- control_service: Start/stop/query service (action: start/stop/restart/status)
- switch_proxy: Switch node (group_name, proxy_name)
- switch_mode: Switch mode (mode: rule/global/direct)
- health_check: Node latency test

## Query Tools

- query_proxies: Query proxy groups and nodes
- query_connections: Query connection info
- query_traffic: Query traffic statistics
- query_settings: Query settings

## Config Management Tools

- manage_profiles: Profile management (list/activate/update/create/delete)
- modify_settings: Modify app settings

## Usage Principles

1. **Read before modify**: Always use read_config to read current content before modifying config
2. **Exact match**: old_string must exactly match config file content (including indentation and newlines)
3. **Keep format**: YAML is format-sensitive, pay attention to indentation (usually 2 spaces)
4. **Concise replies**: Briefly describe results after operations
5. **One edit at a time**: Only call edit_config ONCE per response. If you need multiple edits, do one edit, wait for the result, then do the next in a new response.
6. **Respond in the same language as the user**`;

function generateMsgId() {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

const DIFF_TOOLS = new Set(['edit_config', 'edit_override']);

function buildDiffPreview(toolName: string, rawArgs: string): string | undefined {
  if (!DIFF_TOOLS.has(toolName)) return undefined;
  try {
    const args = JSON.parse(rawArgs);
    const mode = args.mode || 'replace';
    const oldStr: string | undefined = args.old_string ?? args.anchor;
    const newStr: string | undefined = args.new_string;
    const insert: string | undefined = args.insert;

    if (mode === 'insert_before' && oldStr && insert) {
      const lines: string[] = [`@@ ${toolName} mode=insert_before`];
      insert.split('\n').forEach((l: string) => lines.push(`+ ${l}`));
      oldStr.split('\n').forEach((l: string) => lines.push(`  ${l}`));
      return lines.join('\n');
    }
    if (mode === 'insert_after' && oldStr && insert) {
      const lines: string[] = [`@@ ${toolName} mode=insert_after`];
      oldStr.split('\n').forEach((l: string) => lines.push(`  ${l}`));
      insert.split('\n').forEach((l: string) => lines.push(`+ ${l}`));
      return lines.join('\n');
    }
    if (oldStr && newStr !== undefined) {
      const lines: string[] = [`@@ ${toolName} mode=replace`];
      oldStr.split('\n').forEach((l: string) => lines.push(`- ${l}`));
      if (newStr) {
        newStr.split('\n').forEach((l: string) => lines.push(`+ ${l}`));
      } else {
        lines.push('+ (deleted)');
      }
      return lines.join('\n');
    }
  } catch { /* JSON parse failed, no preview */ }
  return undefined;
}

export default function AiAssistant() {
  const { t } = useTranslation();
  const router = useRouter();
  const mihomoAPI = useMihomoAPI();
  const store = useAiStore();
  const [input, setInput] = useState('');
  const [convListOpen, setConvListOpen] = useState(false);
  const [noConfigDialogOpen, setNoConfigDialogOpen] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const messages = store.getCurrentMessages();
  const activeConfig = store.getActiveConfig();

  useEffect(() => {
    if (autoScroll && messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, autoScroll]);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 100);
  }, []);

  const toApiMessages = useCallback((msgs: AiMessage[]): ApiChatMessage[] => {
    const apiMsgs: ApiChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];
    // Collect tool_call IDs that have matching tool result messages
    const toolResultIds = new Set(
      msgs.filter((m) => m.role === 'tool' && m.toolCallId).map((m) => m.toolCallId!)
    );
    for (const m of msgs) {
      if (m.role === 'tool') {
        apiMsgs.push({ role: 'tool', content: m.content, tool_call_id: m.toolCallId });
      } else if (m.role === 'assistant') {
        // Only include tool_calls that have a matching tool result to avoid API 400 errors
        const validToolCalls = m.toolCalls?.filter((tc) => toolResultIds.has(tc.id));
        apiMsgs.push({
          role: 'assistant',
          content: m.content,
          tool_calls: validToolCalls && validToolCalls.length > 0 ? validToolCalls : undefined,
          thinking: m.thinking,
        });
      } else {
        apiMsgs.push({ role: m.role as any, content: m.content });
      }
    }
    return apiMsgs;
  }, []);

  const MAX_TOOL_ROUNDS = 10;

  const log = (...args: any[]) => window.electronAPI?.debugLog?.(...args);

  const processStream = useCallback(async (abortController: AbortController, depth = 0) => {
    if (!activeConfig) return;
    if (depth >= MAX_TOOL_ROUNDS) {
      store.addMessage({ id: generateMsgId(), role: 'assistant', content: '⚠️ 工具调用轮次已达上限，已停止继续执行。', timestamp: Date.now() });
      return;
    }
    const psStart = performance.now();
    log(`>>> processStream depth=${depth} START`);

    const t0 = performance.now();
    const currentMsgs = store.getCurrentMessages();
    const apiMessages = toApiMessages(currentMsgs);
    log(`toApiMessages: ${(performance.now() - t0).toFixed(1)}ms, msgs=${currentMsgs.length}, apiMsgs=${apiMessages.length}, chars=${JSON.stringify(apiMessages).length}`);

    const assistantMsgId = generateMsgId();
    store.addMessage({ id: assistantMsgId, role: 'assistant', content: '', timestamp: Date.now() });

    let fullContent = '';
    let fullThinking = '';
    const pendingToolCalls: Array<{ id: string; name: string; arguments: string }> = [];

    const t1 = performance.now();
    const stream = streamChat(activeConfig, apiMessages, aiToolDefinitions, abortController.signal);

    let tokenCount = 0;
    for await (const delta of stream) {
      if (delta.type === 'text') {
        fullContent += delta.content || '';
        tokenCount++;
        store.updateMessage(assistantMsgId, { content: fullContent });
      } else if (delta.type === 'thinking') {
        fullThinking += delta.content || '';
        store.updateMessage(assistantMsgId, { thinking: fullThinking });
      } else if (delta.type === 'tool_call_done' && delta.toolCall) {
        pendingToolCalls.push(delta.toolCall);
      } else if (delta.type === 'error') {
        store.updateMessage(assistantMsgId, { content: fullContent + `\n\n⚠️ ${delta.error}` });
      }
    }
    log(`streamChat: ${(performance.now() - t1).toFixed(1)}ms, ${tokenCount} text deltas, ${pendingToolCalls.length} tool calls`);

    if (pendingToolCalls.length > 0) {
      const toolCallInfos = pendingToolCalls.map((tc) => ({
        id: tc.id, name: tc.name, arguments: tc.arguments, status: 'pending' as const,
        preview: buildDiffPreview(tc.name, tc.arguments),
      }));
      store.updateMessage(assistantMsgId, { toolCalls: toolCallInfos });

      // Track mutated resources so duplicate writes in the same batch are skipped.
      // Key = resource identifier (e.g. "config", "override:<id>")
      const mutated = new Set<string>();
      const MUTATING_TOOLS: Record<string, (args: Record<string, any>) => string> = {
        edit_config: () => 'config',
        edit_override: (a) => `override:${a.id || a.name || ''}`,
      };

      const updateToolStatus = (id: string, status: 'executing' | 'completed' | 'failed', result?: string) => {
        const updated = toolCallInfos.map((t) => t.id === id ? { ...t, status, result } : t);
        store.updateMessage(assistantMsgId, { toolCalls: updated });
      };

      for (const tc of toolCallInfos) {
        let args: Record<string, any> = {};
        try { args = JSON.parse(tc.arguments); } catch { /* empty */ }

        // Check if this tool mutates a resource that was already modified this batch
        const resourceKeyFn = MUTATING_TOOLS[tc.name];
        if (resourceKeyFn) {
          const key = resourceKeyFn(args);
          if (mutated.has(key)) {
            log(`tool ${tc.name}: skipped (resource "${key}" already mutated this batch)`);
            updateToolStatus(tc.id, 'completed', '已跳过');
            store.addMessage({
              id: generateMsgId(), role: 'tool', toolCallId: tc.id, timestamp: Date.now(),
              content: '已跳过：该资源已在本轮被修改，请重新读取后再次编辑',
            });
            continue;
          }
        }

        log(`tool ${tc.name}: start executing`);
        const toolStart = performance.now();
        updateToolStatus(tc.id, 'executing');
        try {
          const result = await executeTool(tc.name, args, mihomoAPI);
          log(`tool ${tc.name}: ${result.success ? 'ok' : 'fail'}, ${(performance.now() - toolStart).toFixed(1)}ms, resultLen=${result.content.length}`);
          // Mark resource as mutated on success
          if (result.success && resourceKeyFn) {
            mutated.add(resourceKeyFn(args));
          }
          updateToolStatus(tc.id, result.success ? 'completed' : 'failed', result.content);
          store.addMessage({ id: generateMsgId(), role: 'tool', content: result.content, toolCallId: tc.id, timestamp: Date.now() });
        } catch (e: any) {
          log(`tool ${tc.name}: ERROR ${(performance.now() - toolStart).toFixed(1)}ms`, e.message);
          updateToolStatus(tc.id, 'failed', e.message);
          store.addMessage({ id: generateMsgId(), role: 'tool', content: JSON.stringify({ error: e.message }), toolCallId: tc.id, timestamp: Date.now() });
        }
      }
      log(`>>> processStream depth=${depth} DONE tools, total=${(performance.now() - psStart).toFixed(1)}ms, yielding...`);
      await new Promise((r) => setTimeout(r, 0));
      await processStream(abortController, depth + 1);
    } else {
      log(`>>> processStream depth=${depth} DONE (no tools), total=${(performance.now() - psStart).toFixed(1)}ms`);
    }
  }, [activeConfig, store, toApiMessages, mihomoAPI]);

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || store.isStreaming) return;
    if (!activeConfig) {
      setNoConfigDialogOpen(true);
      return;
    }
    if (!store.currentConversationId) store.createConversation();
    store.addMessage({ id: generateMsgId(), role: 'user', content: text.trim(), timestamp: Date.now() });
    setInput('');
    if (textareaRef.current) textareaRef.current.style.height = '42px';
    const conv = store.conversations.find((c) => c.id === store.currentConversationId);
    if (conv && !conv.title) {
      store.updateConversationTitle(conv.id, text.trim().slice(0, 30) + (text.trim().length > 30 ? '...' : ''));
    }
    const abortController = new AbortController();
    store.setAbortController(abortController);
    store.setStreaming(true);
    try {
      await processStream(abortController);
    } catch (e: any) {
      if (e.name !== 'AbortError') {
        store.addMessage({ id: generateMsgId(), role: 'assistant', content: `${t('ai.error')}: ${e.message}`, timestamp: Date.now() });
      }
    } finally {
      store.setStreaming(false);
      store.setAbortController(null);
    }
  }, [activeConfig, store, t, processStream, router]);

  const quickActions = [
    { label: t('ai.quickStatus'), text: t('ai.quickStatusPrompt'), icon: Activity },
    { label: t('ai.quickProxies'), text: t('ai.quickProxiesPrompt'), icon: Globe },
    { label: t('ai.quickTraffic'), text: t('ai.quickTrafficPrompt'), icon: BarChart3 },
    { label: t('ai.quickConfig'), text: t('ai.quickConfigPrompt'), icon: FileCode },
  ];

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(input); }
  };

  return (
    <div className="rounded-2xl bg-white dark:bg-[#2a2a2a] shadow-sm flex flex-col h-full overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2.5 shrink-0">
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="sm" onClick={() => setConvListOpen(true)} className="gap-1.5 h-8">
            <List className="w-4 h-4" />
            <span className="hidden sm:inline text-xs">{t('ai.conversations')}</span>
          </Button>
          <Button variant="ghost" size="sm" onClick={() => { store.createConversation(); setInput(''); }} className="h-8 w-8 p-0">
            <MessageSquarePlus className="w-4 h-4" />
          </Button>
        </div>
        <div className="flex items-center gap-1.5">
          {activeConfig && (
            <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-slate-50 dark:bg-slate-800/50">
              {activeConfig.format === 'claude'
                ? <ClaudeIcon size={20} />
                : <OpenAIIcon size={20} />
              }
              <span className="text-xs text-muted-foreground max-w-[120px] truncate">
                {activeConfig.alias || activeConfig.model}
              </span>
            </div>
          )}
          <Button variant="ghost" size="sm" onClick={() => router.push('/ai-settings')} className="h-8 w-8 p-0">
            <Settings className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Messages area */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto custom-scrollbar px-4 py-3 min-h-0"
      >
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center px-4">
            <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mb-4">
              <Bot className="w-8 h-8 text-primary" />
            </div>
            <h3 className="text-lg font-semibold text-foreground mb-2">{t('ai.welcome')}</h3>
            <p className="text-sm text-muted-foreground mb-6 max-w-md">{t('ai.welcomeDesc')}</p>
            <div className="flex flex-wrap justify-center gap-2">
              {quickActions.map((action) => (
                <button
                  key={action.label}
                  onClick={() => sendMessage(action.text)}
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-slate-800/60 hover:bg-slate-100 dark:hover:bg-slate-700/60 text-sm text-foreground transition-colors border border-slate-200 dark:border-slate-700"
                >
                  <action.icon className="w-3.5 h-3.5 text-primary" />
                  {action.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {messages.map((msg) => <ChatMessage key={msg.id} message={msg} />)}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* Quick actions strip */}
      {messages.length > 0 && !store.isStreaming && (
        <div className="flex gap-1.5 px-4 py-1.5 overflow-x-auto shrink-0">
          {quickActions.map((action) => (
            <button
              key={action.label}
              onClick={() => sendMessage(action.text)}
              className="shrink-0 px-2.5 py-1 rounded-lg bg-slate-50 dark:bg-slate-800/50 hover:bg-slate-100 dark:hover:bg-slate-700/50 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {action.label}
            </button>
          ))}
        </div>
      )}

      {/* Input area */}
      <div className="px-4 py-3 shrink-0">
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              // Auto-resize
              const el = e.target;
              el.style.height = 'auto';
              el.style.height = Math.min(el.scrollHeight, 128) + 'px';
            }}
            onKeyDown={handleKeyDown}
            placeholder={t('ai.inputPlaceholder')}
            rows={1}
            className="flex-1 resize-none rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 custom-scrollbar"
            style={{ minHeight: '42px', maxHeight: '128px' }}
          />
          {store.isStreaming ? (
            <Button variant="destructive" size="sm" onClick={() => store.stopGeneration()} className="h-[42px] w-[42px] rounded-xl p-0">
              <Square className="w-4 h-4" />
            </Button>
          ) : (
            <Button variant="primary" size="sm" onClick={() => sendMessage(input)} disabled={!input.trim() || !activeConfig} className="h-[42px] w-[42px] rounded-xl p-0">
              <Send className="w-4 h-4" />
            </Button>
          )}
        </div>
      </div>

      <ConversationList open={convListOpen} onOpenChange={setConvListOpen} />
      <ConfirmDialog
        open={noConfigDialogOpen}
        title={t('ai.noApiConfig')}
        description={t('ai.noApiConfigDesc')}
        confirmText={t('ai.goSettings')}
        cancelText={t('common.cancel')}
        onConfirm={() => { setNoConfigDialogOpen(false); router.push('/ai-settings'); }}
        onCancel={() => setNoConfigDialogOpen(false)}
      />
    </div>
  );
}
