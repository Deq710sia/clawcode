// Agent-loop tests: steering queue, stale runs after New chat, Stop behavior.
// Bundles the real store with esbuild and drives it with a scripted fake model. Run: npm test
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const outDir = 'node_modules/.cache/clawcode-test';
mkdirSync(outDir, { recursive: true });
await build({ entryPoints: ['src/lib/store.ts'], bundle: true, format: 'esm', platform: 'node', outfile: `${outDir}/store.mjs`, external: ['zustand', 'react'], logLevel: 'error' });
const enc = new TextEncoder();
let listeners = { chunk: [], end: [], error: [] };
let script = [];            // each entry: async (send, reqBody) => void ; decides model output
let requests = [];          // captured request bodies
let toolDelay = 0, onToolCall = null;

const sse = (obj) => enc.encode(`data: ${JSON.stringify(obj)}\n\n`);
const textChunk = (t) => sse({ choices: [{ delta: { content: t } }] });
const toolChunk = (id, name, args) => sse({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });
const done = () => enc.encode('data: [DONE]\n\n');

globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.window.claw = {
  accounts: { list: async () => [], markExhausted: async () => ({}), recordUsage: async () => ({}) },
  config: { get: async () => ({ endpoint: 'http://x/v1', model: 'm', systemPrompt: '' }), getApiKey: async () => ({ apiKey: 'k' }), set: async () => ({}) },
  convos: { delete: async () => ({ ok: true }), list: async () => [], load: async () => null, save: async () => ({ ok: true }) },
  net: {
    abort: () => {}, onChunk: (f) => { listeners.chunk.push(f); return () => {}; }, onEnd: (f) => { listeners.end.push(f); return () => {}; }, onError: (f) => { listeners.error.push(f); return () => {}; },
    request: async ({ id, body }) => {
      const parsed = JSON.parse(body); requests.push(parsed);
      const step = script[requests.length - 1];
      setTimeout(async () => {
        const send = (c) => listeners.chunk.forEach((f) => f(id, c));
        await step(send, parsed);
        send(done()); listeners.end.forEach((f) => f(id));
      }, 5);
      return { ok: true, status: 200, statusText: 'OK', headers: { 'content-type': 'text/event-stream' } };
    },
  },
  skills: { installed: async () => [] },
  tool: { invoke: async (name, args) => { if (/^(AGENTS|CLAUDE)\.md$/.test(args?.path ?? '')) return { ok: false, error: 'not found' }; if (onToolCall) await onToolCall(name, args); await new Promise(r => setTimeout(r, toolDelay)); return { ok: true, result: { content: 'FILE CONTENT', path: args?.path } }; } },
  workspace: { get: async () => '/w' },
};

const { useClaw } = await import(pathToFileURL(process.cwd() + '/' + outDir + '/store.mjs').href);
const st = () => useClaw.getState();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const reset = (s) => { requests = []; script = s; useClaw.getState().startNewConversation(); useClaw.setState({ config: { endpoint: 'http://x/v1', model: 'm', systemPrompt: '', hasApiKey: true }, workspace: '/w' }); };
const roles = (body) => body.messages.filter(m => m.role !== 'system').map(m => m.role + (m.tool_calls ? '(tc)' : '') + (m.role === 'user' ? ':' + m.content : ''));
let fails = 0; const check = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + JSON.stringify(extra))); if (!cond) fails++; };

// 1. Steering during a tool round: queued message must land AFTER the tool result.
reset([
  async (send) => send(toolChunk('c1', 'read_file', { path: 'a.txt' })),
  async (send) => send(textChunk('done, adjusted')),
]);
toolDelay = 80;
const p1 = st().sendUserMessage('first task');
await wait(40); await st().sendUserMessage('actually, also do X');
check('1a message queued while streaming', st().queuedMessages.length === 1 || requests.length >= 2, st().queuedMessages);
await p1; await wait(50);
check('1b two model requests', requests.length === 2, requests.length);
check('1c order: user, assistant(tc), tool, user(steer)', JSON.stringify(roles(requests[1])) === JSON.stringify(['user:first task', 'assistant(tc)', 'tool', 'user:actually, also do X']), roles(requests[1]));
check('1d queue drained, not streaming', st().queuedMessages.length === 0 && !st().isStreaming, { q: st().queuedMessages, s: st().isStreaming });
toolDelay = 0;

// 2. Steering while the final answer is streaming: agent must answer the new message too.
reset([
  async (send) => { send(textChunk('part one ')); await wait(120); send(textChunk('part two')); },
  async (send) => send(textChunk('handled the steer')),
]);
const p2 = st().sendUserMessage('hello');
await wait(60); await st().sendUserMessage('one more thing');
await p2; await wait(50);
check('2a follow-up request made', requests.length === 2, requests.length);
check('2b request 2 contains steer after assistant text', JSON.stringify(roles(requests[1])) === JSON.stringify(['user:hello', 'assistant', 'user:one more thing']), requests[1] && roles(requests[1]));
check('2c finished cleanly', !st().isStreaming && st().queuedMessages.length === 0);

// 3. New chat during a run: old run must not write into the new conversation.
reset([
  async (send) => send(toolChunk('c1', 'read_file', { path: 'a.txt' })),
  async (send) => send(textChunk('LATE ANSWER FROM OLD RUN')),
]);
toolDelay = 100;
const p3 = st().sendUserMessage('long task');
await wait(50); st().startNewConversation();
await p3; await wait(250);
check('3a new chat stays empty', st().messages.length === 0, st().messages.map(m => m.role + ':' + m.content));
check('3b not streaming', !st().isStreaming);
check('3c no second model request from stale run', requests.length === 1, requests.length);
toolDelay = 0;

// 4. Stop between rounds: no false "max rounds" notice.
reset([
  async (send) => send(toolChunk('c1', 'read_file', { path: 'a.txt' })),
  async (send) => send(textChunk('should not be requested')),
]);
toolDelay = 100;
const p4 = st().sendUserMessage('task');
await wait(50); st().stopStreaming();
await p4; await wait(250);
const txt = st().messages.map(m => m.content).join('\n');
check('4a no max-rounds notice', !/max|round limit|reached/i.test(txt), txt.slice(-200));
check('4b not streaming', !st().isStreaming);
toolDelay = 0;

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
