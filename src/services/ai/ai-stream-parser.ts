// SSE stream parser for OpenAI and Claude formats

export interface StreamDelta {
  type: 'text' | 'thinking' | 'tool_call' | 'tool_call_done' | 'done' | 'error';
  content?: string;
  toolCall?: {
    id: string;
    name: string;
    arguments: string;
  };
  error?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export async function* parseOpenAIStream(
  reader: ReadableStreamDefaultReader<Uint8Array>
): AsyncGenerator<StreamDelta> {
  const decoder = new TextDecoder();
  let buffer = '';

  const toolCalls: Record<number, { id: string; name: string; arguments: string }> = {};

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') {
          // Flush any pending tool calls
          for (const idx of Object.keys(toolCalls).map(Number).sort()) {
            yield { type: 'tool_call_done', toolCall: toolCalls[idx] };
          }
          yield { type: 'done' };
          return;
        }

        try {
          const json = JSON.parse(data);

          const choice = json.choices?.[0];
          if (!choice) continue;

          const delta = choice.delta;
          if (!delta) continue;

          if (delta.content) {
            yield { type: 'text', content: delta.content };
          }

          if (delta.reasoning_content) {
            yield { type: 'thinking', content: delta.reasoning_content };
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCalls[idx]) {
                toolCalls[idx] = { id: tc.id || '', name: '', arguments: '' };
              }
              if (tc.id) toolCalls[idx].id = tc.id;
              if (tc.function?.name) toolCalls[idx].name = tc.function.name;
              if (tc.function?.arguments) toolCalls[idx].arguments += tc.function.arguments;
            }
          }

          if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'function_call') {
            for (const idx of Object.keys(toolCalls).map(Number).sort()) {
              yield { type: 'tool_call_done', toolCall: toolCalls[idx] };
            }
          }
        } catch {
          // skip malformed JSON
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function* parseClaudeStream(
  reader: ReadableStreamDefaultReader<Uint8Array>
): AsyncGenerator<StreamDelta> {
  const decoder = new TextDecoder();
  let buffer = '';
  let currentToolUseId = '';
  let currentToolName = '';
  let toolArgsBuffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed.startsWith('event: ')) {
          const event = trimmed.slice(7);
          if (event === 'message_stop') {
            yield { type: 'done' };
            return;
          }
          if (event === 'content_block_stop' && currentToolUseId) {
            yield {
              type: 'tool_call_done',
              toolCall: { id: currentToolUseId, name: currentToolName, arguments: toolArgsBuffer },
            };
            currentToolUseId = '';
            currentToolName = '';
            toolArgsBuffer = '';
          }
          continue;
        }

        if (!trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);

        try {
          const json = JSON.parse(data);

          if (json.type === 'content_block_start') {
            const block = json.content_block;
            if (block?.type === 'tool_use') {
              currentToolUseId = block.id || '';
              currentToolName = block.name || '';
              toolArgsBuffer = '';
            }
          } else if (json.type === 'content_block_delta') {
            const delta = json.delta;
            if (delta?.type === 'text_delta' && delta.text) {
              yield { type: 'text', content: delta.text };
            } else if (delta?.type === 'thinking_delta' && delta.thinking) {
              yield { type: 'thinking', content: delta.thinking };
            } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
              toolArgsBuffer += delta.partial_json;
            }
          } else if (json.type === 'message_delta') {
            if (json.usage) {
              yield {
                type: 'done',
                usage: {
                  inputTokens: json.usage.input_tokens || 0,
                  outputTokens: json.usage.output_tokens || 0,
                },
              };
            }
          } else if (json.type === 'error') {
            yield { type: 'error', error: json.error?.message || 'Unknown error' };
          }
        } catch {
          // skip malformed JSON
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// Parse XML-style tool calls from text (compatibility mode)
export function parseXmlToolCalls(text: string): Array<{ name: string; arguments: Record<string, any> }> | null {
  const toolCallRegex = /<tool_call>\s*\{[\s\S]*?\}\s*<\/tool_call>/g;
  const matches = text.match(toolCallRegex);
  if (!matches) return null;

  const results: Array<{ name: string; arguments: Record<string, any> }> = [];
  for (const match of matches) {
    try {
      const jsonStr = match.replace(/<\/?tool_call>/g, '').trim();
      const parsed = JSON.parse(jsonStr);
      if (parsed.name) {
        results.push({ name: parsed.name, arguments: parsed.arguments || parsed.parameters || {} });
      }
    } catch {
      // skip
    }
  }
  return results.length > 0 ? results : null;
}
