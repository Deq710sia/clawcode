import { useEffect, useRef, useState, useCallback } from 'react';
import { ChevronDown, Code2, Bug, FileSearch, FolderOpen, Plus } from 'lucide-react';
import { useClaw } from '../lib/store';
import Message from './Message';
import MessageInput from './MessageInput';
import PlanPanel from './PlanPanel';
import AccountSwitcher from './AccountSwitcher';
import ModelPicker from './ModelPicker';

const SUGGESTIONS = [
  { icon: FileSearch, title: 'Explore this codebase', sub: 'Walk me through the project structure' },
  { icon: Bug, title: 'Find & fix a bug', sub: 'Describe a symptom, I\'ll diagnose it' },
  { icon: Code2, title: 'Add a feature', sub: 'Describe what you want to build' },
  { icon: FolderOpen, title: 'Refactor a module', sub: 'Point me at files to improve' },
];

export default function ChatPanel() {
  const messages = useClaw((s) => s.messages);
  const workspace = useClaw((s) => s.workspace);
  const sendUserMessage = useClaw((s) => s.sendUserMessage);
  const startNewConversation = useClaw((s) => s.startNewConversation);
  const conversationTitle = useClaw((s) => s.conversationTitle);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);

  const isNearBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 100;
  }, []);

  const handleScroll = useCallback(() => {
    const nearBottom = isNearBottom();
    setAutoScroll(nearBottom);
    setShowScrollBtn(!nearBottom && messages.length > 0);
  }, [isNearBottom, messages.length]);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, autoScroll]);

  const scrollToBottom = () => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      setAutoScroll(true);
      setShowScrollBtn(false);
    }
  };

  const onSuggestion = (text: string) => {
    if (workspace) sendUserMessage(text);
  };

  const handleNewChat = () => {
    startNewConversation();
  };

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <div className="chat-header-title">
          <span className="chat-header-label">{conversationTitle || 'New Chat'}</span>
        </div>
        <div className="chat-header-actions">
          {workspace && (
            <span className="mono tiny muted" style={{ marginRight: 6 }}>
              {workspace.split(/[\\/]/).pop()}
            </span>
          )}
          <ModelPicker />
          <AccountSwitcher />
          <button
            className="chat-header-btn primary"
            onClick={handleNewChat}
            data-tooltip="New conversation"
            aria-label="New conversation"
          >
            <Plus size={13} />
            <span>New</span>
          </button>
        </div>
      </div>

      <div className="chat-messages" ref={scrollRef} onScroll={handleScroll}>
        {messages.length === 0 ? (
          <div className="chat-empty">
            <div className="chat-empty-icon">C</div>
            <div className="chat-empty-title">ClawCode</div>
            <div className="chat-empty-sub">
              Open a folder, then ask me to explore, build, or fix something — I'll call tools to read, edit, and run code in your workspace.
            </div>
            {workspace ? (
              <div className="chat-empty-suggestions">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s.title}
                    className="suggestion-card"
                    onClick={() => onSuggestion(s.title)}
                  >
                    <div className="row" style={{ marginBottom: 4 }}>
                      <s.icon size={14} style={{ color: 'var(--accent-bright)' }} />
                      <div className="suggestion-card-title">{s.title}</div>
                    </div>
                    <div className="suggestion-card-sub">{s.sub}</div>
                  </button>
                ))}
              </div>
            ) : (
              <button className="btn primary" style={{ marginTop: 12 }} onClick={async () => { const r = await window.claw.workspace.pick(); if (r.ok && r.workspace) useClaw.getState().setWorkspace(r.workspace); }}>
                <FolderOpen size={12} /> Open a workspace to get started
              </button>
            )}
          </div>
        ) : (
          <>
            <PlanPanel />
            {messages.map((m) => <Message key={m.id} msg={m} />)}
          </>
        )}
      </div>

      {showScrollBtn && (
        <button className="scroll-to-bottom" onClick={scrollToBottom} aria-label="Scroll to latest">
          <ChevronDown size={16} />
        </button>
      )}

      <MessageInput />
    </div>
  );
}
