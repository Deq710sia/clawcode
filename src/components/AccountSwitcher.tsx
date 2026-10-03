import { useState, useEffect, useRef } from 'react';
import { ChevronDown, User, Plus, Check, AlertCircle } from 'lucide-react';
import { useClaw } from '../lib/store';
import type { AccountProfile } from '../types';

export default function AccountSwitcher() {
  const [open, setOpen] = useState(false);
  const accounts = useClaw((s) => s.accounts);
  const activeAccountId = useClaw((s) => s.activeAccountId);
  const config = useClaw((s) => s.config);
  const refreshAccounts = useClaw((s) => s.refreshAccounts);
  const switchModel = useClaw((s) => s.switchModel);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    refreshAccounts();
  }, [refreshAccounts]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  // Only show for WebChat providers
  const isWebChat = config?.endpoint?.includes('127.0.0.1:7777') || config?.endpoint?.includes('localhost:7777');
  if (!isWebChat || accounts.length === 0) return null;

  const activeAccount = accounts.find((a) => a.id === activeAccountId);

  const handleSwitch = async (account: AccountProfile) => {
    const bridgeUrl = await window.claw.webchat.bridgeUrl();
    const modelMap: Record<string, string> = {
      claude: 'claude.ai',
      chatgpt: 'chatgpt.com',
      gemini: 'gemini.google.com',
      grok: 'grok.com',
      deepseek: 'deepseek.com',
    };
    await switchModel(bridgeUrl, modelMap[account.service] || account.service, account.id);
    setOpen(false);
  };

  return (
    <div className="account-switcher" ref={ref}>
      <button
        className="account-switcher-btn"
        onClick={() => setOpen(!open)}
        aria-label="Switch account"
        aria-expanded={open}
      >
        <User size={12} />
        <span>{activeAccount?.label || 'Default'}</span>
        {activeAccount && (
          <span className={`account-status-dot ${activeAccount.status}`} />
        )}
        <ChevronDown size={10} />
      </button>

      {open && (
        <div className="account-switcher-menu">
          <div className="account-switcher-header">Accounts</div>
          {accounts.map((a) => (
            <button
              key={a.id}
              className={`account-switcher-item ${a.id === activeAccountId ? 'active' : ''}`}
              onClick={() => handleSwitch(a)}
              disabled={!a.loggedIn}
            >
              <div className="account-switcher-item-info">
                <div className="account-switcher-item-label">
                  {a.label}
                  {a.id === activeAccountId && <Check size={11} />}
                </div>
                <div className="account-switcher-item-meta">
                  {a.service} · {a.messageCount}/{a.estimatedLimit} msgs · {a.status}
                </div>
              </div>
              <div className={`account-status-dot ${a.status}`} />
            </button>
          ))}
          {accounts.filter((a) => a.loggedIn).length === 0 && (
            <div className="account-switcher-empty">
              <AlertCircle size={12} />
              <span>No logged-in accounts. Add one in Settings → Accounts.</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
