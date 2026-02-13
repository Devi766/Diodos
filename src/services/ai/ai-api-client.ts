import { parseOpenAIStream, parseClaudeStream, parseXmlToolCalls, type StreamDelta } from './ai-stream-parser';

export type ApiFormat = 'openai' | 'claude';

export interface AiApiConfig {
  id: string;
  alias: string;
  format: ApiFormat;
  apiKey: string;
  baseUrl: string;
  model: string;
  compatMode: boolean; // XML tool call compatibility
  active: boolean;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCallInfo[];
  thinking?: string;
}

export interface ToolCallInfo {
  id: string;
  name: string;
  arguments: string;
  status: 'pending' | 'executing' | 'completed' | 'failed';
  result?: string;
  preview?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

function buildOpenAIBody(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  model: string,
  compatMode: boolean
) {
  const body: any = {
    model,
    messages: messages.map((m) => {
      const msg: any = { role: m.role, content: m.content };
      if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
      if (m.tool_calls && m.tool_calls.length > 0) {
        msg.tool_calls = m.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        }));
      }
      return msg;
    }),
    stream: true,
  };

  if (tools.length > 0 && !compatMode) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }

  return body;
}

function buildClaudeBody(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  model: string,
  compatMode: boolean
) {
  // Separate system message
  let systemPrompt = '';
  const claudeMessages: any[] = [];

  for (const m of messages) {
    if (m.role === 'system') {
      systemPrompt += (systemPrompt ? '\n' : '') + m.content;
      continue;
    }
    if (m.role === 'tool') {
      claudeMessages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.tool_call_id,
            content: m.content,
          },
        ],
      });
      continue;
    }
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      const content: any[] = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const tc of m.tool_calls) {
        let input: any = {};
        try { input = JSON.parse(tc.arguments); } catch { /* empty */ }
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
      }
      claudeMessages.push({ role: 'assistant', content });
      continue;
    }
    claudeMessages.push({ role: m.role, content: m.content });
  }

  const body: any = {
    model,
    messages: claudeMessages,
    max_tokens: 8192,
    stream: true,
  };

  if (systemPrompt) body.system = systemPrompt;

  if (tools.length > 0 && !compatMode) {
    body.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }

  return body;
}

/** Check if IPC proxy is available (Electron environment) */
function hasProxy(): boolean {
  return !!(window as any).electronAPI?.aiProxyStreamStart;
}

/**
 * Create a ReadableStreamDefaultReader that receives raw bytes from IPC events.
 * Listeners are set up BEFORE the HTTP request starts to avoid race conditions.
 */
function createIpcReader(requestId: string): {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  cleanup: () => void;
} {
  const api = (window as any).electronAPI!;
  let cleanupFns: Array<() => void> = [];

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      cleanupFns.push(api.onAiProxyStreamChunk((rid: string, chunk: any) => {
        if (rid === requestId) {
          controller.enqueue(new Uint8Array(chunk));
        }
      }));
      cleanupFns.push(api.onAiProxyStreamEnd((rid: string) => {
        if (rid === requestId) {
          try { controller.close(); } catch { /* already closed */ }
          cleanupAll();
        }
      }));
      cleanupFns.push(api.onAiProxyStreamError((rid: string, error: string) => {
        if (rid === requestId) {
          try { controller.error(new Error(error)); } catch { /* already closed */ }
          cleanupAll();
        }
      }));
    },
  });

  function cleanupAll() {
    cleanupFns.forEach((fn) => fn());
    cleanupFns = [];
  }

  return { reader: stream.getReader(), cleanup: cleanupAll };
}

export async function* streamChat(
  config: AiApiConfig,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  signal?: AbortSignal
): AsyncGenerator<StreamDelta> {
  const isOpenAI = config.format === 'openai';

  const base = config.baseUrl.replace(/\/+$/, '');
  const url = isOpenAI
    ? (base.endsWith('/chat/completions') ? base : `${base}/chat/completions`)
    : `${base}/v1/messages`;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (isOpenAI) {
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  } else {
    headers['x-api-key'] = config.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  }

  // Inject tool descriptions into system prompt for compat mode
  let effectiveMessages = messages;
  if (config.compatMode && tools.length > 0) {
    const toolsDesc = tools
      .map((t) => `<tool>\n${JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }, null, 2)}\n</tool>`)
      .join('\n');
    const compatSystemMsg: ChatMessage = {
      role: 'system',
      content: `You have access to the following tools. To use a tool, respond with:\n<tool_call>\n{"name": "tool_name", "arguments": {...}}\n</tool_call>\n\nAvailable tools:\n${toolsDesc}`,
    };
    const origSystem = messages.filter((m) => m.role === 'system');
    effectiveMessages = [...origSystem, compatSystemMsg, ...messages.filter((m) => m.role !== 'system')];
  }

  const bodyObj = isOpenAI
    ? buildOpenAIBody(effectiveMessages, tools, config.model, config.compatMode)
    : buildClaudeBody(effectiveMessages, tools, config.model, config.compatMode);
  const bodyStr = JSON.stringify(bodyObj);

  // ---- Obtain a reader (IPC proxy or direct fetch) ----
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  let ipcCleanup: (() => void) | undefined;

  if (hasProxy()) {
    // Route through Electron main process – no CORS restrictions
    const requestId = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Set up chunk listeners BEFORE starting the request
    const ipc = createIpcReader(requestId);
    reader = ipc.reader;
    ipcCleanup = ipc.cleanup;

    // Wire abort signal
    if (signal) {
      signal.addEventListener('abort', () => {
        (window as any).electronAPI?.aiProxyStreamAbort(requestId);
        ipcCleanup?.();
      }, { once: true });
    }

    const res = await (window as any).electronAPI!.aiProxyStreamStart({
      url, method: 'POST', headers, body: bodyStr, requestId, timeout: 60000,
    });

    if (!res.ok) {
      ipcCleanup();
      throw new Error(`API error ${res.status}: ${res.errorBody || ''}`);
    }
  } else {
    // Fallback: direct fetch (works for CORS-friendly endpoints)
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), 60_000);
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;

    let response: Response;
    try {
      response = await fetch(url, { method: 'POST', headers, body: bodyStr, signal: combinedSignal });
    } catch (e: any) {
      clearTimeout(timeoutId);
      if (timeoutController.signal.aborted && !signal?.aborted) {
        throw new Error('请求超时，请检查网络连接');
      }
      throw e;
    }
    clearTimeout(timeoutId);

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`API error ${response.status}: ${errText || response.statusText}`);
    }
    if (!response.body) throw new Error('No response body');
    reader = response.body.getReader();
  }

  // ---- Parse the stream ----
  const parser = isOpenAI ? parseOpenAIStream(reader) : parseClaudeStream(reader);

  let fullText = '';
  try {
    for await (const delta of parser) {
      if (delta.type === 'text') fullText += delta.content || '';
      yield delta;
    }
  } finally {
    ipcCleanup?.();
  }

  // Check for XML tool calls in compat mode
  if (config.compatMode && fullText) {
    const xmlTools = parseXmlToolCalls(fullText);
    if (xmlTools) {
      for (const tc of xmlTools) {
        yield {
          type: 'tool_call_done',
          toolCall: {
            id: `compat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        };
      }
    }
  }
}

export async function testConnection(config: AiApiConfig): Promise<{ success: boolean; error?: string }> {
  try {
    const isOpenAI = config.format === 'openai';

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (isOpenAI) {
      headers['Authorization'] = `Bearer ${config.apiKey}`;
    } else {
      headers['x-api-key'] = config.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    }

    if (isOpenAI) {
      const base = config.baseUrl.replace(/\/+$/, '');
      const root = base.endsWith('/chat/completions')
        ? base.slice(0, -'/chat/completions'.length)
        : base;
      const url = `${root}/models`;

      if (hasProxy()) {
        const res = await (window as any).electronAPI!.aiProxyFetch({ url, method: 'GET', headers, timeout: 10000 });
        if (!res.ok) throw new Error(`${res.status}`);
      } else {
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      }
      return { success: true };
    } else {
      const url = `${config.baseUrl.replace(/\/+$/, '')}/v1/messages`;
      const body = JSON.stringify({ model: config.model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });

      if (hasProxy()) {
        const res = await (window as any).electronAPI!.aiProxyFetch({ url, method: 'POST', headers, body, timeout: 15000 });
        if (!res.ok) throw new Error(`${res.status} ${res.body || ''}`);
      } else {
        const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(15000) });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`${res.status} ${text || res.statusText}`);
        }
      }
      return { success: true };
    }
  } catch (e: any) {
    return { success: false, error: e.message || String(e) };
  }
}

