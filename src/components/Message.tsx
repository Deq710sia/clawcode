import { useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ChevronRight,
  FileText,
  ListTree,
  Pencil,
  Play,
  Save,
  Trash2,
  ArrowRight,
  Terminal,
  Search,
  ListChecks,
  Copy,
  Check,
  Brain,
  GitBranch,
} from 'lucide-react';
import type { ChatMessage, ToolCall } from '../types';


/** Collapsible reasoning block. Open while streaming with no answer yet, collapsed once the answer starts. */
function ThinkingBlock({ text, live }: { text: string; live: boolean }) {
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const open = userToggled ?? live;
  return (
    <div className="thinking-block">
      <button className="thinking-toggle" onClick={() => setUserToggled(!open)} aria-expanded={open}>
        <ChevronRight size={11} className={open ? 'rot90' : ''} />
        <Brain size={11} />
        {live ? 'Thinking…' : 'Thought process'}
      </button>
      {open && <div className="thinking-body">{text}</div>}
    </div>
  );
}

/** Copy button for code blocks — appears on hover. */
function CodeBlockCopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(() => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [code]);
  return (
    <button
      className={`code-block-copy ${copied ? 'copied' : ''}`}
      onClick={onCopy}
      aria-label={copied ? 'Copied' : 'Copy code'}
    >
      {copied ? <Check size={10} /> : <Copy size={10} />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

/** Wrap <pre> in a div with a copy button. */
function PreWithCopy({ children, ...props }: any) {
  // Extract text content from the <code> child for copying
  let codeText = '';
  if (children?.props?.children) {
    codeText = typeof children.props.children === 'string'
      ? children.props.children
      : Array.isArray(children.props.children)
        ? children.props.children.join('')
        : String(children.props.children ?? '');
  }
  return (
    <div className="code-block-wrapper">
      <CodeBlockCopyButton code={codeText} />
      <pre {...props}>{children}</pre>
    </div>
  );
}

function ToolIcon({ name }: { name: string }) {
  const map: Record<string, any> = {
    list_files: ListTree,
    read_file: FileText,
    write_file: Save,
    edit_file: Pencil,
    run_command: Play,
    git: GitBranch,
    delete_file: Trash2,
    move_file: ArrowRight,
    update_plan: ListChecks,
    web_search: Search,
  };
  const I = map[name] ?? Terminal;
  return <I size={12} />;
}

function argsPreview(name: string, args: Record<string, any>): string {
  if (name === 'list_files') return args.path ?? '.';
  if (name === 'read_file' || name === 'delete_file') return args.path ?? '';
  if (name === 'write_file') return args.path ?? '';
  if (name === 'edit_file') return `${args.path} · ${args.replacements?.length ?? 0} edits`;
  if (name === 'git') return `${args.subcommand ?? ''} ${(args.args ?? []).join(' ')}`.trim().slice(0, 80);
  if (name === 'run_command') return (args.command ?? '').slice(0, 80);
  if (name === 'move_file') return `${args.from} → ${args.to}`;
  if (name === 'update_plan') return `${args.items?.length ?? 0} items`;
  if (name === 'web_search') return args.query ?? '';
  return JSON.stringify(args).slice(0, 80);
}

function ToolCallCardView({ tc }: { tc: ToolCall }) {
  const [open, setOpen] = useState(false);

  const statusText =
    tc.state === 'running' ? 'running' :
    tc.state === 'done' ? 'ok' :
    tc.state === 'error' ? 'error' : 'pending';

  return (
    <div className={`tool-call-card ${open ? 'open' : ''}`}>
      <div className="tool-call-header" onClick={() => setOpen((v) => !v)}>
        <ChevronRight className="tool-call-chevron" size={10} />
        <div className="tool-call-icon"><ToolIcon name={tc.name} /></div>
        <div className="tool-call-name">{tc.name}</div>
        <div className="tool-call-args-preview">{argsPreview(tc.name, tc.args)}</div>
        <div className="tool-call-spacer" />
        <div className={`tool-call-status ${tc.state}`}>
          <div className="dot" />
          <span>{statusText}</span>
        </div>
      </div>
      {open && (
        <div className="tool-call-body">
          <div className="tool-call-section">
            <div className="tool-call-section-label">Arguments</div>
            <pre className="tool-call-args">{JSON.stringify(tc.args, null, 2)}</pre>
          </div>
          {tc.result !== undefined && (
            <div className="tool-call-section">
              <div className="tool-call-section-label">Result</div>
              <pre className="tool-call-args">{JSON.stringify(tc.result, null, 2)}</pre>
            </div>
          )}
          {tc.error && (
            <div className="tool-call-section">
              <div className="tool-call-section-label">Error</div>
              <pre className="tool-call-args" style={{ color: 'var(--err)' }}>{tc.error}</pre>
            </div>
          )}
          {tc.name === 'edit_file' && tc.result?.diff && (
            <div className="tool-call-section">
              <div className="tool-call-section-label">Diff</div>
              <DiffView diff={tc.result.diff} path={tc.args.path} />
            </div>
          )}
          {tc.name === 'run_command' && tc.result && (
            <div className="tool-call-section">
              <div className="tool-call-section-label">stdout</div>
              <pre className="tool-call-args">{(tc.result.stdout || '(empty)').slice(0, 4000)}</pre>
              {tc.result.stderr && (
                <>
                  <div className="tool-call-section-label" style={{ marginTop: 8, color: 'var(--err)' }}>stderr</div>
                  <pre className="tool-call-args" style={{ color: 'var(--err)' }}>{tc.result.stderr.slice(0, 4000)}</pre>
                </>
              )}
              <div className="tiny muted" style={{ marginTop: 4 }}>
                exit code: <span className="mono">{tc.result.exitCode ?? 'n/a'}</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DiffView({ diff, path }: { diff: string; path: string }) {
  const lines = diff.split('\n');
  return (
    <div className="diff-viewer">
      <div className="diff-header">
        <Pencil size={12} style={{ color: 'var(--accent-bright)' }} />
        <span className="diff-header-path">{path}</span>
      </div>
      <div className="diff-body">
        {lines.map((line, i) => {
          let cls = 'context';
          let marker = ' ';
          if (line.startsWith('+++') || line.startsWith('---')) { cls = 'meta'; marker = ''; }
          else if (line.startsWith('@@')) { cls = 'meta'; marker = ''; }
          else if (line.startsWith('+')) { cls = 'added'; marker = '+'; }
          else if (line.startsWith('-')) { cls = 'removed'; marker = '-'; }
          return (
            <div key={i} className={`diff-line ${cls}`}>
              <span className="diff-line-marker">{marker}</span>
              <span>{line}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Avatar({ role }: { role: ChatMessage['role'] }) {
  if (role === 'user') return <div className="message-avatar">U</div>;
  if (role === 'assistant') return <div className="message-avatar">C</div>;
  return <div className="message-avatar"><Terminal size={13} /></div>;
}

export default function Message({ msg }: { msg: ChatMessage }) {
  if (msg.role === 'tool') {
    // Tool result messages render as compact inline cards attached to the parent assistant message.
    // We don't render them as standalone messages because the ToolCall card already shows the result.
    return null;
  }

  return (
    <div className={`message ${msg.role}`}>
      <Avatar role={msg.role} />
      <div className="message-body">
        <div className="message-role">
          {msg.role === 'assistant' ? 'ClawCode' : msg.role === 'user' ? 'You' : msg.role}
        </div>
        {msg.reasoning && <ThinkingBlock text={msg.reasoning} live={!!msg.streaming && !msg.content} />}
        {msg.content && (
          <div className="message-content">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ pre: PreWithCopy }}>{msg.content}</ReactMarkdown>
            {msg.streaming && <span className="streaming-cursor" />}
          </div>
        )}
        {msg.tool_calls && msg.tool_calls.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {msg.tool_calls.map((tc) => (
              <ToolCallCardView key={tc.id} tc={tc} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
