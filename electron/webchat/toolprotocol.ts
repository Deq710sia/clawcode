/**
 * ClawCode — text protocol that lets a plain chat UI act as a tool-calling model.
 *
 * Web chats have no function-calling API: they take text in and return text out. The
 * bridge therefore (1) renders the OpenAI-style request (system prompt, tool schemas,
 * history incl. tool results) into one prompt that teaches the model a JSON tool-call
 * convention, and (2) parses the reply back into OpenAI `tool_calls`.
 */

export interface OAIToolCallIn { id?: string; function?: { name?: string; arguments?: string } }
export interface OAIMessage {
  role: string;
  content?: unknown;
  tool_calls?: OAIToolCallIn[];
  tool_call_id?: string;
  name?: string;
}
export interface OAITool { type?: string; function?: { name: string; description?: string; parameters?: any } }

export interface ParsedCall { name: string; arguments: string }
export interface ParsedReply { content: string; calls: ParsedCall[] }

const MAX_TOOL_RESULT_CHARS = 8000;
const MAX_PROMPT_CHARS = 80_000;

function contentToText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p: any) => (typeof p === 'string' ? p : p?.text ?? '')).join('\n');
  return c == null ? '' : String(c);
}

function compactSignature(tool: OAITool): string {
  const f = tool.function!;
  const props = f.parameters?.properties ?? {};
  const required = new Set<string>(f.parameters?.required ?? []);
  const args = Object.entries(props).map(([k, v]: [string, any]) => {
    const t = v?.type === 'array' ? `array of ${v?.items?.type ?? 'any'}` : v?.type ?? 'any';
    return `${k}${required.has(k) ? '' : '?'}: ${t}`;
  });
  return `${f.name}(${args.join(', ')})${f.description ? ` — ${f.description}` : ''}`;
}

function renderCall(name: string, args: string): string {
  let parsed: unknown = {};
  try { parsed = args ? JSON.parse(args) : {}; } catch { parsed = { _raw: args }; }
  return '```json\n' + JSON.stringify({ tool_call: { name, arguments: parsed } }) + '\n```';
}

export function buildPrompt(messages: OAIMessage[], tools: OAITool[] = []): string {
  const system = messages.filter((m) => m.role === 'system').map((m) => contentToText(m.content)).join('\n\n');
  const convo = messages.filter((m) => m.role !== 'system');

  const nameById = new Map<string, string>();
  for (const m of convo) for (const tc of m.tool_calls ?? []) if (tc.id && tc.function?.name) nameById.set(tc.id, tc.function.name);

  const turns: string[] = convo.map((m) => {
    if (m.role === 'user') return `[User]\n${contentToText(m.content)}`;
    if (m.role === 'assistant') {
      const parts: string[] = [];
      const text = contentToText(m.content).trim();
      if (text) parts.push(text);
      for (const tc of m.tool_calls ?? []) parts.push(renderCall(tc.function?.name ?? 'unknown', tc.function?.arguments ?? '{}'));
      return `[Assistant]\n${parts.join('\n')}`;
    }
    if (m.role === 'tool') {
      let body = contentToText(m.content);
      if (body.length > MAX_TOOL_RESULT_CHARS) {
        body = body.slice(0, MAX_TOOL_RESULT_CHARS * 0.7) + '\n…[truncated]…\n' + body.slice(-MAX_TOOL_RESULT_CHARS * 0.25);
      }
      const name = m.name || (m.tool_call_id && nameById.get(m.tool_call_id)) || 'tool';
      return `[Tool result: ${name}]\n${body}`;
    }
    return `[${m.role}]\n${contentToText(m.content)}`;
  });

  const header: string[] = [
    "You are the language model inside an agentic coding assistant. Follow the SYSTEM INSTRUCTIONS and write the Assistant's next message in the CONVERSATION below. Reply with only that message (do not repeat the [Assistant] label).",
    '',
    '=== SYSTEM INSTRUCTIONS ===',
    system || '(none)',
  ];

  if (tools.length > 0) {
    header.push(
      '',
      '=== TOOLS ===',
      'You can call the tools listed below. To call a tool, output a JSON object in a ```json code block in exactly this shape:',
      '```json',
      '{"tool_call": {"name": "<tool name>", "arguments": {"<param>": "<value>"}}}',
      '```',
      'Rules:',
      '- One tool call per code block; you may output several blocks in one reply.',
      '- After your tool call block(s), STOP. Never write a tool result yourself — it arrives in the next turn as [Tool result: ...].',
      '- Arguments must be valid JSON (escape newlines inside strings as \\n, quotes as \\").',
      '- If no tool is needed, just answer in plain text and output no tool_call block.',
      '',
      'CRITICAL — CONVERSATIONAL SYNTHESIS:',
      '- After receiving [Tool result: ...] entries, you MUST write a natural language response',
      '  explaining what you found, what you did, and what it means. Do NOT just call another tool',
      '  or output an empty response. The user needs to understand what happened.',
      "- Think of it like talking to a colleague: 'I checked the file and here is what I found...'",
      '- Only call another tool if the current task genuinely requires more information.',
      '  If you have enough to answer, STOP calling tools and write your synthesis.',
      '- Never end a turn with just tool calls. Always wrap up with plain text.',
      '',
      'Available tools:',
      ...tools.filter((t) => t.function?.name).map((t) => `- ${compactSignature(t)}`),
    );
  }

  const head = header.join('\n');
  const tail = '\n\n[Assistant]\n';

  let kept = turns.slice();
  const size = () => head.length + 20 + kept.reduce((n, t) => n + t.length + 2, 0) + tail.length;
  let omitted = false;
  while (size() > MAX_PROMPT_CHARS && kept.length > 2) {
    kept.splice(1, 1);
    omitted = true;
  }
  const body = (omitted ? [kept[0], '[…earlier messages omitted…]', ...kept.slice(1)] : kept).join('\n\n');

  return `${head}\n\n=== CONVERSATION ===\n${body}${tail}`;
}

// ---------------------------------------------------------------------------
// Reply parsing
// ---------------------------------------------------------------------------

function balancedEnd(text: string, start: number): number | null {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i + 1; }
  }
  return null;
}

function repairJson(s: string): string {
  let out = '', inStr = false, esc = false;
  for (const c of s) {
    if (inStr) {
      if (esc) { esc = false; out += c; continue; }
      if (c === '\\') { esc = true; out += c; continue; }
      if (c === '"') { inStr = false; out += c; continue; }
      if (c === '\n') { out += '\\n'; continue; }
      if (c === '\r') { out += '\\r'; continue; }
      if (c === '\t') { out += '\\t'; continue; }
      out += c;
    } else {
      if (c === '"') inStr = true;
      out += c;
    }
  }
  return out;
}

function tryParse(s: string): any | undefined {
  try { return JSON.parse(s); } catch {}
  try { return JSON.parse(repairJson(s)); } catch {}
  return undefined;
}

export function parseReply(text: string, toolNames: string[]): ParsedReply {
  const known = new Set(toolNames);
  const calls: ParsedCall[] = [];
  const spans: [number, number][] = [];

  const consider = (start: number) => {
    const end = balancedEnd(text, start);
    if (end == null) return;
    const obj = tryParse(text.slice(start, end));
    const inner = obj?.tool_call ?? (obj && typeof obj.name === 'string' && 'arguments' in obj ? obj : undefined);
    if (!inner || typeof inner.name !== 'string' || !known.has(inner.name)) return;
    const args = inner.arguments ?? inner.args ?? inner.parameters ?? {};
    calls.push({ name: inner.name, arguments: typeof args === 'string' ? args : JSON.stringify(args) });
    spans.push([start, end]);
  };

  const wrapped = /\{\s*"tool_call"\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = wrapped.exec(text))) {
    const before = calls.length;
    consider(m.index);
    if (calls.length > before) wrapped.lastIndex = spans[spans.length - 1][1];
  }
  if (calls.length === 0) {
    const bare = /\{\s*"name"\s*:\s*"([A-Za-z0-9_\-]+)"\s*,\s*"arguments"\s*:/g;
    while ((m = bare.exec(text))) {
      if (!known.has(m[1])) continue;
      const before = calls.length;
      consider(m.index);
      if (calls.length > before) bare.lastIndex = spans[spans.length - 1][1];
    }
  }

  if (calls.length === 0) return { content: text.trim(), calls };

  let content = '';
  let pos = 0;
  for (const [s, e] of spans) { content += text.slice(pos, s); pos = e; }
  content += text.slice(pos);
  content = content
    .replace(/```[a-zA-Z]*\s*```/g, '')
    .replace(/^\s*(json|Copy code|Copy)\s*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { content, calls };
}
