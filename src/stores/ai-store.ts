import { create } from 'zustand';
import type { AiApiConfig, ChatMessage, ToolCallInfo } from '@/services/ai/ai-api-client';

export interface AiMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  thinking?: string;
  toolCalls?: ToolCallInfo[];
  toolCallId?: string;
  timestamp: number;
}

export interface Conversation {
  id: string;
  title: string;
  messages: AiMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface AiSettings {
  autoRetry: boolean;
  maxRetries: number;
}

interface AiStore {
  // Conversations
  conversations: Conversation[];
  currentConversationId: string | null;

  // API configs
  apiConfigs: AiApiConfig[];

  // Streaming state
  isStreaming: boolean;
  abortController: AbortController | null;

  // Settings
  settings: AiSettings;

  // Actions - Conversations
  createConversation: () => string;
  deleteConversation: (id: string) => void;
  setCurrentConversation: (id: string) => void;
  updateConversationTitle: (id: string, title: string) => void;
  clearAllConversations: () => void;

  // Actions - Messages
  addMessage: (msg: AiMessage) => void;
  updateMessage: (msgId: string, updates: Partial<AiMessage>) => void;
  getCurrentMessages: () => AiMessage[];

  // Actions - API configs
  addApiConfig: (config: AiApiConfig) => void;
  updateApiConfig: (id: string, updates: Partial<AiApiConfig>) => void;
  deleteApiConfig: (id: string) => void;
  setActiveConfig: (id: string) => void;
  getActiveConfig: () => AiApiConfig | null;

  // Actions - Streaming
  setStreaming: (streaming: boolean) => void;
  setAbortController: (controller: AbortController | null) => void;
  stopGeneration: () => void;

  // Actions - Settings
  updateSettings: (updates: Partial<AiSettings>) => void;

  // Persistence
  loadFromStorage: () => void;
  saveToStorage: () => void;
}

const STORAGE_KEY = 'flyclash-ai-store';

function loadState(): Partial<Pick<AiStore, 'conversations' | 'apiConfigs' | 'settings' | 'currentConversationId'>> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* empty */ }
  return {};
}

function saveState(state: Pick<AiStore, 'conversations' | 'apiConfigs' | 'settings' | 'currentConversationId'>) {
  try {
    const t0 = performance.now();
    const json = JSON.stringify({
      conversations: state.conversations,
      apiConfigs: state.apiConfigs,
      settings: state.settings,
      currentConversationId: state.currentConversationId,
    });
    const t1 = performance.now();
    localStorage.setItem(STORAGE_KEY, json);
    const t2 = performance.now();
    if (typeof window !== 'undefined' && window.electronAPI?.debugLog) {
      window.electronAPI.debugLog(`saveState: stringify=${(t1 - t0).toFixed(1)}ms, setItem=${(t2 - t1).toFixed(1)}ms, size=${(json.length / 1024).toFixed(1)}KB`);
    }
  } catch { /* empty */ }
}

// Debounced version for high-frequency updates (streaming, tool status changes)
let _saveTimer: ReturnType<typeof setTimeout> | null = null;
function saveStateDebounced(state: Pick<AiStore, 'conversations' | 'apiConfigs' | 'settings' | 'currentConversationId'>) {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    saveState(state);
  }, 500);
}

// Flush any pending debounced save immediately
function flushSave(state: Pick<AiStore, 'conversations' | 'apiConfigs' | 'settings' | 'currentConversationId'>) {
  if (_saveTimer) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
  }
  saveState(state);
}

export const useAiStore = create<AiStore>((set, get) => {
  const saved = loadState();

  return {
    conversations: saved.conversations || [],
    currentConversationId: saved.currentConversationId || null,
    apiConfigs: saved.apiConfigs || [],
    isStreaming: false,
    abortController: null,
    settings: saved.settings || { autoRetry: true, maxRetries: 2 },

    createConversation: () => {
      const id = `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const conv: Conversation = {
        id,
        title: '',
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      set((s) => {
        const next = { conversations: [conv, ...s.conversations], currentConversationId: id };
        saveState({ ...s, ...next });
        return next;
      });
      return id;
    },

    deleteConversation: (id) => {
      set((s) => {
        const conversations = s.conversations.filter((c) => c.id !== id);
        const currentConversationId = s.currentConversationId === id
          ? (conversations[0]?.id || null)
          : s.currentConversationId;
        const next = { conversations, currentConversationId };
        saveState({ ...s, ...next });
        return next;
      });
    },

    setCurrentConversation: (id) => {
      set((s) => {
        saveState({ ...s, currentConversationId: id });
        return { currentConversationId: id };
      });
    },

    updateConversationTitle: (id, title) => {
      set((s) => {
        const conversations = s.conversations.map((c) =>
          c.id === id ? { ...c, title, updatedAt: Date.now() } : c
        );
        saveState({ ...s, conversations });
        return { conversations };
      });
    },

    clearAllConversations: () => {
      set((s) => {
        const next = { conversations: [], currentConversationId: null };
        saveState({ ...s, ...next });
        return next;
      });
    },

    addMessage: (msg) => {
      set((s) => {
        let convId = s.currentConversationId;
        let conversations = s.conversations;
        if (!convId) {
          convId = `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          const conv: Conversation = { id: convId, title: '', messages: [], createdAt: Date.now(), updatedAt: Date.now() };
          conversations = [conv, ...conversations];
        }
        conversations = conversations.map((c) =>
          c.id === convId ? { ...c, messages: [...c.messages, msg], updatedAt: Date.now() } : c
        );
        saveStateDebounced({ ...s, conversations, currentConversationId: convId });
        return { conversations, currentConversationId: convId };
      });
    },

    updateMessage: (msgId, updates) => {
      set((s) => {
        const conversations = s.conversations.map((c) => {
          if (c.id !== s.currentConversationId) return c;
          return {
            ...c,
            messages: c.messages.map((m) => (m.id === msgId ? { ...m, ...updates } : m)),
            updatedAt: Date.now(),
          };
        });
        saveStateDebounced({ ...s, conversations });
        return { conversations };
      });
    },

    getCurrentMessages: () => {
      const s = get();
      const conv = s.conversations.find((c) => c.id === s.currentConversationId);
      return conv?.messages || [];
    },

    addApiConfig: (config) => {
      set((s) => {
        const apiConfigs = [...s.apiConfigs, config];
        saveState({ ...s, apiConfigs });
        return { apiConfigs };
      });
    },

    updateApiConfig: (id, updates) => {
      set((s) => {
        const apiConfigs = s.apiConfigs.map((c) => (c.id === id ? { ...c, ...updates } : c));
        saveState({ ...s, apiConfigs });
        return { apiConfigs };
      });
    },

    deleteApiConfig: (id) => {
      set((s) => {
        const apiConfigs = s.apiConfigs.filter((c) => c.id !== id);
        saveState({ ...s, apiConfigs });
        return { apiConfigs };
      });
    },

    setActiveConfig: (id) => {
      set((s) => {
        const apiConfigs = s.apiConfigs.map((c) => ({ ...c, active: c.id === id }));
        saveState({ ...s, apiConfigs });
        return { apiConfigs };
      });
    },

    getActiveConfig: () => {
      return get().apiConfigs.find((c) => c.active) || null;
    },

    setStreaming: (streaming) => {
      if (!streaming) {
        // Flush pending saves when streaming ends
        const s = get();
        flushSave(s);
      }
      set({ isStreaming: streaming });
    },
    setAbortController: (controller) => set({ abortController: controller }),

    stopGeneration: () => {
      const s = get();
      s.abortController?.abort();
      set({ isStreaming: false, abortController: null });
    },

    updateSettings: (updates) => {
      set((s) => {
        const settings = { ...s.settings, ...updates };
        saveState({ ...s, settings });
        return { settings };
      });
    },

    loadFromStorage: () => {
      const saved = loadState();
      set({
        conversations: saved.conversations || [],
        currentConversationId: saved.currentConversationId || null,
        apiConfigs: saved.apiConfigs || [],
        settings: saved.settings || { autoRetry: true, maxRetries: 2 },
      });
    },

    saveToStorage: () => {
      const s = get();
      saveState(s);
    },
  };
});
