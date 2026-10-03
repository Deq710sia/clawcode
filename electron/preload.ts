/**
 * ClawCode — preload script (bundled as .cjs by scripts/build-preload.mjs).
 * Exposes a tight, audited `claw` API to the renderer via contextBridge.
 */
import { contextBridge, ipcRenderer } from 'electron';

const api = {
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (patch: any) => ipcRenderer.invoke('config:set', patch),
    setApiKey: (plain: string) => ipcRenderer.invoke('config:setApiKey', plain),
    getApiKey: () => ipcRenderer.invoke('config:getApiKey'),
  },
  workspace: {
    pick: () => ipcRenderer.invoke('workspace:pick'),
    set: (ws: string) => ipcRenderer.invoke('workspace:set', ws),
    get: () => ipcRenderer.invoke('workspace:get'),
  },
  tool: {
    invoke: (name: string, args: any) => ipcRenderer.invoke('tool:invoke', name, args),
  },
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),
  },
  net: {
    request: (req: { id: string; url: string; method?: string; headers?: Record<string, string>; body?: string }) =>
      ipcRenderer.invoke('net:request', req),
    abort: (id: string) => ipcRenderer.invoke('net:abort', id),
    onChunk: (cb: (id: string, chunk: Uint8Array) => void) => {
      const h = (_e: any, id: string, chunk: Uint8Array) => cb(id, chunk);
      ipcRenderer.on('net:chunk', h);
      return () => ipcRenderer.removeListener('net:chunk', h);
    },
    onEnd: (cb: (id: string) => void) => {
      const h = (_e: any, id: string) => cb(id);
      ipcRenderer.on('net:end', h);
      return () => ipcRenderer.removeListener('net:end', h);
    },
    onError: (cb: (id: string, message: string) => void) => {
      const h = (_e: any, id: string, message: string) => cb(id, message);
      ipcRenderer.on('net:error', h);
      return () => ipcRenderer.removeListener('net:error', h);
    },
  },
  providers: {
    list: () => ipcRenderer.invoke('providers:list'),
  },
  webchat: {
    profiles: () => ipcRenderer.invoke('webchat:profiles'),
    status: () => ipcRenderer.invoke('webchat:status'),
    login: (id: string) => ipcRenderer.invoke('webchat:login', id),
    reset: (id: string) => ipcRenderer.invoke('webchat:reset', id),
    bridgeUrl: () => ipcRenderer.invoke('webchat:bridgeUrl'),
  },
  opencode: {
    probe: () => ipcRenderer.invoke('opencode:probe'),
    status: () => ipcRenderer.invoke('opencode:status'),
    start: (opts: any) => ipcRenderer.invoke('opencode:start', opts),
    stop: () => ipcRenderer.invoke('opencode:stop'),
  },
  skills: {
    curated: () => ipcRenderer.invoke('skills:curated'),
    installed: () => ipcRenderer.invoke('skills:installed'),
    search: (opts: any) => ipcRenderer.invoke('skills:search', opts),
    install: (repoUrl: string, name?: string) => ipcRenderer.invoke('skills:install', repoUrl, name),
    uninstall: (name: string) => ipcRenderer.invoke('skills:uninstall', name),
    prompts: () => ipcRenderer.invoke('skills:prompts'),
    fragment: (name: string) => ipcRenderer.invoke('skills:fragment', name),
  },
  hf: {
    search: (opts: any) => ipcRenderer.invoke('hf:search', opts),
    trending: (limit?: number) => ipcRenderer.invoke('hf:trending', limit),
    gguf: (limit?: number) => ipcRenderer.invoke('hf:gguf', limit),
    files: (modelId: string) => ipcRenderer.invoke('hf:files', modelId),
    downloaded: () => ipcRenderer.invoke('hf:downloaded'),
    download: (modelId: string) => ipcRenderer.invoke('hf:download', modelId),
    delete: (name: string) => ipcRenderer.invoke('hf:delete', name),
    probeCli: () => ipcRenderer.invoke('hf:probeCli'),
    hardware: () => ipcRenderer.invoke('hf:hardware'),
    cookbook: () => ipcRenderer.invoke('hf:cookbook'),
    estimateFit: (paramB: number, vramBytes: number, ramBytes?: number, ctx?: number) =>
      ipcRenderer.invoke('hf:estimateFit', paramB, vramBytes, ramBytes, ctx),
    modelfile: (model: any, ggufPath: string, quant: string) =>
      ipcRenderer.invoke('hf:modelfile', model, ggufPath, quant),
  },
  updater: {
    check: () => ipcRenderer.invoke('updater:check'),
    download: () => ipcRenderer.invoke('updater:download'),
    install: () => ipcRenderer.invoke('updater:install'),
    currentVersion: () => ipcRenderer.invoke('updater:currentVersion'),
    openReleases: () => ipcRenderer.invoke('updater:openReleases'),
    onState: (cb: (state: any) => void) => {
      const handler = (_e: any, data: any) => cb(data);
      ipcRenderer.on('updater:state', handler);
      return () => ipcRenderer.removeListener('updater:state', handler);
    },
    onProgress: (cb: (p: any) => void) => {
      const handler = (_e: any, data: any) => cb(data);
      ipcRenderer.on('updater:progress', handler);
      return () => ipcRenderer.removeListener('updater:progress', handler);
    },
  },
  sandbox: {
    available: () => ipcRenderer.invoke('sandbox:available'),
    generate: (config: any) => ipcRenderer.invoke('sandbox:generate', config),
    launch: (config: any) => ipcRenderer.invoke('sandbox:launch', config),
  },
  psandbox: {
    status: () => ipcRenderer.invoke('psandbox:status'),
    setup: (opts: any) => ipcRenderer.invoke('psandbox:setup', opts),
    disable: () => ipcRenderer.invoke('psandbox:disable'),
    teardown: () => ipcRenderer.invoke('psandbox:teardown'),
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld('claw', api);

export type ClawApi = typeof api;
