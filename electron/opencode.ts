/**
 * ClawCode — OpenCode subprocess manager.
 * Spawns `opencode serve` (if installed) and proxies the agent loop through it.
 * OpenCode is OSS (MIT): https://github.com/opencode-ai/opencode
 *
 * If `opencode` is not on PATH, this module reports not-installed and the UI
 * falls back to ClawCode's built-in agent loop.
 */
import { spawn, execSync, ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

export interface OpenCodeStatus {
  installed: boolean;
  version?: string;
  path?: string;
  running: boolean;
  port?: number;
  pid?: number;
  lastError?: string;
}

interface OpenCodeOpts {
  model?: string;
  provider?: string;
  workspace?: string;
  port?: number;
}

let ocProcess: ChildProcess | null = null;
let ocStatus: OpenCodeStatus = { installed: false, running: false };

function findOpenCodeBinary(): string | null {
  const candidates =
    process.platform === 'win32'
      ? ['opencode.exe', 'opencode.cmd', 'opencode']
      : ['opencode'];
  for (const c of candidates) {
    try {
      const path = execSync(`${process.platform === 'win32' ? 'where' : 'which'} ${c}`, { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim()
        .split(/\r?\n/)[0];
      if (path && existsSync(path)) return path;
    } catch {}
  }
  return null;
}

export function probeOpenCode(): OpenCodeStatus {
  const path = findOpenCodeBinary();
  if (!path) {
    ocStatus = { installed: false, running: false };
    return ocStatus;
  }
  let version = '';
  try {
    version = execSync(`"${path}" --version`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {}
  ocStatus = { installed: true, path, version, running: ocProcess !== null };
  return ocStatus;
}

export async function startOpenCode(opts: OpenCodeOpts): Promise<OpenCodeStatus> {
  if (ocProcess) await stopOpenCode();
  const probe = probeOpenCode();
  if (!probe.installed || !probe.path) {
    ocStatus = { installed: false, running: false, lastError: 'opencode not found on PATH' };
    return ocStatus;
  }

  const port = opts.port ?? 43182;
  const workspace = opts.workspace || app.getPath('home');
  const args = ['serve', '--port', String(port)];

  try {
    ocProcess = spawn(probe.path, args, {
      cwd: workspace,
      env: {
        ...process.env,
        OPENCODE_MODEL: opts.model || '',
        OPENCODE_PROVIDER: opts.provider || '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (err: any) {
    ocStatus = { ...probe, running: false, lastError: err?.message ?? String(err) };
    return ocStatus;
  }

  const logDir = join(app.getPath('userData'), 'logs');
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, 'opencode.log');

  ocProcess.stdout?.on('data', (d) => {
    const line = d.toString();
    try { appendFileSync(logFile, line); } catch {}
    if (line.includes('listening') || line.includes('ready') || line.includes('started')) {
      ocStatus = { ...probe, running: true, port, pid: ocProcess?.pid };
    }
  });
  ocProcess.stderr?.on('data', (d) => {
    try { appendFileSync(logFile, d.toString()); } catch {}
  });
  ocProcess.on('error', (err) => {
    // spawn() failed (ENOENT, EPERM, etc.) — clear ocProcess so restart works.
    ocStatus = { ...probe, running: false, lastError: err?.message ?? String(err) };
    ocProcess = null;
  });
  ocProcess.on('exit', (code) => {
    ocStatus = { ...probe, running: false, lastError: code !== 0 ? `exited with code ${code}` : undefined };
    ocProcess = null;
  });

  // Wait briefly for startup
  await new Promise((r) => setTimeout(r, 1500));
  ocStatus = { ...probe, running: ocProcess !== null, port, pid: ocProcess?.pid };
  return ocStatus;
}

export async function stopOpenCode(): Promise<void> {
  if (!ocProcess) return;
  try {
    ocProcess.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    if (!ocProcess.killed) {
      try { ocProcess.kill('SIGKILL'); } catch {}
    }
  } catch {}
  ocProcess = null;
  ocStatus = { ...ocStatus, running: false };
}

export function getOpenCodeStatus(): OpenCodeStatus {
  return ocStatus;
}

/**
 * Proxy a chat completion request to the running OpenCode server.
 * OpenCode's HTTP API mirrors OpenAI's /v1/chat/completions.
 */
export async function proxyToOpenCode(body: any, signal?: AbortSignal): Promise<Response> {
  if (!ocStatus.running || !ocStatus.port) {
    throw new Error('OpenCode backend not running');
  }
  const url = `http://127.0.0.1:${ocStatus.port}/v1/chat/completions`;
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
}
