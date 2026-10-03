import type { Page } from 'playwright';
import { BaseDriver, SiteSelectors, pollUntil, visibleHandle } from './base.js';

export class GrokDriver extends BaseDriver {
  readonly id = 'grok';
  readonly label = 'Grok.com';
  readonly url = 'https://grok.com/';

  protected readonly selectors: SiteSelectors = {
    composer: 'textarea[aria-label*="Ask" i], textarea[placeholder*="Ask" i], textarea, div[contenteditable="true"]',
    sendButton: 'button[type="submit"], button[aria-label="Submit"]',
    assistantMessage: '.response-content-markdown, div.message-bubble:not(.items-end) .markdown',
    busy: 'button[aria-label*="Stop" i]',
  };

  async isLoggedIn(page: Page): Promise<boolean> {
    const url = page.url();
    if (/sign-?in|login|accounts\.x\.ai/.test(url)) return false;
    const composer = await pollUntil(() => visibleHandle(page, this.selectors.composer), { timeoutMs: 8000 });
    return !!composer;
  }
}
