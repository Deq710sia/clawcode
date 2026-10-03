/**
 * ClawCode — Skills browser & installer.
 * A "skill" is a GitHub repo that packages a system prompt augmentation,
 * slash commands, or tool definitions. Installed via `git clone` into
 * userData/skills/<name>/.
 */
import { app } from 'electron';
import { join } from 'node:path';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';

const skillsDir = () => join(app.getPath('userData'), 'skills');

export interface Skill {
  name: string;
  description: string;
  author: string;
  repoUrl: string;
  stars?: number;
  installed: boolean;
  installedPath?: string;
  category: 'skill' | 'tool' | 'prompt' | 'mod' | 'unknown';
  manifest?: SkillManifest;
  source: 'curated' | 'github' | 'installed';
  updatedAt?: string;
}

export interface SkillManifest {
  name: string;
  description: string;
  version?: string;
  commands?: string[];
  tools?: string[];
  promptFile?: string;
  author?: string;
  homepage?: string;
}

export interface InstalledSkill {
  name: string;
  path: string;
  manifest: SkillManifest | null;
  installedAt: number;
}

// ---------------------------------------------------------------------------
// Curated catalog
// ---------------------------------------------------------------------------
const CURATED: Skill[] = [
  {
    name: 'awesome-claude-code',
    description: 'Curated list of awesome Claude Code resources, prompts, tools, and agents.',
    author: 'hesreallyhim',
    repoUrl: 'https://github.com/hesreallyhim/awesome-claude-code',
    category: 'skill',
    source: 'curated',
    installed: false,
  },
  {
    name: 'claude-code-agents',
    description: 'Collection of specialized Claude Code sub-agents for coding, review, debugging.',
    author: 'wshobson',
    repoUrl: 'https://github.com/wshobson/agents',
    category: 'skill',
    source: 'curated',
    installed: false,
  },
  {
    name: 'caveman',
    description: 'Write code like a caveman — minimal, blunt, no abstractions. Community skill (search GitHub if no canonical repo).',
    author: 'community',
    repoUrl: 'https://github.com/search?q=caveman+claude+skill&type=repositories',
    category: 'skill',
    source: 'curated',
    installed: false,
  },
  {
    name: 'ponytail',
    description: 'Ponytail skill — opinionated, single-minded coding style. Community skill (search GitHub if no canonical repo).',
    author: 'community',
    repoUrl: 'https://github.com/search?q=ponytail+agent+skill&type=repositories',
    category: 'skill',
    source: 'curated',
    installed: false,
  },
  {
    name: 'universal-modder',
    description: 'Universal game/app modding skill — patch binaries, hook functions, inject mods.',
    author: 'community',
    repoUrl: 'https://github.com/search?q=universal+modder+agent&type=repositories',
    category: 'mod',
    source: 'curated',
    installed: false,
  },
  {
    name: 'clawhub-skills',
    description: 'ClawHub community skills index — browse and install community-contributed skills.',
    author: 'clawhub',
    repoUrl: 'https://github.com/clawhub/skills',
    category: 'skill',
    source: 'curated',
    installed: false,
  },
  {
    name: 'aider-prompts',
    description: 'Port of Aider\'s best prompt patterns for use in any agentic harness.',
    author: 'community',
    repoUrl: 'https://github.com/Aider-AI/aider',
    category: 'prompt',
    source: 'curated',
    installed: false,
  },
  {
    name: 'odysseus',
    description: 'PewDiePie\'s Odysseus — self-hosted AI workspace (chat, agents, research, Cookbook for hardware-aware model fitting). Reference implementation for the Cookbook patterns used in ClawCode\'s Models tab.',
    author: 'pewdiepie-archdaemon',
    repoUrl: 'https://github.com/pewdiepie-archdaemon/odysseus',
    category: 'skill',
    source: 'curated',
    installed: false,
  },
];

export function initSkills() {
  mkdirSync(skillsDir(), { recursive: true });
}

// ---------------------------------------------------------------------------
// Installed skills
// ---------------------------------------------------------------------------
export function listInstalledSkills(): InstalledSkill[] {
  const dir = skillsDir();
  if (!existsSync(dir)) return [];
  const out: InstalledSkill[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try {
      if (!statSync(path).isDirectory()) continue;
    } catch { continue; }
    const manifest = loadManifest(path);
    out.push({ name, path, manifest, installedAt: statSync(path).mtimeMs });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function loadManifest(skillPath: string): SkillManifest | null {
  const candidates = ['SKILL.md', 'skill.json', 'skill.yaml', 'package.json', 'manifest.json'];
  for (const f of candidates) {
    const p = join(skillPath, f);
    if (!existsSync(p)) continue;
    try {
      const raw = readFileSync(p, 'utf8');
      if (f.endsWith('.json')) {
        const j = JSON.parse(raw);
        return {
          name: j.name,
          description: j.description ?? j.summary ?? '',
          version: j.version,
          commands: j.commands ?? j.slashCommands ?? [],
          tools: j.tools ?? [],
          promptFile: j.promptFile ?? j.main,
          author: j.author,
          homepage: j.homepage ?? j.repository?.url,
        };
      }
      if (f === 'SKILL.md' || f.endsWith('.md')) {
        const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
        if (fm) {
          const meta: any = {};
          for (const line of fm[1].split('\n')) {
            const m = line.match(/^(\w+):\s*(.+)$/);
            if (m) meta[m[1]] = m[2];
          }
          const firstPara = fm[2].split('\n\n')[0].trim();
          return {
            name: meta.name,
            description: meta.description ?? firstPara,
            version: meta.version,
            commands: meta.commands ? meta.commands.split(',').map((s: string) => s.trim()) : [],
            tools: meta.tools ? meta.tools.split(',').map((s: string) => s.trim()) : [],
            author: meta.author,
            homepage: meta.homepage,
          };
        }
        const lines = raw.split('\n');
        const title = lines.find((l) => l.startsWith('#'))?.replace(/^#+\s*/, '') ?? 'Unnamed skill';
        const desc = lines.filter((l) => l.trim() && !l.startsWith('#'))[0] ?? '';
        return { name: title, description: desc, commands: [], tools: [] };
      }
    } catch {}
  }
  return null;
}

export function getSkillPromptFragment(name: string): string | null {
  const dir = join(skillsDir(), name);
  if (!existsSync(dir)) return null;
  const candidates = ['prompt.md', 'SKILL.md', 'system-prompt.md', 'system.md'];
  for (const f of candidates) {
    const p = join(dir, f);
    if (existsSync(p)) {
      try { return readFileSync(p, 'utf8'); } catch {}
    }
  }
  return null;
}

export function getAllInstalledPrompts(): { name: string; commands: string[]; prompt: string }[] {
  return listInstalledSkills()
    .map((s) => {
      const prompt = getSkillPromptFragment(s.name) ?? '';
      return { name: s.name, commands: s.manifest?.commands ?? [], prompt };
    })
    .filter((s) => s.prompt);
}

// ---------------------------------------------------------------------------
// Install / uninstall
// ---------------------------------------------------------------------------
export async function installSkill(repoUrl: string, name?: string): Promise<{ ok: boolean; error?: string; path?: string }> {
  // For GitHub search URLs (not real git repos), redirect user to browser
  if (repoUrl.includes('/search?')) {
    return { ok: false, error: 'This is a GitHub search URL, not a cloneable repo. Click "Browse on GitHub" to open it, then find a real repo to install.' };
  }
  let skillName = name || repoUrl.split('/').pop()?.replace(/\.git$/, '') || 'unnamed';
  skillName = skillName.replace(/[^a-zA-Z0-9_-]/g, '-');
  const target = join(skillsDir(), skillName);
  if (existsSync(target)) return { ok: false, error: `Skill "${skillName}" is already installed` };
  mkdirSync(skillsDir(), { recursive: true });

  return new Promise((resolve) => {
    const args = ['clone', '--depth', '1', repoUrl, target];
    const child = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => resolve({ ok: false, error: `git not found: ${err.message}. Install git from https://git-scm.com` }));
    child.on('close', (code) => {
      if (code === 0) resolve({ ok: true, path: target });
      else resolve({ ok: false, error: `git clone failed (exit ${code}): ${stderr.slice(0, 500)}` });
    });
  });
}

export async function uninstallSkill(name: string): Promise<{ ok: boolean; error?: string }> {
  const target = join(skillsDir(), name);
  if (!existsSync(target)) return { ok: false, error: 'Not installed' };
  try {
    rmSync(target, { recursive: true, force: true });
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

// ---------------------------------------------------------------------------
// GitHub Search API
// ---------------------------------------------------------------------------
export interface GitHubSearchOpts {
  query?: string;
  topic?: string;
  sort?: 'stars' | 'updated' | 'forks';
  perPage?: number;
}

export async function searchGitHubSkills(opts: GitHubSearchOpts): Promise<Skill[]> {
  const q = (opts.query || '').trim();
  const topic = (opts.topic || '').trim();
  const sort = opts.sort ?? 'stars';
  const perPage = Math.min(opts.perPage ?? 30, 100);

  let query = q;
  if (topic) query = query ? `${query} topic:${topic}` : `topic:${topic}`;
  if (!query) query = 'claude-code-skills OR agent-skills OR claude-skills in:name,description,readme';

  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=${sort}&order=desc&per_page=${perPage}`;
  const res = await fetch(url, {
    headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'ClawCode/0.2' },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status}: ${text.slice(0, 300)}`);
  }
  const json: any = await res.json();
  const installed = new Set(listInstalledSkills().map((s) => s.name));
  return (json.items ?? []).map((r: any): Skill => ({
    name: r.name,
    description: r.description ?? '(no description)',
    author: r.owner?.login ?? 'unknown',
    repoUrl: r.clone_url,
    stars: r.stargazers_count,
    installed: installed.has(r.name),
    category: categorizeRepo(r),
    source: 'github',
    updatedAt: r.updated_at,
  }));
}

function categorizeRepo(r: any): Skill['category'] {
  const text = `${r.name} ${r.description ?? ''} ${(r.topics ?? []).join(' ')}`.toLowerCase();
  if (text.includes('mod') || text.includes('patch') || text.includes('hook')) return 'mod';
  if (text.includes('tool') || text.includes('function')) return 'tool';
  if (text.includes('prompt') || text.includes('system')) return 'prompt';
  if (text.includes('skill') || text.includes('agent')) return 'skill';
  return 'unknown';
}

export function getCuratedSkills(): Skill[] {
  const installed = new Set(listInstalledSkills().map((s) => s.name));
  return CURATED.map((s) => ({ ...s, installed: installed.has(s.name) }));
}
