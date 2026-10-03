import { useEffect, useState, useMemo } from 'react';
import { useClaw } from '../lib/store';
import type { AppInfo } from '../types';

export default function StatusBar() {
  const workspace = useClaw((s) => s.workspace);
  const isStreaming = useClaw((s) => s.isStreaming);
  const messages = useClaw((s) => s.messages);
  const config = useClaw((s) => s.config);
  const activeAccountId = useClaw((s) => s.activeAccountId);
  const accounts = useClaw((s) => s.accounts);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [usage, setUsage] = useState<{ used: number; limit: number; percent: number; status: string } | null>(null);

  useEffect(() => {
    window.claw.app.info().then(setInfo);
  }, []);

  // Fetch usage info for active account
  useEffect(() => {
    if (activeAccountId) {
      window.claw.accounts.usage(activeAccountId).then(setUsage);
      const interval = setInterval(() => {
        window.claw.accounts.usage(activeAccountId).then(setUsage);
      }, 5000);
      return () => clearInterval(interval);
    } else {
      setUsage(null);
    }
  }, [activeAccountId]);

  const toolCallCount = messages.reduce(
    (acc, m) => acc + (m.tool_calls?.length ?? 0),
    0
  );

  // Rough context estimation: ~4 chars per token
  const contextChars = useMemo(() => {
    return messages.reduce((acc, m) => {
      const content = typeof m.content === 'string' ? m.content : '';
      const toolCalls = m.tool_calls ? JSON.stringify(m.tool_calls).length : 0;
      return acc + content.length + toolCalls;
    }, 0);
  }, [messages]);

  const contextTokens = Math.round(contextChars / 4);
  const contextMax = 128000; // default assumption
  const contextPercent = Math.min(100, Math.round((contextTokens / contextMax) * 100));
  const contextColor = contextPercent > 80 ? 'err' : contextPercent > 60 ? 'warn' : '';

  const activeAccount = accounts.find((a) => a.id === activeAccountId);

  return (
    <div className="statusbar">
      <div className="statusbar-item">
        <span style={{ color: isStreaming ? 'var(--accent-bright)' : 'var(--fg-3)' }}>●</span>
        <span>{isStreaming ? 'streaming' : 'idle'}</span>
      </div>
      <div className="statusbar-item">
        <span>{messages.length} msgs</span>
      </div>
      <div className="statusbar-item">
        <span>{toolCallCount} tools</span>
      </div>

      {/* Context window indicator */}
      <div className="statusbar-context" title={`~${contextTokens.toLocaleString()} tokens estimated`}>
        <span>ctx</span>
        <div className="context-bar" title={`${contextTokens} / ${contextMax.toLocaleString()} tokens`}>
          <div className={`context-bar-fill ${contextColor}`} style={{ width: `${contextPercent}%` }} />
        </div>
        <span className="muted">{contextPercent}%</span>
      </div>

      {/* Account usage (if using webchat accounts) */}
      {usage && activeAccount && (
        <div className="statusbar-context" title={`${activeAccount.label}: ${usage.used}/${usage.limit} messages`}>
          <span>{activeAccount.label}</span>
          <div className="context-bar" title={`${usage.used}/${usage.limit} msgs`}>
            <div
              className={`context-bar-fill ${usage.status === 'exhausted' ? 'err' : usage.status === 'cooling' ? 'warn' : ''}`}
              style={{ width: `${usage.percent}%` }}
            />
          </div>
          <span className="muted">{usage.used}/{usage.limit}</span>
        </div>
      )}

      <div className="statusbar-spacer" />
      <div className="statusbar-item">
        <span>{config?.model || 'no model'}</span>
      </div>
      <div className="statusbar-item">
        <span>{info ? `v${info.version}` : ''}</span>
      </div>
    </div>
  );
}
