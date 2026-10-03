import { useState, useEffect } from 'react';
import { X, Eye, EyeOff, Save, Trash2, Globe, Cpu, Bot, Cloud, Server } from 'lucide-react';
import { useClaw } from '../lib/store';
import { defaultSystemPrompt } from '../lib/api';
import type { ProviderPreset, WebChatProfile, OpenCodeStatus } from '../types';

type Tab = 'provider' | 'webchats' | 'opencode' | 'advanced';

export default function SettingsModal() {
  const setShowSettings = useClaw((s) => s.setShowSettings);
  const config = useClaw((s) => s.config);
  const setConfig = useClaw((s) => s.setConfig);

  const [tab, setTab] = useState<Tab>('provider');

  const [endpoint, setEndpoint] = useState('');
  const [model, setModel] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [saved, setSaved] = useState(false);

  const [providers, setProviders] = useState<ProviderPreset[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState<string>('');
  const [profiles, setProfiles] = useState<WebChatProfile[]>([]);
  const [ocStatus, setOcStatus] = useState<OpenCodeStatus | null>(null);

  useEffect(() => {
    (async () => {
      const ps = await window.claw.providers.list();
      setProviders(ps);
      const profs = await window.claw.webchat.profiles();
      setProfiles(profs);
      const oc = await window.claw.opencode.probe();
      setOcStatus(oc);
    })();
  }, []);

  useEffect(() => {
    if (config) {
      setEndpoint(config.endpoint);
      setModel(config.model);
      setSystemPrompt(config.systemPrompt);
      setHasApiKey(config.hasApiKey);
    }
  }, [config]);

  const selectProvider = (p: ProviderPreset) => {
    setSelectedProviderId(p.id);
    setEndpoint(p.endpoint);
    if (p.defaultModel) setModel(p.defaultModel);
  };

  const save = async () => {
    await window.claw.config.set({ endpoint, model, systemPrompt });
    if (apiKeyInput) {
      const res = await window.claw.config.setApiKey(apiKeyInput);
      setHasApiKey(res.hasApiKey);
      setApiKeyInput('');
    }
    const updated = await window.claw.config.get();
    setConfig({
      ...updated,
      endpoint: updated.endpoint || 'https://api.openai.com/v1',
      model: updated.model || 'gpt-4o-mini',
      systemPrompt: updated.systemPrompt || defaultSystemPrompt(),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const clearKey = async () => {
    await window.claw.config.setApiKey('');
    setHasApiKey(false);
  };

  const loginWebChat = async (id: string) => {
    setProfiles((ps) => ps.map((p) => (p.id === id ? { ...p, busy: true } : p)));
    const res = await window.claw.webchat.login(id);
    if (res.loggedIn) {
      const updated = await window.claw.webchat.profiles();
      setProfiles(updated);
    } else {
      alert(`Login failed: ${res.error ?? 'unknown error'}`);
    }
    const updated = await window.claw.webchat.profiles();
    setProfiles(updated);
  };

  const resetWebChat = async (id: string) => {
    if (!confirm('Reset this web chat profile? You will need to log in again.')) return;
    await window.claw.webchat.reset(id);
    const updated = await window.claw.webchat.profiles();
    setProfiles(updated);
  };

  const startOpenCode = async () => {
    const ws = await window.claw.workspace.get();
    const status = await window.claw.opencode.start({ workspace: ws || undefined, model });
    setOcStatus(status);
  };

  const stopOpenCode = async () => {
    await window.claw.opencode.stop();
    setOcStatus(await window.claw.opencode.status());
  };

  const tabs: { id: Tab; label: string; icon: any }[] = [
    { id: 'provider', label: 'Provider', icon: Cloud },
    { id: 'webchats', label: 'Web Chats', icon: Globe },
    { id: 'opencode', label: 'OpenCode', icon: Bot },
    { id: 'advanced', label: 'Advanced', icon: Cpu },
  ];

  return (
    <div className="modal-backdrop" onClick={() => setShowSettings(false)}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">Settings</div>
          <button className="modal-close" onClick={() => setShowSettings(false)}>
            <X size={14} />
          </button>
        </div>

        <div className="modal-tabs">
          {tabs.map((t) => (
            <button
              key={t.id}
              className={`modal-tab ${tab === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              <t.icon size={13} />
              {t.label}
            </button>
          ))}
        </div>

        <div className="modal-body">
          {tab === 'provider' && (
            <>
              <div className="form-row">
                <label className="form-label">Provider</label>
                <div className="provider-grid">
                  {providers.map((p) => (
                    <button
                      key={p.id}
                      className={`provider-card ${selectedProviderId === p.id ? 'selected' : ''}`}
                      onClick={() => selectProvider(p)}
                    >
                      <div className="provider-card-header">
                        <span className={`provider-category cat-${p.category}`}>{p.category}</span>
                        <span className="provider-card-label">{p.label}</span>
                      </div>
                      {p.note && <div className="provider-card-note">{p.note}</div>}
                      {p.defaultModel && (
                        <div className="provider-card-model mono">{p.defaultModel}</div>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              <div className="form-row">
                <label className="form-label">Endpoint</label>
                <input
                  className="form-input"
                  type="text"
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  placeholder="https://api.openai.com/v1"
                />
              </div>

              <div className="form-row">
                <label className="form-label">Model</label>
                <input
                  className="form-input"
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="gpt-4o-mini"
                  list="model-presets"
                />
                <datalist id="model-presets">
                  {providers.find((p) => p.id === selectedProviderId)?.models?.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </div>

              <div className="form-row">
                <label className="form-label">
                  API key {hasApiKey && <span style={{ color: 'var(--ok)' }}>· stored</span>}
                </label>
                <div className="api-key-row">
                  <input
                    className="form-input"
                    type={showKey ? 'text' : 'password'}
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    placeholder={hasApiKey ? '•••••••• (enter a new key to replace)' : 'sk-… (leave empty for local servers)'}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button className="btn ghost" onClick={() => setShowKey((v) => !v)} title="Toggle visibility">
                    {showKey ? <EyeOff size={12} /> : <Eye size={12} />}
                  </button>
                  {hasApiKey && (
                    <button className="btn danger" onClick={clearKey} title="Clear stored key">
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
                <div className="form-hint">
                  Encrypted with Windows DPAPI. Not needed for Ollama / LM Studio / WebChat Bridge.
                </div>
              </div>
            </>
          )}

          {tab === 'webchats' && (
            <>
              <div className="form-hint" style={{ marginBottom: 16 }}>
                Each web chat runs a headless Chromium using your saved login. Click "Log in" to open
                a visible browser window — log in normally, then close it. Subsequent queries run headless.
                The bridge exposes an OpenAI-compatible endpoint at <code className="mono">http://127.0.0.1:7777/v1</code>.
              </div>
              <div className="webchat-list">
                {profiles.map((p) => (
                  <div key={p.id} className={`webchat-row ${p.loggedIn ? 'logged-in' : ''}`}>
                    <div className="webchat-row-info">
                      <div className="webchat-row-label">{p.label}</div>
                      <div className="webchat-row-status">
                        {p.loggedIn ? (
                          <span className="status-ok">✓ logged in</span>
                        ) : (
                          <span className="status-pending">not logged in</span>
                        )}
                        {p.lastUsed && <span className="muted tiny"> · last used {new Date(p.lastUsed).toLocaleDateString()}</span>}
                      </div>
                    </div>
                    <div className="webchat-row-actions">
                      <button
                        className="btn primary"
                        onClick={() => loginWebChat(p.id)}
                        disabled={p.busy}
                      >
                        {p.loggedIn ? 'Re-login' : 'Log in'}
                      </button>
                      {p.loggedIn && (
                        <button className="btn ghost" onClick={() => resetWebChat(p.id)}>
                          Reset
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              <div className="form-hint" style={{ marginTop: 16, color: 'var(--warn)' }}>
                ⚠ Using web UIs via automation may violate the provider's ToS. Use at your own risk.
                Profile data is stored locally under userData/webchat-profiles/.
              </div>
            </>
          )}

          {tab === 'opencode' && (
            <>
              <div className="form-row">
                <label className="form-label">OpenCode backend</label>
                <div className="oc-status">
                  <div className="oc-status-row">
                    <span className="muted">Installed:</span>
                    <span>{ocStatus?.installed ? `Yes (${ocStatus.version})` : 'No'}</span>
                  </div>
                  <div className="oc-status-row">
                    <span className="muted">Running:</span>
                    <span>{ocStatus?.running ? `Yes (port ${ocStatus.port})` : 'No'}</span>
                  </div>
                  {ocStatus?.lastError && (
                    <div className="oc-status-row">
                      <span className="muted">Error:</span>
                      <span style={{ color: 'var(--err)' }}>{ocStatus.lastError}</span>
                    </div>
                  )}
                </div>
                <div className="form-hint">
                  Install OpenCode: <code className="mono">curl -fsSL https://opencode.ai/install | bash</code>
                  {' '}or <code className="mono">npm i -g opencode-ai</code>.
                  When running, select the "OpenCode Backend" provider to route the agent loop through it.
                </div>
              </div>

              <div className="form-row">
                <div className="row">
                  <button
                    className="btn primary"
                    onClick={startOpenCode}
                    disabled={!ocStatus?.installed || ocStatus?.running}
                  >
                    Start OpenCode
                  </button>
                  <button
                    className="btn danger"
                    onClick={stopOpenCode}
                    disabled={!ocStatus?.running}
                  >
                    Stop
                  </button>
                </div>
              </div>
            </>
          )}

          {tab === 'advanced' && (
            <>
              <div className="form-row">
                <label className="form-label">System prompt</label>
                <textarea
                  className="form-textarea"
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  placeholder="Leave blank to use the default ClawCode system prompt."
                />
                <div className="form-hint">
                  Customize the assistant's behavior. Workspace path + current time are appended automatically.
                </div>
              </div>
            </>
          )}
        </div>

        <div className="modal-footer">
          {saved && <span className="tiny" style={{ color: 'var(--ok)', marginRight: 'auto' }}>Saved ✓</span>}
          <button className="btn ghost" onClick={() => setShowSettings(false)}>Close</button>
          <button className="btn primary" onClick={save}>
            <Save size={12} /> Save
          </button>
        </div>
      </div>
    </div>
  );
}
