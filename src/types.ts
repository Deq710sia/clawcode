export interface ChatMessage {
  id: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  createdAt: number;
  streaming?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, any>;
  state: 'pending' | 'running' | 'done' | 'error';
  result?: any;
  error?: string;
  startedAt?: number;
  endedAt?: number;
}

export interface ToolCallCard {
  id: string;
  messageId: string;
  toolCallId: string;
  name: string;
  args: Record<string, any>;
  state: ToolCall['state'];
  result?: any;
  error?: string;
  startedAt: number;
  endedAt?: number;
}

export interface AppInfo {
  version: string;
  platform: string;
  arch: string;
  userData: string;
  electron: string;
  chrome: string;
  node: string;
}

export interface PublicConfig {
  endpoint: string;
  model: string;
  hasApiKey: boolean;
  apiKeyCheck: string;
  systemPrompt: string;
  workspace: string;
}

export interface FileEntry {
  path: string;
  type: 'file' | 'dir';
  size?: number;
}

export interface ProviderPreset {
  id: string;
  label: string;
  category: 'api' | 'local' | 'webchat' | 'opencode';
  endpoint: string;
  defaultModel?: string;
  models?: string[];
  docsUrl?: string;
  note?: string;
  isWebChat?: boolean;
  isOpenCode?: boolean;
}

export interface WebChatProfile {
  id: string;
  label: string;
  loggedIn: boolean;
  lastUsed?: number;
  active?: boolean;
  busy?: boolean;
}

export interface AccountProfile {
  id: string;
  service: string;
  label: string;
  loggedIn: boolean;
  lastUsed: number;
  messageCount: number;
  windowStart: number;
  status: 'available' | 'cooling' | 'exhausted';
  estimatedLimit: number;
  windowDurationMs: number;
}

export interface SavedConversation {
  id: string;
  title: string;
  messages: any[];
  plan: any[];
  createdAt: number;
  updatedAt: number;
  model?: string;
  endpoint?: string;
  workspace?: string;
}

export interface OpenCodeStatus {
  installed: boolean;
  version?: string;
  path?: string;
  running: boolean;
  port?: number;
  pid?: number;
  lastError?: string;
}

export interface Skill {
  name: string;
  description: string;
  author: string;
  repoUrl: string;
  stars?: number;
  installed: boolean;
  category: 'skill' | 'tool' | 'prompt' | 'mod' | 'unknown';
  source: 'curated' | 'github' | 'installed';
  updatedAt?: string;
}

export interface InstalledSkill {
  name: string;
  path: string;
  manifest: {
    name?: string;
    description?: string;
    commands?: string[];
    tools?: string[];
    author?: string;
  } | null;
  installedAt: number;
}

export interface HFModel {
  id: string;
  author: string;
  downloads: number;
  likes: number;
  pipelineTag?: string;
  tags: string[];
  lastModified: string;
  hasGguf?: boolean;
  downloaded?: boolean;
}

export interface DownloadedModel {
  id: string;
  name: string;
  path: string;
  sizeBytes: number;
  downloadedAt: number;
  hasGguf: boolean;
  files: string[];
}

export interface HardwareInfo {
  platform: string;
  arch: string;
  cpuModel: string;
  cpuCores: number;
  ramTotalBytes: number;
  gpus: GpuInfo[];
  detectedAt: number;
}

export interface GpuInfo {
  name: string;
  vramTotalBytes: number;
  type: 'nvidia' | 'amd' | 'apple-silicon' | 'intel' | 'unknown';
}

export interface CookbookModel {
  id: string;
  name: string;
  paramB: number;
  contextLength: number;
  license: string;
  tags: string[];
  description: string;
  ggufRepo: string;
  useCases: string[];
}

export interface FitEstimate {
  fits: boolean;
  recommendedQuant: string;
  modelSizeBytes: number;
  contextHeadroomBytes: number;
  score: number;
  reason: string;
}

export type UpdaterState =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'up-to-date'; version: string }
  | { state: 'available'; version: string; releaseNotes?: string; releaseUrl?: string }
  | { state: 'downloading' }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; error: string };

export interface UpdaterProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export interface ProcessSandboxStatus {
  platform: string;
  elevated: boolean;
  userExists: boolean;
  enabled: boolean;
  configured: boolean;
  workspacePath?: string;
  denyNetwork: boolean;
  sandboxUser: string;
}

declare global {
  interface Window {
    claw: {
      config: {
        get: () => Promise<PublicConfig>;
        set: (patch: any) => Promise<{ ok: boolean }>;
        setApiKey: (plain: string) => Promise<{ ok: boolean; hasApiKey: boolean }>;
        getApiKey: () => Promise<{ hasApiKey: boolean; apiKey: string; error?: string }>;
      };
      workspace: {
        pick: () => Promise<{ ok: boolean; workspace?: string }>;
        set: (ws: string) => Promise<{ ok: boolean; error?: string }>;
        get: () => Promise<string>;
      };
      tool: {
        invoke: (name: string, args: any) => Promise<{ ok: boolean; result?: any; error?: string }>;
      };
      net: {
        request: (req: { id: string; url: string; method?: string; headers?: Record<string, string>; body?: string }) => Promise<
          | { ok: true; status: number; statusText: string; headers: Record<string, string> }
          | { ok: false; error: string }
        >;
        abort: (id: string) => Promise<{ ok: boolean }>;
        onChunk: (cb: (id: string, chunk: Uint8Array) => void) => () => void;
        onEnd: (cb: (id: string) => void) => () => void;
        onError: (cb: (id: string, message: string) => void) => () => void;
      };
      app: {
        info: () => Promise<AppInfo>;
        openExternal: (url: string) => Promise<{ ok: boolean }>;
        minimize: () => Promise<{ ok: boolean }>;
        maximize: () => Promise<{ ok: boolean }>;
        close: () => Promise<{ ok: boolean }>;
      };
      providers: {
        list: () => Promise<ProviderPreset[]>;
      };
      webchat: {
        profiles: () => Promise<WebChatProfile[]>;
        status: () => Promise<WebChatProfile[]>;
        login: (id: string) => Promise<{ ok: boolean; loggedIn: boolean; error?: string }>;
        reset: (id: string) => Promise<{ ok: boolean }>;
        bridgeUrl: () => Promise<string>;
      };
      accounts: {
        list: () => Promise<AccountProfile[]>;
        add: (service: string, label: string) => Promise<AccountProfile>;
        remove: (id: string) => Promise<{ ok: boolean; error?: string }>;
        usage: (id: string) => Promise<{ used: number; limit: number; percent: number; status: string; windowMs: number; windowStart: number } | null>;
        login: (accountId: string) => Promise<{ ok: boolean; loggedIn: boolean; error?: string }>;
        recordUsage: (id: string) => Promise<any>;
        markExhausted: (id: string) => Promise<{ ok: boolean }>;
      };
      convos: {
        list: () => Promise<SavedConversation[]>;
        load: (id: string) => Promise<SavedConversation | null>;
        save: (convo: any) => Promise<{ ok: boolean; error?: string }>;
        delete: (id: string) => Promise<{ ok: boolean; error?: string }>;
        rename: (id: string, title: string) => Promise<{ ok: boolean; error?: string }>;
      };
      opencode: {
        probe: () => Promise<OpenCodeStatus>;
        status: () => Promise<OpenCodeStatus>;
        start: (opts: any) => Promise<OpenCodeStatus>;
        stop: () => Promise<{ ok: boolean }>;
      };
      skills: {
        curated: () => Promise<Skill[]>;
        installed: () => Promise<InstalledSkill[]>;
        search: (opts: any) => Promise<Skill[]>;
        install: (repoUrl: string, name?: string) => Promise<{ ok: boolean; error?: string; path?: string }>;
        uninstall: (name: string) => Promise<{ ok: boolean; error?: string }>;
        prompts: () => Promise<{ name: string; commands: string[]; prompt: string }[]>;
        fragment: (name: string) => Promise<string | null>;
      };
      hf: {
        search: (opts: any) => Promise<HFModel[]>;
        trending: (limit?: number) => Promise<HFModel[]>;
        gguf: (limit?: number) => Promise<HFModel[]>;
        files: (modelId: string) => Promise<any[]>;
        downloaded: () => Promise<DownloadedModel[]>;
        download: (modelId: string) => Promise<{ ok: boolean; error?: string; path?: string }>;
        delete: (name: string) => Promise<{ ok: boolean; error?: string }>;
        probeCli: () => Promise<boolean>;
        hardware: () => Promise<HardwareInfo>;
        cookbook: () => Promise<CookbookModel[]>;
        estimateFit: (paramB: number, vramBytes: number, ramBytes?: number, ctx?: number) => Promise<FitEstimate>;
        modelfile: (model: any, ggufPath: string, quant: string) => Promise<string>;
      };
      updater: {
        check: () => Promise<{ ok: boolean; version?: string; available?: boolean; error?: string }>;
        download: () => Promise<{ ok: boolean; error?: string }>;
        install: () => Promise<{ ok: boolean; error?: string }>;
        currentVersion: () => Promise<string>;
        openReleases: () => Promise<{ ok: boolean }>;
        onState: (cb: (state: UpdaterState) => void) => () => void;
        onProgress: (cb: (p: UpdaterProgress) => void) => () => void;
      };
      sandbox: {
        available: () => Promise<boolean>;
        generate: (config: any) => Promise<{ ok: boolean; wsbPath?: string; content?: string }>;
        launch: (config: any) => Promise<{ ok: boolean; error?: string; wsbPath?: string }>;
      };
      psandbox: {
        status: () => Promise<ProcessSandboxStatus>;
        setup: (opts: any) => Promise<{ ok: boolean; error?: string }>;
        disable: () => Promise<{ ok: boolean; error?: string }>;
        teardown: () => Promise<{ ok: boolean; error?: string }>;
      };
      platform: string;
    };
  }
}
