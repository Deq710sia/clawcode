/**
 * ClawCode — Base WebChat driver.
 * Defines the contract all site drivers implement, plus the shared reply-watching
 * logic so the per-site drivers only need to describe their selectors.
 */
import type { Page } from 'playwright';
import { domToMarkdown } from './dom-markdown.js';

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

  /** True when the open page already shows an assistant reply (so a follow-up can be typed into it). */
  async hasConversation(page: Page): Promise<boolean> {
    return (await page.$$(this.selectors.assistantMessage)).length > 0;
  }

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

      // Plain <textarea>/<input> composers take fill() directly. Rich contenteditable editors
      // (Claude's ProseMirror, Gemini's editor) can collapse newlines out of filled text, which
      // would silently corrupt multi-line prompts. Verify what landed; on mismatch, paste instead.
      const plain = await composer.evaluate((el: any) => el.tagName === 'TEXTAREA' || el.tagName === 'INPUT').catch(() => false);
      let typed = false;
      if (plain) {
        await composer.fill(text);
        typed = true;
      } else {
        await composer.fill(text).catch(() => {});
        typed = await this.textLanded(composer, text);
        if (!typed) {
          await this.pasteIntoEditor(page, text);
          typed = await this.textLanded(composer, text);
          if (!typed) throw new Error(`Could not enter the message into ${this.label}. The editor refused the text; the site layout may have changed.`);
        }
      }
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

  /** True when the editable holds (approximately) the text we tried to enter. */
  private async textLanded(composer: any, text: string): Promise<boolean> {
    const got = await composer.evaluate((el: any) => String(el.textContent ?? el.value ?? '')).catch(() => null);
    if (got == null) return true; // cannot read the editor — assume it worked, as before this check existed
    return Math.abs(got.length - text.length) <= Math.max(80, Math.floor(text.length * 0.05));
  }

  /** Paste via the clipboard API; every chat editor handles pasted multi-line text like a user paste. */
  private async pasteIntoEditor(page: Page, text: string): Promise<void> {
    try {
      const wrote = await page.evaluate(async (t: string) => {
        try { await (globalThis as any).navigator.clipboard.writeText(t); return true; } catch { return false; }
      }, text);
      if (!wrote) return;
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Control+V');
      await page.waitForTimeout(150);
    } catch {
      // Clipboard unavailable — the text that fill() did land is our best effort.
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
      const bubble = bubbles[bubbles.length - 1];
      // DOM → markdown (code fences, list markers, emphasis, KaTeX) instead of innerText's
      // flattened text. innerText stays as the fallback: it beats an empty string.
      const raw = await bubble.evaluate(domToMarkdown).catch(() =>
        bubble.innerText().catch(() => '')
      );
      text = String(raw).replace(/\r\n/g, '\n').trim();
    }

    if (text && text !== latest) {
      latest = text;
      lastChangeAt = now;
      // Stream only complete lines: the markdown shape of the line still being typed can
      // change (list marker, fence, emphasis), which would garble a mid-line cut.
      const safe = text.slice(0, text.lastIndexOf('\n') + 1);
      if (safe.length > emitted.length && safe.startsWith(emitted)) {
        o.onDelta(safe.slice(emitted.length));
        emitted = safe;
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
