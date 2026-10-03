/**
 * fetch() replacement that performs the request in the Electron main process.
 *
 * The renderer loads from file:// (origin "null"), so the browser's CORS rules block
 * direct calls to many LLM endpoints. Routing through main avoids CORS entirely and
 * uses Chromium's network stack (system proxy, certificates). The result is a normal
 * `Response` with a streaming body, so SSE parsing code is unchanged.
 */
type Controller = ReadableStreamDefaultController<Uint8Array>;

const streams = new Map<string, Controller>();
let listening = false;

function ensureListeners() {
  if (listening) return;
  listening = true;
  window.claw.net.onChunk((id, chunk) => {
    try { streams.get(id)?.enqueue(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as any)); } catch {}
  });
  window.claw.net.onEnd((id) => {
    const c = streams.get(id);
    streams.delete(id);
    try { c?.close(); } catch {}
  });
  window.claw.net.onError((id, message) => {
    const c = streams.get(id);
    streams.delete(id);
    try {
      c?.error(message === 'aborted' ? new DOMException('Aborted', 'AbortError') : new Error(message));
    } catch {}
  });
}

function newId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `net_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function proxyFetch(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal } = {}
): Promise<Response> {
  ensureListeners();
  const id = newId();

  if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const body = new ReadableStream<Uint8Array>({
    start(controller) { streams.set(id, controller); },
    cancel() { streams.delete(id); window.claw.net.abort(id); },
  });

  const onAbort = () => {
    window.claw.net.abort(id);
    const c = streams.get(id);
    streams.delete(id);
    try { c?.error(new DOMException('Aborted', 'AbortError')); } catch {}
  };
  init.signal?.addEventListener('abort', onAbort, { once: true });

  const meta = await window.claw.net.request({
    id,
    url,
    method: init.method,
    headers: init.headers,
    body: init.body,
  });

  if (!meta.ok) {
    streams.delete(id);
    init.signal?.removeEventListener('abort', onAbort);
    if (init.signal?.aborted || meta.error === 'aborted') throw new DOMException('Aborted', 'AbortError');
    throw new Error(meta.error);
  }

  const nullBody = [101, 204, 205, 304].includes(meta.status);
  return new Response(nullBody ? null : body, {
    status: meta.status,
    statusText: meta.statusText,
    headers: meta.headers,
  });
}
