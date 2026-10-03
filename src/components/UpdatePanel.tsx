import { useState, useEffect } from 'react';
import { RefreshCw, Download, RotateCw, CheckCircle2, AlertCircle, ExternalLink, Loader2, Info } from 'lucide-react';
import type { UpdaterState, UpdaterProgress } from '../types';

export default function UpdatePanel() {
  const [currentVersion, setCurrentVersion] = useState('');
  const [state, setState] = useState<UpdaterState>({ state: 'idle' });
  const [progress, setProgress] = useState<UpdaterProgress | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    window.claw.updater.currentVersion().then(setCurrentVersion);
    const unsubState = window.claw.updater.onState(setState);
    return unsubState;
  }, []);

  useEffect(() => {
    const unsub = window.claw.updater.onProgress(setProgress);
    return unsub;
  }, []);

  const check = async () => {
    setBusy(true);
    setState({ state: 'checking' });
    try {
      const res = await window.claw.updater.check();
      if (!res.ok) {
        setState({ state: 'error', error: res.error || 'Check failed' });
      } else if (!res.available) {
        setState({ state: 'up-to-date', version: res.version || currentVersion });
      } else if (res.version) {
        setState({ state: 'available', version: res.version });
      }
    } finally {
      setBusy(false);
    }
  };

  const download = async () => {
    setBusy(true);
    setState({ state: 'downloading' });
    setProgress({ percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 });
    try {
      const res = await window.claw.updater.download();
      if (!res.ok) {
        setState({ state: 'error', error: res.error || 'Download failed' });
        setProgress(null);
      }
    } finally {
      setBusy(false);
    }
  };

  const install = async () => {
    if (!confirm('ClawCode will now quit and install the update. All your settings, skills, models, and web chat logins are preserved. Continue?')) {
      return;
    }
    await window.claw.updater.install();
  };

  const openReleases = () => window.claw.updater.openReleases();

  const fmtBytes = (b: number) => {
    if (!b) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(b) / Math.log(k));
    return `${(b / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  };

  const fmtSpeed = (bps: number) => {
    if (!bps) return '';
    return `${fmtBytes(bps)}/s`;
  };

  return (
    <div className="update-panel">
      <div className="update-current">
        <div className="update-current-label">Current version</div>
        <div className="update-current-value">v{currentVersion}</div>
      </div>

      {/* State-specific UI */}
      {state.state === 'idle' && (
        <div className="update-state idle">
          <Info size={14} style={{ color: 'var(--fg-3)' }} />
          <div className="update-state-text">Click "Check for updates" to look for newer releases on GitHub.</div>
        </div>
      )}

      {state.state === 'checking' && (
        <div className="update-state">
          <Loader2 size={14} className="spin" style={{ color: 'var(--accent-bright)' }} />
          <div className="update-state-text">Checking GitHub for updates…</div>
        </div>
      )}

      {state.state === 'up-to-date' && (
        <div className="update-state up-to-date">
          <CheckCircle2 size={14} style={{ color: 'var(--ok)' }} />
          <div className="update-state-text">
            You're on the latest version (v{state.version}).
          </div>
        </div>
      )}

      {state.state === 'available' && (
        <div className="update-state available">
          <AlertCircle size={14} style={{ color: 'var(--accent-bright)' }} />
          <div className="update-state-text">
            <strong>v{state.version}</strong> is available!{' '}
            <button className="link-btn" onClick={openReleases}>View release notes</button>
          </div>
        </div>
      )}

      {state.state === 'downloading' && (
        <div className="update-downloading">
          <div className="update-state">
            <Loader2 size={14} className="spin" style={{ color: 'var(--accent-bright)' }} />
            <div className="update-state-text">Downloading update…</div>
          </div>
          {progress && (
            <div className="update-progress">
              <div className="update-progress-bar">
                <div className="update-progress-fill" style={{ width: `${progress.percent}%` }} />
              </div>
              <div className="update-progress-meta">
                <span>{progress.percent.toFixed(1)}%</span>
                {progress.transferred > 0 && (
                  <span className="muted">{fmtBytes(progress.transferred)} / {fmtBytes(progress.total)}</span>
                )}
                {progress.bytesPerSecond > 0 && (
                  <span className="muted">{fmtSpeed(progress.bytesPerSecond)}</span>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {state.state === 'downloaded' && (
        <div className="update-state downloaded">
          <CheckCircle2 size={14} style={{ color: 'var(--ok)' }} />
          <div className="update-state-text">
            <strong>v{state.version}</strong> downloaded. Install now? All your data (settings, skills, models, web chat logins) will be preserved.
          </div>
        </div>
      )}

      {state.state === 'error' && (
        <div className="update-state error">
          <AlertCircle size={14} style={{ color: 'var(--err)' }} />
          <div className="update-state-text">
            Update failed: {state.error}
            <br />
            <button className="link-btn" onClick={openReleases}>Open releases page manually</button>
          </div>
        </div>
      )}

      {/* Action buttons */}
      <div className="update-actions">
        {state.state === 'available' && (
          <button className="btn primary" onClick={download} disabled={busy}>
            <Download size={12} /> Download v{state.version}
          </button>
        )}
        {state.state === 'downloaded' && (
          <button className="btn primary" onClick={install}>
            <RotateCw size={12} /> Install & Restart
          </button>
        )}
        {state.state !== 'downloading' && state.state !== 'checking' && (
          <button className="btn ghost" onClick={check} disabled={busy}>
            <RefreshCw size={12} /> Check for updates
          </button>
        )}
        <button className="btn ghost" onClick={openReleases}>
          <ExternalLink size={12} /> View on GitHub
        </button>
      </div>

      {/* Data preservation note */}
      <div className="update-note">
        <Info size={11} />
        <div>
          <strong>Your data is preserved across updates:</strong>
          <br />
          Settings, API keys (encrypted via DPAPI), installed skills, downloaded HuggingFace models, web chat login profiles, and chat history all live in <code className="mono">%APPDATA%/ClawCode</code> — keyed by app ID, not version. Updating only replaces the application binaries.
        </div>
      </div>
    </div>
  );
}
