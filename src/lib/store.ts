import { create } from 'zustand';
import type { ChatMessage, ToolCall, FileEntry, PublicConfig, InstalledSkill } from '../types';
import { streamChat, type ChatStreamEvent, type ApiMessage } from './api';

interface PendingDiff {
  id: string;
  path: string;
  diff: string;
  before: string;
  after: string;
  applied: boolean;
  rejected: boolean;
}

interface ClawState {
  workspace: string;
  setWorkspace: (ws: string) => void;

  config: PublicConfig | null;
  setConfig: (c: PublicConfig | null) => void;

  files: FileEntry[];
  setFiles: (f: FileEntry[]) => void;
  refreshFiles: () => Promise<void>;

  messages: ChatMessage[];
  isStreaming: boolean;
  pendingToolCalls: Record<string, ToolCall>;
  sendUserMessage: (text: string) => Promise<void>;
  stopStreaming: () => void;

  plan: PlanItem[];
  pendingDiffs: PendingDiff[];
  applyDiff: (id: string) => Promise<void>;
  rejectDiff: (id: string) => void;

  installedSkills: InstalledSkill[];
  refreshInstalledSkills: () => Promise<void>;

  showSettings: boolean;
  setShowSettings: (v: boolean) => void;
  showWelcome: boolean;
  setShowWelcome: (v: boolean) => void;
}

let streamController: AbortController | null = null;
const MAX_TOOL_ROUNDS = 24;

export interface PlanItem {
  text: string;
  status: 'pending' | 'in_progress' | 'done' | 'blocked';
}

/**
 * If a turn was stopped (or the app crashed) between an assistant tool call and its
 * result, the history contains a tool_call with no matching `tool` message. Providers
 * reject that with HTTP 400, which would brick the conversation. Insert placeholders.
 */
function repairDangling(msgs: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    out.push(m);
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const answered = new Set<string>();
      for (let j = i + 1; j < msgs.length && msgs[j].role === 'tool'; j++) {
        if (msgs[j].tool_call_id) answered.add(msgs[j].tool_call_id!);
      }
      for (const tc of m.tool_calls) {
        if (!answered.has(tc.id)) {
          out.push({
            id: `repair_${tc.id}`,
            role: 'tool',
            content: JSON.stringify({ error: 'Tool call was cancelled before it completed.' }),
            tool_call_id: tc.id,
            name: tc.name,
            createdAt: m.createdAt,
          });
        }
      }
    }
  }
  return out;
}

function toApiMessages(rawMsgs: ChatMessage[]): ApiMessage[] {
  const msgs = repairDangling(rawMsgs);
  return msgs
    .filter((m) => !(m.role === 'tool' && !m.content))
    .map((m) => ({
      role: m.role,
      content: m.content,
      tool_call_id: m.tool_call_id,
      name: m.name,
      tool_calls: m.tool_calls?.length
        ? m.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          }))
        : undefined,
    }));
}

function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `id_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export const useClaw = create<ClawState>((set, get) => ({
  workspace: '',
  setWorkspace: (ws) => set({ workspace: ws }),

  config: null,
  setConfig: (c) => set({ config: c }),

  files: [],
  setFiles: (f) => set({ files: f }),

  refreshFiles: async () => {
    const ws = get().workspace;
    if (!ws) return;
    try {
      const res = await window.claw.tool.invoke('list_files', { path: '.', maxDepth: 4 });
      if (res.ok) set({ files: res.result.entries });
    } catch {}
  },

  messages: [],
  isStreaming: false,
  pendingToolCalls: {},
  plan: [],

  sendUserMessage: async (text) => {
    if (get().isStreaming) return;
    const cfg = get().config;
    if (!cfg) return;

    const userMsg: ChatMessage = {
      id: uuid(),
      role: 'user',
      content: text,
      createdAt: Date.now(),
    };
    set((s) => ({
      messages: [...s.messages, userMsg],
      isStreaming: true,
    }));

    streamController = new AbortController();
    const apiKeyRes = await window.claw.config.getApiKey();
    const apiKey = apiKeyRes.apiKey || '';

    // Agentic loop: stream → tool calls → execute → stream again, up to MAX_TOOL_ROUNDS.
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (streamController.signal.aborted) break;

      const assistantMsg: ChatMessage = {
        id: uuid(),
        role: 'assistant',
        content: '',
        createdAt: Date.now(),
        streaming: true,
        tool_calls: [],
      };
      set((s) => ({ messages: [...s.messages, assistantMsg] }));

      let hadToolCalls = false;
      let textBuffer = '';
      const pendingToolCallsForThisRound: ToolCall[] = [];

      const onEvent = async (ev: ChatStreamEvent) => {
        if (ev.type === 'delta' && ev.text) {
          textBuffer += ev.text;
          set((s) => ({
            messages: s.messages.map((m) =>
              m.id === assistantMsg.id ? { ...m, content: m.content + ev.text } : m
            ),
          }));
        } else if (ev.type === 'tool_calls' && ev.calls) {
          hadToolCalls = true;
          const calls: ToolCall[] = ev.calls.map((c) => ({
            id: c.id,
            name: c.name,
            args: c.args,
            state: 'running' as const,
            startedAt: Date.now(),
          }));
          pendingToolCallsForThisRound.push(...calls);
          set((s) => ({
            messages: s.messages.map((m) =>
              m.id === assistantMsg.id
                ? { ...m, tool_calls: [...(m.tool_calls ?? []), ...calls] }
                : m
            ),
            pendingToolCalls: {
              ...s.pendingToolCalls,
              ...Object.fromEntries(calls.map((c) => [c.id, c])),
            },
          }));
        } else if (ev.type === 'done') {
          set((s) => ({
            messages: s.messages.map((m) =>
              m.id === assistantMsg.id ? { ...m, streaming: false } : m
            ),
          }));
        } else if (ev.type === 'error') {
          set((s) => ({
            messages: s.messages.map((m) =>
              m.id === assistantMsg.id
                ? { ...m, streaming: false, content: (m.content || '') + `\n\n[error] ${ev.message}` }
                : m
            ),
            isStreaming: false,
          }));
          return;
        }
      };

      try {
        await streamChat({
          endpoint: cfg.endpoint,
          apiKey,
          model: cfg.model,
          messages: toApiMessages(get().messages.filter((m) => m.id !== assistantMsg.id)),
          systemPrompt: cfg.systemPrompt,
          signal: streamController.signal,
          onEvent,
        });
      } catch (err: any) {
        if (err?.name === 'AbortError') {
          set((s) => ({
            messages: s.messages.map((m) =>
              m.id === assistantMsg.id ? { ...m, streaming: false, content: m.content + '\n\n[stopped]' } : m
            ),
            isStreaming: false,
          }));
          return;
        }
        set((s) => ({
          messages: s.messages.map((m) =>
            m.id === assistantMsg.id
              ? { ...m, streaming: false, content: (m.content || '') + `\n\n[error] ${err?.message ?? err}` }
              : m
          ),
          isStreaming: false,
        }));
        return;
      }

      if (!hadToolCalls) {
        // No more tool calls — assistant finished its turn.
        set({ isStreaming: false });
        return;
      }

      // Execute all tool calls emitted this round, push tool result messages.
      for (const call of pendingToolCallsForThisRound) {
        try {
          const res = call.args?.__parse_error
            ? { ok: false as const, error: String(call.args.__parse_error), result: undefined }
            : await window.claw.tool.invoke(call.name, call.args);
          const finished: ToolCall = {
            ...call,
            state: res.ok ? 'done' : 'error',
            result: res.result,
            error: res.error,
            endedAt: Date.now(),
          };
          set((s) => ({
            pendingToolCalls: { ...s.pendingToolCalls, [call.id]: finished },
            messages: s.messages.map((m) =>
              m.id === assistantMsg.id
                ? { ...m, tool_calls: (m.tool_calls ?? []).map((tc) => (tc.id === call.id ? finished : tc)) }
                : m
            ),
          }));

          const toolMsg: ChatMessage = {
            id: uuid(),
            role: 'tool',
            content: JSON.stringify(res.ok ? res.result : { error: res.error }, null, 2),
            tool_call_id: call.id,
            name: call.name,
            createdAt: Date.now(),
          };
          set((s) => ({ messages: [...s.messages, toolMsg] }));

          // Surface edit_file diffs to the pendingDiffs queue for visual review.
          if (call.name === 'edit_file' && res.ok && res.result?.diff) {
            const diffId = uuid();
            set((s) => ({
              pendingDiffs: [
                ...s.pendingDiffs,
                {
                  id: diffId,
                  path: res.result.path,
                  diff: res.result.diff,
                  before: '',
                  after: '',
                  applied: true,
                  rejected: false,
                },
              ],
            }));
          }

          // update_plan: sync plan state into the UI
          if (call.name === 'update_plan' && res.ok && Array.isArray(res.result?.items)) {
            set({ plan: res.result.items });
          }
        } catch (err: any) {
          const failed: ToolCall = {
            ...call,
            state: 'error',
            error: err?.message ?? String(err),
            endedAt: Date.now(),
          };
          set((s) => ({
            pendingToolCalls: { ...s.pendingToolCalls, [call.id]: failed },
            messages: s.messages.map((m) =>
              m.id === assistantMsg.id
                ? { ...m, tool_calls: (m.tool_calls ?? []).map((tc) => (tc.id === call.id ? failed : tc)) }
                : m
            ),
          }));

          const toolMsg: ChatMessage = {
            id: uuid(),
            role: 'tool',
            content: JSON.stringify({ error: err?.message ?? String(err) }),
            tool_call_id: call.id,
            name: call.name,
            createdAt: Date.now(),
          };
          set((s) => ({ messages: [...s.messages, toolMsg] }));
        }
      }

      // Loop continues — next iteration will create a new assistant message and stream again
      // with the tool results now in history.
    }

    // Hit the round limit
    set((s) => ({
      isStreaming: false,
      messages: s.messages.some((m) => m.streaming)
        ? s.messages.map((m) => (m.streaming ? { ...m, streaming: false, content: m.content + '\n\n[reached max tool rounds]' } : m))
        : s.messages,
    }));
  },

  stopStreaming: () => {
    streamController?.abort();
    set({ isStreaming: false });
  },

  pendingDiffs: [],
  applyDiff: async (id) => {
    set((s) => ({
      pendingDiffs: s.pendingDiffs.map((d) => (d.id === id ? { ...d, applied: true } : d)),
    }));
    await get().refreshFiles();
  },
  rejectDiff: (id) => {
    set((s) => ({
      pendingDiffs: s.pendingDiffs.map((d) => (d.id === id ? { ...d, rejected: true } : d)),
    }));
  },

  installedSkills: [],
  refreshInstalledSkills: async () => {
    const list = await window.claw.skills.installed();
    set({ installedSkills: list });
  },

  showSettings: false,
  setShowSettings: (v) => set({ showSettings: v }),
  showWelcome: false,
  setShowWelcome: (v) => set({ showWelcome: v }),
}));
