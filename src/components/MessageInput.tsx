import { useEffect, useRef, useState, useMemo } from 'react';
import { ArrowUp, Square, Sparkles } from 'lucide-react';
import { useClaw } from '../lib/store';

export default function MessageInput() {
  const [text, setText] = useState('');
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const isStreaming = useClaw((s) => s.isStreaming);
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
  }, [filteredCmds]);

  useEffect(() => {
    if (taRef.current) {
      taRef.current.style.height = 'auto';
      taRef.current.style.height = Math.min(taRef.current.scrollHeight, 240) + 'px';
    }
  }, [text]);

  const submit = async () => {
    if (!text.trim() || isStreaming) return;
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
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      if (showSlashMenu) return; // let the menu handle Enter
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
            {filteredCmds.map((c) => (
              <button
                key={c.name + c.skill}
                className="slash-menu-item"
                onClick={() => pickCommand(c)}
              >
                <span className="slash-menu-cmd mono">/{c.name}</span>
                <span className="slash-menu-desc">{c.description.slice(0, 60)}</span>
                <span className="slash-menu-skill">{c.skill}</span>
              </button>
            ))}
          </div>
        )}
        <div className="composer-footer">
          <span className="composer-hint">
            <kbd style={{ background: 'var(--bg-3)', padding: '1px 5px', borderRadius: 3, border: '1px solid var(--border-2)' }}>Enter</kbd> send ·{' '}
            <kbd style={{ background: 'var(--bg-3)', padding: '1px 5px', borderRadius: 3, border: '1px solid var(--border-2)' }}>Shift+Enter</kbd> newline
            {slashCommands.length > 0 && (
              <> · <kbd style={{ background: 'var(--bg-3)', padding: '1px 5px', borderRadius: 3, border: '1px solid var(--border-2)' }}>/</kbd> skills</>
            )}
          </span>
          <div className="composer-spacer" />
          {isStreaming ? (
            <button className="composer-stop" onClick={stopStreaming} title="Stop">
              <Square size={11} fill="currentColor" />
            </button>
          ) : (
            <button
              className="composer-send"
              onClick={submit}
              disabled={!text.trim() || !workspace}
              title="Send"
            >
              <ArrowUp size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
