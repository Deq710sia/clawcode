import type { Page } from 'playwright';
import { BaseDriver, SiteSelectors, pollUntil, visibleHandle } from './base.js';

export class GeminiDriver extends BaseDriver {
  readonly id = 'gemini';
  readonly label = 'Gemini';
  readonly url = 'https://gemini.google.com/app';

  protected readonly selectors: SiteSelectors = {
    composer: 'rich-textarea div.ql-editor[contenteditable="true"], rich-textarea div[contenteditable="true"], div[contenteditable="true"][aria-label*="prompt" i]',
    sendButton: 'button[aria-label="Send message"], button.send-button',
    assistantMessage: 'message-content, .model-response-text',
    busy: 'button[aria-label*="Stop" i], .stop-icon',
  };

  async isLoggedIn(page: Page): Promise<boolean> {
    const url = page.url();
    if (url.includes('accounts.google.com') || url.includes('ServiceLogin')) return false;
    const signIn = await visibleHandle(page, 'a[href*="accounts.google.com/ServiceLogin"], a:has-text("Sign in")');
    if (signIn) return false;
    const composer = await pollUntil(() => visibleHandle(page, this.selectors.composer), { timeoutMs: 8000 });
    return !!composer;
  }

  async prepare(page: Page): Promise<void> {
    try {
      const dismiss = await visibleHandle(page, 'button:has-text("Accept all"), button:has-text("Dismiss"), button:has-text("Skip"), button[aria-label="Close"]');
      if (dismiss) await dismiss.click().catch(() => {});
    } catch {}
  }
}
