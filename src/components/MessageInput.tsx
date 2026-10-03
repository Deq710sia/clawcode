import { useEffect, useRef, useState, useMemo } from 'react';
import { ArrowUp, Square, Sparkles } from 'lucide-react';
import { useClaw } from '../lib/store';

export default function MessageInput() {
  const [text, setText] = useState('');
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashMenuIndex, setSlashMenuIndex] = useState(0);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const isStreaming = useClaw((s) => s.isStreaming);
  const queuedMessages = useClaw((s) => s.queuedMessages);
  const sendUserMessage = useClaw((s) => s.sendUserMessage);
  const stopStreaming = useClaw((s) => s.stopStreaming);
  const workspace = useClaw((s) => s.workspace);
  const installedSkills = useClaw((s) => s.installedSkills);
  const refreshInstalledSkills = useClaw((s) => s.refreshInstalledSkills);

  useEffect(() => {
    refreshInstalledSkills();
  }, [refreshInstalledSkills]);

  // All slash commands available from installed skills
  const slashCommands = useMemo(() => {
    const cmds: { name: string; skill: string; description: string }[] = [];
    for (const skill of installedSkills) {
      for (const cmd of skill.manifest?.commands ?? []) {
        cmds.push({
          name: cmd,
          skill: skill.name,
          description: skill.manifest?.description ?? '',
        });
      }
    }
    return cmds;
  }, [installedSkills]);

  // Show slash menu when text starts with /
  const slashQuery = useMemo(() => {
    if (!text.startsWith('/')) return null;
    const m = text.match(/^\/(\w*)$/);
    return m ? m[1] : '';
  }, [text]);

  const filteredCmds = useMemo(() => {
    if (slashQuery === null) return [];
    return slashCommands.filter((c) => c.name.toLowerCase().includes(slashQuery.toLowerCase())).slice(0, 6);
  }, [slashQuery, slashCommands]);

  useEffect(() => {
    setShowSlashMenu(filteredCmds.length > 0);
    setSlashMenuIndex(0);
  }, [filteredCmds]);

  useEffect(() => {
    if (taRef.current) {
      taRef.current.style.height = 'auto';
      taRef.current.style.height = Math.min(taRef.current.scrollHeight, 240) + 'px';
    }
  }, [text]);

  const submit = async () => {
    if (!text.trim()) return;
    if (!workspace) return;

    // Check for slash command
    if (text.startsWith('/')) {
      const m = text.match(/^\/(\w+)\s*(.*)$/);
      if (m) {
        const cmdName = m[1];
        const restText = m[2];
        const cmd = slashCommands.find((c) => c.name === cmdName);
        if (cmd) {
          const fragment = await window.claw.skills.fragment(cmd.skill);
          if (fragment) {
            // Inject the skill prompt fragment as a system-level instruction
            const fullText = restText
              ? `<skill:${cmd.skill}>\n${fragment}\n</skill:${cmd.skill}>\n\nUser request: ${restText}`
              : `<skill:${cmd.skill}>\n${fragment}\n</skill:${cmd.skill}>\n\nActivate this skill for the rest of the conversation.`;
            await sendUserMessage(fullText);
            setText('');
            return;
          }
        }
      }
    }

    await sendUserMessage(text.trim());
    setText('');
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Slash menu keyboard navigation
    if (showSlashMenu && filteredCmds.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashMenuIndex((i) => (i + 1) % filteredCmds.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashMenuIndex((i) => (i - 1 + filteredCmds.length) % filteredCmds.length);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        pickCommand(filteredCmds[slashMenuIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowSlashMenu(false);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
    if (e.key === 'Escape') {
      setShowSlashMenu(false);
    }
  };

  const pickCommand = (cmd: typeof slashCommands[number]) => {
    setText(`/${cmd.name} `);
    setShowSlashMenu(false);
    taRef.current?.focus();
  };

  return (
    <div className="composer">
      {queuedMessages.length > 0 && (
        <div className="composer-queue" role="status">
          {queuedMessages.length === 1 ? 'Queued' : `${queuedMessages.length} queued`}, delivered after the current step:{' '}
          <span className="mono">{queuedMessages[queuedMessages.length - 1].slice(0, 80)}</span>
        </div>
      )}
      <div className="composer-inner">
        <textarea
          ref={taRef}
          className="composer-textarea"
          placeholder={workspace ? 'Ask ClawCode to build, edit, or explain something…  (type / for skills)' : 'Open a workspace to start coding…'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={!workspace}
        />
        {showSlashMenu && (
          <div className="slash-menu">
            <div className="slash-menu-header">Skills</div>
            {filteredCmds.map((c, i) => (
              <button
                key={c.name + c.skill}
                className={`slash-menu-item ${i === slashMenuIndex ? 'active' : ''}`}
                onClick={() => pickCommand(c)}
                onMouseEnter={() => setSlashMenuIndex(i)}
              >
                <span className="slash-menu-cmd mono">/{c.name}</span>
                <span className="slash-menu-desc">{c.description}</span>
                <span className="slash-menu-skill">{c.skill}</span>
              </button>
            ))}
          </div>
        )}
        <div className="composer-footer">
          <span className="composer-hint">
            <kbd className="kbd">Enter</kbd> send ·{' '}
            <kbd className="kbd">Shift+Enter</kbd> newline
            {slashCommands.length > 0 && (
              <> · <kbd className="kbd">/</kbd> skills</>
            )}
          </span>
          <div className="composer-spacer" />
          {isStreaming && (
            <button className="composer-stop" onClick={stopStreaming} title="Stop">
              <Square size={11} fill="currentColor" />
            </button>
          )}
          {isStreaming && !text.trim() ? null : (
            <button
              className="composer-send"
              onClick={submit}
              disabled={!text.trim() || !workspace}
              title={isStreaming ? 'Send now: delivered after the current step' : 'Send'}
            >
              <ArrowUp size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
