import { useEffect, useRef } from 'react';
import { Sparkles, FolderOpen, Code2, Bug, FileSearch } from 'lucide-react';
import { useClaw } from '../lib/store';
import Message from './Message';
import MessageInput from './MessageInput';
import PlanPanel from './PlanPanel';

const SUGGESTIONS = [
  { icon: FileSearch, title: 'Explore this codebase', sub: 'Walk me through the project structure' },
  { icon: Bug, title: 'Find & fix a bug', sub: 'Describe a symptom, I\'ll diagnose it' },
  { icon: Code2, title: 'Add a feature', sub: 'Describe what you want to build' },
  { icon: FolderOpen, title: 'Refactor a module', sub: 'Point me at files to improve' },
];

export default function ChatPanel() {
  const messages = useClaw((s) => s.messages);
  const config = useClaw((s) => s.config);
  const workspace = useClaw((s) => s.workspace);
  const sendUserMessage = useClaw((s) => s.sendUserMessage);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const onSuggestion = (text: string) => {
    if (workspace) sendUserMessage(text);
  };

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <div className="chat-header-title">
          <span>Chat</span>
          {config?.model && <span className="chat-header-model">{config.model}</span>}
        </div>
        <div className="row tiny muted">
          {workspace ? (
            <span className="mono">{workspace.split(/[\\/]/).pop()}</span>
          ) : (
            <span>no workspace</span>
          )}
        </div>
      </div>

      <div className="chat-messages" ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="chat-empty">
            <div className="chat-empty-icon">C</div>
            <div className="chat-empty-title">ClawCode</div>
            <div className="chat-empty-sub">
              A clean-room agentic coding harness. Open a folder, then ask me to explore, build, or fix something — I'll call tools to read, edit, and run code in your workspace.
            </div>
            <div className="chat-empty-suggestions">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s.title}
                  className="suggestion-card"
                  onClick={() => onSuggestion(s.title)}
                  disabled={!workspace}
                >
                  <div className="row" style={{ marginBottom: 4 }}>
                    <s.icon size={14} style={{ color: 'var(--accent-bright)' }} />
                    <div className="suggestion-card-title">{s.title}</div>
                  </div>
                  <div className="suggestion-card-sub">{s.sub}</div>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            <PlanPanel />
            {messages.map((m) => <Message key={m.id} msg={m} />)}
          </>
        )}
      </div>

      <MessageInput />
    </div>
  );
}
