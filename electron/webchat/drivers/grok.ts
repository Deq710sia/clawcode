/**
 * ClawCode — Grok.com driver.
 * Drives https://grok.com/ to send messages and stream responses.
 */
import type { Page } from 'playwright';
import { BaseDriver, SendMessageOpts, wait, pollUntil, normalizeText } from './base.js';

export class GrokDriver extends BaseDriver {
  readonly id = 'grok';
  readonly label = 'Grok.com';
  readonly url = 'https://grok.com/';

  async isLoggedIn(page: Page): Promise<boolean> {
    const url = page.url();
    if (url.includes('login') || url.includes('signin') || url.includes('auth')) return false;
    const composer = await pollUntil(
      () => page.$('textarea[aria-label*="Message"], textarea[placeholder*="Ask"], div[contenteditable="true"]'),
      { timeoutMs: 8000 }
    );
    return !!composer;
  }

  async sendMessage(page: Page, opts: SendMessageOpts): Promise<void> {
    const { text, onDelta, onDone, onError, signal } = opts;

    try {
      const composer = await pollUntil(
        () => page.$('textarea[aria-label*="Message"], textarea[placeholder*="Ask"], div[contenteditable="true"]'),
        { timeoutMs: 15000, signal }
      );
      if (!composer) throw new Error('Could not find Grok composer');

      const tagName = await composer.evaluate((el) => el.tagName.toLowerCase()).catch(() => 'textarea');

      if (tagName === 'textarea') {
        await composer.fill(text);
      } else {
        await composer.click();
        await page.keyboard.type(text, { delay: 5 });
      }
      await wait(200, signal);
      await page.keyboard.press('Enter');

      let lastText = '';
      let stableCount = 0;
      const startTime = Date.now();
      const maxWait = 5 * 60 * 1000;

      while (Date.now() - startTime < maxWait) {
        if (signal?.aborted) { onError(new Error('aborted')); return; }

        const lastAssistant = await page.$(
          'div[class*="message-content"]:last-of-type, div[class*="response-text"]:last-of-type, .markdown-body:last-of-type'
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
            const stopBtn = await page.$('button[aria-label*="Stop"], button[aria-label*="Cancel"]');
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
