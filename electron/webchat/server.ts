/**
 * ClawCode — WebChat Bridge HTTP server.
 * Exposes OpenAI-compatible /v1/chat/completions on 127.0.0.1:7777.
 * Routes requests to the right web chat based on the `model` field.
 *
 * Because web chats have no function-calling API, `tools` and tool results are translated
 * to/from a text protocol (see toolprotocol.ts) so the agent loop works over them.
 *
 * Security: this server drives logged-in browser sessions, so it must not be reachable
 * from web pages. No CORS headers are sent, cross-origin browser requests (Origin header)
 * are rejected unless they carry the per-launch token, and the Host header must be loopback
 * (blocks DNS-rebinding).
 */
import express from 'express';
import { randomBytes } from 'node:crypto';
import { query, getBridgeStatus, getChatState, setChatState, clearChatState, type WebChatId } from './bridge.js';
import { buildPrompt, buildContinuationPrompt, parseReply, type OAIMessage, type OAITool } from './toolprotocol.js';
import { planTurn, nextState } from './continuation.js';

export const BRIDGE_PORT = 7777;
const HOST = '127.0.0.1';
export const BRIDGE_TOKEN = randomBytes(16).toString('hex');
export const BRIDGE_TOKEN_HEADER = 'x-clawcode-bridge-token';

let server: any = null;

function modelToWebChat(model: string): WebChatId | null {
  const m = (model || '').toLowerCase();
  if (m.includes('claude')) return 'claude';
  if (m.includes('chatgpt') || m.includes('openai') || m.includes('gpt')) return 'chatgpt';
  if (m.includes('gemini') || m.includes('google')) return 'gemini';
  if (m.includes('grok') || m.includes('xai')) return 'grok';
  if (m.includes('deepseek')) return 'deepseek';
  return null;
}

const MODEL_IDS: Record<string, string> = {
  claude: 'claude.ai',
  chatgpt: 'chatgpt.com',
  gemini: 'gemini.google.com',
  grok: 'grok.com',
  deepseek: 'deepseek.com',
};

function streamableLength(full: string): number {
  const lead = full.trimStart();
  if (lead.length > 0 && lead.length < '[Assistant]'.length && '[Assistant]'.startsWith(lead)) return 0;
  const fence = full.indexOf('```');
  const brace = full.search(/\{\s*"tool_call"/);
  let cut = full.length;
  if (fence !== -1) cut = Math.min(cut, fence);
  if (brace !== -1) cut = Math.min(cut, brace);
  while (cut > 0 && full[cut - 1] === '`') cut--;
  if (cut < full.length) cut = full.slice(0, cut).trimEnd().length;
  return cut;
}

const stripLabel = (s: string) => s.replace(/^\s*\[Assistant\]\s*/i, '');

export function startBridgeServer(): Promise<{ ok: boolean; port?: number; error?: string }> {
  return new Promise((resolve) => {
    if (server) {
      resolve({ ok: true, port: BRIDGE_PORT });
      return;
    }
    const app = express();

    app.use((req, res, next) => {
      const host = (req.headers.host || '').toLowerCase();
      if (!(host === `127.0.0.1:${BRIDGE_PORT}` || host === `localhost:${BRIDGE_PORT}`)) {
        res.status(403).json({ error: { message: 'Forbidden host', type: 'forbidden' } });
        return;
      }
      if (req.headers.origin && req.headers[BRIDGE_TOKEN_HEADER] !== BRIDGE_TOKEN) {
        res.status(403).json({ error: { message: 'Cross-origin requests are not allowed', type: 'forbidden' } });
        return;
      }
      next();
    });
    app.use(express.json({ limit: '20mb' }));

    app.get('/v1/models', (_req, res) => {
      const data = getBridgeStatus().map((p) => ({
        id: MODEL_IDS[p.id] ?? p.id,
        object: 'model' as const,
        created: Math.floor(Date.now() / 1000),
        owned_by: 'clawcode-webchat',
      }));
      res.json({ object: 'list', data });
    });

    app.get('/v1/bridge/status', (_req, res) => {
      res.json({ profiles: getBridgeStatus() });
    });

    app.post('/v1/chat/completions', async (req, res) => {
      const { model, messages, stream, tools } = (req.body || {}) as {
        model?: string; messages?: OAIMessage[]; stream?: boolean; tools?: OAITool[];
      };
      const webChatId = modelToWebChat(model || '');
      if (!webChatId) {
        res.status(400).json({ error: { message: `Unknown model: ${model}. Use claude.ai / chatgpt.com / gemini.google.com / grok.com / deepseek.com`, type: 'invalid_request_error' } });
        return;
      }
      if (!Array.isArray(messages) || !messages.some((m) => m?.role === 'user')) {
        res.status(400).json({ error: { message: 'messages must contain at least one user message', type: 'invalid_request_error' } });
        return;
      }

      const toolList = Array.isArray(tools) ? tools.filter((t) => t?.function?.name) : [];
      const toolNames = toolList.map((t) => t.function!.name);
      const toolMode = toolList.length > 0;

      const onlyUser = messages.length === 1 && messages[0].role === 'user';
      const freshText = onlyUser && !toolMode
        ? (typeof messages[0].content === 'string' ? messages[0].content : buildPrompt(messages, []))
        : buildPrompt(messages, toolList);

      // Continue the open web chat (send only what is new) when this request extends the previous one exactly.
      const plan = onlyUser && !toolMode ? { mode: 'fresh' as const, deltaStart: 0 } : planTurn(getChatState(webChatId), messages, toolList);
      const textFor = (mode: 'continue' | 'fresh') => (mode === 'continue' ? buildContinuationPrompt(messages, plan.deltaStart) : freshText);

      const requestId = `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const created = Math.floor(Date.now() / 1000);

      const abort = new AbortController();
      res.on('close', () => { if (!res.writableEnded) abort.abort(); });

      const mkCalls = (calls: { name: string; arguments: string }[]) =>
        calls.map((c, i) => ({
          index: i,
          id: `call_${Math.random().toString(36).slice(2, 10)}`,
          type: 'function' as const,
          function: { name: c.name, arguments: c.arguments },
        }));

      /**
       * Run one turn. A failed continuation (page moved, site changed) is retried ONCE as a fresh chat with the
       * full transcript, but only if nothing was shown yet. Any failure drops the chat state, so the next request
       * starts clean instead of building on a half-finished site conversation.
       */
      const run = async (
        mode: 'continue' | 'fresh',
        h: { started: () => boolean; reset?: () => void; onDelta: (d: string) => void; onDone: (finalText: string) => void; onError: (e: Error) => void },
      ): Promise<void> => {
        let failure: Error | null = null;
        await query(webChatId, {
          text: textFor(mode),
          continueChat: mode === 'continue',
          signal: abort.signal,
          onDelta: h.onDelta,
          onDone: h.onDone,
          onError: (e) => { failure = e; },
        });
        if (failure) {
          clearChatState(webChatId);
          if (mode === 'continue' && !abort.signal.aborted && !h.started()) {
            h.reset?.();
            return run('fresh', h);
          }
          h.onError(failure);
        }
      };

      /** Remember what the site's chat now contains, so the next request can continue it. */
      const remember = (reply: { content: string; calls: { name: string; arguments: string }[] }) => {
        if (!reply.content.trim() && reply.calls.length === 0) clearChatState(webChatId);
        else setChatState(webChatId, nextState(messages, toolList, reply));
      };

      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();

        const send = (delta: any, finish: string | null = null) => {
          if (res.writableEnded) return;
          res.write(`data: ${JSON.stringify({
            id: requestId, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`);
        };
        const end = () => { if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); } };

        let full = '';
        let sentText = '';
        const reset = () => { full = ''; sentText = ''; };
        await run(plan.mode, {
          started: () => sentText.length > 0,
          reset,
          onDelta: (d) => {
            full += d;
            const cleaned = stripLabel(full);
            const safe = toolMode ? cleaned.slice(0, streamableLength(cleaned)) : cleaned;
            if (safe.length > sentText.length && safe.startsWith(sentText)) {
              send({ content: safe.slice(sentText.length) });
              sentText = safe;
            }
          },
          onDone: (finalText) => {
            const finalClean = stripLabel(finalText || full);
            if (toolMode) {
              const parsed = parseReply(finalClean, toolNames);
              if (parsed.content.startsWith(sentText) && parsed.content.length > sentText.length) {
                send({ content: parsed.content.slice(sentText.length) });
              } else if (!sentText && parsed.content) {
                send({ content: parsed.content });
              }
              remember(parsed);
              if (parsed.calls.length > 0) {
                send({ tool_calls: mkCalls(parsed.calls) });
                send({}, 'tool_calls');
              } else {
                send({}, 'stop');
              }
            } else {
              if (finalClean.startsWith(sentText) && finalClean.length > sentText.length) {
                send({ content: finalClean.slice(sentText.length) });
              }
              remember({ content: finalClean, calls: [] });
              send({}, 'stop');
            }
            end();
          },
          onError: (err) => {
            reset();
            // A real stream error (not assistant text): the client shows it as an error and nothing is added to history.
            if (!abort.signal.aborted && !res.writableEnded) {
              res.write(`data: ${JSON.stringify({ error: { message: err.message, type: 'bridge_error' } })}\n\n`);
            }
            end();
          },
        });
      } else {
        await run(plan.mode, {
          started: () => false,
          onDelta: () => {},
          onDone: (finalText) => {
            const clean = stripLabel(finalText);
            const parsed = toolMode ? parseReply(clean, toolNames) : { content: clean, calls: [] as { name: string; arguments: string }[] };
            remember(parsed);
            const message: any = { role: 'assistant', content: parsed.content || (parsed.calls.length ? null : '') };
            if (parsed.calls.length > 0) message.tool_calls = mkCalls(parsed.calls).map(({ index: _i, ...c }) => c);
            res.json({
              id: requestId, object: 'chat.completion', created, model,
              choices: [{ index: 0, message, finish_reason: parsed.calls.length ? 'tool_calls' : 'stop' }],
              usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            });
          },
          onError: (err) => {
            if (!res.headersSent) res.status(502).json({ error: { message: err.message, type: 'bridge_error' } });
          },
        });
      }
    });

    app.get('/health', (_req, res) => res.json({ ok: true, port: BRIDGE_PORT }));

    app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (res.headersSent) return;
      res.status(err?.status || 500).json({ error: { message: err?.message ?? 'Internal error', type: 'server_error' } });
    });

    server = app.listen(BRIDGE_PORT, HOST);
    server.once('listening', () => resolve({ ok: true, port: BRIDGE_PORT }));
    server.once('error', (err: any) => {
      server = null;
      resolve({
        ok: false,
        error: err?.code === 'EADDRINUSE'
          ? `Port ${BRIDGE_PORT} is already in use. WebChat providers will not work until it is free.`
          : err?.message ?? String(err),
      });
    });
  });
}

export function stopBridgeServer() {
  if (server) {
    server.close();
    server = null;
  }
}
