/**
 * ClawCode tools — clean-room implementations.
 * Each tool has:
 *   - a JSON-Schema descriptor (OpenAI-compatible function calling)
 *   - a handler that runs in the Electron main process
 *
 * Tools are sandboxed to the active workspace: any path argument is resolved
 * against the workspace root and rejected if it escapes.
 */
import type { IpcMain } from 'electron';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  renameSync,
  realpathSync,
} from 'node:fs';
import { join, resolve as pathResolve, relative, isAbsolute, normalize, dirname, sep } from 'node:path';

export interface ToolContext {
  workspace: string;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: any; // JSON Schema
  run: (args: any, ctx: ToolContext) => Promise<any> | any;
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------
function safePath(ctx: ToolContext, p: string): string {
  if (!p || typeof p !== 'string') throw new Error('Path argument required');
  const candidate = isAbsolute(p) ? p : join(ctx.workspace, p);
  const resolved = pathResolve(candidate);
  const inside = (root: string, target: string) => {
    const rel = relative(root, target);
    return !(rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel));
  };
  if (!inside(ctx.workspace, resolved)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  // Symlinks: resolve the nearest existing ancestor and make sure it is still inside the real workspace.
  try {
    const realRoot = realpathSync(ctx.workspace);
    let probe = resolved;
    while (!existsSync(probe)) {
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    if (!inside(realRoot, realpathSync(probe))) {
      throw new Error(`Path escapes workspace via symlink: ${p}`);
    }
  } catch (err: any) {
    if (String(err?.message).startsWith('Path escapes')) throw err;
    // realpath failures (permissions, races) fall through to the lexical check above
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Tool: list_files
// ---------------------------------------------------------------------------
const listFiles: ToolDef = {
  name: 'list_files',
  description:
    'List files and directories under a path (relative to workspace root). Returns a tree-flat list with type indicators. Use "." for the workspace root.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path relative to workspace root. Use "." for root.' },
      maxDepth: { type: 'integer', description: 'Max recursion depth. Default 3.', default: 3 },
    },
    required: ['path'],
  },
  run: (args, ctx) => {
    const root = safePath(ctx, args.path ?? '.');
    const maxDepth = Math.max(1, Math.min(args.maxDepth ?? 3, 6));
    const out: { path: string; type: 'file' | 'dir'; size?: number }[] = [];

    const walk = (dir: string, depth: number) => {
      if (depth > maxDepth) return;
      let entries: string[];
      try {
        entries = readdirSync(dir).sort();
      } catch (e) {
        return;
      }
      for (const name of entries) {
        if (name === 'node_modules' || name === '.git' || name.startsWith('.DS_Store')) continue;
        const full = join(dir, name);
        try {
          const st = statSync(full);
          const rel = relative(ctx.workspace, full).split(sep).join('/');
          if (st.isDirectory()) {
            out.push({ path: rel, type: 'dir' });
            walk(full, depth + 1);
          } else {
            out.push({ path: rel, type: 'file', size: st.size });
          }
        } catch {}
      }
    };

    walk(root, 1);
    return { entries: out, root: relative(ctx.workspace, root) };
  },
};

// ---------------------------------------------------------------------------
// Tool: read_file
// ---------------------------------------------------------------------------
const READ_MAX_LINES = 2000;
const READ_MAX_CHARS = 60_000;

const readFile: ToolDef = {
  name: 'read_file',
  description:
    'Read a UTF-8 text file. Large files are returned in chunks: use offset (1-based line) and limit (lines) to continue. ' +
    'Returns { path, content, totalLines, startLine, endLine, truncated, nextOffset }.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to workspace root.' },
      offset: { type: 'integer', description: 'First line to read (1-based). Default 1.' },
      limit: { type: 'integer', description: `Max lines to return. Default ${READ_MAX_LINES}.` },
    },
    required: ['path'],
  },
  run: (args, ctx) => {
    const full = safePath(ctx, args.path);
    if (!existsSync(full)) throw new Error(`File not found: ${args.path}`);
    const st = statSync(full);
    if (st.isDirectory()) throw new Error(`Path is a directory: ${args.path}`);
    if (st.size > 20 * 1024 * 1024) throw new Error(`File too large (${st.size} bytes > 20MB)`);
    const raw = readFileSync(full, 'utf8');
    const lines = raw.split('\n');
    const totalLines = lines.length;
    const start = Math.max(1, Math.floor(Number(args.offset) || 1));
    if (start > totalLines) throw new Error(`offset ${start} is past the end of the file (${totalLines} lines)`);
    const limit = Math.min(Math.max(Math.floor(Number(args.limit) || READ_MAX_LINES), 1), READ_MAX_LINES);

    let end = Math.min(start - 1 + limit, totalLines);
    let content = lines.slice(start - 1, end).join('\n');
    if (content.length > READ_MAX_CHARS) {
      // Cut at a line boundary under the char budget (always keep at least one line).
      let acc = 0;
      let n = 0;
      for (const l of lines.slice(start - 1, end)) {
        if (n > 0 && acc + l.length + 1 > READ_MAX_CHARS) break;
        acc += l.length + 1;
        n++;
      }
      end = start - 1 + n;
      content = lines.slice(start - 1, end).join('\n');
    }
    const truncated = end < totalLines;
    return {
      path: args.path,
      content,
      size: st.size,
      totalLines,
      startLine: start,
      endLine: end,
      truncated,
      ...(truncated ? { nextOffset: end + 1, note: `File continues. Call read_file again with offset=${end + 1}.` } : {}),
    };
  },
};

// ---------------------------------------------------------------------------
// Tool: write_file
// ---------------------------------------------------------------------------
const writeFile: ToolDef = {
  name: 'write_file',
  description:
    'Create or overwrite a file with the given UTF-8 content. Parent directories are created automatically. Returns { path, bytesWritten }.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to workspace root.' },
      content: { type: 'string', description: 'Full file contents to write.' },
    },
    required: ['path', 'content'],
  },
  run: (args, ctx) => {
    const full = safePath(ctx, args.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, args.content ?? '', 'utf8');
    return { path: args.path, bytesWritten: Buffer.byteLength(args.content ?? '', 'utf8') };
  },
};


/** Find `needle` in `hay` ignoring CRLF and trailing spaces per line. Returns the real matched text. */
function fuzzyFind(hay: string, needle: string): { index: number; matched: string } | null {
  const norm = (t: string) => t.replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/, ''));
  const h = hay.split('\n');
  const n = norm(needle);
  if (n.length === 0) return null;
  const hn = h.map((l) => l.replace(/\r$/, '').replace(/[ \t]+$/, ''));
  let found = -1;
  for (let i = 0; i + n.length <= hn.length; i++) {
    let ok = true;
    for (let j = 0; j < n.length; j++) if (hn[i + j] !== n[j]) { ok = false; break; }
    if (ok) { if (found !== -1) return null; found = i; } // ambiguous -> refuse
  }
  if (found === -1) return null;
  const index = h.slice(0, found).reduce((a, l) => a + l.length + 1, 0);
  const matched = h.slice(found, found + n.length).join('\n');
  return { index, matched };
}

// ---------------------------------------------------------------------------
// Tool: edit_file
// ---------------------------------------------------------------------------
const editFile: ToolDef = {
  name: 'edit_file',
  description:
    'Apply a list of string replacements to a file. Each replacement = { old, new }. Returns { path, applied, diff } where diff is a unified diff. If `old` is not found, that replacement is skipped and reported in `failed`.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      replacements: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            old: { type: 'string' },
            new: { type: 'string' },
            replaceAll: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match.' },
          },
          required: ['old', 'new'],
        },
      },
    },
    required: ['path', 'replacements'],
  },
  run: (args, ctx) => {
    const full = safePath(ctx, args.path);
    if (!existsSync(full)) throw new Error(`File not found: ${args.path}`);
    const original = readFileSync(full, 'utf8');
    let updated = original;
    const applied: { old: string; new: string }[] = [];
    const failed: { old: string; reason: string }[] = [];

    for (let r of args.replacements ?? []) {
      if (typeof r?.old !== 'string' || typeof r?.new !== 'string' || r.old === '') {
        failed.push({ old: String(r?.old ?? '').slice(0, 80), reason: '`old` and `new` must be strings and `old` must be non-empty' });
        continue;
      }
      if (r.old === r.new) {
        failed.push({ old: r.old.slice(0, 80), reason: 'old and new are identical' });
        continue;
      }
      // Match against the *current* text so sequential replacements compose correctly.
      let first = updated.indexOf(r.old);
      let oldText = r.old;
      if (first === -1) {
        // Fallback: tolerate CRLF vs LF and trailing-whitespace drift.
        const fuzzy = fuzzyFind(updated, r.old);
        if (!fuzzy) {
          failed.push({ old: r.old.slice(0, 80), reason: 'old string not found (exact or whitespace-tolerant)' });
          continue;
        }
        first = fuzzy.index;
        oldText = fuzzy.matched;
      }
      r = { ...r, old: oldText };
      if (!r.replaceAll && updated.indexOf(r.old, first + 1) !== -1) {
        failed.push({ old: r.old.slice(0, 80), reason: 'old string is not unique; add more surrounding context or set replaceAll' });
        continue;
      }
      // Use split/join, NOT String.replace: replace() interprets $&, $1, $$ in the
      // replacement string, which silently corrupts code (template literals, regexes, shell).
      updated = r.replaceAll
        ? updated.split(r.old).join(r.new)
        : updated.slice(0, first) + r.new + updated.slice(first + r.old.length);
      applied.push({ old: r.old, new: r.new });
    }

    if (applied.length > 0) {
      writeFileSync(full, updated, 'utf8');
    }

    const diff = makeUnifiedDiff(args.path, original, updated);

    return {
      path: args.path,
      applied: applied.length,
      failed,
      diff,
    };
  },
};

// ---------------------------------------------------------------------------
// Tool: run_command
// ---------------------------------------------------------------------------
const runCommand: ToolDef = {
  name: 'run_command',
  description:
    'Execute a shell command in the workspace. Returns { ok, exitCode, stdout, stderr }. The command runs via bash on macOS/Linux and PowerShell on Windows. Timeout: 120s. If process sandbox is enabled in Settings, the command runs as a restricted local user with filesystem + network isolation.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute.' },
      timeoutMs: { type: 'integer', description: 'Optional timeout in milliseconds. Default 120000.', default: 120000 },
    },
    required: ['command'],
  },
  run: async (args, ctx) => {
    // If the process sandbox is enabled, commands MUST go through it. On any failure we
    // return an error instead of falling back to unsandboxed execution (fail closed).
    const sandbox = await import('../process-sandbox.js');
    const sbCfg = sandbox.loadSandboxConfig();
    if (sbCfg.enabled) {
      try {
        const result = await sandbox.runCommandSandboxed(args.command, {
          cwd: ctx.workspace,
          timeoutMs: args.timeoutMs,
        });
        return {
          ok: result.ok,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr + '\n[sandboxed: ran as restricted user "ClawCodeSandbox"]',
        };
      } catch (err: any) {
        return {
          ok: false,
          error: `Process sandbox is enabled but the command was NOT run: ${err?.message ?? err}. Fix the sandbox in Settings → Sandbox or disable it.`,
          stdout: '',
          stderr: '',
        };
      }
    }

    // Default: spawn directly (no sandbox)
    const { spawn, execFile } = await import('node:child_process');
    const isWin = process.platform === 'win32';
    const MAX_OUT = 200_000; // chars kept per stream; protects memory and the model's context
    const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || 120_000, 1_000), 600_000);

    return new Promise((resolve) => {
      // Windows: no profile, non-interactive, UTF-8 output so non-ASCII is not mangled.
      // The `$LASTEXITCODE` tail makes native-command failures surface as the exit code.
      const child = isWin
        ? spawn(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-ExecutionPolicy', 'Bypass',
              '-Command',
              `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ErrorActionPreference='Continue'; ${args.command}; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }`,
            ],
            { cwd: ctx.workspace, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
          )
        : spawn(args.command, {
            cwd: ctx.workspace,
            shell: '/bin/bash',
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true, // own process group so the whole tree can be killed
          });

      let stdout = '';
      let stderr = '';
      let truncated = false;
      let timedOut = false;
      let settled = false;
      const append = (cur: string, d: Buffer) => {
        if (cur.length >= MAX_OUT) { truncated = true; return cur; }
        const next = cur + d.toString('utf8');
        if (next.length > MAX_OUT) { truncated = true; return next.slice(0, MAX_OUT); }
        return next;
      };

      const killTree = () => {
        const pid = child.pid;
        if (!pid) return;
        if (isWin) {
          // child.kill() would leave grandchildren (npm, node, etc.) running and holding the pipes open.
          execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {});
        } else {
          try { process.kill(-pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
        }
      };

      let hardStop: NodeJS.Timeout | undefined;
      const finish = (r: any) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (hardStop) clearTimeout(hardStop);
        if (truncated) r.stderr = (r.stderr ?? '') + `\n[ClawCode] output truncated to ${MAX_OUT} characters per stream`;
        resolve(r);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killTree();
        // If something still holds the pipes after the kill, do not hang forever.
        hardStop = setTimeout(
          () => finish({ ok: false, exitCode: null, timedOut: true, stdout, stderr: stderr + '\n[ClawCode] process timed out and was force-stopped' }),
          5_000,
        );
      }, timeoutMs);

      child.stdout?.on('data', (d: Buffer) => (stdout = append(stdout, d)));
      child.stderr?.on('data', (d: Buffer) => (stderr = append(stderr, d)));
      child.on('error', (err) => finish({ ok: false, error: err.message, stdout, stderr }));
      child.on('close', (code) => {
        if (timedOut) stderr += `\n[ClawCode] process timed out after ${timeoutMs} ms and was killed`;
        finish({ ok: !timedOut && code === 0, exitCode: code, timedOut, stdout, stderr });
      });
    });
  },
};

// ---------------------------------------------------------------------------
// Tool: git
// ---------------------------------------------------------------------------
// Allowlisted, shell-free git access. No push/reset/clean/force: those stay with the user.
const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'branch']);
const GIT_WRITE = new Set(['add', 'commit']);

const gitTool: ToolDef = {
  name: 'git',
  description:
    'Run a safe git subcommand in the workspace. Allowed: status, diff, log, show, branch (read-only listing), add, commit. ' +
    'Pass arguments as an array, e.g. { subcommand: "commit", args: ["-m", "fix: typo"] }. ' +
    'Push, reset, clean, checkout, rebase and force flags are not available. Returns { ok, exitCode, stdout, stderr }.',
  parameters: {
    type: 'object',
    properties: {
      subcommand: { type: 'string', enum: [...GIT_READ, ...GIT_WRITE] },
      args: { type: 'array', items: { type: 'string' }, description: 'Arguments after the subcommand.' },
    },
    required: ['subcommand'],
  },
  run: async (args, ctx) => {
    const sub = String(args.subcommand ?? '');
    const rest: string[] = Array.isArray(args.args) ? args.args.map(String) : [];
    if (!GIT_READ.has(sub) && !GIT_WRITE.has(sub)) {
      return { ok: false, error: `git ${sub} is not allowed. Allowed: ${[...GIT_READ, ...GIT_WRITE].join(', ')}` };
    }
    // `git branch` is listing only: reject anything that creates, renames or deletes branches.
    if (sub === 'branch' && rest.some((a) => /^-(d|D|m|M|c|C|f)$|^--(delete|move|copy|force|set-upstream-to|unset-upstream)/.test(a) || !a.startsWith('-'))) {
      return { ok: false, error: 'git branch is read-only here; only listing flags (e.g. -a, -vv) are allowed.' };
    }
    // Block flags that execute commands or escape the workspace.
    const banned = /^(--force|-f|--exec|--upload-pack|--receive-pack|--output|--git-dir|--work-tree|-c|--config)(=|$)/;
    if (rest.some((a) => banned.test(a))) {
      return { ok: false, error: 'That flag is not allowed.' };
    }
    // Pathspecs must stay inside the workspace.
    for (const a of rest) {
      if (!a.startsWith('-') && (a.startsWith('..') || isAbsolute(a))) {
        const resolved = pathResolve(isAbsolute(a) ? a : join(ctx.workspace, a));
        const rel = relative(ctx.workspace, resolved);
        if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
          return { ok: false, error: `Path escapes workspace: ${a}` };
        }
      }
    }
    if (sub === 'commit' && !rest.some((a) => a === '-m' || a.startsWith('--message') || a === '-F')) {
      return { ok: false, error: 'git commit requires -m "<message>" (no interactive editor).' };
    }

    const { execFile } = await import('node:child_process');
    return new Promise((resolve) => {
      execFile(
        'git',
        ['--no-pager', sub, ...rest],
        {
          cwd: ctx.workspace,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_PAGER: 'cat' },
          timeout: 30_000,
          maxBuffer: 2_000_000,
          windowsHide: true,
        },
        (err: any, stdout, stderr) => {
          if (err && err.code === 'ENOENT') return resolve({ ok: false, error: 'git is not installed or not on PATH.', stdout: '', stderr: '' });
          const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
          resolve({ ok: code === 0, exitCode: code, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Tool: use_skill
// ---------------------------------------------------------------------------
// Skills are listed by name + description in the system prompt; the full instructions are
// loaded only when the model asks for them (progressive disclosure keeps every turn cheap).
const useSkill: ToolDef = {
  name: 'use_skill',
  description: 'Load the full instructions of an installed skill by name. Only call this when the skill is relevant to the task.',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: 'Skill name exactly as listed under "Available skills".' } },
    required: ['name'],
  },
  run: async (args) => {
    const skills = await import('../skills/index.js');
    const text = skills.getSkillPromptFragment(String(args.name ?? ''));
    if (!text) throw new Error(`No installed skill named "${args.name}", or it has no instruction file.`);
    const MAX = 30_000;
    return { name: args.name, instructions: text.length > MAX ? text.slice(0, MAX) + '\n[truncated]' : text };
  },
};

// ---------------------------------------------------------------------------
// Tool: delete_file
// ---------------------------------------------------------------------------
const deleteFile: ToolDef = {
  name: 'delete_file',
  description: 'Delete a file. Refuses directories. Returns { path, deleted: true }.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
    },
    required: ['path'],
  },
  run: (args, ctx) => {
    const full = safePath(ctx, args.path);
    if (!existsSync(full)) throw new Error(`File not found: ${args.path}`);
    const st = statSync(full);
    if (st.isDirectory()) throw new Error('Refusing to delete a directory');
    unlinkSync(full);
    return { path: args.path, deleted: true };
  },
};

// ---------------------------------------------------------------------------
// Tool: move_file
// ---------------------------------------------------------------------------
const moveFile: ToolDef = {
  name: 'move_file',
  description: 'Move or rename a file. Returns { from, to }.',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string' },
      to: { type: 'string' },
    },
    required: ['from', 'to'],
  },
  run: (args, ctx) => {
    const src = safePath(ctx, args.from);
    const dst = safePath(ctx, args.to);
    if (!existsSync(src)) throw new Error(`Source not found: ${args.from}`);
    mkdirSync(dirname(dst), { recursive: true });
    renameSync(src, dst);
    return { from: args.from, to: args.to };
  },
};

// ---------------------------------------------------------------------------
// Tool: update_plan
// ---------------------------------------------------------------------------
const updatePlan: ToolDef = {
  name: 'update_plan',
  description: 'Update the persistent task plan / todo list.',
  parameters: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'blocked'] },
          },
          required: ['text', 'status'],
        },
      },
    },
    required: ['items'],
  },
  run: (args, _ctx) => {
    // Plan is purely renderer-side state; main process just echoes back.
    return { items: args.items, updatedAt: Date.now() };
  },
};

// ---------------------------------------------------------------------------
// Tool: web_search
// ---------------------------------------------------------------------------
const webSearch: ToolDef = {
  name: 'web_search',
  description: 'Search the web for current information.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      maxResults: { type: 'integer', default: 5 },
    },
    required: ['query'],
  },
  run: async (args, _ctx) => {
    // Use DuckDuckGo HTML endpoint (no API key required, clean-room).
    const q = encodeURIComponent(args.query);
    const maxResults = Math.min(args.maxResults ?? 5, 10);
    try {
      const res = await fetch(`https://html.duckduckgo.com/html/?q=${q}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      });
      const html = await res.text();
      // Parse results from DDG HTML
      const results: { title: string; snippet: string; url: string }[] = [];
      const re = /<a rel="nofollow" class="result__a" href="([^"]+)">(.*?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>(.*?)<\/a>/g;
      let m;
      while ((m = re.exec(html)) && results.length < maxResults) {
        const url = m[1].replace(/&amp;/g, '&');
        const title = m[2].replace(/<[^>]+>/g, '').trim();
        const snippet = m[3].replace(/<[^>]+>/g, '').trim();
        results.push({ title, snippet, url });
      }
      return { query: args.query, results };
    } catch (err: any) {
      return { query: args.query, results: [], error: err?.message ?? String(err) };
    }
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------
export const TOOLS: ToolDef[] = [
  listFiles,
  readFile,
  writeFile,
  editFile,
  runCommand,
  gitTool,
  useSkill,
  deleteFile,
  moveFile,
  updatePlan,
  webSearch,
];

export async function handleToolCall(name: string, args: any, ctx: ToolContext): Promise<any> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.run(args ?? {}, ctx);
}

export function registerTools(_ipc: IpcMain, _opts: { pwd: () => string }) {
  // Tools are invoked via the `tool:invoke` channel in main.ts.
  // This function exists so future per-tool IPC channels can be wired here.
}

// ---------------------------------------------------------------------------
// Tiny unified-diff generator (clean-room, no deps)
// ---------------------------------------------------------------------------
function makeUnifiedDiff(path: string, a: string, b: string): string {
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  const lines: string[] = [];
  lines.push(`--- a/${path}`);
  lines.push(`+++ b/${path}`);

  // LCS-based diff (O(n*m)). Fine for typical file sizes.
  const n = aLines.length;
  const m = bLines.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (aLines[i] === bLines[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  let i = 0, j = 0;
  let aStart = -1, bStart = -1;
  let aCount = 0, bCount = 0; // separate counts for old-side and new-side
  const emit = (aIdx: number, bIdx: number, marker: ' ' | '-' | '+', text: string) => {
    if (aStart === -1) { aStart = aIdx; bStart = bIdx; }
    lines.push(`${marker}${text}`);
    if (marker !== '+') aCount++;
    if (marker !== '-') bCount++;
  };

  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) {
      emit(i + 1, j + 1, ' ', aLines[i]);
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      emit(i + 1, j, '-', aLines[i]);
      i++;
    } else {
      emit(i, j + 1, '+', bLines[j]);
      j++;
    }
  }
  while (i < n) { emit(i + 1, j, '-', aLines[i]); i++; }
  while (j < m) { emit(i, j + 1, '+', bLines[j]); j++; }

  // Insert hunk header at the top (after the +++ line).
  // Unified diff counts: old-side = deletions + context; new-side = additions + context.
  if (aStart >= 0) {
    lines.splice(2, 0, `@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
  }
  return lines.join('\n');
}
