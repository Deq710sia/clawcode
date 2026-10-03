/**
 * Decides whether a request can continue the web chat opened by the previous request
 * (send only the new messages) or must start a fresh chat (send the full transcript).
 *
 * The HTTP interface stays stateless like any OpenAI-compatible API: continuation is only
 * used when the incoming history is EXACTLY the previous history + the reply we produced +
 * new messages. Anything else (edited history, truncation, different system prompt or tools,
 * a stopped reply) falls back to a fresh chat, so results never depend on hidden state.
 */
import { createHash } from 'node:crypto';
import { contentToText, type OAIMessage, type OAITool } from './toolprotocol.js';

export interface ChatState {
  /** Hash of everything the first message of the web chat carried: system prompt + tool signatures. */
  head: string;
  /** Signatures of every message the site's chat already contains, in order (incl. our last reply). */
  sigs: string[];
}

const norm = (t: string) => t.replace(/\s+/g, ' ').trim();
const hash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 16);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function canonicalArgs(args: string | undefined): string {
  if (!args) return '{}';
  try { return canonical(JSON.parse(args)); } catch { return norm(args); }
}

export function assistantSig(content: string, calls: { name: string; arguments: string }[]): string {
  return hash('assistant|' + norm(content) + '|' + calls.map((c) => c.name + canonicalArgs(c.arguments)).join(';'));
}

export function messageSig(m: OAIMessage): string {
  if (m.role === 'assistant') {
    const calls = (m.tool_calls ?? []).map((tc) => ({ name: tc.function?.name ?? '', arguments: tc.function?.arguments ?? '{}' }));
    return assistantSig(contentToText(m.content), calls);
  }
  return hash(m.role + '|' + norm(contentToText(m.content)));
}

export function headHash(messages: OAIMessage[], tools: OAITool[]): string {
  const system = messages.filter((m) => m.role === 'system').map((m) => norm(contentToText(m.content))).join('\n');
  return hash(system + '||' + canonical(tools.map((t) => t.function ?? {})));
}

export interface TurnPlan {
  mode: 'continue' | 'fresh';
  /** Index into the non-system messages where the new (unsent) messages begin. Only for 'continue'. */
  deltaStart: number;
}

export function planTurn(state: ChatState | undefined, messages: OAIMessage[], tools: OAITool[]): TurnPlan {
  const fresh: TurnPlan = { mode: 'fresh', deltaStart: 0 };
  if (!state) return fresh;
  if (state.head !== headHash(messages, tools)) return fresh;
  const convo = messages.filter((m) => m.role !== 'system');
  const k = state.sigs.length;
  if (k === 0 || convo.length <= k) return fresh; // nothing new to send
  for (let i = 0; i < k; i++) if (messageSig(convo[i]) !== state.sigs[i]) return fresh;
  // The new part must contain no assistant turn: the site never saw those.
  if (convo.slice(k).some((m) => m.role === 'assistant')) return fresh;
  return { mode: 'continue', deltaStart: k };
}

/** State after a successful reply: the site's chat now holds `messages` + our reply. */
export function nextState(messages: OAIMessage[], tools: OAITool[], reply: { content: string; calls: { name: string; arguments: string }[] }): ChatState {
  const convo = messages.filter((m) => m.role !== 'system');
  return { head: headHash(messages, tools), sigs: [...convo.map(messageSig), assistantSig(reply.content, reply.calls)] };
}
