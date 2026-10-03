import { useState, useEffect, useCallback, useMemo } from 'react';
import { Search, Star, Download, Trash2, ExternalLink, Cpu, Loader2, HardDrive, Filter, TrendingUp, Zap, ChefHat, Activity, Server } from 'lucide-react';
import type { HFModel, DownloadedModel, HardwareInfo, CookbookModel, FitEstimate } from '../types';

type Sort = 'downloads' | 'likes' | 'trending';
type TaskFilter = 'all' | 'text-generation' | 'text2text-generation' | 'code-generation' | 'image-text-to-text';
type View = 'cookbook' | 'browse' | 'gguf' | 'downloaded';

const TASK_LABELS: Record<string, string> = {
  'text-generation': 'Text',
  'text2text-generation': 'Seq2Seq',
  'code-generation': 'Code',
  'image-text-to-text': 'Vision',
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

export default function ModelsBrowser() {
  const [view, setView] = useState<View>('cookbook');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('downloads');
  const [task, setTask] = useState<TaskFilter>('all');
  const [results, setResults] = useState<HFModel[]>([]);
  const [downloaded, setDownloaded] = useState<DownloadedModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<Record<string, boolean>>({});
  const [hfCliInstalled, setHfCliInstalled] = useState<boolean | null>(null);

  // Cookbook state
  const [hardware, setHardware] = useState<HardwareInfo | null>(null);
  const [cookbook, setCookbook] = useState<CookbookModel[]>([]);
  const [fits, setFits] = useState<Record<string, FitEstimate>>({});
  const [cookbookFilter, setCookbookFilter] = useState<string>('all');

  const refreshDownloaded = useCallback(async () => {
    const list = await window.claw.hf.downloaded();
    setDownloaded(list);
  }, []);

  useEffect(() => {
    window.claw.hf.probeCli().then(setHfCliInstalled);
    refreshDownloaded();
    // Load cookbook + hardware on mount
    window.claw.hf.cookbook().then(setCookbook);
    window.claw.hf.hardware().then(setHardware);
  }, [refreshDownloaded]);

  // Compute fits when hardware or cookbook changes
  useEffect(() => {
    if (!hardware || cookbook.length === 0) return;
    const vram = hardware.gpus.reduce((acc, g) => acc + g.vramTotalBytes, 0);
    const ram = hardware.ramTotalBytes;
    (async () => {
      const newFits: Record<string, FitEstimate> = {};
      for (const m of cookbook) {
        newFits[m.id] = await window.claw.hf.estimateFit(m.paramB, vram, ram, m.contextLength);
      }
      setFits(newFits);
    })();
  }, [hardware, cookbook]);

  const doSearch = async (whichView?: View) => {
    setLoading(true);
    setError(null);
    try {
      let models: HFModel[];
      if (whichView === 'gguf') {
        models = await window.claw.hf.gguf(50);
      } else if (query.trim()) {
        models = await window.claw.hf.search({
          query: query.trim(),
          pipelineTag: task === 'all' ? undefined : task,
          sort,
          limit: 50,
        });
      } else {
        models = await window.claw.hf.trending(50);
      }
      setResults(models);
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setLoading(false);
    }
  };

  const download = async (model: HFModel) => {
    setDownloading((s) => ({ ...s, [model.id]: true }));
    try {
      const res = await window.claw.hf.download(model.id);
      if (!res.ok) {
        alert(`Download failed: ${res.error}`);
      } else {
        await refreshDownloaded();
      }
    } finally {
      setDownloading((s) => ({ ...s, [model.id]: false }));
    }
  };

  const downloadCookbook = async (m: CookbookModel, fit: FitEstimate) => {
    setDownloading((s) => ({ ...s, [m.id]: true }));
    try {
      // Download the GGUF repo
      const res = await window.claw.hf.download(m.ggufRepo);
      if (!res.ok) {
        alert(`Download failed: ${res.error}`);
        return;
      }
      await refreshDownloaded();
      // Offer to generate Ollama Modelfile
      const generateModelfile = confirm(
        `Downloaded ${m.name} to:\n${res.path}\n\nGenerate Ollama Modelfile at ${fit.recommendedQuant}? You can run 'ollama create ${m.id} -f Modelfile' to serve it.`
      );
      if (generateModelfile) {
        const modelfile = await window.claw.hf.modelfile(m, res.path!, fit.recommendedQuant);
        // Show the Modelfile content in a prompt so user can save it
        const blob = new Blob([modelfile], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `Modelfile.${m.id}`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } finally {
      setDownloading((s) => ({ ...s, [m.id]: false }));
    }
  };

  const removeModel = async (name: string) => {
    if (!confirm(`Delete downloaded model "${name}"? This frees disk space.`)) return;
    await window.claw.hf.delete(name);
    await refreshDownloaded();
  };

  const openExternal = (url: string) => window.claw.app.openExternal(url);

  const tabs: { id: View; label: string; icon: any }[] = [
    { id: 'cookbook', label: 'Cookbook', icon: ChefHat },
    { id: 'browse', label: 'Browse HF', icon: Search },
    { id: 'gguf', label: 'GGUF', icon: Zap },
    { id: 'downloaded', label: 'Downloaded', icon: HardDrive },
  ];

  const sorts: { id: Sort; label: string; icon: any }[] = [
    { id: 'downloads', label: 'Downloads', icon: Download },
    { id: 'likes', label: 'Likes', icon: Star },
    { id: 'trending', label: 'Trending', icon: TrendingUp },
  ];

  const tasks: { id: TaskFilter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'text-generation', label: 'Text' },
    { id: 'text2text-generation', label: 'Seq2Seq' },
    { id: 'code-generation', label: 'Code' },
  ];

  const cookbookFilters = [
    { id: 'all', label: 'All' },
    { id: 'tiny', label: 'Tiny (<3B)' },
    { id: 'small', label: 'Small (7-9B)' },
    { id: 'medium', label: 'Medium (12-14B)' },
    { id: 'large', label: 'Large (27B+)' },
    { id: 'coding', label: 'Coding' },
    { id: 'reasoning', label: 'Reasoning' },
    { id: 'vision', label: 'Vision' },
  ];

  const filteredCookbook = useMemo(() => {
    if (cookbookFilter === 'all') return cookbook;
    if (['tiny', 'small', 'medium', 'large'].includes(cookbookFilter)) {
      const ranges: Record<string, [number, number]> = {
        tiny: [0, 3], small: [3, 10], medium: [10, 20], large: [20, 1000],
      };
      const [lo, hi] = ranges[cookbookFilter];
      return cookbook.filter((m) => m.paramB >= lo && m.paramB < hi);
    }
    return cookbook.filter((m) => m.tags.includes(cookbookFilter));
  }, [cookbook, cookbookFilter]);

  // Sort cookbook by fit score (best first)
  const sortedCookbook = useMemo(() => {
    return [...filteredCookbook].sort((a, b) => (fits[b.id]?.score ?? 0) - (fits[a.id]?.score ?? 0));
  }, [filteredCookbook, fits]);

  return (
    <div className="browser-panel">
      <div className="browser-header">
        <div className="browser-title">
          <Cpu size={13} style={{ color: 'var(--accent-bright)' }} />
          <span>Models</span>
        </div>
        <div className="browser-tabs">
          {tabs.map((t) => (
            <button
              key={t.id}
              className={`browser-tab ${view === t.id ? 'active' : ''}`}
              onClick={() => {
                setView(t.id);
                if (t.id === 'browse' || t.id === 'gguf') doSearch(t.id);
              }}
            >
              <t.icon size={11} />
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {hfCliInstalled === false && view !== 'cookbook' && (
        <div className="browser-warn">
          ⚠ <code className="mono">huggingface-cli</code> not found. Install with <code className="mono">pip install huggingface_hub</code> for resumable downloads.
        </div>
      )}

      {/* Cookbook view */}
      {view === 'cookbook' && (
        <>
          {hardware && <HardwarePanel hw={hardware} />}
          <div className="browser-controls">
            <div className="browser-filters">
              <Filter size={11} style={{ color: 'var(--fg-3)' }} />
              {cookbookFilters.map((f) => (
                <button
                  key={f.id}
                  className={`filter-chip ${cookbookFilter === f.id ? 'active' : ''}`}
                  onClick={() => setCookbookFilter(f.id)}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
          <div className="browser-content">
            <div className="cookbook-hint">
              <ChefHat size={11} /> Recommended for your hardware. Higher score = better VRAM fit.
              (Pattern ported from <button className="link-btn" onClick={() => openExternal('https://github.com/pewdiepie-archdaemon/odysseus')}>Odysseus Cookbook</button>.)
            </div>
            <div className="card-grid">
              {sortedCookbook.map((m) => (
                <CookbookCard
                  key={m.id}
                  model={m}
                  fit={fits[m.id]}
                  downloading={!!downloading[m.id]}
                  alreadyDownloaded={downloaded.some((d) => d.id === m.ggufRepo || d.files.some((f) => f.includes(m.id)))}
                  onDownload={() => fits[m.id] && downloadCookbook(m, fits[m.id])}
                  onOpen={() => openExternal(`https://huggingface.co/${m.ggufRepo}`)}
                />
              ))}
            </div>
          </div>
        </>
      )}

      {/* Browse / GGUF view */}
      {(view === 'browse' || view === 'gguf') && (
        <>
          <div className="browser-controls">
            {view === 'browse' && (
              <>
                <div className="browser-search">
                  <Search size={12} />
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && doSearch()}
                    placeholder="Search HuggingFace models…"
                  />
                  <button className="btn primary" onClick={() => doSearch()} disabled={loading}>
                    {loading ? <Loader2 size={11} className="spin" /> : 'Search'}
                  </button>
                </div>
                <div className="browser-filters">
                  <Filter size={11} style={{ color: 'var(--fg-3)' }} />
                  {sorts.map((s) => (
                    <button key={s.id} className={`filter-chip ${sort === s.id ? 'active' : ''}`} onClick={() => { setSort(s.id); doSearch(); }}>
                      <s.icon size={10} /> {s.label}
                    </button>
                  ))}
                  <span style={{ width: 1, height: 14, background: 'var(--border-2)', margin: '0 4px' }} />
                  {tasks.map((t) => (
                    <button key={t.id} className={`filter-chip ${task === t.id ? 'active' : ''}`} onClick={() => { setTask(t.id); doSearch(); }}>
                      {t.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          <div className="browser-content">
            {error && <div className="browser-error">{error}</div>}
            {loading && results.length === 0 && <div className="browser-empty">Loading models…</div>}
            {!loading && results.length === 0 && !error && (
              <div className="browser-empty">No models found. Try a different search.</div>
            )}
            <div className="card-grid">
              {results.map((m) => (
                <ModelCard
                  key={m.id}
                  model={m}
                  downloading={!!downloading[m.id]}
                  onDownload={() => download(m)}
                  onOpen={() => openExternal(`https://huggingface.co/${m.id}`)}
                />
              ))}
            </div>
          </div>
        </>
      )}

      {/* Downloaded view */}
      {view === 'downloaded' && (
        <div className="browser-content">
          {downloaded.length === 0 && (
            <div className="browser-empty">
              No models downloaded yet. Use the Cookbook tab for hardware-aware recommendations, or Browse HF to search.
            </div>
          )}
          <div className="installed-list">
            {downloaded.map((m) => (
              <div key={m.name} className="installed-row">
                <div className="installed-row-info">
                  <div className="installed-row-name">
                    {m.id}
                    {m.hasGguf && <span className="gguf-badge">GGUF</span>}
                  </div>
                  <div className="installed-row-desc">
                    {formatBytes(m.sizeBytes)} · {m.files.length} files · {new Date(m.downloadedAt).toLocaleDateString()}
                  </div>
                  <div className="installed-row-path mono">{m.path}</div>
                </div>
                <div className="installed-row-actions">
                  <button className="btn ghost" onClick={() => openExternal(`https://huggingface.co/${m.id}`)}>
                    <ExternalLink size={11} />
                  </button>
                  <button className="btn danger" onClick={() => removeModel(m.name)}>
                    <Trash2 size={11} /> Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function HardwarePanel({ hw }: { hw: HardwareInfo }) {
  const totalVram = hw.gpus.reduce((acc, g) => acc + g.vramTotalBytes, 0);
  return (
    <div className="hardware-panel">
      <div className="hardware-header">
        <Activity size={12} style={{ color: 'var(--accent-bright)' }} />
        <span>Detected Hardware</span>
      </div>
      <div className="hardware-grid">
        <div className="hardware-item">
          <div className="hardware-label">CPU</div>
          <div className="hardware-value">{hw.cpuModel}</div>
          <div className="hardware-sub">{hw.cpuCores} cores · {hw.arch}</div>
        </div>
        <div className="hardware-item">
          <div className="hardware-label">RAM</div>
          <div className="hardware-value">{formatBytes(hw.ramTotalBytes)}</div>
        </div>
        {hw.gpus.length > 0 ? (
          hw.gpus.map((g, i) => (
            <div key={i} className="hardware-item">
              <div className="hardware-label">GPU {i + 1} · <span className={`gpu-type gpu-${g.type}`}>{g.type}</span></div>
              <div className="hardware-value">{g.name}</div>
              <div className="hardware-sub">{g.vramTotalBytes > 0 ? `${formatBytes(g.vramTotalBytes)} VRAM` : 'VRAM unknown'}</div>
            </div>
          ))
        ) : (
          <div className="hardware-item">
            <div className="hardware-label">GPU</div>
            <div className="hardware-value muted">None detected</div>
            <div className="hardware-sub">CPU-only inference (slow)</div>
          </div>
        )}
      </div>
      {totalVram > 0 && (
        <div className="hardware-total">
          Total VRAM: <strong>{formatBytes(totalVram)}</strong> · Cookbook will recommend models that fit with 20% headroom for KV cache.
        </div>
      )}
    </div>
  );
}

function CookbookCard({
  model,
  fit,
  downloading,
  alreadyDownloaded,
  onDownload,
  onOpen,
}: {
  model: CookbookModel;
  fit?: FitEstimate;
  downloading: boolean;
  alreadyDownloaded: boolean;
  onDownload: () => void;
  onOpen: () => void;
}) {
  const score = fit?.score ?? 0;
  const scoreColor = score >= 70 ? 'var(--ok)' : score >= 40 ? 'var(--warn)' : 'var(--err)';

  return (
    <div className={`skill-card cookbook-card ${fit?.fits ? 'fits' : 'no-fit'}`}>
      <div className="skill-card-header">
        {model.tags.slice(0, 2).map((t) => (
          <span key={t} className="skill-category cat-skill">{t}</span>
        ))}
        <span className="skill-card-name">{model.name}</span>
        {fit && (
          <span className="fit-score" style={{ color: scoreColor }} title={fit.reason}>
            {score}/100
          </span>
        )}
      </div>
      <div className="skill-card-desc">{model.description}</div>
      <div className="cookbook-meta">
        <span><strong>{model.paramB}B</strong> params</span>
        <span>·</span>
        <span>{(model.contextLength / 1000).toFixed(0)}K context</span>
        <span>·</span>
        <span className="muted">{model.license}</span>
      </div>
      {fit && (
        <div className={`cookbook-fit ${fit.fits ? 'fits' : 'no-fit'}`}>
          <span className="quant-badge" title={fit.reason}>
            {fit.fits ? `✓ ${fit.recommendedQuant}` : '✗ no fit'}
          </span>
          <span className="fit-reason">{fit.reason}</span>
        </div>
      )}
      <div className="skill-card-actions">
        {alreadyDownloaded ? (
          <span className="skill-card-msg" style={{ color: 'var(--ok)' }}>✓ downloaded</span>
        ) : (
          <button
            className="btn primary"
            onClick={onDownload}
            disabled={downloading || !fit?.fits}
            title={!fit?.fits ? 'Does not fit your hardware' : ''}
          >
            {downloading ? <Loader2 size={10} className="spin" /> : <Download size={10} />}
            {downloading ? 'Downloading…' : fit?.fits ? `Download ${fit.recommendedQuant}` : "Won't fit"}
          </button>
        )}
        <button className="btn ghost" onClick={onOpen} title="Open on HuggingFace">
          <ExternalLink size={10} />
        </button>
      </div>
    </div>
  );
}

function ModelCard({
  model,
  downloading,
  onDownload,
  onOpen,
}: {
  model: HFModel;
  downloading: boolean;
  onDownload: () => void;
  onOpen: () => void;
}) {
  const fmtNum = (n: number) => {
    if (n > 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n > 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  };

  return (
    <div className={`skill-card ${model.downloaded ? 'installed' : ''}`}>
      <div className="skill-card-header">
        {model.hasGguf && <span className="skill-category cat-gguf">GGUF</span>}
        {model.pipelineTag && TASK_LABELS[model.pipelineTag] && (
          <span className="skill-category cat-task">{TASK_LABELS[model.pipelineTag]}</span>
        )}
        <span className="skill-card-name" title={model.id}>{model.id.split('/').pop()}</span>
      </div>
      <div className="skill-card-desc" title={model.id}>
        <span className="mono tiny">{model.id}</span>
      </div>
      <div className="skill-card-author">
        <span title="Downloads"><Download size={10} /> {fmtNum(model.downloads)}</span>
        <span title="Likes" style={{ marginLeft: 10 }}><Star size={10} /> {fmtNum(model.likes)}</span>
      </div>
      <div className="skill-card-actions">
        {model.downloaded ? (
          <span className="skill-card-msg" style={{ color: 'var(--ok)' }}>✓ downloaded</span>
        ) : (
          <button className="btn primary" onClick={onDownload} disabled={downloading}>
            {downloading ? <Loader2 size={10} className="spin" /> : <Download size={10} />}
            {downloading ? 'Downloading…' : 'Download'}
          </button>
        )}
        <button className="btn ghost" onClick={onOpen} title="Open on HuggingFace">
          <ExternalLink size={10} />
        </button>
      </div>
    </div>
  );
}
