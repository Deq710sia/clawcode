import { useEffect, useState } from 'react';
import { MessageSquare, Plus, Trash2, Search, Clock } from 'lucide-react';
import { useClaw } from '../lib/store';
import type { SavedConversation } from '../types';

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  const hr = Math.floor(diff / 3600000);
  const day = Math.floor(diff / 86400000);
  if (day > 0) return `${day}d ago`;
  if (hr > 0) return `${hr}h ago`;
  if (min > 0) return `${min}m ago`;
  return 'just now';
}

function groupByDate(convos: SavedConversation[]): { label: string; items: SavedConversation[] }[] {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = today - 86400000;
  const weekAgo = today - 7 * 86400000;

  const groups: Record<string, SavedConversation[]> = {};
  for (const c of convos) {
    let label: string;
    if (c.updatedAt >= today) label = 'Today';
    else if (c.updatedAt >= yesterday) label = 'Yesterday';
    else if (c.updatedAt >= weekAgo) label = 'This Week';
    else label = 'Older';
    if (!groups[label]) groups[label] = [];
    groups[label].push(c);
  }

  return ['Today', 'Yesterday', 'This Week', 'Older']
    .filter((label) => groups[label])
    .map((label) => ({ label, items: groups[label] }));
}

export default function ConversationHistory({ onClose }: { onClose?: () => void }) {
  const conversationList = useClaw((s) => s.conversationList);
  const conversationId = useClaw((s) => s.conversationId);
  const refreshConversationList = useClaw((s) => s.refreshConversationList);
  const loadConversation = useClaw((s) => s.loadConversation);
  const startNewConversation = useClaw((s) => s.startNewConversation);
  const deleteConversation = useClaw((s) => s.deleteConversation);
  const [search, setSearch] = useState('');

  useEffect(() => {
    refreshConversationList();
  }, [refreshConversationList]);

  const filtered = search.trim()
    ? conversationList.filter((c) => c.title.toLowerCase().includes(search.toLowerCase()))
    : conversationList;

  const groups = groupByDate(filtered);

  return (
    <div className="convo-history">
      <div className="convo-history-header">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="sidebar-title">History</span>
          <button
            className="sidebar-icon-btn"
            onClick={() => { startNewConversation(); onClose?.(); }}
            data-tooltip="New conversation"
            aria-label="New conversation"
          >
            <Plus size={12} />
          </button>
        </div>
        <div className="convo-search">
          <Search size={11} />
          <input
            type="text"
            placeholder="Search conversations…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search conversations"
          />
        </div>
      </div>

      <div className="convo-list">
        {filtered.length === 0 && (
          <div className="convo-empty">
            <MessageSquare size={20} style={{ opacity: 0.3 }} />
            <div>No conversations yet</div>
          </div>
        )}
        {groups.map((group) => (
          <div key={group.label} className="convo-group">
            <div className="convo-group-label">{group.label}</div>
            {group.items.map((c) => (
              <div
                key={c.id}
                className={`convo-item ${c.id === conversationId ? 'active' : ''}`}
                onClick={() => { loadConversation(c.id); onClose?.(); }}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter') { loadConversation(c.id); onClose?.(); } }}
              >
                <div className="convo-item-title">{c.title}</div>
                <div className="convo-item-meta">
                  <Clock size={9} />
                  <span>{timeAgo(c.updatedAt)}</span>
                  {c.model && <span className="muted">· {c.model}</span>}
                </div>
                <button
                  className="convo-item-delete"
                  onClick={(e) => { e.stopPropagation(); deleteConversation(c.id); }}
                  aria-label="Delete conversation"
                >
                  <Trash2 size={10} />
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
