import { useMemo, useState } from 'react';
import { RefreshCw, FolderOpen, File, Folder, ChevronRight, Package, Cpu, Files } from 'lucide-react';
import { useClaw } from '../lib/store';
import type { FileEntry } from '../types';
import SkillsBrowser from './SkillsBrowser';
import ModelsBrowser from './ModelsBrowser';

type Tab = 'explorer' | 'skills' | 'models';

interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size?: number;
  children?: TreeNode[];
}

function buildTree(entries: FileEntry[]): TreeNode | null {
  if (entries.length === 0) return null;
  const root: TreeNode = { name: '', path: '', type: 'dir', children: [] };
  for (const e of entries) {
    const parts = e.path.split('/');
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLeaf = i === parts.length - 1;
      let next = cur.children!.find((c) => c.name === part);
      if (!next) {
        next = {
          name: part,
          path: parts.slice(0, i + 1).join('/'),
          type: isLeaf ? e.type : 'dir',
          size: isLeaf ? e.size : undefined,
          children: [],
        };
        cur.children!.push(next);
      }
      cur = next;
    }
  }
  const sortNode = (n: TreeNode) => {
    if (!n.children) return;
    n.children.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    n.children.forEach(sortNode);
  };
  sortNode(root);
  return root;
}

function TreeView({ node, depth }: { node: TreeNode; depth: number }) {
  const [open, setOpen] = useState<Record<string, boolean>>({ [node.path || '/']: true });
  const toggle = (path: string) => setOpen((s) => ({ ...s, [path]: !s[path] }));
  if (!node.children || node.children.length === 0) return null;
  return (
    <div>
      {node.children.map((child) => {
        const isOpen = open[child.path] ?? (depth < 1);
        return (
          <div key={child.path}>
            <div
              className={`tree-item ${child.type === 'dir' ? 'dir' : ''} ${isOpen ? 'open' : ''}`}
              style={{ paddingLeft: 6 + depth * 12 }}
              onClick={() => child.type === 'dir' && toggle(child.path)}
            >
              {child.type === 'dir' ? (
                <ChevronRight className="tree-chevron" size={10} />
              ) : (
                <span className="tree-chevron" />
              )}
              <span className="tree-icon">
                {child.type === 'dir' ? <Folder size={12} /> : <File size={12} />}
              </span>
              <span className="tree-name">{child.name}</span>
            </div>
            {child.type === 'dir' && isOpen && child.children && (
              <TreeView node={child} depth={depth + 1} />
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function Sidebar() {
  const [tab, setTab] = useState<Tab>('explorer');
  const files = useClaw((s) => s.files);
  const workspace = useClaw((s) => s.workspace);
  const refreshFiles = useClaw((s) => s.refreshFiles);

  const tree = useMemo(() => buildTree(files), [files]);

  const openFolder = async () => {
    const res = await window.claw.workspace.pick();
    if (res.ok && res.workspace) {
      useClaw.getState().setWorkspace(res.workspace);
      await refreshFiles();
    }
  };

  const tabs: { id: Tab; label: string; icon: any }[] = [
    { id: 'explorer', label: 'Files', icon: Files },
    { id: 'skills', label: 'Skills', icon: Package },
    { id: 'models', label: 'Models', icon: Cpu },
  ];

  return (
    <aside className="sidebar">
      <div className="sidebar-tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`sidebar-tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
            title={t.label}
          >
            <t.icon size={13} />
            <span className="sidebar-tab-label">{t.label}</span>
          </button>
        ))}
      </div>

      {tab === 'explorer' && (
        <>
          <div className="sidebar-header">
            <div className="sidebar-title">Explorer</div>
            <div className="sidebar-actions">
              <button className="sidebar-icon-btn" title="Refresh" onClick={refreshFiles}>
                <RefreshCw size={12} />
              </button>
              <button className="sidebar-icon-btn" title="Open folder" onClick={openFolder}>
                <FolderOpen size={12} />
              </button>
            </div>
          </div>

          {workspace && tree ? (
            <>
              <div style={{ padding: '6px 12px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-2)', borderBottom: '1px solid var(--border-1)' }}>
                {workspace.split(/[\\/]/).pop()}
              </div>
              <div className="sidebar-tree">
                <TreeView node={tree} depth={0} />
              </div>
            </>
          ) : (
            <div className="sidebar-empty">
              <FolderOpen className="sidebar-empty-icon" />
              <div>No folder open</div>
              <button className="btn primary" onClick={openFolder}>
                <FolderOpen size={12} /> Open Folder
              </button>
            </div>
          )}
        </>
      )}

      {tab === 'skills' && <SkillsBrowser />}
      {tab === 'models' && <ModelsBrowser />}
    </aside>
  );
}
