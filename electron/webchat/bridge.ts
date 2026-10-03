/**
 * ClawCode — WebChat Bridge orchestrator.
 * Manages a single Playwright BrowserContext per active web chat.
 * Exposes login(prompt), query(stream) operations.
 *
 * Uses playwright-extra + stealth plugin to evade headless detection.
 * Visible-first login: when no logged-in profile exists, launches headful.
 * After successful login, subsequent launches are headless.
 */
import { app } from 'electron';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { initProfiles, getProfile, getAllProfiles, setLoggedIn, getProfileDir, resetProfile, WebChatId } from './profiles.js';
import { BaseDriver } from './drivers/base.js';
import { ClaudeDriver } from './drivers/claude.js';
import { ChatGPTDriver } from './drivers/chatgpt.js';
import { GeminiDriver } from './drivers/gemini.js';
import { GrokDriver } from './drivers/grok.js';
import { DeepSeekDriver } from './drivers/deepseek.js';

// Dynamic import for ESM-only playwright-extra.
// Singleton promise prevents concurrent init races (double `chromium.use(stealth())`).
let chromium: any = null;
let pwPromise: Promise<void> | null = null;

function ensurePlaywright(): Promise<void> {
  if (pwPromise) return pwPromise;
  pwPromise = (async () => {
    const pwExtra = await import('playwright-extra');
    chromium = pwExtra.chromium;
    try {
      const puppeteerStealth = await import('puppeteer-extra-plugin-stealth');
      const stealth = puppeteerStealth.default;
      chromium.use(stealth());
    } catch (err) {
      console.warn('[webchat] stealth plugin unavailable, falling back to vanilla playwright:', err);
    }
  })();
  return pwPromise;
}

const DRIVERS: Record<WebChatId, () => BaseDriver> = {
  claude: () => new ClaudeDriver(),
  chatgpt: () => new ChatGPTDriver(),
  gemini: () => new GeminiDriver(),
  grok: () => new GrokDriver(),
  deepseek: () => new DeepSeekDriver(),
};

interface ActiveSession {
  driver: BaseDriver;
  context: any; // BrowserContext
  page: any; // Page
  busy: boolean;
}

const sessions: Partial<Record<WebChatId, ActiveSession>> = {};

/** Set CLAWCODE_WEBCHAT_HEADFUL=1 to keep a visible browser window (more reliable against bot checks). */
const FORCE_HEADFUL = process.env.CLAWCODE_WEBCHAT_HEADFUL === '1';

async function launchSession(id: WebChatId, headless: boolean): Promise<ActiveSession> {
  await ensurePlaywright();
  const profile = getProfile(id);
  const driver = DRIVERS[id]();
  const userDataDir = getProfileDir(id);

  let context: any;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: headless && !FORCE_HEADFUL,
      viewport: { width: 1280, height: 900 },
      // No userAgent override: a hard-coded UA that disagrees with the real browser
      // version / OS (and its client-hint headers) is a classic bot-detection signal.
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=Translate',
        '--lang=en-US,en',
      ],
    });
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (/Executable doesn't exist|browserType\.launch|playwright install/i.test(msg)) {
      throw new Error(
        'The Chromium browser used by the WebChat bridge is not installed. ' +
        'Run `npx playwright install chromium` (dev) or reinstall ClawCode. Details: ' + msg.split('\n')[0]
      );
    }
    throw err;
  }

  // Headless only: skip heavy assets for speed. Never in the visible login window,
  // where the user may need to solve a captcha or upload an image.
  if (headless && !FORCE_HEADFUL) {
    await context.route('**/*.{png,jpg,jpeg,gif,webp,woff,woff2}', (route: any) => {
      const url = route.request().url();
      if (/accounts\.google\.com|recaptcha|turnstile|challenges\.cloudflare|\/auth|\/login/.test(url)) route.continue();
      else route.abort();
    });
  }

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(driver.url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

  return { driver, context, page, busy: false };
}

export async function closeSession(id: WebChatId) {
  const s = sessions[id];
  if (!s) return;
  try { await s.context.close(); } catch {}
  delete sessions[id];
}

export async function closeAllSessions() {
  await Promise.all(Object.keys(sessions).map((id) => closeSession(id as WebChatId)));
}

/** Launch a visible browser window so the user can log in to the web chat. */
export async function login(id: WebChatId): Promise<{ ok: boolean; loggedIn: boolean; error?: string }> {
  try {
    await closeSession(id);
    const session = await launchSession(id, false); // headful
    sessions[id] = session;

    // Poll for login success for up to 5 minutes (user needs time to log in)
    const start = Date.now();
    while (Date.now() - start < 5 * 60 * 1000) {
      if (session.page.isClosed()) {
        await closeSession(id);
        return { ok: false, loggedIn: false, error: 'Login window was closed before login completed' };
      }
      const loggedIn = await session.driver.isLoggedIn(session.page).catch(() => false);
      if (loggedIn) {
        setLoggedIn(id, true);
        // Cookies are persisted in the profile dir. Reopen headless for actual queries.
        await goHeadless(id).catch(() => {});
        return { ok: true, loggedIn: true };
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    await closeSession(id);
    return { ok: false, loggedIn: false, error: 'Login timed out (5 min)' };
  } catch (err: any) {
    await closeSession(id);
    return { ok: false, loggedIn: false, error: err?.message ?? String(err) };
  }
}

/** Switch the active session to headless mode (close headful, reopen headless). */
export async function goHeadless(id: WebChatId): Promise<void> {
  await closeSession(id);
  const session = await launchSession(id, true);
  sessions[id] = session;
}

export interface QueryOpts {
  text: string;
  onDelta: (text: string) => void;
  onDone: (fullText: string) => void;
  onError: (err: Error) => void;
  signal?: AbortSignal;
}

/** Send a message to the web chat and stream the response. Resolves when the reply is complete. */
export async function query(id: WebChatId, opts: QueryOpts): Promise<void> {
  let session: ActiveSession | undefined;
  let settled = false;
  const fail = (err: Error) => { if (!settled) { settled = true; opts.onError(err); } };
  const finish = (full: string) => { if (!settled) { settled = true; opts.onDone(full); } };

  try {
    if (!getProfile(id).loggedIn) {
      // Never logged in: open the visible login window and wait.
      const result = await login(id);
      if (!result.loggedIn) {
        return fail(new Error(`Not logged in to ${id}: ${result.error ?? 'login required'}`));
      }
    }

    session = sessions[id];
    if (!session) {
      session = await launchSession(id, true);
      sessions[id] = session;
    }
    if (session.busy) return fail(new Error(`${id} session is busy with another query`));
    session.busy = true;

    // Every request starts a fresh conversation. The bridge is stateless like any
    // OpenAI-compatible API: the caller sends the full history each time.
    await session.page.goto(session.driver.url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await session.page.waitForTimeout(1200);
    if (!(await session.driver.isLoggedIn(session.page).catch(() => false))) {
      setLoggedIn(id, false);
      session.busy = false;
      return fail(new Error(`Your ${id} session is not logged in (expired, or a bot-check page is showing). Log in again from Settings → Web Chats.`));
    }
    await session.driver.prepare(session.page);

    const active = session;
    await new Promise<void>((resolve) => {
      active.driver.sendMessage(active.page, {
        text: opts.text,
        onDelta: (d) => { if (!settled) opts.onDelta(d); },
        onDone: (full) => { finish(full); resolve(); },
        onError: (err) => { fail(err); resolve(); },
        signal: opts.signal,
      }).catch((err) => { fail(err); resolve(); });
    });
    setLoggedIn(id, true);
  } catch (err: any) {
    fail(err instanceof Error ? err : new Error(String(err)));
  } finally {
    if (session) session.busy = false;
  }
}

export function getBridgeStatus() {
  return getAllProfiles().map((p) => ({
    ...p,
    active: !!sessions[p.id as WebChatId],
    busy: sessions[p.id as WebChatId]?.busy ?? false,
  }));
}

export function initBridge() {
  initProfiles();
}

export async function resetWebChat(id: WebChatId) {
  await closeSession(id);
  resetProfile(id);
}

// Re-export for IPC
export { getAllProfiles, getProfile };
export type { WebChatId };
