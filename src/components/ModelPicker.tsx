import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Check, Settings } from 'lucide-react';
import { useClaw } from '../lib/store';

interface Preset { id: string; label: string; endpoint: string; models?: string[] }

const norm = (u: string) => u.replace(/\/+$/, '');

export default function ModelPicker() {
  const config = useClaw((s) => s.config);
  const switchModel = useClaw((s) => s.switchModel);
  const isStreaming = useClaw((s) => s.isStreaming);
  const setShowSettings = useClaw((s) => s.setShowSettings);
  const [open, setOpen] = useState(false);
  const [presets, setPresets] = useState<Preset[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.claw.providers.list().then((p: Preset[]) => setPresets(p)).catch(() => setPresets([]));
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  if (!config) return null;

  // Only offer models from the active provider: the saved API key is valid there.
  const preset = presets.find((p) => norm(p.endpoint) === norm(config.endpoint));
  const models = Array.from(new Set([config.model, ...(preset?.models ?? [])]));

  const pick = async (m: string) => {
    setOpen(false);
    if (m !== config.model) await switchModel(config.endpoint, m);
  };

  return (
    <div className="model-picker" ref={ref}>
      <button
        className="chat-header-model model-picker-btn"
        onClick={() => setOpen((o) => !o)}
        disabled={isStreaming}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={isStreaming ? 'Wait for the reply to finish' : 'Change model'}
      >
        {config.model}
        <ChevronDown size={11} />
      </button>
      {open && (
        <div className="model-picker-menu" role="listbox">
          {preset && <div className="model-picker-group-label">{preset.label}</div>}
          {models.map((m) => (
            <button key={m} role="option" aria-selected={m === config.model} className="model-picker-item" onClick={() => pick(m)}>
              <span className="mono">{m}</span>
              {m === config.model && <Check size={12} />}
            </button>
          ))}
          <button className="model-picker-item model-picker-footer" onClick={() => { setOpen(false); setShowSettings(true); }}>
            <Settings size={12} /> Change provider or key…
          </button>
        </div>
      )}
    </div>
  );
}
