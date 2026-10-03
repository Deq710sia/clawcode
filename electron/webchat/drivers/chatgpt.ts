import type { Page } from 'playwright';
import { BaseDriver, SiteSelectors, pollUntil, visibleHandle } from './base.js';

export class ChatGPTDriver extends BaseDriver {
  readonly id = 'chatgpt';
  readonly label = 'ChatGPT.com';
  readonly url = 'https://chatgpt.com/';

  protected readonly selectors: SiteSelectors = {
    composer: '#prompt-textarea, textarea[data-testid="prompt-textarea"]',
    sendButton: 'button[data-testid="send-button"], button[aria-label="Send prompt"]',
    assistantMessage: '[data-message-author-role="assistant"]',
    busy: 'button[data-testid="stop-button"], button[aria-label="Stop streaming"]',
  };

  async isLoggedIn(page: Page): Promise<boolean> {
    const url = page.url();
    if (/\/(auth|login)/.test(url)) return false;
    const loginBtn = await visibleHandle(page, '[data-testid="login-button"], a[href*="/auth/login"]');
    if (loginBtn) return false;
    const composer = await pollUntil(() => visibleHandle(page, this.selectors.composer), { timeoutMs: 8000 });
    return !!composer;
  }

  async prepare(page: Page): Promise<void> {
    try {
      const dismiss = await visibleHandle(page, 'button:has-text("Stay logged out"), button:has-text("Dismiss"), button[aria-label="Close"]');
      if (dismiss) await dismiss.click().catch(() => {});
    } catch {}
  }
}
