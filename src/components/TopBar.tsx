import { FolderOpen, Settings, Plus, Sparkles } from 'lucide-react';
import { useClaw } from '../lib/store';

export default function TopBar() {
  const workspace = useClaw((s) => s.workspace);
  const isStreaming = useClaw((s) => s.isStreaming);
  const setShowSettings = useClaw((s) => s.setShowSettings);
  const config = useClaw((s) => s.config);

  const pickWorkspace = async () => {
    const res = await window.claw.workspace.pick();
    if (res.ok && res.workspace) {
      useClaw.getState().setWorkspace(res.workspace);
      await useClaw.getState().refreshFiles();
    }
  };

  const newChat = () => {
    useClaw.setState({ messages: [], pendingDiffs: [] });
  };

  return (
    <div className="topbar">
      <div className="topbar-left">
        <div className="topbar-logo">
          <div className="topbar-logo-mark">C</div>
          <span>ClawCode</span>
        </div>
      </div>

      <div className="topbar-spacer" />

      <div className="topbar-right">
        <button className="topbar-btn" onClick={pickWorkspace} title="Open workspace">
          <FolderOpen size={13} />
          <span>Open Folder</span>
        </button>
        <div className="topbar-workspace" title={workspace}>
          <div className={`topbar-status-dot ${isStreaming ? 'streaming' : workspace ? 'ready' : ''}`} />
          <span>{workspace || 'no workspace'}</span>
        </div>
        <button className="topbar-btn" onClick={newChat} title="New chat">
          <Plus size={13} />
        </button>
        <button className="topbar-btn" onClick={() => setShowSettings(true)} title="Settings">
          <Settings size={13} />
        </button>
      </div>
    </div>
  );
}
