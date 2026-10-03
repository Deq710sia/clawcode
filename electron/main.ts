/**
 * ClawCode — Electron main process
 * Clean-room implementation. No third-party agent runtime; all tools are
 * implemented from scratch using only Node's standard libraries.
 */
import { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, net } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';

import { registerTools, handleToolCall } from './tools/index.js';
import { initBridge, getAllProfiles, login as webchatLogin, closeAllSessions, resetWebChat, getBridgeStatus, type WebChatId } from './webchat/bridge.js';
import { startBridgeServer, stopBridgeServer, BRIDGE_PORT, BRIDGE_TOKEN, BRIDGE_TOKEN_HEADER } from './webchat/server.js';
import { probeOpenCode, startOpenCode, stopOpenCode, getOpenCodeStatus } from './opencode.js';
import { PROVIDERS } from './providers/index.js';
import * as Skills from './skills/index.js';
import * as HF from './huggingface.js';
import pkg from 'electron-updater';
const { autoUpdater } = pkg;
import * as Sandbox from './sandbox.js';
import * as ProcessSandbox from './process-sandbox.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const isDev = !!process.env.VITE_DEV_SERVER_URL;

// Where Playwright looks for Chromium. Packaged: the copy bundled in resources/browsers
// (see build.extraResources). Dev: "0" = node_modules/playwright-core/.local-browsers,
// which is where `postinstall` downloads it. Must be set before playwright is first imported.
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = app.isPackaged ? join(process.resourcesPath, 'browsers') : '0';
}

const userDataDir = app.getPath('userData');
const configFile = join(userDataDir, 'clawcode.config.json');

process.env.APP_ROOT = isDev ? __dirname : dirname(app.getPath('exe'));
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

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

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
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
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

  // Restore the last workspace in the main process so tools work immediately,
  // independent of when the renderer finishes bootstrapping.
  const wsArg = process.argv.find((a) => a.startsWith('--workspace='))?.slice('--workspace='.length);
  const savedWs = wsArg || loadConfig().workspace;
  if (savedWs && existsSync(savedWs)) state.workspace = savedWs;

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

let isQuitting = false;
app.on('before-quit', (e) => {
  if (isQuitting) return;
  e.preventDefault();
  isQuitting = true;
  (async () => {
    try {
      await closeAllSessions();
      stopBridgeServer();
      await stopOpenCode();
    } catch (err) {
      console.error('[clawcode] cleanup error:', err);
    }
    app.exit(0);
  })();
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
    // Whitelist allowed fields — never let the renderer write apiKeyCipher or
    // apiKeyCheck directly (that would bypass encryption). Use config:setApiKey.
    const next: Config = { ...cfg };
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

  // ----- Network proxy for LLM calls -----
  // The renderer is served from file:// (origin "null"), so direct fetch() to most
  // LLM APIs is blocked by CORS. Requests are made here instead, via Chromium's
  // network stack (honours system proxy settings).
  const netControllers = new Map<string, AbortController>();

  ipcMain.handle('net:request', async (e, req: { id: string; url: string; method?: string; headers?: Record<string, string>; body?: string }) => {
    const sender = e.sender;
    let url: URL;
    try {
      url = new URL(req.url);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http(s) URLs are allowed');
    } catch (err: any) {
      return { ok: false as const, error: err?.message ?? 'Invalid URL' };
    }
    const ctrl = new AbortController();
    netControllers.set(req.id, ctrl);
    // Requests to our own WebChat bridge carry the per-launch token.
    const headers: Record<string, string> = { ...(req.headers ?? {}) };
    if ((url.hostname === '127.0.0.1' || url.hostname === 'localhost') && url.port === String(BRIDGE_PORT)) {
      headers[BRIDGE_TOKEN_HEADER] = BRIDGE_TOKEN;
    }
    try {
      const res = await net.fetch(url.toString(), {
        method: req.method ?? 'GET',
        headers,
        body: req.body,
        signal: ctrl.signal,
      });
      const resHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => { resHeaders[k] = v; });

      setImmediate(async () => {
        try {
          if (res.body) {
            const reader = res.body.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (sender.isDestroyed()) { ctrl.abort(); break; }
              sender.send('net:chunk', req.id, value);
            }
          }
          if (!sender.isDestroyed()) sender.send('net:end', req.id);
        } catch (err: any) {
          if (!sender.isDestroyed()) sender.send('net:error', req.id, err?.name === 'AbortError' ? 'aborted' : (err?.message ?? String(err)));
        } finally {
          netControllers.delete(req.id);
        }
      });
      return { ok: true as const, status: res.status, statusText: res.statusText, headers: resHeaders };
    } catch (err: any) {
      netControllers.delete(req.id);
      return { ok: false as const, error: err?.name === 'AbortError' ? 'aborted' : (err?.cause?.message ? `${err.message}: ${err.cause.message}` : (err?.message ?? String(err))) };
    }
  });

  ipcMain.handle('net:abort', (_e, id: string) => {
    netControllers.get(id)?.abort();
    netControllers.delete(id);
    return { ok: true };
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
  ipcMain.handle('webchat:bridgeUrl', () => `http://127.0.0.1:${BRIDGE_PORT}/v1`);

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

  // ----- Windows Sandbox (VM-based, full isolation) -----
  ipcMain.handle('sandbox:available', () => Sandbox.isSandboxAvailable());
  ipcMain.handle('sandbox:generate', (_e, config: any) => {
    const wsbPath = Sandbox.writeWsbFile({ ...Sandbox.DEFAULT_SANDBOX_CONFIG, ...config });
    return { ok: true, wsbPath, content: Sandbox.generateWsb({ ...Sandbox.DEFAULT_SANDBOX_CONFIG, ...config }) };
  });
  ipcMain.handle('sandbox:launch', (_e, config: any) => Sandbox.launchSandbox({ ...Sandbox.DEFAULT_SANDBOX_CONFIG, ...config }));

  // ----- Process Sandbox (Codex-style restricted user, seamless) -----
  ipcMain.handle('psandbox:status', () => ProcessSandbox.getSandboxStatus());
  ipcMain.handle('psandbox:setup', async (_e, opts: any) => ProcessSandbox.setupSandbox(opts || {}));
  ipcMain.handle('psandbox:disable', async () => ProcessSandbox.disableSandbox());
  ipcMain.handle('psandbox:teardown', async () => ProcessSandbox.teardownSandbox());
}
