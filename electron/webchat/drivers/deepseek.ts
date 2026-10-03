/**
 * ClawCode — DeepSeek.com driver.
 * Drives https://chat.deepseek.com/ to send messages and stream responses.
 */
import type { Page } from 'playwright';
import { BaseDriver, SendMessageOpts, wait, pollUntil, normalizeText } from './base.js';

export class DeepSeekDriver extends BaseDriver {
  readonly id = 'deepseek';
  readonly label = 'DeepSeek';
  readonly url = 'https://chat.deepseek.com/';

  async isLoggedIn(page: Page): Promise<boolean> {
    const url = page.url();
    if (url.includes('sign_in') || url.includes('login')) return false;
    const composer = await pollUntil(
      () => page.$('textarea[id*="chat"], textarea[placeholder*="Message"], textarea[placeholder*="问"], div[contenteditable="true"]'),
      { timeoutMs: 8000 }
    );
    return !!composer;
  }

  async sendMessage(page: Page, opts: SendMessageOpts): Promise<void> {
    const { text, onDelta, onDone, onError, signal } = opts;

    try {
      const composer = await pollUntil(
        () => page.$('textarea[id*="chat"], textarea[placeholder*="Message"], textarea[placeholder*="问"], textarea'),
        { timeoutMs: 15000, signal }
      );
      if (!composer) throw new Error('Could not find DeepSeek composer');

      await composer.fill(text);
      await wait(200, signal);
      await page.keyboard.press('Enter');

      let lastText = '';
      let stableCount = 0;
      const startTime = Date.now();
      const maxWait = 5 * 60 * 1000;

      while (Date.now() - startTime < maxWait) {
        if (signal?.aborted) { onError(new Error('aborted')); return; }

        // DeepSeek renders markdown response in a div with class containing "markdown"
        const lastAssistant = await page.$(
          'div[class*="markdown"]:last-of-type, div[class*="message-content"]:last-of-type, div.ds-markdown:last-of-type'
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
            const stopBtn = await page.$('button[aria-label*="Stop"], button:has-text("Stop")');
            if (!stopBtn) { onDone(lastText); return; }
          }
        }
        await wait(450, signal);
      }
      onDone(lastText);
    } catch (err: any) {
      if (err?.message === 'aborted') { onError(err); return; }
      onError(err);
    }
  }
}
