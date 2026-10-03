import type { Page } from 'playwright';
import { BaseDriver, SiteSelectors, pollUntil, visibleHandle } from './base.js';

export class DeepSeekDriver extends BaseDriver {
  readonly id = 'deepseek';
  readonly label = 'DeepSeek';
  readonly url = 'https://chat.deepseek.com/';

  protected readonly selectors: SiteSelectors = {
    composer: 'textarea#chat-input, textarea[placeholder*="Message" i], textarea',
    assistantMessage: '.ds-markdown',
  };

  async isLoggedIn(page: Page): Promise<boolean> {
    const url = page.url();
    if (/sign_in|login/.test(url)) return false;
    const composer = await pollUntil(() => visibleHandle(page, this.selectors.composer), { timeoutMs: 8000 });
    return !!composer;
  }
}
