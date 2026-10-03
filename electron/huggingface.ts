/**
 * ClawCode — HuggingFace model browser & downloader.
 * Uses the public HuggingFace API (https://huggingface.co/api) to search models,
 * and `huggingface-cli` (preferred) or `git lfs clone` (fallback) to download.
 *
 * Downloaded models land in userData/models/<model_id_safe>/.
 * After download, the user can point Ollama / LM Studio / vLLM at the folder.
 */
import { app } from 'electron';
import { join } from 'node:path';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import os from 'node:os';

const modelsDir = () => join(app.getPath('userData'), 'models');

export interface HFModel {
  id: string;
  author: string;
  downloads: number;
  likes: number;
  pipelineTag?: string;
  tags: string[];
  lastModified: string;
  /** True if a GGUF quant is available */
  hasGguf?: boolean;
  /** True if already downloaded */
  downloaded?: boolean;
}

export interface HFSearchOpts {
  query?: string;
  author?: string;
  pipelineTag?: string;
  sort?: 'downloads' | 'likes' | 'lastModified' | 'trending';
  direction?: 'asc' | 'desc';
  limit?: number;
  /** Filter to models with GGUF files (for Ollama use) */
  ggufOnly?: boolean;
}

const HF_API = 'https://huggingface.co/api';

export function initModels() {
  mkdirSync(modelsDir(), { recursive: true });
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
export async function searchModels(opts: HFSearchOpts = {}): Promise<HFModel[]> {
  const params = new URLSearchParams();
  if (opts.query) params.set('search', opts.query);
  if (opts.author) params.set('author', opts.author);
  if (opts.pipelineTag) params.set('filter', opts.pipelineTag);
  params.set('sort', opts.sort ?? 'downloads');
  params.set('direction', opts.direction ?? 'desc');
  params.set('limit', String(Math.min(opts.limit ?? 50, 200)));

  const url = `${HF_API}/models?${params}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'ClawCode/0.2' } });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`HuggingFace API ${res.status}: ${txt.slice(0, 300)}`);
  }
  const json = (await res.json()) as any[];
  const downloaded = new Set(listDownloadedModels().map((m) => m.id));
  let models: HFModel[] = (json ?? []).map((m: any): HFModel => ({
    id: m.id ?? m.modelId ?? '',
    author: m.id?.split('/')[0] ?? 'unknown',
    downloads: m.downloads ?? 0,
    likes: m.likes ?? 0,
    pipelineTag: m.pipeline_tag,
    tags: m.tags ?? [],
    lastModified: m.lastModified ?? m.last_modified ?? '',
    hasGguf: (m.tags ?? []).some((t: string) => t.toLowerCase().includes('gguf')),
    downloaded: downloaded.has(m.id ?? m.modelId ?? ''),
  }));

  if (opts.ggufOnly) {
    models = models.filter((m) => m.hasGguf);
  }
  return models;
}

// ---------------------------------------------------------------------------
// Trending / featured
// ---------------------------------------------------------------------------
export async function getTrendingModels(limit: number = 30): Promise<HFModel[]> {
  // HF has no official "trending" endpoint; use sort=likes + recent by fetching last 7 days
  // Fallback: sort by likes, take top N
  return searchModels({ sort: 'likes', limit });
}

export async function getGgufModels(limit: number = 30): Promise<HFModel[]> {
  return searchModels({ sort: 'downloads', limit, ggufOnly: true });
}

// ---------------------------------------------------------------------------
// Model details (file listing)
// ---------------------------------------------------------------------------
export interface HFModelFile {
  path: string;
  size: number;
  type: 'model' | 'config' | 'tokenizer' | 'readme' | 'other';
}

export async function getModelFiles(modelId: string): Promise<HFModelFile[]> {
  const url = `${HF_API}/models/${modelId}/tree/main`;
  const res = await fetch(url, { headers: { 'User-Agent': 'ClawCode/0.2' } });
  if (!res.ok) return [];
  const json = (await res.json()) as any[];
  const out: HFModelFile[] = [];
  for (const f of json ?? []) {
    const path: string = f.path ?? '';
    const size: number = f.size ?? 0;
    let type: HFModelFile['type'] = 'other';
    if (path.endsWith('.gguf')) type = 'model';
    else if (path.endsWith('.safetensors') || path.endsWith('.bin') || path.endsWith('.pt')) type = 'model';
    else if (path.endsWith('.json') && path.includes('config')) type = 'config';
    else if (path.includes('tokenizer')) type = 'tokenizer';
    else if (path.toLowerCase() === 'readme.md') type = 'readme';
    out.push({ path, size, type });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------
export interface DownloadProgress {
  modelId: string;
  phase: 'starting' | 'downloading' | 'done' | 'error';
  message?: string;
  percent?: number;
  path?: string;
}

export async function downloadModel(
  modelId: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<{ ok: boolean; error?: string; path?: string }> {
  const safeName = modelId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const target = join(modelsDir(), safeName);
  if (existsSync(target)) {
    return { ok: false, error: `Already downloaded at ${target}` };
  }
  mkdirSync(modelsDir(), { recursive: true });

  onProgress?.({ modelId, phase: 'starting', message: 'Resolving download method…' });

  // Method 1: huggingface-cli (preferred — supports resumable downloads, dedup)
  const hfResult = await tryHuggingfaceCli(modelId, target, onProgress);
  if (hfResult.ok || hfResult.partialOk) return hfResult;

  // Method 2: git lfs clone (fallback)
  onProgress?.({ modelId, phase: 'starting', message: 'Falling back to git lfs clone…' });
  return tryGitLfsClone(modelId, target, onProgress);
}

async function tryHuggingfaceCli(
  modelId: string,
  target: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<{ ok: boolean; partialOk?: boolean; error?: string; path?: string }> {
  return new Promise((resolve) => {
    const child = spawn('huggingface-cli', ['download', modelId, '--local-dir', target], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: true,
    });
    let stderr = '';
    let lastStdout = '';
    child.stdout?.on('data', (d) => {
      lastStdout = d.toString().trim();
      // HF CLI emits progress lines like "Fetching X files: 50%|#####  "
      const pctMatch = lastStdout.match(/(\d+)%/);
      if (pctMatch) {
        onProgress?.({ modelId, phase: 'downloading', percent: parseInt(pctMatch[1]), message: lastStdout.slice(-100) });
      }
    });
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('error', () => {
      // huggingface-cli not installed — fall through to git lfs
      resolve({ ok: false });
    });
    child.on('close', (code) => {
      if (code === 0) {
        // Save a marker file with the model ID for later lookup
        try { writeFileSync(join(target, '.clawcode-model-id'), modelId, 'utf8'); } catch {}
        onProgress?.({ modelId, phase: 'done', path: target });
        resolve({ ok: true, path: target });
      } else {
        resolve({ ok: false, error: `huggingface-cli exited ${code}: ${stderr.slice(0, 300)}` });
      }
    });
  });
}

async function tryGitLfsClone(
  modelId: string,
  target: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<{ ok: boolean; error?: string; path?: string }> {
  return new Promise((resolve) => {
    const url = `https://huggingface.co/${modelId}`;
    const child = spawn('git', ['lfs', 'clone', url, target], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr?.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      onProgress?.({ modelId, phase: 'downloading', message: s.slice(-100) });
    });
    child.on('error', (err) => resolve({ ok: false, error: `git not found: ${err.message}. Install git-lfs from https://git-lfs.com` }));
    child.on('close', (code) => {
      if (code === 0) {
        try { writeFileSync(join(target, '.clawcode-model-id'), modelId, 'utf8'); } catch {}
        onProgress?.({ modelId, phase: 'done', path: target });
        resolve({ ok: true, path: target });
      } else {
        resolve({ ok: false, error: `git lfs clone exited ${code}: ${stderr.slice(0, 300)}` });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Downloaded models
// ---------------------------------------------------------------------------
export interface DownloadedModel {
  id: string;
  name: string;
  path: string;
  sizeBytes: number;
  downloadedAt: number;
  hasGguf: boolean;
  files: string[];
}

export function listDownloadedModels(): DownloadedModel[] {
  const dir = modelsDir();
  if (!existsSync(dir)) return [];
  const out: DownloadedModel[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try {
      if (!statSync(path).isDirectory()) continue;
    } catch { continue; }
    let modelId = name;
    const idFile = join(path, '.clawcode-model-id');
    if (existsSync(idFile)) {
      try { modelId = readFileSync(idFile, 'utf8').trim(); } catch {}
    }
    const files = listFilesDeep(path);
    let size = 0;
    for (const f of files) {
      try { size += statSync(join(path, f)).size; } catch {}
    }
    out.push({
      id: modelId,
      name,
      path,
      sizeBytes: size,
      downloadedAt: statSync(path).mtimeMs,
      hasGguf: files.some((f) => f.endsWith('.gguf')),
      files,
    });
  }
  return out.sort((a, b) => b.downloadedAt - a.downloadedAt);
}

function listFilesDeep(dir: string, prefix: string = ''): string[] {
  const out: string[] = [];
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (e === '.git') continue;
    const full = join(dir, e);
    const rel = prefix ? `${prefix}/${e}` : e;
    try {
      if (statSync(full).isDirectory()) out.push(...listFilesDeep(full, rel));
      else out.push(rel);
    } catch {}
  }
  return out;
}

export async function deleteDownloadedModel(name: string): Promise<{ ok: boolean; error?: string }> {
  const target = join(modelsDir(), name);
  if (!existsSync(target)) return { ok: false, error: 'Not found' };
  try {
    rmSync(target, { recursive: true, force: true });
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/** Check if huggingface-cli is on PATH. */
export function probeHfCli(): boolean {
  try {
    execSync('huggingface-cli --version', { stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Hardware detection (port of Odysseus Cookbook's hardware-aware model fitting)
// ---------------------------------------------------------------------------
export interface HardwareInfo {
  platform: string;
  arch: string;
  cpuModel: string;
  cpuCores: number;
  ramTotalBytes: number;
  gpus: GpuInfo[];
  /** Detected via nvidia-smi / wmic / system_profiler */
  detectedAt: number;
}

export interface GpuInfo {
  name: string;
  vramTotalBytes: number;
  type: 'nvidia' | 'amd' | 'apple-silicon' | 'intel' | 'unknown';
}

export function detectHardware(): HardwareInfo {
  const info: HardwareInfo = {
    platform: process.platform,
    arch: process.arch,
    cpuModel: os.cpus()[0]?.model ?? 'Unknown CPU',
    cpuCores: os.cpus().length,
    ramTotalBytes: os.totalmem(),
    gpus: [],
    detectedAt: Date.now(),
  };

  // NVIDIA via nvidia-smi (cross-platform)
  try {
    const out = execSync('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    for (const line of out.split('\n')) {
      const m = line.match(/^([^,]+),\s*(\d+)/);
      if (m) {
        info.gpus.push({
          name: m[1].trim(),
          vramTotalBytes: parseInt(m[2]) * 1024 * 1024, // MiB → bytes
          type: 'nvidia',
        });
      }
    }
  } catch {}

  // Apple Silicon (macOS) — unified memory
  if (process.platform === 'darwin' && info.gpus.length === 0) {
    try {
      const out = execSync('system_profiler SPHardwareDataType', { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString();
      const chipMatch = out.match(/Chip:\s*(.+)/);
      const memMatch = out.match(/Memory:\s*(\d+)\s*GB/);
      if (chipMatch) {
        info.gpus.push({
          name: chipMatch[1].trim(),
          vramTotalBytes: memMatch ? parseInt(memMatch[1]) * 1024 * 1024 * 1024 : info.ramTotalBytes,
          type: 'apple-silicon',
        });
      }
    } catch {}
  }

  // Windows GPU via PowerShell/CIM (wmic is removed on recent Windows 11 builds).
  if (process.platform === 'win32' && info.gpus.length === 0) {
    try {
      const out = execSync(
        'powershell -NoProfile -Command "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress"',
        { stdio: ['ignore', 'pipe', 'ignore'] }
      ).toString().trim();
      const parsed = JSON.parse(out || '[]');
      const list: { Name?: string; AdapterRAM?: number }[] = Array.isArray(parsed) ? parsed : [parsed];
      for (const g of list) {
        if (!g?.Name) continue;
        const lower = g.Name.toLowerCase();
        info.gpus.push({
          name: g.Name,
          vramTotalBytes: g.AdapterRAM && g.AdapterRAM > 0 ? g.AdapterRAM : 0,
          type: lower.includes('nvidia') ? 'nvidia' : lower.includes('amd') || lower.includes('radeon') ? 'amd' : lower.includes('intel') ? 'intel' : 'unknown',
        });
      }
    } catch {}
  }

  // Linux AMD/intel via lspci (last resort)
  if (process.platform === 'linux' && info.gpus.length === 0) {
    try {
      const out = execSync('lspci | grep -iE "vga|3d|display"', { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString();
      for (const line of out.split('\n')) {
        const name = line.split(':').slice(2).join(':').trim();
        if (name) {
          info.gpus.push({
            name,
            vramTotalBytes: 0, // Unknown without proprietary tools
            type: name.toLowerCase().includes('amd') ? 'amd' : name.toLowerCase().includes('intel') ? 'intel' : 'unknown',
          });
        }
      }
    } catch {}
  }

  return info;
}

// ---------------------------------------------------------------------------
// VRAM scoring + quantization tier selection
// (Port of Odysseus Cookbook's approach: pick the best quant that fits in VRAM,
//  with a headroom budget for context + KV cache.)
// ---------------------------------------------------------------------------
export type QuantTier = 'Q4_0' | 'Q4_K_M' | 'Q4_K_S' | 'Q5_K_M' | 'Q5_K_S' | 'Q6_K' | 'Q8_0' | 'F16' | 'F32';

/** Approximate bits-per-parameter for each quant tier. */
const QUANT_BPP: Record<QuantTier, number> = {
  Q4_0: 4.5,
  Q4_K_M: 4.8,
  Q4_K_S: 4.6,
  Q5_K_M: 5.7,
  Q5_K_S: 5.5,
  Q6_K: 6.6,
  Q8_0: 8.5,
  F16: 17,
  F32: 34,
};

/** Quantization tiers in order of preference (best quality last among those that fit). */
const QUANT_PREFERENCE: QuantTier[] = ['Q4_0', 'Q4_K_S', 'Q4_K_M', 'Q5_K_S', 'Q5_K_M', 'Q6_K', 'Q8_0', 'F16'];

export interface FitEstimate {
  fits: boolean;
  recommendedQuant: QuantTier;
  modelSizeBytes: number;
  contextHeadroomBytes: number;
  /** 0–100 score, higher = better fit */
  score: number;
  reason: string;
}

/**
 * Estimate whether a model of `paramCountBillion` parameters fits in `vramBytes`,
 * and which quantization tier to use.
 *
 * Heuristics (port of Odysseus Cookbook patterns):
 * - Reserve 20% of VRAM for KV cache + context + overhead
 * - Walk QUANT_PREFERENCE from low to high; pick the highest that fits
 * - If even Q4_0 doesn't fit in VRAM but fits in RAM (with 30% headroom), mark as "fits via CPU offload"
 */
export function estimateFit(
  paramCountBillion: number,
  vramBytes: number,
  ramBytes?: number,
  contextLength: number = 8192
): FitEstimate {
  const usableVram = vramBytes * 0.8; // 20% headroom for KV cache
  const kvCacheBytes = estimateKvCache(paramCountBillion, contextLength);

  let best: QuantTier | null = null;
  let bestSize = 0;
  for (const q of QUANT_PREFERENCE) {
    const size = paramCountBillion * 1e9 * QUANT_BPP[q] / 8;
    if (size + kvCacheBytes <= usableVram) {
      best = q;
      bestSize = size;
    }
  }

  if (best) {
    const utilization = (bestSize + kvCacheBytes) / vramBytes;
    const score = Math.round(100 - Math.abs(0.7 - utilization) * 100); // peak score when ~70% utilized
    return {
      fits: true,
      recommendedQuant: best,
      modelSizeBytes: bestSize,
      contextHeadroomBytes: usableVram - bestSize - kvCacheBytes,
      score: Math.max(0, Math.min(100, score)),
      reason: `Fits in VRAM at ${best} (${formatBytes(bestSize)} model + ${formatBytes(kvCacheBytes)} KV cache)`,
    };
  }

  // CPU offload check
  if (ramBytes) {
    const usableRam = ramBytes * 0.5;
    const q4Size = paramCountBillion * 1e9 * QUANT_BPP.Q4_0 / 8;
    if (q4Size + kvCacheBytes <= usableRam) {
      return {
        fits: true,
        recommendedQuant: 'Q4_0',
        modelSizeBytes: q4Size,
        contextHeadroomBytes: usableRam - q4Size - kvCacheBytes,
        score: 30,
        reason: `Fits in system RAM at Q4_0 (CPU offload, slower)`,
      };
    }
  }

  return {
    fits: false,
    recommendedQuant: 'Q4_0',
    modelSizeBytes: paramCountBillion * 1e9 * QUANT_BPP.Q4_0 / 8,
    contextHeadroomBytes: 0,
    score: 0,
    reason: `Does not fit (min ${formatBytes(paramCountBillion * 1e9 * QUANT_BPP.Q4_0 / 8)} needed)`,
  };
}

function estimateKvCache(paramB: number, contextLength: number): number {
  // Rough: KV cache ≈ 2 * layers * hidden * context * 2 bytes
  // For a 7B model: layers≈32, hidden≈4096 → ~2MB per 1K tokens
  // Scaled by paramB/7
  const basePer1K = 2 * 1024 * 1024 * (paramB / 7);
  return basePer1K * (contextLength / 1024);
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

// ---------------------------------------------------------------------------
// Cookbook: curated model catalog with metadata (port of Odysseus Cookbook patterns)
// ---------------------------------------------------------------------------
export interface CookbookModel {
  id: string;
  name: string;
  paramB: number; // billions of parameters
  contextLength: number;
  license: string;
  tags: string[];
  description: string;
  /** Curated GGUF repo on HuggingFace */
  ggufRepo: string;
  /** Recommended use cases */
  useCases: string[];
}

const COOKBOOK: CookbookModel[] = [
  // Tiny (1-3B) — fit anywhere
  { id: 'qwen2.5-0.5b', name: 'Qwen2.5 0.5B', paramB: 0.5, contextLength: 32768, license: 'Apache-2.0', tags: ['tiny', 'fast', 'multilingual'], description: 'Smallest Qwen2.5 — fits in 1GB VRAM. Great for simple tasks.', ggufRepo: 'Qwen/Qwen2.5-0.5B-Instruct-GGUF', useCases: ['classification', 'simple QA', 'edge'] },
  { id: 'qwen2.5-1.5b', name: 'Qwen2.5 1.5B', paramB: 1.5, contextLength: 32768, license: 'Apache-2.0', tags: ['tiny', 'fast'], description: 'Small but capable. Good for autocomplete and simple agents.', ggufRepo: 'Qwen/Qwen2.5-1.5B-Instruct-GGUF', useCases: ['autocomplete', 'simple chat'] },
  { id: 'phi-3-mini', name: 'Phi-3 Mini', paramB: 3.8, contextLength: 128000, license: 'MIT', tags: ['small', 'long-context', 'microsoft'], description: 'Microsoft\'s small model with 128K context. Punches above its weight.', ggufRepo: 'microsoft/Phi-3-mini-4k-instruct-gguf', useCases: ['long docs', 'chat', 'extraction'] },
  { id: 'gemma-2-2b', name: 'Gemma 2 2B', paramB: 2.6, contextLength: 8192, license: 'Gemma', tags: ['small', 'google'], description: 'Google\'s compact model. Good reasoning for the size.', ggufRepo: 'bartowski/gemma-2-2b-it-GGUF', useCases: ['chat', 'reasoning'] },

  // Small (7-9B) — sweet spot for 8GB VRAM
  { id: 'llama-3.1-8b', name: 'Llama 3.1 8B', paramB: 8, contextLength: 128000, license: 'Llama 3.1', tags: ['popular', 'meta', 'long-context'], description: 'Meta\'s flagship small model. Excellent general-purpose.', ggufRepo: 'lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF', useCases: ['chat', 'agents', 'coding', 'general'] },
  { id: 'qwen2.5-7b', name: 'Qwen2.5 7B', paramB: 7, contextLength: 32768, license: 'Apache-2.0', tags: ['popular', 'multilingual', 'coding'], description: 'Strong all-around. Excellent multilingual + coding.', ggufRepo: 'bartowski/Qwen2.5-7B-Instruct-GGUF', useCases: ['chat', 'coding', 'multilingual'] },
  { id: 'qwen2.5-coder-7b', name: 'Qwen2.5 Coder 7B', paramB: 7, contextLength: 32768, license: 'Apache-2.0', tags: ['coding', 'specialized'], description: 'Best small coding model. Built for agentic coding workflows.', ggufRepo: 'bartowski/Qwen2.5-Coder-7B-Instruct-GGUF', useCases: ['coding', 'agents'] },
  { id: 'gemma-2-9b', name: 'Gemma 2 9B', paramB: 9, contextLength: 8192, license: 'Gemma', tags: ['small', 'google', 'reasoning'], description: 'Google\'s 9B with strong reasoning. Trained on more data.', ggufRepo: 'bartowski/gemma-2-9b-it-GGUF', useCases: ['chat', 'reasoning'] },
  { id: 'deepseek-coder-7b', name: 'DeepSeek Coder 7B', paramB: 6.7, contextLength: 128000, license: 'DeepSeek', tags: ['coding', 'long-context'], description: 'Strong coding model with 128K context.', ggufRepo: 'lmstudio-community/DeepSeek-Coder-7B-Instruct-v1.5-GGUF', useCases: ['coding', 'long files'] },

  // Medium (12-14B) — 12GB VRAM
  { id: 'qwen2.5-14b', name: 'Qwen2.5 14B', paramB: 14, contextLength: 32768, license: 'Apache-2.0', tags: ['medium'], description: 'Mid-tier Qwen. Better reasoning than 7B, still fits 12GB.', ggufRepo: 'bartowski/Qwen2.5-14B-Instruct-GGUF', useCases: ['chat', 'agents'] },
  { id: 'phi-3-medium', name: 'Phi-3 Medium', paramB: 14, contextLength: 128000, license: 'MIT', tags: ['medium', 'long-context'], description: 'Microsoft\'s 14B with 128K context.', ggufRepo: 'microsoft/Phi-3-medium-128k-instruct-gguf', useCases: ['long docs', 'chat'] },

  // Large (27-70B) — 24GB+ VRAM
  { id: 'qwen2.5-coder-32b', name: 'Qwen2.5 Coder 32B', paramB: 32, contextLength: 32768, license: 'Apache-2.0', tags: ['large', 'coding', 'frontier-small'], description: 'Best open coding model. Rivals GPT-4 for coding tasks.', ggufRepo: 'bartowski/Qwen2.5-Coder-32B-Instruct-GGUF', useCases: ['coding', 'agents'] },
  { id: 'qwen2.5-32b', name: 'Qwen2.5 32B', paramB: 32, contextLength: 32768, license: 'Apache-2.0', tags: ['large'], description: 'Strong general-purpose 32B. Needs 24GB VRAM at Q4.', ggufRepo: 'bartowski/Qwen2.5-32B-Instruct-GGUF', useCases: ['chat', 'agents', 'reasoning'] },
  { id: 'gemma-2-27b', name: 'Gemma 2 27B', paramB: 27, contextLength: 8192, license: 'Gemma', tags: ['large', 'google'], description: 'Google\'s 27B. Excellent reasoning.', ggufRepo: 'bartowski/gemma-2-27b-it-GGUF', useCases: ['chat', 'reasoning'] },
  { id: 'llama-3.1-70b', name: 'Llama 3.1 70B', paramB: 70, contextLength: 128000, license: 'Llama 3.1', tags: ['large', 'meta', 'frontier'], description: 'Meta\'s 70B. Frontier-class open model. Needs 48GB+ VRAM.', ggufRepo: 'lmstudio-community/Meta-Llama-3.1-70B-Instruct-GGUF', useCases: ['chat', 'agents', 'reasoning'] },
  { id: 'deepseek-v2', name: 'DeepSeek V2', paramB: 21, contextLength: 128000, license: 'DeepSeek', tags: ['large', 'moe', 'long-context'], description: 'MoE model with 21B active. Strong reasoning + coding.', ggufRepo: 'bartowski/DeepSeek-V2-Lite-Chat-GGUF', useCases: ['chat', 'coding', 'reasoning'] },

  // Vision
  { id: 'llama-3.2-11b-vision', name: 'Llama 3.2 11B Vision', paramB: 11, contextLength: 128000, license: 'Llama 3.2', tags: ['vision', 'multimodal'], description: 'Meta\'s vision-language model. Image + text in, text out.', ggufRepo: 'lmstudio-community/Llama-3.2-11B-Vision-Instruct-GGUF', useCases: ['vision', 'image QA'] },
  { id: 'qwen2.5-vl-7b', name: 'Qwen2.5 VL 7B', paramB: 7, contextLength: 32768, license: 'Apache-2.0', tags: ['vision', 'multimodal', 'small'], description: 'Qwen vision model. Strong OCR + document understanding.', ggufRepo: 'bartowski/Qwen2.5-VL-7B-Instruct-GGUF', useCases: ['vision', 'OCR', 'documents'] },

  // Reasoning models
  { id: 'deepseek-r1-7b', name: 'DeepSeek R1 7B', paramB: 7, contextLength: 65536, license: 'DeepSeek', tags: ['reasoning', 'distill'], description: 'Distilled R1 reasoning model. Thinks before answering.', ggufRepo: 'bartowski/DeepSeek-R1-Distill-Qwen-7B-GGUF', useCases: ['reasoning', 'math', 'coding'] },
  { id: 'deepseek-r1-14b', name: 'DeepSeek R1 14B', paramB: 14, contextLength: 65536, license: 'DeepSeek', tags: ['reasoning', 'distill'], description: '14B reasoning distill. Better math + logic.', ggufRepo: 'bartowski/DeepSeek-R1-Distill-Qwen-14B-GGUF', useCases: ['reasoning', 'math'] },
  { id: 'deepseek-r1-32b', name: 'DeepSeek R1 32B', paramB: 32, contextLength: 65536, license: 'DeepSeek', tags: ['reasoning', 'distill', 'frontier'], description: '32B reasoning. Rivals o1 on many benchmarks.', ggufRepo: 'bartowski/DeepSeek-R1-Distill-Qwen-32B-GGUF', useCases: ['reasoning', 'math', 'coding'] },
];

export function getCookbookModels(): CookbookModel[] {
  return COOKBOOK;
}

// ---------------------------------------------------------------------------
// Ollama Modelfile generation (for "Download & Serve" one-click)
// ---------------------------------------------------------------------------
export function generateOllamaModelfile(model: CookbookModel, ggufPath: string, quant: QuantTier): string {
  return `# Generated by ClawCode Cookbook
# Model: ${model.name} (${model.paramB}B params)
# Quant: ${quant}
# License: ${model.license}
FROM ${ggufPath}

PARAMETER context_length ${model.contextLength}
PARAMETER temperature 0.6
PARAMETER top_p 0.9
PARAMETER stop "<|im_start|>"
PARAMETER stop "<|im_end|>"

SYSTEM "You are a helpful assistant."

# Tags: ${model.tags.join(', ')}
# Use cases: ${model.useCases.join(', ')}
`;
}
