import { useState } from 'react';
import { X, ArrowRight, Settings } from 'lucide-react';
import { useClaw } from '../lib/store';

export default function WelcomeModal() {
  const setShowWelcome = useClaw((s) => s.setShowWelcome);
  const setShowSettings = useClaw((s) => s.setShowSettings);
  const [step, setStep] = useState(0);

  const next = () => {
    if (step < 2) setStep(step + 1);
    else {
      setShowWelcome(false);
      setShowSettings(true);
    }
  };

  const skip = () => {
    setShowWelcome(false);
  };

  return (
    <div className="modal-backdrop" onClick={skip}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 'min(480px, 92vw)' }}>
        <div className="modal-header">
          <div className="modal-title">Welcome to ClawCode</div>
          <button className="modal-close" onClick={skip}><X size={14} /></button>
        </div>

        <div className="modal-body">
          <div className="welcome-content">
            <div className="welcome-icon">C</div>
            <div className="welcome-title">A clean-room coding harness</div>
            <div className="welcome-sub">
              ClawCode is an agentic IDE companion that reads, writes, and runs code in a workspace folder you choose — powered by any OpenAI-compatible model.
            </div>

            <div className="welcome-steps">
              <div className="welcome-step">
                <div className="welcome-step-num">1</div>
                <div><strong>Open a folder</strong> — ClawCode only operates inside this workspace.</div>
              </div>
              <div className="welcome-step">
                <div className="welcome-step-num">2</div>
                <div><strong>Configure your endpoint</strong> — pick OpenAI, OpenRouter, Ollama, or any OpenAI-compatible server, and drop in your API key.</div>
              </div>
              <div className="welcome-step">
                <div className="welcome-step-num">3</div>
                <div><strong>Start chatting</strong> — ask ClawCode to explore, build, or fix. It'll call tools and show diffs you can review inline.</div>
              </div>
            </div>
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn ghost" onClick={skip}>Skip</button>
          <button className="btn primary" onClick={next}>
            {step < 2 ? 'Next' : 'Configure'} <ArrowRight size={12} />
          </button>
        </div>
      </div>
    </div>
  );
}
