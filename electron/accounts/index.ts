/**
 * ClawCode — Multi-account manager.
 *
 * Each web chat service (Claude, ChatGPT, etc.) can have MULTIPLE accounts.
 * Each account gets its own Chromium profile dir, label, and usage tracker.
 *
 * The failover layer (in store.ts) uses this to:
 *   1. Detect when an account hits a rate limit (429, quota message)
 *   2. Find the next available account for the same service
 *   3. If none, switch to a different service/model entirely
 *   4. Re-send the full conversation history — no context lost
 */
import { app } from 'electron';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { WebChatId } from '../webchat/bridge.js';

export interface AccountProfile {
  id: string;
  service: WebChatId;
  label: string;
  loggedIn: boolean;
  lastUsed: number;
  messageCount: number;
  windowStart: number;
  status: 'available' | 'cooling' | 'exhausted';
  estimatedLimit: number;
  windowDurationMs: number;
}

const SERVICE_LIMITS: Record<WebChatId, { messages: number; windowMs: number }> = {
  claude:   { messages: 45,  windowMs: 8 * 60 * 60 * 1000 },
  chatgpt:  { messages: 40,  windowMs: 3 * 60 * 60 * 1000 },
  gemini:   { messages: 50,  windowMs: 24 * 60 * 60 * 1000 },
  grok:     { messages: 25,  windowMs: 2 * 60 * 60 * 1000 },
  deepseek: { messages: 60,  windowMs: 24 * 60 * 60 * 1000 },
};

const accountsDir = () => join(app.getPath('userData'), 'accounts');
const metaFile = () => join(accountsDir(), 'accounts.json');
let accounts: AccountProfile[] = [];

export function initAccounts() {
  mkdirSync(accountsDir(), { recursive: true });
  try {
    if (existsSync(metaFile())) {
      accounts = JSON.parse(readFileSync(metaFile(), 'utf8'));
    }
  } catch { accounts = []; }
  saveAccounts();
}

function saveAccounts() {
  writeFileSync(metaFile(), JSON.stringify(accounts, null, 2), 'utf8');
}

export function getAccounts(): AccountProfile[] {
  return accounts;
}

export function getAccountsByService(service: WebChatId): AccountProfile[] {
  return accounts.filter((a) => a.service === service);
}

export function getAccount(id: string): AccountProfile | undefined {
  return accounts.find((a) => a.id === id);
}

export function getAvailableAccount(service: WebChatId): AccountProfile | undefined {
  const serviceAccounts = getAccountsByService(service).filter((a) => a.loggedIn);
  return serviceAccounts.find((a) => a.status === 'available')
    ?? serviceAccounts.find((a) => a.status === 'cooling')
    ?? serviceAccounts[0];
}

export function getAccountProfileDir(id: string): string {
  const dir = join(accountsDir(), id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function addAccount(service: WebChatId, label: string): AccountProfile {
  const id = `${service}_${randomBytes(4).toString('hex')}`;
  const limits = SERVICE_LIMITS[service];
  const account: AccountProfile = {
    id,
    service,
    label: label || `${service} #${accounts.filter((a) => a.service === service).length + 1}`,
    loggedIn: false,
    lastUsed: 0,
    messageCount: 0,
    windowStart: Date.now(),
    status: 'available',
    estimatedLimit: limits.messages,
    windowDurationMs: limits.windowMs,
  };
  accounts.push(account);
  saveAccounts();
  return account;
}

export function removeAccount(id: string): { ok: boolean; error?: string } {
  const idx = accounts.findIndex((a) => a.id === id);
  if (idx < 0) return { ok: false, error: 'Account not found' };
  const dir = getAccountProfileDir(id);
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
  accounts.splice(idx, 1);
  saveAccounts();
  return { ok: true };
}

export function setAccountLoggedIn(id: string, loggedIn: boolean) {
  const a = getAccount(id);
  if (!a) return;
  a.loggedIn = loggedIn;
  if (loggedIn) a.lastUsed = Date.now();
  saveAccounts();
}

export function recordUsage(id: string): AccountProfile | undefined {
  const a = getAccount(id);
  if (!a) return;
  const now = Date.now();
  if (now - a.windowStart > a.windowDurationMs) {
    a.windowStart = now;
    a.messageCount = 0;
    a.status = 'available';
  }
  a.messageCount++;
  a.lastUsed = now;
  const usage = a.messageCount / a.estimatedLimit;
  if (usage >= 1.0) a.status = 'exhausted';
  else if (usage >= 0.8) a.status = 'cooling';
  saveAccounts();
  return a;
}

export function markExhausted(id: string) {
  const a = getAccount(id);
  if (!a) return;
  a.status = 'exhausted';
  a.messageCount = a.estimatedLimit;
  saveAccounts();
}

export function getUsageInfo(id: string): { used: number; limit: number; percent: number; status: string; windowMs: number; windowStart: number } | null {
  const a = getAccount(id);
  if (!a) return null;
  const now = Date.now();
  if (now - a.windowStart > a.windowDurationMs) {
    a.windowStart = now;
    a.messageCount = 0;
    a.status = 'available';
    saveAccounts();
  }
  return {
    used: a.messageCount,
    limit: a.estimatedLimit,
    percent: Math.round((a.messageCount / a.estimatedLimit) * 100),
    status: a.status,
    windowMs: a.windowDurationMs,
    windowStart: a.windowStart,
  };
}

export function hasAvailableAccount(service: WebChatId): boolean {
  return !!getAvailableAccount(service);
}

export function findFallbackService(currentService: WebChatId, allServices: WebChatId[]): { service: WebChatId; account: AccountProfile } | null {
  for (const svc of allServices) {
    if (svc === currentService) continue;
    const account = getAvailableAccount(svc);
    if (account) return { service: svc, account };
  }
  return null;
}

export type { WebChatId };
