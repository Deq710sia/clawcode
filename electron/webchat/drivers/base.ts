/**
 * ClawCode — Base WebChat driver.
 * Defines the contract all site drivers implement. Each driver knows how to:
 *   1. Navigate to its web chat
 *   2. Detect whether the user is logged in
 *   3. Send a message
 *   4. Stream the response back token-by-token
 *   5. Detect completion
 */
import type { Page, BrowserContext } from 'playwright';

export interface SendMessageOpts {
  text: string;
  history?: { role: 'user' | 'assistant'; content: string }[];
  onDelta: (text: string) => void;
  onDone: (fullText: string) => void;
  onError: (err: Error) => void;
  signal?: AbortSignal;
}

export abstract class BaseDriver {
  abstract readonly id: string;
  abstract readonly label: string;
  abstract readonly url: string;

  /** Detect whether the user is logged in (not on a sign-in page). */
  abstract isLoggedIn(page: Page): Promise<boolean>;

  /** Send a message and stream the response. */
  abstract sendMessage(page: Page, opts: SendMessageOpts): Promise<void>;

  /** Optional: pre-navigate hook (e.g., dismiss banners, switch model). */
  async prepare(_page: Page): Promise<void> {}

  /** Optional: select a specific model variant from the web UI. */
  async selectModel(_page: Page, _model: string): Promise<void> {}
}

/** Wait helper that respects an AbortSignal. */
export function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
  });
}

/** Poll a condition until it returns truthy or timeout. */
export async function pollUntil<T>(
  fn: () => Promise<T> | T,
  opts: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<T | null> {
  const interval = opts.intervalMs ?? 400;
  const timeout = opts.timeoutMs ?? 30000;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (opts.signal?.aborted) return null;
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await wait(interval, opts.signal);
  }
  return null;
}

/** Stable text extraction: visible, non-empty, normalized whitespace. */
export function normalizeText(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}
