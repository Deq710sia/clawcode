/**
 * ClawCode — Electron main process
 * Clean-room implementation. No third-party agent runtime; all tools are
 * implemented from scratch using only Node's standard libraries.
 */
import { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve as pathResolve, relative, normalize, isAbsolute } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync, renameSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';

import { registerTools, handleToolCall } from './tools/index.js';
import { initBridge, getAllProfiles, login as webchatLogin, closeAllSessions, resetWebChat, getBridgeStatus, type WebChatId } from './webchat/bridge.js';
import { startBridgeServer, stopBridgeServer } from './webchat/server.js';
import { probeOpenCode, startOpenCode, stopOpenCode, getOpenCodeStatus, proxyToOpenCode } from './opencode.js';
import { PROVIDERS } from './providers/index.js';
import * as Skills from './skills/index.js';
import * as HF from './huggingface.js';
import { autoUpdater } from 'electron-updater';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const isDev = !!process.env.VITE_DEV_SERVER_URL;
const userDataDir = app.getPath('userData');
const configFile = join(userDataDir, 'clawcode.config.json');

process.env.APP_ROOT = isDev ? __dirname : dirname(app.getPath('exe'));
const MAIN_DIST = join(__dirname, '../dist-electron');
const RENDERER_DIST = join(__dirname, '../dist');

// ---------------------------------------------------------------------------
// Single-instance lock
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0b12',
    icon: join(__dirname, '../build/icon.ico'),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    titleBarOverlay: {
      color: '#0b0b12',
      symbolColor: '#a78bfa',
      height: 36,
    },
    frame: process.platform === 'darwin',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  if (isDev) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL!);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(join(RENDERER_DIST, 'index.html'));
  }

  // Open external links in browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
}

app.whenReady().then(async () => {
  // Init WebChat bridge + local HTTP server
  initBridge();
  Skills.initSkills();
  HF.initModels();
  const bridgeStatus = await startBridgeServer();
  if (!bridgeStatus.ok) {
    console.error('[clawcode] WebChat bridge server failed to start:', bridgeStatus.error);
  } else {
    console.log(`[clawcode] WebChat bridge listening on 127.0.0.1:${bridgeStatus.port}`);
  }

  // Auto-updater config (GitHub releases)
  autoUpdater.autoDownload = false;       // user clicks button to download
  autoUpdater.autoInstallOnAppQuit = true; // install on next launch if downloaded
  autoUpdater.allowDowngrade = false;
  // Log updater events to console for debugging
  const logUpdater = (label: string) => () => console.log(`[updater:${label}]`);
  autoUpdater.on('checking-for-update', logUpdater('checking'));
  autoUpdater.on('update-available', (info: any) => {
    console.log('[updater] update available:', info?.version);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater:state', {
        state: 'available',
        version: info?.version,
        releaseNotes: info?.releaseNotes,
        releaseUrl: info?.releaseName ? `https://github.com/Deq710sia/clawcode/releases/tag/v${info.version}` : undefined,
      });
    }
  });
  autoUpdater.on('update-not-available', (info: any) => {
    console.log('[updater] up to date');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater:state', { state: 'up-to-date', version: info?.version || app.getVersion() });
    }
  });
  autoUpdater.on('error', (err: Error) => {
    console.error('[updater] error:', err?.message);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater:state', { state: 'error', error: err?.message ?? String(err) });
    }
  });
  autoUpdater.on('download-progress', (progress: any) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater:progress', {
        percent: progress?.percent ?? 0,
        transferred: progress?.transferred,
        total: progress?.total,
        bytesPerSecond: progress?.bytesPerSecond,
      });
    }
  });
  autoUpdater.on('update-downloaded', (info: any) => {
    console.log('[updater] downloaded:', info?.version);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater:state', { state: 'downloaded', version: info?.version });
    }
  });

  registerTools(ipcMain, {
    pwd: () => state.workspace,
  });
  registerIpc();
  createWindow();

  // Auto-check for updates 5s after launch (silent)
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err: any) => {
      console.warn('[updater] initial check failed:', err?.message);
    });
  }, 5000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', async () => {
  await closeAllSessions();
  stopBridgeServer();
  await stopOpenCode();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------
const state = {
  workspace: '' as string,
};

// ---------------------------------------------------------------------------
// Config (with safeStorage-encrypted API key)
// ---------------------------------------------------------------------------
interface Config {
  endpoint?: string;
  model?: string;
  apiKeyCipher?: string; // base64
  apiKeyCheck?: string;  // sha256 of plaintext for verification
  systemPrompt?: string;
  workspace?: string;
}

function loadConfig(): Config {
  try {
    if (!existsSync(configFile)) return {};
    const raw = readFileSync(configFile, 'utf8');
    return JSON.parse(raw) as Config;
  } catch {
    return {};
  }
}

function saveConfig(cfg: Config) {
  mkdirSync(dirname(configFile), { recursive: true });
  writeFileSync(configFile, JSON.stringify(cfg, null, 2), 'utf8');
}

function encryptApiKey(plain: string): { cipher: string; check: string } {
  if (!safeStorage.isEncryptionAvailable()) {
    // Fallback: XOR with a per-install key (NOT secure, but better than plaintext)
    const key = randomBytes(32);
    const buf = Buffer.from(plain, 'utf8');
    const out = Buffer.alloc(buf.length);
    for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ key[i % key.length];
    return {
      cipher: `xor:${key.toString('base64')}:${out.toString('base64')}`,
      check: createHash('sha256').update(plain).digest('hex'),
    };
  }
  const cipher = safeStorage.encryptString(plain).toString('base64');
  return {
    cipher,
    check: createHash('sha256').update(plain).digest('hex'),
  };
}

function decryptApiKey(cipher: string): string {
  if (cipher.startsWith('xor:')) {
    const [, keyB64, dataB64] = cipher.split(':');
    const key = Buffer.from(keyB64, 'base64');
    const data = Buffer.from(dataB64, 'base64');
    const out = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i++) out[i] = data[i] ^ key[i % key.length];
    return out.toString('utf8');
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS secure storage unavailable; cannot decrypt API key.');
  }
  return safeStorage.decryptString(Buffer.from(cipher, 'base64'));
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function registerIpc() {
  ipcMain.handle('config:get', () => {
    const cfg = loadConfig();
    return {
      endpoint: cfg.endpoint ?? '',
      model: cfg.model ?? '',
      hasApiKey: !!cfg.apiKeyCipher,
      apiKeyCheck: cfg.apiKeyCheck ?? '',
      systemPrompt: cfg.systemPrompt ?? '',
      workspace: cfg.workspace ?? '',
    };
  });

  ipcMain.handle('config:set', (_e, patch: Partial<Config>) => {
    const cfg = loadConfig();
    const next: Config = { ...cfg, ...patch };
    if (patch.endpoint !== undefined) next.endpoint = patch.endpoint;
    if (patch.model !== undefined) next.model = patch.model;
    if (patch.systemPrompt !== undefined) next.systemPrompt = patch.systemPrompt;
    if (patch.workspace !== undefined) {
      next.workspace = patch.workspace;
      state.workspace = patch.workspace;
    }
    saveConfig(next);
    return { ok: true };
  });

  ipcMain.handle('config:setApiKey', (_e, plain: string) => {
    if (!plain) {
      const cfg = loadConfig();
      delete cfg.apiKeyCipher;
      delete cfg.apiKeyCheck;
      saveConfig(cfg);
      return { ok: true, hasApiKey: false };
    }
    const { cipher, check } = encryptApiKey(plain);
    const cfg = loadConfig();
    cfg.apiKeyCipher = cipher;
    cfg.apiKeyCheck = check;
    saveConfig(cfg);
    return { ok: true, hasApiKey: true };
  });

  ipcMain.handle('config:getApiKey', () => {
    const cfg = loadConfig();
    if (!cfg.apiKeyCipher) return { hasApiKey: false, apiKey: '' };
    try {
      return { hasApiKey: true, apiKey: decryptApiKey(cfg.apiKeyCipher) };
    } catch (err) {
      return { hasApiKey: false, apiKey: '', error: String(err) };
    }
  });

  ipcMain.handle('workspace:pick', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select ClawCode workspace',
    });
    if (result.canceled || result.filePaths.length === 0) return { ok: false };
    const ws = result.filePaths[0];
    state.workspace = ws;
    const cfg = loadConfig();
    cfg.workspace = ws;
    saveConfig(cfg);
    return { ok: true, workspace: ws };
  });

  ipcMain.handle('workspace:set', (_e, ws: string) => {
    if (!existsSync(ws)) return { ok: false, error: 'Path does not exist' };
    state.workspace = ws;
    const cfg = loadConfig();
    cfg.workspace = ws;
    saveConfig(cfg);
    return { ok: true };
  });

  ipcMain.handle('workspace:get', () => state.workspace);

  // Tool execution bridge (renderer asks main to run a tool safely)
  ipcMain.handle('tool:invoke', async (_e, name: string, args: any) => {
    if (!state.workspace) {
      return { ok: false, error: 'No workspace selected. Use File → Open Workspace.' };
    }
    try {
      const result = await handleToolCall(name, args, { workspace: state.workspace });
      return { ok: true, result };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });

  // Native shell execution for the bash tool
  ipcMain.handle('shell:exec', async (_e, command: string, opts?: { cwd?: string; timeoutMs?: number }) => {
    const cwd = opts?.cwd && isAbsolute(opts.cwd) ? opts.cwd : state.workspace;
    if (!cwd) return { ok: false, error: 'No workspace set' };
    return new Promise((resolve) => {
      const isWin = process.platform === 'win32';
      const child = spawn(command, {
        cwd,
        shell: isWin ? 'powershell.exe' : '/bin/bash',
        env: process.env,
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      const timeout = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        stderr += '\n[ClawCode] process timed out';
      }, Math.min(opts?.timeoutMs ?? 120_000, 600_000));

      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));
      child.on('error', (err) => {
        clearTimeout(timeout);
        resolve({ ok: false, error: err.message, stdout, stderr });
      });
      child.on('close', (code) => {
        clearTimeout(timeout);
        resolve({ ok: code === 0, exitCode: code, stdout, stderr });
      });
    });
  });

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    userData: userDataDir,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  }));

  ipcMain.handle('app:openExternal', (_e, url: string) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
      return { ok: true };
    }
    return { ok: false };
  });

  // ----- Providers -----
  ipcMain.handle('providers:list', () => PROVIDERS);

  // ----- WebChat Bridge -----
  ipcMain.handle('webchat:profiles', () => getAllProfiles());
  ipcMain.handle('webchat:status', () => getBridgeStatus());
  ipcMain.handle('webchat:login', async (_e, id: WebChatId) => webchatLogin(id));
  ipcMain.handle('webchat:reset', async (_e, id: WebChatId) => { await resetWebChat(id); return { ok: true }; });
  ipcMain.handle('webchat:bridgeUrl', () => 'http://127.0.0.1:7777/v1');

  // ----- OpenCode -----
  ipcMain.handle('opencode:probe', () => probeOpenCode());
  ipcMain.handle('opencode:status', () => getOpenCodeStatus());
  ipcMain.handle('opencode:start', async (_e, opts: any) => startOpenCode(opts || {}));
  ipcMain.handle('opencode:stop', async () => { await stopOpenCode(); return { ok: true }; });

  // ----- Skills -----
  ipcMain.handle('skills:curated', () => Skills.getCuratedSkills());
  ipcMain.handle('skills:installed', () => Skills.listInstalledSkills());
  ipcMain.handle('skills:search', async (_e, opts: any) => Skills.searchGitHubSkills(opts || {}));
  ipcMain.handle('skills:install', async (_e, repoUrl: string, name?: string) => Skills.installSkill(repoUrl, name));
  ipcMain.handle('skills:uninstall', async (_e, name: string) => Skills.uninstallSkill(name));
  ipcMain.handle('skills:prompts', () => Skills.getAllInstalledPrompts());
  ipcMain.handle('skills:fragment', (_e, name: string) => Skills.getSkillPromptFragment(name));

  // ----- HuggingFace -----
  ipcMain.handle('hf:search', async (_e, opts: any) => HF.searchModels(opts || {}));
  ipcMain.handle('hf:trending', async (_e, limit?: number) => HF.getTrendingModels(limit));
  ipcMain.handle('hf:gguf', async (_e, limit?: number) => HF.getGgufModels(limit));
  ipcMain.handle('hf:files', async (_e, modelId: string) => HF.getModelFiles(modelId));
  ipcMain.handle('hf:downloaded', () => HF.listDownloadedModels());
  ipcMain.handle('hf:download', async (_e, modelId: string) => HF.downloadModel(modelId));
  ipcMain.handle('hf:delete', async (_e, name: string) => HF.deleteDownloadedModel(name));
  ipcMain.handle('hf:probeCli', () => HF.probeHfCli());

  // ----- Cookbook (Odysseus-style hardware-aware model fitting) -----
  ipcMain.handle('hf:hardware', () => HF.detectHardware());
  ipcMain.handle('hf:cookbook', () => HF.getCookbookModels());
  ipcMain.handle('hf:estimateFit', (_e, paramB: number, vramBytes: number, ramBytes?: number, ctx?: number) =>
    HF.estimateFit(paramB, vramBytes, ramBytes, ctx)
  );
  ipcMain.handle('hf:modelfile', (_e, model: any, ggufPath: string, quant: string) =>
    HF.generateOllamaModelfile(model, ggufPath, quant as any)
  );

  // ----- Auto-updater -----
  ipcMain.handle('updater:check', async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      return {
        ok: true,
        version: result?.updateInfo?.version,
        available: !!result?.updateInfo,
      };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle('updater:download', async () => {
    try {
      await autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle('updater:install', () => {
    // Install + restart. All user data (config, skills, models, webchat profiles)
    // lives in app.getPath('userData'), keyed by appId — preserved across versions.
    try {
      setImmediate(() => autoUpdater.quitAndInstall(true, true));
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle('updater:currentVersion', () => app.getVersion());

  ipcMain.handle('updater:openReleases', () => {
    shell.openExternal('https://github.com/Deq710sia/clawcode/releases/latest');
    return { ok: true };
  });
}
