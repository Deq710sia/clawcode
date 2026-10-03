/**
 * ClawCode — Claude.ai driver.
 * Drives https://claude.ai/new to send messages and stream responses.
 * Selectors current as of 2025-Q1; multiple fallbacks included.
 */
import type { Page } from 'playwright';
import { BaseDriver, SendMessageOpts, wait, pollUntil, normalizeText } from './base.js';

export class ClaudeDriver extends BaseDriver {
  readonly id = 'claude';
  readonly label = 'Claude.ai';
  readonly url = 'https://claude.ai/new';

  async isLoggedIn(page: Page): Promise<boolean> {
    const url = page.url();
    if (url.includes('login') || url.includes('signin')) return false;
    // Claude.ai shows the composer when logged in
    const composer = await pollUntil(
      () => page.$('div[contenteditable="true"], textarea[data-testid="chat-message-input"], #chat-message-input'),
      { timeoutMs: 8000 }
    );
    return !!composer;
  }

  async prepare(page: Page): Promise<void> {
    // Dismiss any "what's new" / banner dialogs
    try {
      const dismiss = await page.$('button:has-text("Dismiss"), button:has-text("Close"), button[aria-label="Close"]');
      if (dismiss) await dismiss.click().catch(() => {});
    } catch {}
  }

  async sendMessage(page: Page, opts: SendMessageOpts): Promise<void> {
    const { text, onDelta, onDone, onError, signal } = opts;

    try {
      // Find the composer
      const composer = await pollUntil(
        () => page.$('div[contenteditable="true"][role="textbox"], div.ProseMirror[contenteditable="true"], textarea[data-testid="chat-message-input"]'),
        { timeoutMs: 15000, signal }
      );
      if (!composer) throw new Error('Could not find Claude.ai composer');

      await composer.click();
      await composer.fill(text);
      await wait(200, signal);

      // Press Enter to send (Claude.ai uses Enter to send, Shift+Enter for newline)
      await page.keyboard.press('Enter');

      // Stream the response: poll the last assistant message
      let lastText = '';
      let stableCount = 0;
      const startTime = Date.now();
      const maxWait = 5 * 60 * 1000; // 5 min cap

      while (Date.now() - startTime < maxWait) {
        if (signal?.aborted) { onError(new Error('aborted')); return; }

        // Find the latest assistant message bubble
        const lastAssistant = await page.$(
          'div[data-testid="user-message"] + div [data-testid="message-text-content"], ' +
          'font-claude-message + div, ' +
          'div[class*="message-content"]:last-of-type, ' +
          '[data-testid="assistant-message"] [data-testid="message-text-content"]'
        );

        let currentText = '';
        if (lastAssistant) {
          currentText = normalizeText(await lastAssistant.innerText().catch(() => ''));
        }

        if (currentText && currentText !== lastText) {
          // Emit only the delta
          if (currentText.startsWith(lastText)) {
            onDelta(currentText.slice(lastText.length));
          } else {
            // Text changed unexpectedly; emit full as a single delta
            onDelta(currentText);
          }
          lastText = currentText;
          stableCount = 0;
        } else if (currentText && currentText === lastText) {
          stableCount++;
          // If the response hasn't changed for ~2.5s AND there's text, assume done
          if (stableCount > 6 && lastText.length > 0) {
            // Also check that the stop-button is gone
            const stopBtn = await page.$('button[aria-label="Stop"], button[data-testid="stop-button"]');
            if (!stopBtn) {
              onDone(lastText);
              return;
            }
          }
        }
        await wait(400, signal);
      }

      onDone(lastText);
    } catch (err: any) {
      if (err?.message === 'aborted') { onError(err); return; }
      onError(err);
    }
  }
}
