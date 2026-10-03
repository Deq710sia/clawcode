import { useEffect } from 'react';
import { useClaw } from './lib/store';
import { defaultSystemPrompt } from './lib/api';
import TopBar from './components/TopBar';
import Sidebar from './components/Sidebar';
import ChatPanel from './components/ChatPanel';
import SettingsModal from './components/SettingsModal';
import WelcomeModal from './components/WelcomeModal';
import StatusBar from './components/StatusBar';
import ErrorBoundary from './components/ErrorBoundary';

export default function App() {
  const config = useClaw((s) => s.config);
  const setConfig = useClaw((s) => s.setConfig);
  const setWorkspace = useClaw((s) => s.setWorkspace);
  const refreshFiles = useClaw((s) => s.refreshFiles);
  const showSettings = useClaw((s) => s.showSettings);
  const showWelcome = useClaw((s) => s.showWelcome);

  // Bootstrap config on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const c = await window.claw.config.get();
      if (cancelled) return;
      // Apply defaults
      const defaulted = {
        ...c,
        endpoint: c.endpoint || 'https://api.openai.com/v1',
        model: c.model || 'gpt-4o-mini',
        systemPrompt: c.systemPrompt || defaultSystemPrompt(),
      };
      setConfig(defaulted);
      if (c.workspace) {
        // Tell the main process first; setWorkspace triggers a file-tree refresh that
        // needs the main process to already know the workspace.
        const r = await window.claw.workspace.set(c.workspace);
        if (!cancelled && r.ok) setWorkspace(c.workspace);
      }
      // First-run welcome if no API key and no endpoint customization
      if (!cancelled && !c.hasApiKey && !c.endpoint) {
        useClaw.getState().setShowWelcome(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Refresh files when workspace changes
  useEffect(() => {
    const unsub = useClaw.subscribe((s, prev) => {
      if (s.workspace !== prev.workspace) refreshFiles();
    });
    return unsub;
  }, [refreshFiles]);

  return (
    <ErrorBoundary>
      <div className="app-root">
        <TopBar />
        <div className="app-body">
          <Sidebar />
          <ChatPanel />
        </div>
        <StatusBar />
        {showSettings && <SettingsModal />}
        {showWelcome && <WelcomeModal />}
      </div>
    </ErrorBoundary>
  );
}
