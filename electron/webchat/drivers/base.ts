/**
 * ClawCode — Base WebChat driver.
 * Defines the contract all site drivers implement, plus the shared reply-watching
 * logic so the per-site drivers only need to describe their selectors.
 */
import type { Page } from 'playwright';

export interface SendMessageOpts {
  text: string;
  onDelta: (text: string) => void;
  onDone: (fullText: string) => void;
  onError: (err: Error) => void;
  signal?: AbortSignal;
}

export interface SiteSelectors {
  composer: string;
  sendButton?: string;
  assistantMessage: string;
  busy?: string;
}

export abstract class BaseDriver {
  abstract readonly id: string;
  abstract readonly label: string;
  abstract readonly url: string;
  protected abstract readonly selectors: SiteSelectors;

  abstract isLoggedIn(page: Page): Promise<boolean>;

  async prepare(_page: Page): Promise<void> {}

  async sendMessage(page: Page, opts: SendMessageOpts): Promise<void> {
    const { text, onDelta, onDone, onError, signal } = opts;
    const sel = this.selectors;
    try {
      const composer = await pollUntil(
        async () => (await visibleHandle(page, sel.composer)),
        { timeoutMs: 20000, signal }
      );
      if (!composer) throw new Error(`Could not find the ${this.label} message box. The site layout may have changed, or you may need to log in again.`);

      const baseline = (await page.$$(sel.assistantMessage)).length;

      await composer.click();
      await composer.fill(text);
      await wait(250, signal);

      let sent = false;
      if (sel.sendButton) {
        const btn = await visibleHandle(page, sel.sendButton);
        if (btn && (await btn.isEnabled().catch(() => true))) {
          try {
            await btn.click();
            sent = true;
          } catch {
            // Click failed (detached element, intercept) — fall through to Enter.
          }
        }
      }
      if (!sent) await page.keyboard.press('Enter');

      const final = await watchReply(page, {
        assistantSelector: sel.assistantMessage,
        busySelector: sel.busy,
        baseline,
        onDelta,
        signal,
      });
      onDone(final);
    } catch (err: any) {
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

export async function visibleHandle(page: Page, selector: string) {
  const handles = await page.$$(selector);
  for (const h of handles) {
    if (await h.isVisible().catch(() => false)) return h;
  }
  return null;
}

interface WatchOpts {
  assistantSelector: string;
  busySelector?: string;
  baseline: number;
  onDelta: (text: string) => void;
  signal?: AbortSignal;
  firstTokenTimeoutMs?: number;
  maxMs?: number;
}

export async function watchReply(page: Page, o: WatchOpts): Promise<string> {
  const firstTokenTimeout = o.firstTokenTimeoutMs ?? 90_000;
  const maxMs = o.maxMs ?? 5 * 60_000;
  const start = Date.now();
  let emitted = '';
  let latest = '';
  let lastChangeAt = Date.now();

  while (true) {
    if (o.signal?.aborted) throw new Error('aborted');
    const now = Date.now();
    if (now - start > maxMs) return latest;

    const bubbles = await page.$$(o.assistantSelector);
    let text = '';
    if (bubbles.length > o.baseline) {
      text = (await bubbles[bubbles.length - 1].innerText().catch(() => '')).replace(/\r\n/g, '\n').trim();
    }

    if (text && text !== latest) {
      latest = text;
      lastChangeAt = now;
      if (text.startsWith(emitted)) {
        const delta = text.slice(emitted.length);
        if (delta) { o.onDelta(delta); emitted = text; }
      }
    }

    if (!latest) {
      if (now - start > firstTokenTimeout) {
        throw new Error('No reply appeared. The site may be showing a captcha/limit message, or its layout changed.');
      }
    } else {
      const stableFor = now - lastChangeAt;
      const busy = o.busySelector ? !!(await visibleHandle(page, o.busySelector)) : false;
      if ((!busy && stableFor >= 2000) || stableFor >= 30_000) {
        return latest;
      }
    }
    await wait(350, o.signal);
  }
}

export function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new Error('aborted')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

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

export function normalizeText(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}
