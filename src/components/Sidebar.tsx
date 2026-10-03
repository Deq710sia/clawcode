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
              role="treeitem"
              aria-expanded={child.type === 'dir' ? isOpen : undefined}
              aria-label={child.name}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  if (child.type === 'dir') toggle(child.path);
                }
                if (e.key === 'ArrowRight' && child.type === 'dir' && !isOpen) { e.preventDefault(); toggle(child.path); }
                if (e.key === 'ArrowLeft' && child.type === 'dir' && isOpen) { e.preventDefault(); toggle(child.path); }
              }}
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
  const [fileFilter, setFileFilter] = useState('');
  const files = useClaw((s) => s.files);
  const workspace = useClaw((s) => s.workspace);
  const refreshFiles = useClaw((s) => s.refreshFiles);

  const tree = useMemo(() => buildTree(files), [files]);

  // Flat file list for filtering
  const flatFiles = useMemo(() => {
    const out: string[] = [];
    const walk = (n: TreeNode) => {
      if (!n.children) return;
      for (const c of n.children) {
        if (c.type === 'file') out.push(c.path);
        if (c.children) walk(c);
      }
    };
    if (tree) walk(tree);
    return out;
  }, [tree]);

  const filteredFiles = useMemo(() => {
    if (!fileFilter.trim()) return null;
    const q = fileFilter.toLowerCase();
    return flatFiles.filter((p) => p.toLowerCase().includes(q)).slice(0, 100);
  }, [fileFilter, flatFiles]);

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
              <div className="sidebar-workspace-path">
                {workspace.split(/[\\/]/).pop()}
              </div>
              <div className="sidebar-search">
                <input
                  type="text"
                  placeholder="Filter files…"
                  value={fileFilter}
                  onChange={(e) => setFileFilter(e.target.value)}
                  aria-label="Filter files"
                />
              </div>
              {filteredFiles ? (
                <div className="sidebar-tree">
                  {filteredFiles.length === 0 ? (
                    <div style={{ padding: '12px', fontSize: 11, color: 'var(--fg-3)' }}>No files match "{fileFilter}"</div>
                  ) : (
                    filteredFiles.map((p) => (
                      <div key={p} className="tree-item" role="treeitem" tabIndex={0} aria-label={p}>
                        <span className="tree-chevron" />
                        <span className="tree-icon"><File size={12} /></span>
                        <span className="tree-name">{p}</span>
                      </div>
                    ))
                  )}
                </div>
              ) : (
                <div className="sidebar-tree">
                  <TreeView node={tree} depth={0} />
                </div>
              )}
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
