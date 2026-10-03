/**
 * ClawCode — Conversation persistence.
 * Saves/loads conversations to disk so they survive app restarts.
 * Conversations are stored as JSON files under userData/conversations/.
 */
import { app } from 'electron';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, statSync } from 'node:fs';

const convosDir = () => join(app.getPath('userData'), 'conversations');

export interface SavedConversation {
  id: string;
  title: string;
  messages: any[];
  plan: any[];
  createdAt: number;
  updatedAt: number;
  model?: string;
  endpoint?: string;
  workspace?: string;
}

export function initConversations() {
  mkdirSync(convosDir(), { recursive: true });
}

export function saveConversation(convo: SavedConversation): { ok: boolean; error?: string } {
  try {
    mkdirSync(convosDir(), { recursive: true });
    const path = join(convosDir(), `${convo.id}.json`);
    writeFileSync(path, JSON.stringify(convo, null, 2), 'utf8');
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

export function loadConversation(id: string): SavedConversation | null {
  try {
    const path = join(convosDir(), `${id}.json`);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function listConversations(): SavedConversation[] {
  try {
    const dir = convosDir();
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    const convos: SavedConversation[] = [];
    for (const f of files) {
      try {
        const c = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        convos.push(c);
      } catch {}
    }
    return convos.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  } catch {
    return [];
  }
}

export function deleteConversation(id: string): { ok: boolean; error?: string } {
  try {
    const path = join(convosDir(), `${id}.json`);
    if (existsSync(path)) unlinkSync(path);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

export function renameConversation(id: string, title: string): { ok: boolean; error?: string } {
  try {
    const c = loadConversation(id);
    if (!c) return { ok: false, error: 'Conversation not found' };
    c.title = title;
    return saveConversation(c);
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}
