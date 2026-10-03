import { FolderOpen, Settings, Plus, Sparkles, Minus, Square, X } from 'lucide-react';
import { useClaw } from '../lib/store';
import { useState } from 'react';
import ConfirmDialog from './ConfirmDialog';

export default function TopBar() {
  const workspace = useClaw((s) => s.workspace);
  const isStreaming = useClaw((s) => s.isStreaming);
  const setShowSettings = useClaw((s) => s.setShowSettings);
  const config = useClaw((s) => s.config);
  const messages = useClaw((s) => s.messages);
  const [confirmNewChat, setConfirmNewChat] = useState(false);

  const pickWorkspace = async () => {
    const res = await window.claw.workspace.pick();
    if (res.ok && res.workspace) {
      useClaw.getState().setWorkspace(res.workspace);
      await useClaw.getState().refreshFiles();
    }
  };

  const newChat = () => {
    if (messages.length > 0) {
      setConfirmNewChat(true);
    } else {
      useClaw.setState({ messages: [], pendingDiffs: [], plan: [] });
    }
  };

  return (
    <>
      <div className="topbar">
        <div className="topbar-left">
          <div className="topbar-logo">
            <div className="topbar-logo-mark">C</div>
            <span>ClawCode</span>
          </div>
        </div>

        <div className="topbar-spacer" />

        <div className="topbar-right">
          <button className="topbar-btn" onClick={pickWorkspace} data-tooltip="Open workspace folder" aria-label="Open folder">
            <FolderOpen size={13} />
            <span>Open Folder</span>
          </button>
          <div className="topbar-workspace" title={workspace} aria-label={`Workspace: ${workspace || 'none'}`}>
            <div className={`topbar-status-dot ${isStreaming ? 'streaming' : workspace ? 'ready' : ''}`} role="status" aria-label={isStreaming ? 'streaming' : workspace ? 'ready' : 'no workspace'} />
            <span>{workspace || 'no workspace'}</span>
          </div>
          <button className="topbar-btn" onClick={newChat} data-tooltip="New chat (clears conversation)" aria-label="New chat">
            <Plus size={13} />
          </button>
          <button className="topbar-btn" onClick={() => setShowSettings(true)} data-tooltip="Settings" aria-label="Settings">
            <Settings size={13} />
          </button>

          {/* Window controls (Windows only — macOS uses hiddenInset) */}
          {window.claw.platform === 'win32' && (
            <div className="window-controls">
              <button className="window-control" onClick={() => window.claw.app.minimize?.()} aria-label="Minimize">
                <Minus size={14} />
              </button>
              <button className="window-control" onClick={() => window.claw.app.maximize?.()} aria-label="Maximize">
                <Square size={11} />
              </button>
              <button className="window-control close" onClick={() => window.claw.app.close?.()} aria-label="Close">
                <X size={14} />
              </button>
            </div>
          )}
        </div>
      </div>

      {confirmNewChat && (
        <ConfirmDialog
          message="Start a new chat?"
          detail="This will clear the current conversation and plan. This cannot be undone."
          confirmLabel="New Chat"
          danger
          onConfirm={() => {
            useClaw.setState({ messages: [], pendingDiffs: [], plan: [] });
            setConfirmNewChat(false);
          }}
          onCancel={() => setConfirmNewChat(false)}
        />
      )}
    </>
  );
}
