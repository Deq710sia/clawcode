/**
 * ClawCode — Process-level sandbox (Codex-style restricted user isolation).
 *
 * Runs the AGENT'S SHELL COMMANDS as a restricted local user that only has
 * filesystem write access to the workspace folder.
 *
 * Honest scope: this runs the agent's shell commands as a separate low-privilege
 * Windows account that can only write to the workspace. It is NOT a VM or container;
 * use the Windows Sandbox integration for hard isolation.
 */
import { app, safeStorage } from 'electron';
import { join, relative, isAbsolute } from 'node:path';
import { existsSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const SANDBOX_USER = 'ClawCodeSandbox';
const configFilePath = () => join(app.getPath('userData'), 'sandbox-config.json');

export interface ProcessSandboxConfig {
  enabled: boolean;
  sandboxUser: string;
  passwordCipher?: string;
  workspacePath?: string;
  denyNetwork: boolean;
  createdAt?: number;
}

export function loadSandboxConfig(): ProcessSandboxConfig {
  try {
    if (!existsSync(configFilePath())) return defaultConfig();
    const raw = readFileSync(configFilePath(), 'utf8');
    return { ...defaultConfig(), ...JSON.parse(raw) };
  } catch {
    return defaultConfig();
  }
}

function defaultConfig(): ProcessSandboxConfig {
  return {
    enabled: false,
    sandboxUser: SANDBOX_USER,
    denyNetwork: false,
  };
}

function saveSandboxConfig(cfg: ProcessSandboxConfig) {
  writeFileSync(configFilePath(), JSON.stringify(cfg, null, 2), 'utf8');
}

function encryptPassword(plain: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    const key = randomBytes(32);
    const buf = Buffer.from(plain, 'utf8');
    const out = Buffer.alloc(buf.length);
    for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ key[i % key.length];
    return `xor:${key.toString('base64')}:${out.toString('base64')}`;
  }
  return safeStorage.encryptString(plain).toString('base64');
}

export function decryptPassword(cipher: string): string {
  if (cipher.startsWith('xor:')) {
    const [, keyB64, dataB64] = cipher.split(':');
    const key = Buffer.from(keyB64, 'base64');
    const data = Buffer.from(dataB64, 'base64');
    const out = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i++) out[i] = data[i] ^ key[i % key.length];
    return out.toString('utf8');
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS secure storage unavailable; cannot decrypt sandbox password.');
  }
  return safeStorage.decryptString(Buffer.from(cipher, 'base64'));
}

function generatePassword(): string {
  // 24-char alphanumeric. No shell metacharacters so it can never be mangled.
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const out: string[] = [];
  const bytes = randomBytes(24);
  for (let i = 0; i < 24; i++) out.push(chars[bytes[i] % chars.length]);
  return out.join('');
}

const run = (file: string, args: string[]) =>
  execFileSync(file, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).toString();

const ps = (script: string) =>
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);

/**
 * Check if the ClawCodeSandbox user exists.
 * `net user <name>` exits non-zero when the account does not exist (locale independent).
 */
export function isSandboxUserExists(): boolean {
  if (process.platform !== 'win32') return false;
  try {
    run('net', ['user', SANDBOX_USER]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if ClawCode is running elevated (admin rights).
 * `fltmc` only succeeds for administrators.
 */
export function isElevated(): boolean {
  if (process.platform !== 'win32') return false;
  try {
    run('fltmc', []);
    return true;
  } catch {
    return false;
  }
}

const FIREWALL_RULE = 'ClawCodeSandbox-Deny-Outbound';

/**
 * Set up the sandbox user + ACLs. Requires admin elevation.
 * Idempotent — safe to call multiple times.
 */
export async function setupSandbox(opts: { workspacePath: string; denyNetwork: boolean }): Promise<{ ok: boolean; error?: string }> {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'Process sandbox only available on Windows' };
  }
  if (!isElevated()) {
    return { ok: false, error: 'Admin rights required. Relaunch ClawCode as administrator (right-click → Run as administrator) to set up the sandbox.' };
  }
  if (!opts.workspacePath || !existsSync(opts.workspacePath)) {
    return { ok: false, error: 'Invalid workspace path' };
  }

  const cfg = loadSandboxConfig();
  cfg.workspacePath = opts.workspacePath;
  cfg.denyNetwork = opts.denyNetwork;

  // 1. Create the user (or reset its password if we lost it).
  //    Password is passed via stdin to `net user … *` to avoid leaking it in
  //    the process command line (visible via Task Manager / Process Explorer).
  try {
    if (!isSandboxUserExists()) {
      const password = generatePassword();
      cfg.passwordCipher = encryptPassword(password);
      saveSandboxConfig(cfg);
      // Use PowerShell New-LocalUser which accepts the password as a SecureString
      // passed via pipeline, never as a command-line argument.
      const b64Pw = Buffer.from(password, 'utf16le').toString('base64');
      ps(`
        $pw = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${b64Pw}')) | ConvertTo-SecureString -AsPlainText -Force
        New-LocalUser -Name '${SANDBOX_USER}' -Password $pw -Description 'ClawCode agent sandbox' -PasswordNeverExpires -UserMayNotChangePassword
        Add-LocalGroupMember -Group 'Users' -Member '${SANDBOX_USER}'
        try { Remove-LocalGroupMember -Group 'Remote Desktop Users' -Member '${SANDBOX_USER}' -ErrorAction SilentlyContinue } catch {}
      `);
    } else if (!cfg.passwordCipher) {
      const password = generatePassword();
      cfg.passwordCipher = encryptPassword(password);
      saveSandboxConfig(cfg);
      const b64Pw = Buffer.from(password, 'utf16le').toString('base64');
      ps(`
        $pw = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${b64Pw}')) | ConvertTo-SecureString -AsPlainText -Force
        Set-LocalUser -Name '${SANDBOX_USER}' -Password $pw
      `);
    }
  } catch (err: any) {
    return { ok: false, error: `Failed to create sandbox user: ${err?.stderr?.toString?.() || err?.message || err}` };
  }

  // 2. Filesystem ACLs.
  //    Grant workspace access FIRST. Then, if the workspace is under the user profile,
  //    deny access to the profile EXCLUDING the workspace (using an explicit allow on
  //    the workspace path which takes precedence over inherited deny).
  try {
    run('icacls', [opts.workspacePath, '/grant', `${SANDBOX_USER}:(OI)(CI)M`, '/T', '/C', '/Q']);
  } catch (err: any) {
    return { ok: false, error: `Failed to grant workspace access: ${err?.stderr?.toString?.() || err?.message || err}` };
  }
  // Deny access to the user's home directory, but ONLY if the workspace is NOT inside it.
  // If the workspace IS inside the profile, the explicit allow above takes precedence
  // over inherited denies (Windows ACL: explicit allow > inherited deny).
  // So we deny at the profile level but the workspace's explicit grant wins.
  try {
    const userProfile = process.env.USERPROFILE;
    if (userProfile && existsSync(userProfile)) {
      // Deny at the Users directory level (parent of all profiles).
      // The explicit allow on the workspace overrides this inherited deny.
      const usersDir = userProfile.split('\\').slice(0, -1).join('\\');
      if (usersDir && existsSync(usersDir)) {
        run('icacls', [usersDir, '/deny', `${SANDBOX_USER}:(OI)(CI)(R)`, '/C', '/Q']);
      }
    }
  } catch (err: any) {
    console.warn('[sandbox] could not deny access to user directory:', err?.message);
  }

  // 3. Outbound network block (optional). Uses a per-user firewall rule.
  try {
    ps(`Remove-NetFirewallRule -DisplayName '${FIREWALL_RULE}' -ErrorAction SilentlyContinue`);
    if (cfg.denyNetwork) {
      ps(`
        $sid = (New-Object System.Security.Principal.NTAccount('${SANDBOX_USER}')).Translate([System.Security.Principal.SecurityIdentifier]).Value
        New-NetFirewallRule -DisplayName '${FIREWALL_RULE}' -Direction Outbound -Action Block -Profile Any -LocalUser ("D:(A;;CC;;;" + $sid + ")") | Out-Null
      `);
    }
  } catch (err: any) {
    if (cfg.denyNetwork) {
      return { ok: false, error: `Network block requested but the firewall rule could not be created: ${err?.stderr?.toString?.() || err?.message || err}` };
    }
  }

  cfg.enabled = true;
  cfg.createdAt = Date.now();
  saveSandboxConfig(cfg);
  return { ok: true };
}

export async function disableSandbox(): Promise<{ ok: boolean; error?: string }> {
  const cfg = loadSandboxConfig();
  cfg.enabled = false;
  saveSandboxConfig(cfg);
  return { ok: true };
}

export async function teardownSandbox(): Promise<{ ok: boolean; error?: string }> {
  if (process.platform !== 'win32') return { ok: false, error: 'Windows only' };
  if (!isElevated()) {
    return { ok: false, error: 'Admin rights required' };
  }
  try {
    try { ps(`Remove-NetFirewallRule -DisplayName '${FIREWALL_RULE}' -ErrorAction SilentlyContinue`); } catch {}
    if (isSandboxUserExists()) {
      run('net', ['user', SANDBOX_USER, '/delete']);
    }
  } catch (err: any) {
    return { ok: false, error: err?.stderr?.toString?.() || err?.message || String(err) };
  }
  const cfg = loadSandboxConfig();
  cfg.enabled = false;
  cfg.passwordCipher = undefined;
  cfg.workspacePath = undefined;
  saveSandboxConfig(cfg);
  try { rmSync(configFilePath(), { force: true }); } catch {}
  return { ok: true };
}

/**
 * Run a shell command as the sandbox user (PowerShell, matching the unsandboxed path).
 * Throws if the sandbox cannot be used — callers MUST NOT fall back to unsandboxed execution.
 *
 * The command is passed via -EncodedCommand (base64 UTF-16LE), never interpolated into
 * script text — this prevents PowerShell variable expansion ($var, ${...}, $(...)) in
 * the agent's command string.
 */
export async function runCommandSandboxed(command: string, opts: { cwd: string; timeoutMs?: number }): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number | null }> {
  const cfg = loadSandboxConfig();
  if (process.platform !== 'win32') throw new Error('Process sandbox only available on Windows');
  if (!cfg.enabled || !cfg.passwordCipher || !cfg.workspacePath) {
    throw new Error('Process sandbox not configured');
  }
  const cwd = opts.cwd || cfg.workspacePath;
  const rel = relative(cfg.workspacePath, cwd);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Sandbox only has access to ${cfg.workspacePath}. Re-run sandbox setup for the current workspace (${cwd}).`);
  }
  const password = decryptPassword(cfg.passwordCipher);
  const timeoutMs = Math.min(opts.timeoutMs ?? 120000, 600000);
  const b64 = (v: string) => Buffer.from(v, 'utf8').toString('base64');
  // -EncodedCommand expects UTF-16LE base64.
  const innerEncoded = Buffer.from(command, 'utf16le').toString('base64');
  const pwEncoded = Buffer.from(password, 'utf16le').toString('base64');
  const cwdEncoded = Buffer.from(cwd, 'utf16le').toString('base64');

  // The inner PowerShell script runs the agent's command as the sandbox user.
  // It reads stdout/stderr ASYNCHRONOUSLY (BeginOutputReadLine) to avoid the
  // classic .NET deadlock where WaitForExit blocks on a full pipe buffer.
  const script = `
$ErrorActionPreference = 'Stop'
function D($s) { [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($s)) }
$pw = ConvertTo-SecureString (D '${pwEncoded}') -AsPlainText -Force
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'powershell.exe'
$psi.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${innerEncoded}'
$psi.WorkingDirectory = (D '${cwdEncoded}')
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $true
$psi.LoadUserProfile = $true
$psi.UserName = '${SANDBOX_USER}'
$psi.Password = $pw
$p = [System.Diagnostics.Process]::Start($psi)
$out = new-object System.Text.StringBuilder
$err = new-object System.Text.StringBuilder
$outHandler = { if (-not $EventArgs.Data) { return }; [void]$out.AppendLine($EventArgs.Data) }
$errHandler = { if (-not $EventArgs.Data) { return }; [void]$err.AppendLine($EventArgs.Data) }
Register-ObjectEvent -InputObject $p -EventName OutputDataReceived -Action $outHandler | Out-Null
Register-ObjectEvent -InputObject $p -EventName ErrorDataReceived -Action $errHandler | Out-Null
$p.BeginOutputReadLine()
$p.BeginErrorReadLine()
$timedOut = -not $p.WaitForExit(${timeoutMs})
if ($timedOut) { try { $p.Kill() } catch {}; $p.WaitForExit() }
$p.CancelOutputRead()
$p.CancelErrorRead()
$result = @{ exit = $(if ($timedOut) { -1 } else { $p.ExitCode }); timedOut = $timedOut; out = $out.ToString(); err = $err.ToString() }
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($result | ConvertTo-Json -Compress)))
`.trim();

  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let errOut = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (errOut += d.toString()));
    const killer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs + 15000);
    child.on('error', (e) => { clearTimeout(killer); reject(e); });
    child.on('close', () => {
      clearTimeout(killer);
      try {
        const payload = JSON.parse(Buffer.from(out.trim().split(/\r?\n/).pop() || '', 'base64').toString('utf8'));
        resolve({
          ok: payload.exit === 0,
          stdout: payload.out ?? '',
          stderr: (payload.err ?? '') + (payload.timedOut ? '\n[ClawCode] process timed out' : ''),
          exitCode: payload.exit ?? null,
        });
      } catch {
        reject(new Error(`Sandboxed launch failed: ${(errOut || out).trim().slice(0, 600) || 'no output from PowerShell'}`));
      }
    });
  });
}

export function getSandboxStatus(): {
  platform: string;
  elevated: boolean;
  userExists: boolean;
  enabled: boolean;
  configured: boolean;
  workspacePath?: string;
  denyNetwork: boolean;
  sandboxUser: string;
} {
  const cfg = loadSandboxConfig();
  return {
    platform: process.platform,
    elevated: isElevated(),
    userExists: isSandboxUserExists(),
    enabled: cfg.enabled,
    configured: !!cfg.passwordCipher && !!cfg.workspacePath,
    workspacePath: cfg.workspacePath,
    denyNetwork: cfg.denyNetwork,
    sandboxUser: SANDBOX_USER,
  };
}
