/**
 * ClawCode tools — clean-room implementations.
 * Each tool has:
 *   - a JSON-Schema descriptor (OpenAI-compatible function calling)
 *   - a handler that runs in the Electron main process
 *
 * Tools are sandboxed to the active workspace: any path argument is resolved
 * against the workspace root and rejected if it escapes.
 */
import { IpcMain } from 'electron';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  renameSync,
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
  const rel = relative(ctx.workspace, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${p}`);
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
const readFile: ToolDef = {
  name: 'read_file',
  description:
    'Read the full contents of a UTF-8 text file. Returns { path, content }. Rejects paths outside the workspace.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to workspace root.' },
    },
    required: ['path'],
  },
  run: (args, ctx) => {
    const full = safePath(ctx, args.path);
    if (!existsSync(full)) throw new Error(`File not found: ${args.path}`);
    const st = statSync(full);
    if (st.isDirectory()) throw new Error(`Path is a directory: ${args.path}`);
    if (st.size > 5 * 1024 * 1024) throw new Error(`File too large (${st.size} bytes > 5MB)`);
    const content = readFileSync(full, 'utf8');
    return { path: args.path, content, size: st.size };
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

    for (const r of args.replacements ?? []) {
      if (!original.includes(r.old)) {
        failed.push({ old: r.old.slice(0, 80), reason: 'old string not found' });
        continue;
      }
      if (r.old === r.new) {
        failed.push({ old: r.old.slice(0, 80), reason: 'old and new are identical' });
        continue;
      }
      // Replace first occurrence only (deterministic)
      updated = updated.replace(r.old, r.new);
      applied.push({ old: r.old, new: r.new });
    }

    if (applied.length > 0) {
      writeFileSync(full, updated, 'utf8');
    }

    // Build a simple unified diff (no external deps)
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
    'Execute a shell command in the workspace. Returns { ok, exitCode, stdout, stderr }. The command runs via bash on macOS/Linux and PowerShell on Windows. Timeout: 120s.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute.' },
      timeoutMs: { type: 'integer', description: 'Optional timeout in milliseconds. Default 120000.', default: 120000 },
    },
    required: ['command'],
  },
  run: async (args, ctx) => {
    // Defer to the IPC `shell:exec` channel by re-using spawn inline.
    const { spawn } = await import('node:child_process');
    const isWin = process.platform === 'win32';
    return new Promise((resolve) => {
      const child = spawn(args.command, {
        cwd: ctx.workspace,
        shell: isWin ? 'powershell.exe' : '/bin/bash',
        env: process.env,
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        stderr += '\n[ClawCode] process timed out';
      }, Math.min(args.timeoutMs ?? 120_000, 600_000));

      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ ok: false, error: err.message, stdout, stderr });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ ok: code === 0, exitCode: code, stdout, stderr });
      });
    });
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
  let aStart = -1, bStart = -1, count = 0;
  const emit = (aIdx: number, bIdx: number, marker: ' ' | '-' | '+', text: string) => {
    if (aStart === -1) { aStart = aIdx; bStart = bIdx; }
    lines.push(`${marker}${text}`);
    count++;
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

  // Insert hunk header at the top (after the +++ line)
  if (aStart >= 0) {
    lines.splice(2, 0, `@@ -${aStart},${count} +${bStart},${count} @@`);
  }
  return lines.join('\n');
}
