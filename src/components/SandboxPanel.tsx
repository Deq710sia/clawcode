import { useState, useEffect } from 'react';
import { Shield, Loader2, AlertCircle, CheckCircle2, Cpu, Network, Clipboard, HardDrive, FolderOpen, Play, FileText, Lock, Unlock, Trash2, ShieldCheck } from 'lucide-react';
import { useClaw } from '../lib/store';
import type { ProcessSandboxStatus } from '../types';

export default function SandboxPanel() {
  const workspace = useClaw((s) => s.workspace);
  const [vmAvailable, setVmAvailable] = useState<boolean | null>(null);
  const [persistUserData, setPersistUserData] = useState(true);
  const [enableNetworking, setEnableNetworking] = useState(true);
  const [enableGpu, setEnableGpu] = useState(true);
  const [enableClipboard, setEnableClipboard] = useState(true);
  const [wsbContent, setWsbContent] = useState<string>('');
  const [wsbPath, setWsbPath] = useState('');
  const [launching, setLaunching] = useState(false);
  const [launchMsg, setLaunchMsg] = useState('');

  // Process sandbox state
  const [psStatus, setPsStatus] = useState<ProcessSandboxStatus | null>(null);
  const [denyNetwork, setDenyNetwork] = useState(false);
  const [psBusy, setPsBusy] = useState(false);
  const [psMsg, setPsMsg] = useState('');

  const refreshPsStatus = async () => {
    const s = await window.claw.psandbox.status();
    setPsStatus(s);
    setDenyNetwork(s.denyNetwork);
  };

  useEffect(() => {
    window.claw.sandbox.available().then(setVmAvailable);
    refreshPsStatus();
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

  const setupPsandbox = async () => {
    if (!workspace) {
      setPsMsg('Open a workspace first.');
      return;
    }
    if (!psStatus?.elevated) {
      setPsMsg('Admin rights required. Relaunch ClawCode as administrator (right-click → Run as administrator).');
      return;
    }
    setPsBusy(true);
    setPsMsg('Setting up sandbox user + ACLs…');
    const res = await window.claw.psandbox.setup({ workspacePath: workspace, denyNetwork });
    if (res.ok) {
      setPsMsg('✓ Process sandbox enabled. All agent shell commands now run as the restricted "ClawCodeSandbox" user.');
    } else {
      setPsMsg(`✗ ${res.error}`);
    }
    setPsBusy(false);
    refreshPsStatus();
  };

  const disablePsandbox = async () => {
    setPsBusy(true);
    const res = await window.claw.psandbox.disable();
    setPsMsg(res.ok ? 'Process sandbox disabled. Commands run as your normal user again.' : `Failed: ${res.error}`);
    setPsBusy(false);
    refreshPsStatus();
  };

  const teardownPsandbox = async () => {
    if (!confirm('Remove the ClawCodeSandbox user entirely? This deletes the user account + ACLs + firewall rules. Requires admin.')) return;
    setPsBusy(true);
    const res = await window.claw.psandbox.teardown();
    setPsMsg(res.ok ? '✓ Sandbox user removed.' : `Failed: ${res.error}`);
    setPsBusy(false);
    refreshPsStatus();
  };

  return (
    <div className="sandbox-panel">
      {/* Process Sandbox (Codex-style) — recommended */}
      <div className="sandbox-section-title">
        <ShieldCheck size={14} style={{ color: 'var(--ok)' }} />
        <span>Process Sandbox</span>
        <span className="sandbox-section-tag recommended">Recommended · seamless</span>
      </div>
      <div className="form-hint" style={{ marginBottom: 12 }}>
        Runs the agent's shell commands as a restricted local user ("ClawCodeSandbox") that only has filesystem write access to your workspace. Same approach OpenAI Codex uses on Windows. No VM, no startup delay — every <code className="mono">run_command</code> call is transparently sandboxed.
      </div>

      {/* Status badges */}
      {psStatus && (
        <div className="psandbox-status-grid">
          <div className={`psandbox-badge ${psStatus.elevated ? 'ok' : 'warn'}`}>
            {psStatus.elevated ? <Lock size={11} /> : <Unlock size={11} />}
            <span>{psStatus.elevated ? 'Running as admin' : 'Not admin'}</span>
          </div>
          <div className={`psandbox-badge ${psStatus.userExists ? 'ok' : 'muted'}`}>
            <Cpu size={11} />
            <span>{psStatus.userExists ? 'User exists' : 'User not created'}</span>
          </div>
          <div className={`psandbox-badge ${psStatus.enabled ? 'ok' : 'muted'}`}>
            <Shield size={11} />
            <span>{psStatus.enabled ? 'Enabled' : 'Disabled'}</span>
          </div>
          <div className={`psandbox-badge ${psStatus.denyNetwork ? 'warn' : 'ok'}`}>
            <Network size={11} />
            <span>{psStatus.denyNetwork ? 'Network blocked' : 'Network allowed'}</span>
          </div>
        </div>
      )}

      {/* Workspace */}
      <div className="form-row">
        <label className="form-label">Workspace to sandbox</label>
        <input type="text" value={workspace} readOnly placeholder="Open a workspace first" className="form-input mono" />
        <div className="form-hint">
          The sandbox user only has write access to this folder + temp. Everything else on your PC is denied.
        </div>
      </div>

      {/* Network option */}
      <div className="form-row">
        <label className="sandbox-option">
          <input type="checkbox" checked={denyNetwork} onChange={(e) => setDenyNetwork(e.target.checked)} disabled={!psStatus?.elevated || psBusy} />
          <Network size={12} />
          <span>Deny network access to sandbox user (via Windows Firewall) — air-gap the agent</span>
        </label>
      </div>

      {/* Actions */}
      <div className="sandbox-actions">
        {!psStatus?.enabled ? (
          <button className="btn primary" onClick={setupPsandbox} disabled={psBusy || !workspace || !psStatus?.elevated}>
            {psBusy ? <Loader2 size={12} className="spin" /> : <ShieldCheck size={12} />}
            Enable Process Sandbox
          </button>
        ) : (
          <>
            <button className="btn ghost" onClick={disablePsandbox} disabled={psBusy}>
              <Unlock size={12} /> Disable (run as normal user)
            </button>
            <button className="btn danger" onClick={teardownPsandbox} disabled={psBusy || !psStatus?.elevated}>
              <Trash2 size={12} /> Remove sandbox user
            </button>
          </>
        )}
      </div>

      {!psStatus?.elevated && (
        <div className="sandbox-msg warn">
          ⚠ Admin rights required to create the sandbox user. Close ClawCode, right-click the .exe → "Run as administrator", then try again.
        </div>
      )}

      {psMsg && <div className="sandbox-msg">{psMsg}</div>}

      {/* What it protects against */}
      <div className="sandbox-protection">
        <div className="sandbox-protection-title">
          <Shield size={12} /> What the process sandbox blocks
        </div>
        <ul>
          <li><strong>Filesystem damage</strong> — sandbox user can only write to your workspace + temp. System files, user documents, other projects are all denied.</li>
          <li><strong>Malicious commands</strong> — if the agent runs <code className="mono">rm -rf /</code> or a destructive PowerShell cmdlet, it only has access to the workspace.</li>
          <li><strong>Network exfiltration</strong> — enable "Deny network" to block all outbound traffic from sandboxed commands.</li>
          <li><strong>Credential theft</strong> — sandbox user has no access to your browser cookies, SSH keys, or other user profiles.</li>
          <li><strong>Persistence</strong> — sandbox user cannot install software system-wide or modify startup items.</li>
        </ul>
      </div>

      <hr className="sandbox-divider" />

      {/* Windows Sandbox (VM-based) — maximum isolation */}
      <div className="sandbox-section-title">
        <HardDrive size={14} style={{ color: 'var(--accent-bright)' }} />
        <span>Windows Sandbox (full VM)</span>
        <span className="sandbox-section-tag">Maximum isolation</span>
      </div>
      <div className="form-hint" style={{ marginBottom: 12 }}>
        Launches the entire ClawCode app inside a disposable Windows Sandbox VM. Strongest isolation but slower to start. Requires Windows 10/11 Pro+.
      </div>

      <div className={`sandbox-status ${vmAvailable === false ? 'unavailable' : vmAvailable ? 'available' : ''}`}>
        {vmAvailable === null && <Loader2 size={14} className="spin" />}
        {vmAvailable === true && <CheckCircle2 size={14} style={{ color: 'var(--ok)' }} />}
        {vmAvailable === false && <AlertCircle size={14} style={{ color: 'var(--warn)' }} />}
        <div>
          <strong>Windows Sandbox</strong>
          {vmAvailable === true && <span style={{ color: 'var(--ok)' }}> — available</span>}
          {vmAvailable === false && <span style={{ color: 'var(--warn)' }}> — not enabled</span>}
        </div>
      </div>

      {vmAvailable === false && (
        <div className="sandbox-instructions">
          <div className="sandbox-instructions-title">How to enable Windows Sandbox</div>
          <ol>
            <li>Requires <strong>Windows 10/11 Pro, Enterprise, or Education</strong>.</li>
            <li>Open <strong>Settings → Apps → Optional features → More Windows features</strong>.</li>
            <li>Check <strong>Windows Sandbox</strong> and click OK. Restart when prompted.</li>
          </ol>
        </div>
      )}

      <div className="form-row">
        <label className="sandbox-option">
          <input type="checkbox" checked={persistUserData} onChange={(e) => setPersistUserData(e.target.checked)} />
          <Shield size={12} />
          <span>Persist settings/skills/models across sandbox launches</span>
        </label>
        <label className="sandbox-option">
          <input type="checkbox" checked={enableNetworking} onChange={(e) => setEnableNetworking(e.target.checked)} />
          <Network size={12} />
          <span>Enable networking (required for API + webchats)</span>
        </label>
        <label className="sandbox-option">
          <input type="checkbox" checked={enableGpu} onChange={(e) => setEnableGpu(e.target.checked)} />
          <Cpu size={12} />
          <span>Enable GPU passthrough (for local model inference)</span>
        </label>
        <label className="sandbox-option">
          <input type="checkbox" checked={enableClipboard} onChange={(e) => setEnableClipboard(e.target.checked)} />
          <Clipboard size={12} />
          <span>Enable clipboard sharing with host</span>
        </label>
      </div>

      <div className="sandbox-actions">
        <button className="btn primary" onClick={launch} disabled={launching || !workspace || vmAvailable === false}>
          {launching ? <Loader2 size={12} className="spin" /> : <Play size={12} />}
          Launch in Windows Sandbox
        </button>
        <button className="btn ghost" onClick={generate} disabled={!workspace}>
          <FileText size={12} /> Generate .wsb file
        </button>
        {wsbPath && (
          <button className="btn ghost" onClick={openWsb}>
            <FolderOpen size={12} /> Open .wsb
          </button>
        )}
      </div>

      {launchMsg && <div className="sandbox-msg">{launchMsg}</div>}

      {wsbContent && (
        <details className="sandbox-wsb-preview">
          <summary>View generated .wsb config</summary>
          <pre className="mono">{wsbContent}</pre>
        </details>
      )}
    </div>
  );
}
