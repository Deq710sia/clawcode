import { useState, useEffect, useCallback } from 'react';
import { Search, Star, Download, Trash2, ExternalLink, Package, Loader2, CheckCircle2, Filter } from 'lucide-react';
import type { Skill, InstalledSkill } from '../types';

type Category = 'all' | 'skill' | 'tool' | 'prompt' | 'mod';

export default function SkillsBrowser() {
  const [view, setView] = useState<'curated' | 'search' | 'installed'>('curated');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<Category>('all');
  const [curated, setCurated] = useState<Skill[]>([]);
  const [results, setResults] = useState<Skill[]>([]);
  const [installed, setInstalled] = useState<InstalledSkill[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<Record<string, boolean>>({});
  const [installMsg, setInstallMsg] = useState<Record<string, string>>({});

  const refreshInstalled = useCallback(async () => {
    const list = await window.claw.skills.installed();
    setInstalled(list);
  }, []);

  const refreshCurated = useCallback(async () => {
    const list = await window.claw.skills.curated();
    setCurated(list);
  }, []);

  useEffect(() => {
    refreshCurated();
    refreshInstalled();
  }, [refreshCurated, refreshInstalled]);

  const doSearch = async () => {
    setLoading(true);
    setError(null);
    try {
      const topic = category === 'all' ? undefined : `${category}-skill`;
      const results = await window.claw.skills.search({ query, topic, perPage: 40 });
      setResults(results);
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setLoading(false);
    }
  };

  const install = async (skill: Skill) => {
    setInstalling((s) => ({ ...s, [skill.name]: true }));
    setInstallMsg((s) => ({ ...s, [skill.name]: '' }));
    try {
      const res = await window.claw.skills.install(skill.repoUrl, skill.name);
      if (res.ok) {
        setInstallMsg((s) => ({ ...s, [skill.name]: 'Installed ✓' }));
        await refreshInstalled();
        await refreshCurated();
      } else {
        setInstallMsg((s) => ({ ...s, [skill.name]: res.error ?? 'Failed' }));
      }
    } catch (err: any) {
      setInstallMsg((s) => ({ ...s, [skill.name]: err?.message ?? String(err) }));
    } finally {
      setInstalling((s) => ({ ...s, [skill.name]: false }));
      setTimeout(() => setInstallMsg((s) => ({ ...s, [skill.name]: '' })), 3000);
    }
  };

  const uninstall = async (name: string) => {
    if (!confirm(`Uninstall ${name}?`)) return;
    await window.claw.skills.uninstall(name);
    await refreshInstalled();
    await refreshCurated();
  };

  const openExternal = (url: string) => window.claw.app.openExternal(url);

  const filterByCategory = (list: Skill[]) =>
    category === 'all' ? list : list.filter((s) => s.category === category);

  const tabs: { id: typeof view; label: string; icon: any }[] = [
    { id: 'curated', label: 'Featured', icon: Package },
    { id: 'search', label: 'Search GitHub', icon: Search },
    { id: 'installed', label: 'Installed', icon: CheckCircle2 },
  ];

  const categories: { id: Category; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'skill', label: 'Skills' },
    { id: 'tool', label: 'Tools' },
    { id: 'prompt', label: 'Prompts' },
    { id: 'mod', label: 'Mods' },
  ];

  return (
    <div className="browser-panel">
      <div className="browser-header">
        <div className="browser-title">
          <Package size={13} style={{ color: 'var(--accent-bright)' }} />
          <span>Skills & Tools</span>
        </div>
        <div className="browser-tabs">
          {tabs.map((t) => (
            <button
              key={t.id}
              className={`browser-tab ${view === t.id ? 'active' : ''}`}
              onClick={() => setView(t.id)}
            >
              <t.icon size={11} />
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="browser-controls">
        {view === 'search' && (
          <>
            <div className="browser-search">
              <Search size={12} />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && doSearch()}
                placeholder="Search GitHub for skills, tools, prompts…"
              />
              <button className="btn primary" onClick={doSearch} disabled={loading}>
                {loading ? <Loader2 size={11} className="spin" /> : 'Search'}
              </button>
            </div>
            <div className="browser-filters">
              <Filter size={11} style={{ color: 'var(--fg-3)' }} />
              {categories.map((c) => (
                <button
                  key={c.id}
                  className={`filter-chip ${category === c.id ? 'active' : ''}`}
                  onClick={() => setCategory(c.id)}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </>
        )}
        {view === 'curated' && (
          <div className="browser-filters">
            <Filter size={11} style={{ color: 'var(--fg-3)' }} />
            {categories.map((c) => (
              <button
                key={c.id}
                className={`filter-chip ${category === c.id ? 'active' : ''}`}
                onClick={() => setCategory(c.id)}
              >
                {c.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="browser-content">
        {error && <div className="browser-error">{error}</div>}

        {view === 'curated' && (
          <div className="card-grid">
            {filterByCategory(curated).map((s) => (
              <SkillCard
                key={s.name}
                skill={s}
                installing={!!installing[s.name]}
                msg={installMsg[s.name]}
                onInstall={() => install(s)}
                onUninstall={() => uninstall(s.name)}
                onOpen={() => openExternal(s.repoUrl)}
              />
            ))}
          </div>
        )}

        {view === 'search' && (
          <>
            {loading && results.length === 0 && <div className="browser-empty">Searching GitHub…</div>}
            {!loading && results.length === 0 && !error && (
              <div className="browser-empty">No results yet. Try searching for "claude code skills" or "agent tools".</div>
            )}
            <div className="card-grid">
              {filterByCategory(results).map((s) => (
                <SkillCard
                  key={s.name + s.author}
                  skill={s}
                  installing={!!installing[s.name]}
                  msg={installMsg[s.name]}
                  onInstall={() => install(s)}
                  onUninstall={() => uninstall(s.name)}
                  onOpen={() => openExternal(s.repoUrl)}
                />
              ))}
            </div>
          </>
        )}

        {view === 'installed' && (
          <>
            {installed.length === 0 && (
              <div className="browser-empty">
                No skills installed yet. Browse Featured or Search GitHub to install one.
              </div>
            )}
            <div className="installed-list">
              {installed.map((s) => (
                <div key={s.name} className="installed-row">
                  <div className="installed-row-info">
                    <div className="installed-row-name">{s.name}</div>
                    <div className="installed-row-desc">{s.manifest?.description ?? '(no manifest)'}</div>
                    {s.manifest?.commands && s.manifest.commands.length > 0 && (
                      <div className="installed-row-cmds">
                        {s.manifest.commands.map((c) => (
                          <code key={c} className="cmd-chip">/{c}</code>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="installed-row-actions">
                    <button className="btn ghost" onClick={() => uninstall(s.name)}>
                      <Trash2 size={11} /> Uninstall
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function SkillCard({
  skill,
  installing,
  msg,
  onInstall,
  onUninstall,
  onOpen,
}: {
  skill: Skill;
  installing: boolean;
  msg?: string;
  onInstall: () => void;
  onUninstall: () => void;
  onOpen: () => void;
}) {
  const fmtStars = (n?: number) => {
    if (n === undefined) return '';
    if (n > 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  };

  return (
    <div className={`skill-card ${skill.installed ? 'installed' : ''}`}>
      <div className="skill-card-header">
        <span className={`skill-category cat-${skill.category}`}>{skill.category}</span>
        <span className="skill-card-name">{skill.name}</span>
        {skill.stars !== undefined && (
          <span className="skill-card-stars" title="GitHub stars">
            <Star size={10} /> {fmtStars(skill.stars)}
          </span>
        )}
      </div>
      <div className="skill-card-desc">{skill.description}</div>
      <div className="skill-card-author">by {skill.author}</div>
      <div className="skill-card-actions">
        {skill.installed ? (
          <button className="btn ghost" onClick={onUninstall}>
            <Trash2 size={10} /> Uninstall
          </button>
        ) : (
          <button className="btn primary" onClick={onInstall} disabled={installing}>
            {installing ? <Loader2 size={10} className="spin" /> : <Download size={10} />}
            {installing ? 'Installing…' : 'Install'}
          </button>
        )}
        <button className="btn ghost" onClick={onOpen} title="Open on GitHub">
          <ExternalLink size={10} />
        </button>
        {msg && <span className="skill-card-msg">{msg}</span>}
      </div>
    </div>
  );
}
