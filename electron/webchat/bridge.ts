/**
 * ClawCode — WebChat Bridge orchestrator.
 * Manages a single Playwright BrowserContext per active web chat.
 * Exposes login(prompt), query(stream) operations.
 *
 * Uses playwright-extra + stealth plugin to evade headless detection.
 * Visible-first login: when no logged-in profile exists, launches headful.
 * After successful login, subsequent launches are headless.
 */
import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { initProfiles, getProfile, getAllProfiles, setLoggedIn, getProfileDir, resetProfile, WebChatId } from './profiles.js';
import { BaseDriver, SendMessageOpts } from './drivers/base.js';
import { ClaudeDriver } from './drivers/claude.js';
import { ChatGPTDriver } from './drivers/chatgpt.js';
import { GeminiDriver } from './drivers/gemini.js';
import { GrokDriver } from './drivers/grok.js';
import { DeepSeekDriver } from './drivers/deepseek.js';

// Dynamic import for ESM-only playwright-extra
let chromium: any = null;
let stealth: any = null;

async function ensurePlaywright() {
  if (chromium) return;
  // playwright-extra is ESM; dynamic import works in ESM main
  const pwExtra = await import('playwright-extra');
  chromium = pwExtra.chromium;
  try {
    const puppeteerStealth = await import('puppeteer-extra-plugin-stealth');
    stealth = puppeteerStealth.default;
    chromium.use(stealth());
  } catch (err) {
    console.warn('[webchat] stealth plugin unavailable, falling back to vanilla playwright:', err);
  }
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

async function launchSession(id: WebChatId, headless: boolean): Promise<ActiveSession> {
  await ensurePlaywright();
  const profile = getProfile(id);
  const driver = DRIVERS[id]();
  const userDataDir = getProfileDir(id);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless,
    viewport: { width: 1280, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate',
      '--lang=en-US,en',
    ],
  });

  // Block heavy resources for speed (images still allowed for login captcha)
  await context.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2}', (route: any) => {
    const url = route.request().url();
    // Allow images on auth pages (captcha)
    if (url.includes('accounts.google.com') || url.includes('auth') || url.includes('login') || url.includes('recaptcha')) {
      route.continue();
    } else {
      route.abort();
    }
  });

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(driver.url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(2000);

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
      const loggedIn = await session.driver.isLoggedIn(session.page).catch(() => false);
      if (loggedIn) {
        setLoggedIn(id, true);
        // Keep the session open for queries; switch to headless on next query
        return { ok: true, loggedIn: true };
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return { ok: false, loggedIn: false, error: 'Login timed out (5 min)' };
  } catch (err: any) {
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

/** Send a message to the web chat and stream the response. */
export async function query(id: WebChatId, opts: QueryOpts): Promise<void> {
  try {
    const profile = getProfile(id);
    if (!profile.loggedIn) {
      // Auto-launch headful login if never logged in
      const result = await login(id);
      if (!result.loggedIn) {
        opts.onError(new Error(`Not logged in to ${id}: ${result.error ?? 'login required'}`));
        return;
      }
    }

    let session = sessions[id];
    if (!session) {
      // Reuse profile, launch headless
      session = await launchSession(id, true);
      sessions[id] = session;
    }

    if (session.busy) {
      opts.onError(new Error(`${id} session is busy with another query`));
      return;
    }
    session.busy = true;

    await session.driver.prepare(session.page);
    await session.driver.sendMessage(session.page, {
      text: opts.text,
      onDelta: opts.onDelta,
      onDone: (full) => {
        session.busy = false;
        opts.onDone(full);
      },
      onError: (err) => {
        session.busy = false;
        opts.onError(err);
      },
      signal: opts.signal,
    });
  } catch (err: any) {
    opts.onError(err);
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
