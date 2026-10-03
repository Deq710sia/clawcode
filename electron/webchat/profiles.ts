/**
 * ClawCode — WebChat profile manager.
 * Each web chat (Claude.ai, ChatGPT, etc.) gets its own persistent Chromium profile
 * (cookies, localStorage, IndexedDB) stored under userData/webchat-profiles/<id>/.
 *
 * First login: launchPersistentContext with headless=false so the user can log in
 * through a real visible browser window. Subsequent runs reuse the same profile
 * with headless=true.
 */
import { app } from 'electron';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';

export type WebChatId = 'claude' | 'chatgpt' | 'gemini' | 'grok' | 'deepseek';

export interface WebChatProfile {
  id: WebChatId;
  label: string;
  loggedIn: boolean;
  lastUsed?: number;
  createdAt?: number;
}

const profilesDir = () => join(app.getPath('userData'), 'webchat-profiles');
const metaFile = () => join(profilesDir(), 'profiles.json');

let meta: Record<string, WebChatProfile> = {};

export function initProfiles() {
  mkdirSync(profilesDir(), { recursive: true });
  try {
    if (existsSync(metaFile())) {
      meta = JSON.parse(readFileSync(metaFile(), 'utf8'));
    }
  } catch { meta = {}; }

  // Ensure default entries exist
  const defaults: WebChatProfile[] = [
    { id: 'claude', label: 'Claude.ai', loggedIn: false },
    { id: 'chatgpt', label: 'ChatGPT.com', loggedIn: false },
    { id: 'gemini', label: 'Gemini', loggedIn: false },
    { id: 'grok', label: 'Grok.com', loggedIn: false },
    { id: 'deepseek', label: 'DeepSeek', loggedIn: false },
  ];
  for (const d of defaults) {
    if (!meta[d.id]) meta[d.id] = d;
  }
  saveMeta();
}

function saveMeta() {
  writeFileSync(metaFile(), JSON.stringify(meta, null, 2), 'utf8');
}

export function getProfile(id: WebChatId): WebChatProfile {
  return meta[id] ?? { id, label: id, loggedIn: false };
}

export function getAllProfiles(): WebChatProfile[] {
  return Object.values(meta);
}

export function setLoggedIn(id: WebChatId, loggedIn: boolean) {
  if (!meta[id]) return;
  meta[id].loggedIn = loggedIn;
  meta[id].lastUsed = Date.now();
  saveMeta();
}

export function getProfileDir(id: WebChatId): string {
  const dir = join(profilesDir(), id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function resetProfile(id: WebChatId) {
  const dir = getProfileDir(id);
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
  mkdirSync(dir, { recursive: true });
  if (meta[id]) {
    meta[id].loggedIn = false;
    meta[id].lastUsed = undefined;
    saveMeta();
  }
}
