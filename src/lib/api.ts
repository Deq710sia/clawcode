/**
 * ClawCode — Strong agentic loop with planning, memory, retry, and long-context handling.
 * Compatible with OpenAI / OpenRouter / Ollama / LM Studio / Z.ai / Groq / WebChat Bridge.
 *
 * Loop:
 *   1. (Optional) planning phase: model emits a plan + first action
 *   2. tool round: stream → tool calls → execute → tool results → stream again
 *   3. retry on transient errors
 *   4. long-context truncation (keep system + last N messages + recent tool results)
 */

import { proxyFetch } from './netfetch';

export interface ApiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }[];
}

export interface ChatStreamEvent {
  type: 'delta' | 'reasoning' | 'tool_calls' | 'done' | 'error' | 'plan';
  text?: string;
  calls?: { id: string; name: string; args: Record<string, any> }[];
  message?: string;
  plan?: string;
}


/**
 * Splits streamed content into visible text and <think>…</think> reasoning.
 * Tags may be split across chunks, so a possible partial tag is held back until the next chunk.
 */
export function createThinkSplitter() {
  let inThink = false;
  let hold = '';
  const OPEN = '<think>';
  const CLOSE = '</think>';
  const partialAtEnd = (text: string, tag: string) => {
    for (let n = Math.min(tag.length - 1, text.length); n > 0; n--) {
      if (tag.startsWith(text.slice(-n))) return n;
    }
    return 0;
  };
  return {
    push(chunk: string): { text: string; reasoning: string } {
      let buf = hold + chunk;
      hold = '';
      let text = '';
      let reasoning = '';
      while (buf) {
        const tag = inThink ? CLOSE : OPEN;
        const i = buf.indexOf(tag);
        if (i === -1) {
          const keep = partialAtEnd(buf, tag);
          const emit = buf.slice(0, buf.length - keep);
          if (inThink) reasoning += emit; else text += emit;
          hold = buf.slice(buf.length - keep);
          break;
        }
        const before = buf.slice(0, i);
        if (inThink) reasoning += before; else text += before;
        buf = buf.slice(i + tag.length);
        inThink = !inThink;
      }
      return { text, reasoning };
    },
    flush(): { text: string; reasoning: string } {
      const out = inThink ? { text: '', reasoning: hold } : { text: hold, reasoning: '' };
      hold = '';
      return out;
    },
  };
}

export interface StreamChatOpts {
  endpoint: string;
  apiKey: string;
  model: string;
  messages: ApiMessage[];
  systemPrompt?: string;
  signal: AbortSignal;
  onEvent: (ev: ChatStreamEvent) => void | Promise<void>;
  enablePlanning?: boolean;
  /** Cap on tool rounds (default 24 — enough for real tasks). */
  maxRounds?: number;
}

const TOOL_SCHEMAS = [
  {
    type: 'function' as const,
    function: {
      name: 'list_files',
      description: 'List files and directories under a path (relative to workspace root).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path relative to workspace root. Use "." for root.' },
          maxDepth: { type: 'integer', description: 'Max recursion depth. Default 3.', default: 3 },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: 'Read the full UTF-8 contents of a file in the workspace.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_file',
      description: 'Create or overwrite a file with the given content. Parent dirs are auto-created.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'edit_file',
      description: 'Apply string replacements to a file. Returns a unified diff. Each replacement = { old, new }. Old must be unique in the file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          replacements: {
            type: 'array',
            items: {
              type: 'object',
              properties: { old: { type: 'string' }, new: { type: 'string' }, replaceAll: { type: 'boolean' } },
              required: ['old', 'new'],
            },
          },
        },
        required: ['path', 'replacements'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'run_command',
      description: 'Execute a shell command in the workspace (bash on Unix, PowerShell on Windows). Use for builds, tests, git, etc.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          timeoutMs: { type: 'integer', default: 120000 },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'delete_file',
      description: 'Delete a file. Refuses directories.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'move_file',
      description: 'Move or rename a file.',
      parameters: {
        type: 'object',
        properties: { from: { type: 'string' }, to: { type: 'string' } },
        required: ['from', 'to'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'update_plan',
      description: 'Update the persistent task plan / todo list. Use this to track multi-step work — call after every meaningful step. The plan is shown to the user and persists across the conversation.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string', description: 'What needs to be done' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'blocked'], description: 'Current status' },
              },
              required: ['text', 'status'],
            },
          },
        },
        required: ['items'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'web_search',
      description: 'Search the web for current information. Returns titles + snippets + URLs. Use for docs, error messages, library APIs.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          maxResults: { type: 'integer', default: 5 },
        },
        required: ['query'],
      },
    },
  },
];

const DEFAULT_SYSTEM_PROMPT = `You are ClawCode, a clean-room universal agentic coding harness.
You combine the best patterns of Claude Code, OpenCode, and Codex into one capable long-term agent.

OPERATING PROTOCOL:
1. PLAN FIRST. For any non-trivial task, call update_plan with the steps you'll take before touching files.
2. READ BEFORE WRITE. Never assume file contents — use list_files and read_file to ground yourself.
3. PREFER edit_file (targeted string replacement) over write_file (full rewrite) for existing files.
4. ONE THING AT A TIME. Make one logical change per tool call, observe the result, then continue.
5. UPDATE THE PLAN. After each meaningful step, mark it done and start the next.
6. RECOVER FROM ERRORS. If a tool fails, read the error, adjust your approach, and retry — don't get stuck. If a tool fails twice with the same error, STOP and explain the problem to the user instead of retrying.
7. VERIFY. After making changes, run_command (tests, typecheck, build) to verify your work.
8. BE CONCISE IN PROSE. Verbose in code. Use markdown for prose, fenced blocks for code.
9. ALWAYS SYNTHESIZE. After receiving tool results, you MUST write a natural language response
   explaining what you found, what you did, and what it means. Do NOT just call another tool
   or output an empty response. The user needs to understand what happened. Think of it as
   talking to a colleague: "I checked the file and here's what I found..."
   Only call another tool if the current task genuinely requires more information.
10. NEVER END WITH JUST TOOLS. Every turn must end with plain text. If you called tools,
    wrap up with a summary of what you did and what the results mean.

CAPABILITIES:
- Full workspace file ops (read, write, edit, delete, move)
- Shell command execution
- Web search for current info
- Persistent plan/todo tracking

You are running against the user's local workspace. Files outside the workspace are inaccessible.`;

export function defaultSystemPrompt() {
  return DEFAULT_SYSTEM_PROMPT;
}

function normalizeEndpoint(endpoint: string): string {
  let ep = (endpoint || '').trim();
  if (!ep) ep = 'https://api.openai.com/v1';
  if (ep.endsWith('/')) ep = ep.slice(0, -1);
  return ep;
}

/**
 * Truncate message history to fit within an approximate token budget.
 * Keeps: system prompt, first user message (the task), last N messages,
 * and trims long tool results to a summary.
 */
function truncateHistory(messages: ApiMessage[], maxChars: number = 100_000): ApiMessage[] {
  let total = messages.reduce((acc, m) => acc + (m.content?.length ?? 0) + JSON.stringify(m.tool_calls ?? []).length, 0);
  if (total <= maxChars) return messages;

  const kept: ApiMessage[] = [];
  // Always keep system + first user
  if (messages[0]?.role === 'system') kept.push(messages[0]);
  const firstUserIdx = messages.findIndex((m) => m.role === 'user');
  if (firstUserIdx >= 0) kept.push(messages[firstUserIdx]);

  // Take last N messages
  let tail = messages.slice(Math.max(firstUserIdx + 1, messages.length - 20));
  // A `tool` message is only valid directly after the assistant message that issued the
  // call. If the cut landed in the middle of a round, drop the orphaned tool results,
  // otherwise providers reject the request with HTTP 400.
  while (tail.length && tail[0].role === 'tool') tail = tail.slice(1);
  for (const m of tail) {
    if (m.role === 'tool' && (m.content?.length ?? 0) > 4000) {
      kept.push({ ...m, content: (m.content ?? '').slice(0, 2000) + '\n…[truncated]…\n' + (m.content ?? '').slice(-1500) });
    } else {
      kept.push(m);
    }
  }
  return kept;
}

/** Strip fields providers reject (e.g. an empty `tool_calls: []` array on plain assistant turns). */
function sanitizeForWire(m: ApiMessage): ApiMessage {
  const out: any = { role: m.role, content: m.content ?? '' };
  if (m.tool_calls && m.tool_calls.length > 0) out.tool_calls = m.tool_calls;
  if (m.role === 'tool') {
    out.tool_call_id = m.tool_call_id;
    if (m.name) out.name = m.name;
  }
  return out;
}

export async function streamChat(opts: StreamChatOpts) {
  const base = normalizeEndpoint(opts.endpoint);
  const url = `${base}/chat/completions`;
  const workspace = await window.claw.workspace.get().catch(() => '');

  const messages: ApiMessage[] = [];
  const sys = (opts.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT) +
    `\n\nWorkspace: ${workspace || '(none selected)'}\nCurrent time: ${new Date().toISOString()}`;
  messages.push({ role: 'system', content: sys });
  for (const m of opts.messages) {
    if (m.role === 'tool' && !m.content) continue;
    messages.push(m);
  }

  const truncated = truncateHistory(messages);

  const body: any = {
    model: opts.model || 'gpt-4o-mini',
    messages: truncated.map(sanitizeForWire),
    stream: true,
    tools: TOOL_SCHEMAS,
    tool_choice: 'auto',
  };
  // OpenAI reasoning models (o1/o3/o4/gpt-5) reject any non-default temperature.
  if (!/^(o\d|gpt-5)/i.test(body.model)) body.temperature = 0.4;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
    // OpenRouter requires these headers
    ...(base.includes('openrouter') ? { 'HTTP-Referer': 'https://clawcode.app', 'X-Title': 'ClawCode' } : {}),
  };

  const post = (payload: any) =>
    proxyFetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: opts.signal });

  // Some endpoints (Ollama, LM Studio, older local servers) reject `tools`.
  // Try with tools first; on a tool-related 400 retry without.
  let res: Response;
  try {
    res = await post(body);
    if (res.status === 400 || res.status === 422) {
      const errText = await res.text().catch(() => '');
      if (/tool|function|unsupported/i.test(errText)) {
        const bodyNoTools = { ...body };
        delete bodyNoTools.tools;
        delete bodyNoTools.tool_choice;
        res = await post(bodyNoTools);
      } else {
        opts.onEvent({ type: 'error', message: `HTTP ${res.status}: ${errText.slice(0, 500)}` });
        return;
      }
    }
  } catch (err: any) {
    if (err?.name === 'AbortError') return;
    opts.onEvent({ type: 'error', message: `Network error: ${err?.message ?? err}` });
    return;
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    opts.onEvent({ type: 'error', message: `HTTP ${res.status}: ${txt.slice(0, 500)}` });
    return;
  }
  if (!res.body) {
    opts.onEvent({ type: 'error', message: 'No response body' });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const toolCallBuffers: Map<number, { id: string; name: string; argsStr: string }> = new Map();
  let hadToolCalls = false;
  const thinkSplitter = createThinkSplitter();
  const flushThink = () => {
    const rest = thinkSplitter.flush();
    if (rest.reasoning) opts.onEvent({ type: 'reasoning', text: rest.reasoning });
    if (rest.text) opts.onEvent({ type: 'delta', text: rest.text });
  };

  const flushToolCalls = () => {
    if (toolCallBuffers.size === 0) return;
    const calls = Array.from(toolCallBuffers.values()).map((c) => {
      let args: Record<string, any> = {};
      try {
        args = c.argsStr ? JSON.parse(c.argsStr) : {};
      } catch (e: any) {
        // Surface malformed JSON to the model instead of silently running the tool with {}.
        args = { __parse_error: `Tool arguments were not valid JSON (${e?.message}). Raw: ${c.argsStr.slice(0, 300)}` };
      }
      return { id: c.id, name: c.name, args };
    });
    opts.onEvent({ type: 'tool_calls', calls });
    toolCallBuffers.clear();
    hadToolCalls = true;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      const lines = buf.split('\n');
      buf = lines.pop() ?? '';

      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          flushThink();
          flushToolCalls();
          opts.onEvent({ type: 'done' });
          return;
        }
        try {
          const json = JSON.parse(data);
          const choice = json.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta ?? {};
          // DeepSeek/GLM/Qwen send `reasoning_content`; OpenRouter sends `reasoning`.
          const rs = delta.reasoning_content ?? delta.reasoning;
          if (typeof rs === 'string' && rs) {
            opts.onEvent({ type: 'reasoning', text: rs });
          }
          if (typeof delta.content === 'string' && delta.content) {
            const parts = thinkSplitter.push(delta.content);
            if (parts.reasoning) opts.onEvent({ type: 'reasoning', text: parts.reasoning });
            if (parts.text) opts.onEvent({ type: 'delta', text: parts.text });
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx: number = tc.index ?? 0;
              if (!toolCallBuffers.has(idx)) {
                toolCallBuffers.set(idx, { id: tc.id ?? `call_${idx}_${Date.now()}`, name: '', argsStr: '' });
              }
              const b = toolCallBuffers.get(idx)!;
              if (tc.id) b.id = tc.id;
              if (tc.function?.name) b.name += tc.function.name;
              if (tc.function?.arguments) b.argsStr += tc.function.arguments;
            }
          }
          if (choice.finish_reason === 'tool_calls') {
            flushToolCalls();
          }
        } catch {
          // ignore parse errors on partial lines
        }
      }
    }

    flushThink();
    flushToolCalls();
    opts.onEvent({ type: 'done' });
  } finally {
    // Release the reader so the underlying stream can be garbage-collected.
    reader.releaseLock();
  }
}

export { DEFAULT_SYSTEM_PROMPT };
