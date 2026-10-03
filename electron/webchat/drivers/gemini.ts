/**
 * ClawCode — Gemini driver.
 * Drives https://gemini.google.com/app to send messages and stream responses.
 * Selectors current as-of 2025-Q1; multiple fallbacks included.
 */
import type { Page } from 'playwright';
import { BaseDriver, SendMessageOpts, wait, pollUntil, normalizeText } from './base.js';

export class GeminiDriver extends BaseDriver {
  readonly id = 'gemini';
  readonly label = 'Gemini';
  readonly url = 'https://gemini.google.com/app';

  async isLoggedIn(page: Page): Promise<boolean> {
    const url = page.url();
    if (url.includes('accounts.google.com') || url.includes('ServiceLogin')) return false;
    const composer = await pollUntil(
      () => page.$('rich-textarea, textarea[aria-label*="Prompt"], div[contenteditable="true"][aria-label*="Prompt"]'),
      { timeoutMs: 8000 }
    );
    return !!composer;
  }

  async prepare(page: Page): Promise<void> {
    // Dismiss any welcome / cookie banners
    try {
      const dismiss = await page.$('button:has-text("Accept all"), button:has-text("Dismiss"), button:has-text("Skip"), button[aria-label="Close"]');
      if (dismiss) await dismiss.click().catch(() => {});
    } catch {}
  }

  async sendMessage(page: Page, opts: SendMessageOpts): Promise<void> {
    const { text, onDelta, onDone, onError, signal } = opts;

    try {
      const composer = await pollUntil(
        () => page.$('rich-textarea, div[contenteditable="true"][aria-label*="Prompt"]'),
        { timeoutMs: 15000, signal }
      );
      if (!composer) throw new Error('Could not find Gemini composer');

      await composer.click();
      // Gemini's rich-textarea uses contenteditable; type character by character is slow, use keyboard.type
      await page.keyboard.type(text, { delay: 5 });
      await wait(300, signal);

      // Press Enter (Gemini uses Enter to send)
      await page.keyboard.press('Enter');

      let lastText = '';
      let stableCount = 0;
      const startTime = Date.now();
      const maxWait = 5 * 60 * 1000;

      while (Date.now() - startTime < maxWait) {
        if (signal?.aborted) { onError(new Error('aborted')); return; }

        // Gemini renders the response inside <message-content> elements
        const lastAssistant = await page.$(
          'message-content:last-of-type, .model-response-text:last-of-type, .response-container:last-of-type'
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
            // Gemini shows a "copy" button when done; absence of "Generating..." or progress indicator
            const generating = await page.$('.generating-indicator, .loading-dots, [aria-busy="true"]');
            if (!generating) {
              onDone(lastText);
              return;
            }
          }
        }
        await wait(500, signal);
      }
      onDone(lastText);
    } catch (err: any) {
      if (err?.message === 'aborted') { onError(err); return; }
      onError(err);
    }
  }
}
