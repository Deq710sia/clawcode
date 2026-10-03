/**
 * ClawCode — ChatGPT.com driver.
 * Drives https://chatgpt.com/ to send messages and stream responses.
 * Selectors current as of 2025-Q1; multiple fallbacks included.
 */
import type { Page } from 'playwright';
import { BaseDriver, SendMessageOpts, wait, pollUntil, normalizeText } from './base.js';

export class ChatGPTDriver extends BaseDriver {
  readonly id = 'chatgpt';
  readonly label = 'ChatGPT.com';
  readonly url = 'https://chatgpt.com/';

  async isLoggedIn(page: Page): Promise<boolean> {
    const url = page.url();
    if (url.includes('auth') || url.includes('login')) return false;
    const composer = await pollUntil(
      () => page.$('#prompt-textarea, textarea[placeholder*="Message"], div[contenteditable="true"][id*="prompt"]'),
      { timeoutMs: 8000 }
    );
    return !!composer;
  }

  async prepare(page: Page): Promise<void> {
    // Dismiss login nudge / banners
    try {
      const dismiss = await page.$('button:has-text("Stay logged out"), button:has-text("Dismiss"), button[aria-label="Close"]');
      if (dismiss) await dismiss.click().catch(() => {});
    } catch {}
  }

  async sendMessage(page: Page, opts: SendMessageOpts): Promise<void> {
    const { text, onDelta, onDone, onError, signal } = opts;

    try {
      const composer = await pollUntil(
        () => page.$('#prompt-textarea, div#prompt-textarea, textarea[data-testid="prompt-textarea"]'),
        { timeoutMs: 15000, signal }
      );
      if (!composer) throw new Error('Could not find ChatGPT composer');

      await composer.click();
      await composer.fill(text);
      await wait(200, signal);

      // Find and click the send button (more reliable than Enter on ChatGPT)
      const sendBtn = await page.$('button[data-testid="send-button"], button[aria-label="Send prompt"]');
      if (sendBtn) {
        await sendBtn.click();
      } else {
        await page.keyboard.press('Enter');
      }

      let lastText = '';
      let stableCount = 0;
      const startTime = Date.now();
      const maxWait = 5 * 60 * 1000;

      while (Date.now() - startTime < maxWait) {
        if (signal?.aborted) { onError(new Error('aborted')); return; }

        // ChatGPT marks the streaming message with a data-message attribute
        const lastAssistant = await page.$(
          '[data-testid="conversation-turn-2"] [data-message-author-role="assistant"], ' +
          'div[data-message-author-role="assistant"]:last-of-type'
        );

        let currentText = '';
        if (lastAssistant) {
          currentText = normalizeText(await lastAssistant.innerText().catch(() => ''));
        }

        if (currentText && currentText !== lastText) {
          if (currentText.startsWith(lastText)) {
            onDelta(currentText.slice(lastText.length));
          } else {
            onDelta(currentText);
          }
          lastText = currentText;
          stableCount = 0;
        } else if (currentText && currentText === lastText) {
          stableCount++;
          if (stableCount > 6 && lastText.length > 0) {
            // Check for absence of the stop-streaming button
            const stopBtn = await page.$('button[data-testid="stop-button"], button[aria-label="Stop streaming"]');
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
