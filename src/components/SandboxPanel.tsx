import { useState, useEffect } from 'react';
import { Shield, Loader2, AlertCircle, CheckCircle2, Cpu, Network, Clipboard, HardDrive, FolderOpen, Play, FileText } from 'lucide-react';
import { useClaw } from '../lib/store';

export default function SandboxPanel() {
  const workspace = useClaw((s) => s.workspace);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [persistUserData, setPersistUserData] = useState(true);
  const [enableNetworking, setEnableNetworking] = useState(true);
  const [enableGpu, setEnableGpu] = useState(true);
  const [enableClipboard, setEnableClipboard] = useState(true);
  const [wsbContent, setWsbContent] = useState<string>('');
  const [wsbPath, setWsbPath] = useState('');
  const [launching, setLaunching] = useState(false);
  const [launchMsg, setLaunchMsg] = useState('');

  useEffect(() => {
    window.claw.sandbox.available().then(setAvailable);
  }, []);

  const generate = async () => {
    const res = await window.claw.sandbox.generate({
      workspacePath: workspace,
      persistUserData,
      enableNetworking,
      enableGpu,
      enableClipboard,
    });
    if (res.ok) {
      setWsbContent(res.content || '');
      setWsbPath(res.wsbPath || '');
    }
  };

  const launch = async () => {
    setLaunching(true);
    setLaunchMsg('');
    const res = await window.claw.sandbox.launch({
      workspacePath: workspace,
      persistUserData,
      enableNetworking,
      enableGpu,
      enableClipboard,
    });
    if (res.ok) {
      setLaunchMsg('Sandbox launching… a Windows Sandbox window should appear shortly.');
      setWsbPath(res.wsbPath || '');
    } else {
      setLaunchMsg(`Failed: ${res.error}`);
    }
    setLaunching(false);
  };

  const openWsb = () => {
    if (wsbPath) window.claw.app.openExternal(wsbPath);
  };

  return (
    <div className="sandbox-panel">
      {/* Availability check */}
      <div className={`sandbox-status ${available === false ? 'unavailable' : available ? 'available' : ''}`}>
        {available === null && <Loader2 size={14} className="spin" />}
        {available === true && <CheckCircle2 size={14} style={{ color: 'var(--ok)' }} />}
        {available === false && <AlertCircle size={14} style={{ color: 'var(--warn)' }} />}
        <div>
          <strong>Windows Sandbox</strong>
          {available === true && <span style={{ color: 'var(--ok)' }}> — available</span>}
          {available === false && <span style={{ color: 'var(--warn)' }}> — not enabled on this PC</span>}
          {available === null && <span> — checking…</span>}
        </div>
      </div>

      {available === false && (
        <div className="sandbox-instructions">
          <div className="sandbox-instructions-title">How to enable Windows Sandbox</div>
          <ol>
            <li>Requires <strong>Windows 10/11 Pro, Enterprise, or Education</strong> (Home edition doesn't support it).</li>
            <li>Open <strong>Settings → Apps → Optional features → More Windows features</strong>.</li>
            <li>Check <strong>Windows Sandbox</strong> and click OK.</li>
            <li>Restart your PC when prompted.</li>
            <li>Reopen ClawCode → Settings → Sandbox.</li>
          </ol>
          <div className="sandbox-note">
            Alternative: <strong>Sandboxie-Plus</strong> (free, works on Home edition) or a <strong>VM</strong> (Hyper-V, VirtualBox, VMware).
          </div>
        </div>
      )}

      {/* Configuration */}
      <div className="form-row">
        <label className="form-label">Workspace to map (read-write)</label>
        <input
          type="text"
          value={workspace}
          readOnly
          placeholder="Open a workspace first"
          className="form-input mono"
        />
        <div className="form-hint">
          The agent will only be able to touch files inside this folder. Everything else on your PC is invisible to the sandbox.
        </div>
      </div>

      <div className="form-row">
        <label className="form-label">Options</label>
        <div className="sandbox-options">
          <label className="sandbox-option">
            <input type="checkbox" checked={persistUserData} onChange={(e) => setPersistUserData(e.target.checked)} />
            <Shield size={12} />
            <span>Persist settings + skills + models + webchat logins across sandbox launches</span>
          </label>
          <label className="sandbox-option">
            <input type="checkbox" checked={enableNetworking} onChange={(e) => setEnableNetworking(e.target.checked)} />
            <Network size={12} />
            <span>Enable networking (required for API calls + webchats + model downloads)</span>
          </label>
          <label className="sandbox-option">
            <input type="checkbox" checked={enableGpu} onChange={(e) => setEnableGpu(e.target.checked)} />
            <Cpu size={12} />
            <span>Enable GPU passthrough (required for local model inference — Ollama, LM Studio)</span>
          </label>
          <label className="sandbox-option">
            <input type="checkbox" checked={enableClipboard} onChange={(e) => setEnableClipboard(e.target.checked)} />
            <Clipboard size={12} />
            <span>Enable clipboard sharing with host (copy-paste between ClawCode and your PC)</span>
          </label>
        </div>
      </div>

      {/* Actions */}
      <div className="sandbox-actions">
        <button
          className="btn primary"
          onClick={launch}
          disabled={launching || !workspace || available === false}
          title={!workspace ? 'Open a workspace first' : available === false ? 'Sandbox not enabled' : ''}
        >
          {launching ? <Loader2 size={12} className="spin" /> : <Play size={12} />}
          Launch in Sandbox
        </button>
        <button className="btn ghost" onClick={generate} disabled={!workspace}>
          <FileText size={12} /> Generate .wsb file
        </button>
        {wsbPath && (
          <button className="btn ghost" onClick={openWsb} title={`Open ${wsbPath}`}>
            <FolderOpen size={12} /> Open .wsb
          </button>
        )}
      </div>

      {launchMsg && <div className="sandbox-msg">{launchMsg}</div>}

      {/* What this protects against */}
      <div className="sandbox-protection">
        <div className="sandbox-protection-title">
          <Shield size={12} /> What sandboxing protects against
        </div>
        <ul>
          <li><strong>Malicious code execution</strong> — if the agent runs a destructive shell command, it only affects the sandbox VM, not your real PC.</li>
          <li><strong>Filesystem damage</strong> — only the mapped workspace folder is writable. Your system files, documents, etc. are invisible.</li>
          <li><strong>Network exfiltration</strong> — disable networking to air-gap the agent entirely.</li>
          <li><strong>Persistence</strong> — when the sandbox closes, all installed software, registry changes, and files inside the VM are destroyed (except the mapped folders).</li>
          <li><strong>Credential leakage</strong> — API keys stored in ClawCode's userData stay isolated to the sandbox's view of that folder.</li>
        </ul>
      </div>

      {/* Generated .wsb preview */}
      {wsbContent && (
        <details className="sandbox-wsb-preview">
          <summary>View generated .wsb config</summary>
          <pre className="mono">{wsbContent}</pre>
        </details>
      )}
    </div>
  );
}
