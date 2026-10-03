/**
 * ClawCode — WebChat Bridge HTTP server.
 * Exposes OpenAI-compatible /v1/chat/completions on 127.0.0.1:7777.
 * Routes requests to the right web chat based on the `model` field.
 *
 * Model → web chat mapping:
 *   "claude.ai"    → claude
 *   "chatgpt.com"  → chatgpt
 *   "gemini.google.com" → gemini
 *   "grok.com"     → grok
 *   "deepseek.com" → deepseek
 */
import express from 'express';
import cors from 'cors';
import { query, getBridgeStatus, type WebChatId } from './bridge.js';

const PORT = 7777;
const HOST = '127.0.0.1';

let server: any = null;

function modelToWebChat(model: string): WebChatId | null {
  const m = (model || '').toLowerCase();
  if (m.includes('claude')) return 'claude';
  if (m.includes('chatgpt') || m.includes('openai') || m.includes('gpt')) return 'chatgpt';
  if (m.includes('gemini') || m.includes('google')) return 'gemini';
  if (m.includes('grok') || m.includes('xai')) return 'grok';
  if (m.includes('deepseek')) return 'deepseek';
  // Direct match
  if (m === 'claude.ai') return 'claude';
  if (m === 'chatgpt.com') return 'chatgpt';
  if (m === 'gemini.google.com') return 'gemini';
  if (m === 'grok.com') return 'grok';
  if (m === 'deepseek.com') return 'deepseek';
  return null;
}

export function startBridgeServer(): Promise<{ ok: boolean; port?: number; error?: string }> {
  return new Promise((resolve) => {
    if (server) {
      resolve({ ok: true, port: PORT });
      return;
    }
    const app = express();
    app.use(cors());
    app.use(express.json({ limit: '10mb' }));

    // GET /v1/models — list available web chats as models
    app.get('/v1/models', (_req, res) => {
      const profiles = getBridgeStatus();
      const data = profiles.map((p) => ({
        id: p.id === 'claude' ? 'claude.ai' :
            p.id === 'chatgpt' ? 'chatgpt.com' :
            p.id === 'gemini' ? 'gemini.google.com' :
            p.id === 'grok' ? 'grok.com' :
            p.id === 'deepseek' ? 'deepseek.com' : p.id,
        object: 'model' as const,
        created: Math.floor(Date.now() / 1000),
        owned_by: 'clawcode-webchat',
      }));
      res.json({ object: 'list', data });
    });

    // GET /v1/bridge/status — ClawCode-specific status endpoint
    app.get('/v1/bridge/status', (_req, res) => {
      res.json({ profiles: getBridgeStatus() });
    });

    // POST /v1/chat/completions — stream a response from the web chat
    app.post('/v1/chat/completions', async (req, res) => {
      const { model, messages, stream } = req.body || {};
      const webChatId = modelToWebChat(model || '');
      if (!webChatId) {
        res.status(400).json({ error: { message: `Unknown model: ${model}. Use claude.ai / chatgpt.com / gemini.google.com / grok.com / deepseek.com`, type: 'invalid_request_error' } });
        return;
      }

      // Concatenate the conversation: we send only the last user message to the web chat.
      // (Web chats don't have a clean API to inject multi-turn history; we trust that
      // the active conversation in the browser is the source of truth.)
      const lastUser = [...messages].reverse().find((m: any) => m.role === 'user');
      if (!lastUser) {
        res.status(400).json({ error: { message: 'No user message found', type: 'invalid_request_error' } });
        return;
      }
      const text = typeof lastUser.content === 'string'
        ? lastUser.content
        : Array.isArray(lastUser.content)
          ? lastUser.content.map((c: any) => c.text || '').join('\n')
          : '';

      const requestId = `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const created = Math.floor(Date.now() / 1000);

      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();

        const send = (obj: any) => {
          res.write(`data: ${JSON.stringify(obj)}\n\n`);
        };

        const abort = new AbortController();
        req.on('close', () => abort.abort());

        await query(webChatId, {
          text,
          signal: abort.signal,
          onDelta: (delta) => {
            send({
              id: requestId,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
            });
          },
          onDone: (_full) => {
            send({
              id: requestId,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            });
            res.write('data: [DONE]\n\n');
            res.end();
          },
          onError: (err) => {
            send({
              id: requestId,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{ index: 0, delta: { content: `\n\n[bridge error] ${err.message}` }, finish_reason: 'stop' }],
            });
            res.write('data: [DONE]\n\n');
            res.end();
          },
        });
      } else {
        // Non-streaming: collect full response then return
        let full = '';
        const abort = new AbortController();
        req.on('close', () => abort.abort());

        await query(webChatId, {
          text,
          signal: abort.signal,
          onDelta: (d) => { full += d; },
          onDone: (done) => {
            res.json({
              id: requestId,
              object: 'chat.completion',
              created,
              model,
              choices: [{ index: 0, message: { role: 'assistant', content: done }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            });
          },
          onError: (err) => {
            res.status(502).json({ error: { message: err.message, type: 'bridge_error' } });
          },
        });
      }
    });

    app.get('/health', (_req, res) => res.json({ ok: true, port: PORT }));

    server = app.listen(PORT, HOST, () => {
      resolve({ ok: true, port: PORT });
    });
    server.on('error', (err: any) => {
      resolve({ ok: false, error: err?.message ?? String(err) });
    });
  });
}

export function stopBridgeServer() {
  if (server) {
    server.close();
    server = null;
  }
}
