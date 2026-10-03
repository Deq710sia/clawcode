import type { Page } from 'playwright';
import { BaseDriver, SiteSelectors, pollUntil, visibleHandle } from './base.js';

export class ClaudeDriver extends BaseDriver {
  readonly id = 'claude';
  readonly label = 'Claude.ai';
  readonly url = 'https://claude.ai/new';

  protected readonly selectors: SiteSelectors = {
    composer: 'div.ProseMirror[contenteditable="true"], div[contenteditable="true"][role="textbox"], textarea[data-testid="chat-message-input"]',
    sendButton: 'button[aria-label="Send message"], button[aria-label="Send Message"]',
    assistantMessage: '.font-claude-response, .font-claude-message, [data-testid="assistant-message"]',
    busy: 'button[aria-label="Stop response"], button[aria-label="Stop Response"], button[data-testid="stop-button"]',
  };

  async isLoggedIn(page: Page): Promise<boolean> {
    const url = page.url();
    if (/\/(login|signin|logout)/.test(url)) return false;
    const composer = await pollUntil(() => visibleHandle(page, this.selectors.composer), { timeoutMs: 8000 });
    return !!composer;
  }

  async prepare(page: Page): Promise<void> {
    try {
      const dismiss = await visibleHandle(page, 'button:has-text("Dismiss"), button[aria-label="Close"]');
      if (dismiss) await dismiss.click().catch(() => {});
    } catch {}
  }
}
