import { useEffect, useState } from 'react';
import { useClaw } from '../lib/store';
import type { AppInfo } from '../types';

export default function StatusBar() {
  const workspace = useClaw((s) => s.workspace);
  const isStreaming = useClaw((s) => s.isStreaming);
  const messages = useClaw((s) => s.messages);
  const config = useClaw((s) => s.config);
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    window.claw.app.info().then(setInfo);
  }, []);

  const toolCallCount = messages.reduce(
    (acc, m) => acc + (m.tool_calls?.length ?? 0),
    0
  );

  return (
    <div className="statusbar">
      <div className="statusbar-item">
        <span style={{ color: 'var(--accent-bright)' }}>●</span>
        <span>{isStreaming ? 'streaming' : 'idle'}</span>
      </div>
      <div className="statusbar-item">
        <span>{messages.length} msgs</span>
      </div>
      <div className="statusbar-item">
        <span>{toolCallCount} tool calls</span>
      </div>
      <div className="statusbar-spacer" />
      <div className="statusbar-item">
        <span>{config?.model || 'no model'}</span>
      </div>
      <div className="statusbar-item">
        <span>{info ? `ClawCode ${info.version}` : ''}</span>
      </div>
      <div className="statusbar-item">
        <span>{info ? `${info.platform} · ${info.arch}` : ''}</span>
      </div>
    </div>
  );
}
