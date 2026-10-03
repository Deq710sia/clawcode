/**
 * ClawCode — Process-level sandbox (Codex-style restricted user isolation).
 *
 * Instead of running ClawCode inside a Windows Sandbox VM (electron/sandbox.ts),
 * this module runs the AGENT'S SHELL COMMANDS as a restricted local user that
 * only has filesystem write access to the workspace folder.
 *
 * This is the approach OpenAI Codex uses on Windows:
 *   - Create a restricted local user (ClawCodeSandbox)
 *   - Set filesystem ACLs: workspace = writable, everything else = denied
 *   - Optionally deny network access via Windows Firewall
 *   - Spawn each `run_command` call as that user via PowerShell Start-Process -Credential
 *
 * Seamless to the user: no VM startup, no manual setup beyond a one-time
 * admin elevation to create the user.
 */
import { app, safeStorage } from 'electron';
import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';

const SANDBOX_USER = 'ClawCodeSandbox';
const configFilePath = () => join(app.getPath('userData'), 'sandbox-config.json');

export interface ProcessSandboxConfig {
  enabled: boolean;
  sandboxUser: string;
  /** Encrypted password (base64 safeStorage) */
  passwordCipher?: string;
  /** Workspace path the sandbox user has write access to */
  workspacePath?: string;
  /** If true, deny network access to sandbox user via Windows Firewall */
  denyNetwork: boolean;
  /** Created at timestamp */
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
    // XOR fallback (same as API key handling)
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
  // 24-char alphanumeric + symbols that are PowerShell-safe
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^*';
  const bytes = randomBytes(24);
  let out = '';
  for (let i = 0; i < 24; i++) out += chars[bytes[i] % chars.length];
  return out;
}

/**
 * Check if the ClawCodeSandbox user exists on this system.
 */
export function isSandboxUserExists(): boolean {
  if (process.platform !== 'win32') return false;
  try {
    const out = execSync(`net user "${SANDBOX_USER}"`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return !out.includes('not found') && !out.toLowerCase().includes('the user name could not be found');
  } catch {
    return false;
  }
}

/**
 * Check if ClawCode is running elevated (admin rights).
 * Required for creating local users and setting firewall rules.
 */
export function isElevated(): boolean {
  if (process.platform !== 'win32') return false;
  try {
    execSync('net session', { stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

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

  // 1. Create user if not exists
  if (!isSandboxUserExists()) {
    const password = generatePassword();
    cfg.passwordCipher = encryptPassword(password);
    try {
      execSync(`net user "${SANDBOX_USER}" "${password}" /add /active:yes /passwordreq:yes /expires:never`, { stdio: ['ignore', 'pipe', 'pipe'] });
      // Add to Users group (not Administrators). Deny Remote Desktop + interactive logon.
      execSync(`net localgroup Users "${SANDBOX_USER}" /add`, { stdio: ['ignore', 'pipe', 'pipe'] });
      execSync(`net localgroup "Remote Desktop Users" "${SANDBOX_USER}" /delete`, { stdio: ['ignore', 'pipe', 'pipe'] });
      // Deny interactive logon (can only run processes, not log in at lock screen)
      execSync(`ntrights +r SeDenyInteractiveLogonRight -u "${SANDBOX_USER}"`, { stdio: ['ignore', 'pipe', 'pipe'] });
      execSync(`ntrights +r SeDenyNetworkLogonRight -u "${SANDBOX_USER}"`, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err: any) {
      return { ok: false, error: `Failed to create sandbox user: ${err?.message ?? err}` };
    }
  } else if (!cfg.passwordCipher) {
    // User exists but we don't have the password — reset it
    const password = generatePassword();
    cfg.passwordCipher = encryptPassword(password);
    try {
      execSync(`net user "${SANDBOX_USER}" "${password}"`, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err: any) {
      return { ok: false, error: `Failed to reset sandbox user password: ${err?.message ?? err}` };
    }
  }

  // 2. Set filesystem ACLs:
  //    - Workspace: full control for sandbox user
  //    - Temp dir: full control (needed for command temp files)
  //    - User profile folders: deny
  try {
    const ws = opts.workspacePath;
    execSync(`icacls "${ws}" /grant "${SANDBOX_USER}:(OI)(CI)F" /T`, { stdio: ['ignore', 'pipe', 'pipe'] });
    // Grant temp dir access
    const tempDir = process.env.TEMP || 'C:\\Windows\\Temp';
    execSync(`icacls "${tempDir}" /grant "${SANDBOX_USER}:(OI)(CI)M" /T`, { stdio: ['ignore', 'pipe', 'pipe'] });
    // Deny access to other user profiles
    const userProfile = process.env.USERPROFILE || 'C:\\Users\\Default';
    const usersDir = userProfile.split('\\').slice(0, -1).join('\\');
    execSync(`icacls "${usersDir}" /deny "${SANDBOX_USER}:(OI)(CI)R"`, { stdio: ['ignore', 'pipe', 'pipe'] });
    // Re-grant access to the sandbox user's own profile (so it can run)
    execSync(`icacls "${usersDir}\\${SANDBOX_USER}" /grant "${SANDBOX_USER}:(OI)(CI)F" /T`, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err: any) {
    return { ok: false, error: `Failed to set ACLs: ${err?.message ?? err}` };
  }

  // 3. Network firewall rules (optional)
  try {
    if (cfg.denyNetwork) {
      execSync(`netsh advfirewall firewall add rule name="ClawCodeSandbox-Deny-Outbound" dir=out action=block profile=any localuser="${SANDBOX_USER}"`, { stdio: ['ignore', 'pipe', 'pipe'] });
    } else {
      execSync(`netsh advfirewall firewall delete rule name="ClawCodeSandbox-Deny-Outbound"`, { stdio: ['ignore', 'pipe', 'pipe'] });
    }
  } catch (err: any) {
    // Non-fatal — firewall rules require specific Windows versions
    console.warn('[sandbox] firewall rule setup failed:', err?.message);
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
    // Remove firewall rule
    try { execSync(`netsh advfirewall firewall delete rule name="ClawCodeSandbox-Deny-Outbound"`, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch {}
    // Delete user
    if (isSandboxUserExists()) {
      execSync(`net user "${SANDBOX_USER}" /delete`, { stdio: ['ignore', 'pipe', 'pipe'] });
    }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
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
 * Run a shell command as the sandbox user. Used by the run_command tool when sandbox is enabled.
 * Spawns PowerShell, which uses Start-Process -Credential to run the command as the sandbox user.
 */
export async function runCommandSandboxed(command: string, opts: { cwd: string; timeoutMs?: number }): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number | null }> {
  const cfg = loadSandboxConfig();
  if (!cfg.enabled || !cfg.passwordCipher || !cfg.workspacePath) {
    throw new Error('Process sandbox not configured');
  }
  const password = decryptPassword(cfg.passwordCipher);
  const cwd = opts.cwd || cfg.workspacePath;

  // Use PowerShell Start-Process -Credential to run as the sandbox user
  // Output is captured via temp files (Start-Process doesn't pipeline stdout/stderr)
  const tmpDir = process.env.TEMP || 'C:\\Windows\\Temp';
  const outId = randomBytes(8).toString('hex');
  const stdoutFile = join(tmpDir, `clawcode-stdout-${outId}.txt`);
  const stderrFile = join(tmpDir, `clawcode-stderr-${outId}.txt`);
  const exitCodeFile = join(tmpDir, `clawcode-exit-${outId}.txt`);

  // Escape the command for PowerShell embedding
  const psCommand = `
$pw = ConvertTo-SecureString '${password.replace(/'/g, "''")}' -AsPlainText -Force
$cred = New-Object System.Management.Automation.PSCredential('${SANDBOX_USER}', $pw)
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'cmd.exe'
$psi.Arguments = '/c ' + [char]34 + ${JSON.stringify(command)} + [char]34
$psi.WorkingDirectory = ${JSON.stringify(cwd)}
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.UserName = '${SANDBOX_USER}'
$psi.Password = $pw
$psi.WindowStyle = 'Hidden'
$p = [System.Diagnostics.Process]::Start($psi)
$p.WaitForExit(${Math.min(opts.timeoutMs ?? 120000, 600000)})
$exit = $p.ExitCode
$stdout = $p.StandardOutput.ReadToEnd()
$stderr = $p.StandardError.ReadToEnd()
[System.IO.File]::WriteAllText('${stdoutFile.replace(/\\/g, '\\\\')}', $stdout)
[System.IO.File]::WriteAllText('${stderrFile.replace(/\\/g, '\\\\')}', $stderr)
[System.IO.File]::WriteAllText('${exitCodeFile.replace(/\\/g, '\\\\')}', $exit)
`.trim();

  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCommand], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
    }, Math.min(opts.timeoutMs ?? 120000, 600000) + 5000);

    child.on('close', () => {
      clearTimeout(timer);
      let stdout = '';
      let cmdStderr = '';
      let exitCode: number | null = null;
      try { stdout = readFileSync(stdoutFile, 'utf8'); } catch {}
      try { cmdStderr = readFileSync(stderrFile, 'utf8'); } catch {}
      try { exitCode = parseInt(readFileSync(exitCodeFile, 'utf8').trim()); } catch {}
      try { rmSync(stdoutFile, { force: true }); } catch {}
      try { rmSync(stderrFile, { force: true }); } catch {}
      try { rmSync(exitCodeFile, { force: true }); } catch {}
      resolve({
        ok: exitCode === 0,
        stdout,
        stderr: cmdStderr + (stderr ? `\n[PowerShell] ${stderr}` : ''),
        exitCode,
      });
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
