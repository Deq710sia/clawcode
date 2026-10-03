/**
 * ClawCode — Windows Sandbox integration.
 * Generates a .wsb (Windows Sandbox config) file that launches ClawCode inside
 * an isolated Windows Sandbox VM with the user's workspace folder mapped read-write.
 *
 * Windows Sandbox is built into Windows 10/11 Pro/Enterprise/Education.
 * It creates a disposable, isolated Windows environment — anything that runs inside
 * stays inside. When the sandbox closes, all state is destroyed (except mapped folders).
 *
 * This is the "totally isolate my vibecoding from the rest of my PC" feature.
 */
import { app } from 'electron';
import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execSync, exec } from 'node:child_process';

export interface SandboxConfig {
  /** Workspace folder to map into the sandbox (read-write) */
  workspacePath: string;
  /** If true, the sandbox maps ClawCode's userData folder so settings/skills/models persist */
  persistUserData: boolean;
  /** If true, networking is enabled in the sandbox (required for API calls + webchats) */
  enableNetworking: boolean;
  /** If true, GPU passthrough is enabled (required for local model inference) */
  enableGpu: boolean;
  /** If true, clipboard sharing with host is enabled */
  enableClipboard: boolean;
  /** Path to the ClawCode .exe inside the sandbox (where it's mapped) */
  exePathInSandbox: string;
}

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  workspacePath: '',
  persistUserData: true,
  enableNetworking: true,
  enableGpu: true,
  enableClipboard: true,
  exePathInSandbox: 'C:\\ClawCode\\ClawCode.exe',
};

/**
 * Generate a .wsb file that launches ClawCode inside Windows Sandbox.
 * The .wsb file is XML with a specific schema understood by Windows Sandbox.
 *
 * Mapping strategy:
 *   - Host workspace folder → C:\Workspace in sandbox (read-write)
 *   - Host ClawCode install dir → C:\ClawCode in sandbox (read-only, just the .exe + resources)
 *   - Host userData (if persistUserData) → C:\Users\WDAGUtilityAccount\AppData\Roaming\ClawCode (read-write)
 *   - A startup script launches ClawCode.exe with the workspace path
 */
export function generateWsb(config: SandboxConfig): string {
  const hostExeDir = process.env.APP_ROOT || (process.platform === 'win32' ? join(app.getAppPath(), '..') : '');
  const hostUserData = app.getPath('userData');
  const hostExePath = join(hostExeDir, 'ClawCode.exe');

  const mappings: string[] = [];

  // Map the ClawCode install dir (read-only)
  if (hostExeDir && existsSync(hostExeDir)) {
    mappings.push(`    <MappedFolder>
      <HostFolder>${escapeXml(hostExeDir)}</HostFolder>
      <SandboxFolder>C:\\ClawCode</SandboxFolder>
      <ReadOnly>true</ReadOnly>
    </MappedFolder>`);
  }

  // Map the workspace folder (read-write so the agent can edit files)
  if (config.workspacePath && existsSync(config.workspacePath)) {
    mappings.push(`    <MappedFolder>
      <HostFolder>${escapeXml(config.workspacePath)}</HostFolder>
      <SandboxFolder>C:\\Workspace</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>`);
  }

  // Map userData so settings/skills/models/webchat-logins persist across sandbox launches
  if (config.persistUserData && existsSync(hostUserData)) {
    mappings.push(`    <MappedFolder>
      <HostFolder>${escapeXml(hostUserData)}</HostFolder>
      <SandboxFolder>C:\\Users\\WDAGUtilityAccount\\AppData\\Roaming\\ClawCode</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>`);
  }

  // Startup command: launch ClawCode with the sandbox workspace path
  const workspaceArg = config.workspacePath ? ' --workspace=C:\\Workspace' : '';
  const logonCommand = `    <LogonCommand>
      <Command>C:\\ClawCode\\ClawCode.exe${workspaceArg}</Command>
    </LogonCommand>`;

  return `<?xml version="1.0" encoding="utf-8"?>
<Configuration>
  <Networking>${config.enableNetworking ? 'Enable' : 'Disable'}</Networking>
  <VGpu>${config.enableGpu ? 'Enable' : 'Disable'}</VGpu>
  <ClipboardRedirection>${config.enableClipboard ? 'Enable' : 'Disable'}</ClipboardRedirection>
  <ProtectedClient>Enable</ProtectedClient>
  <MemoryInMB>4096</MemoryInMB>
${mappings.join('\n')}
${logonCommand}
</Configuration>`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * Write the .wsb file to disk and return its path.
 * The user double-clicks the .wsb file to launch the sandbox.
 */
export function writeWsbFile(config: SandboxConfig): string {
  const wsbDir = join(app.getPath('userData'), 'sandbox');
  mkdirSync(wsbDir, { recursive: true });
  const wsbPath = join(wsbDir, 'ClawCode-Sandbox.wsb');
  writeFileSync(wsbPath, generateWsb(config), 'utf8');
  return wsbPath;
}

/**
 * Check if Windows Sandbox is available (Windows 10/11 Pro+ with the optional feature enabled).
 */
export function isSandboxAvailable(): boolean {
  if (process.platform !== 'win32') return false;
  // Querying the optional feature needs admin rights, so just look for the executable
  // that the feature installs (Windows 10/11 Pro, Enterprise, Education).
  const sysRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return existsSync(join(sysRoot, 'System32', 'WindowsSandbox.exe'));
}

/**
 * Launch the sandbox by opening the .wsb file (Windows associates .wsb with WindowsSandbox.exe).
 */
export function launchSandbox(config: SandboxConfig): { ok: boolean; error?: string; wsbPath?: string } {
  try {
    const wsbPath = writeWsbFile(config);
    if (process.platform !== 'win32') {
      return { ok: false, error: 'Windows Sandbox only available on Windows 10/11 Pro+', wsbPath };
    }
    exec(`start "" "${wsbPath}"`);
    return { ok: true, wsbPath };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}
