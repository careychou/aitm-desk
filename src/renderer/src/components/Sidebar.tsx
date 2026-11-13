import { useState } from 'react'
import type { FolderRow, SessionRow } from '../../../shared/api'
import { buildTree, type TreeNode } from '../../../shared/fork'

interface Props {
  folders: FolderRow[]
  sessions: SessionRow[]
  currentId: string | null
  busyIds: Set<string>
  onOpen(id: string): void
  onNewChat(cwd: string): void
  onDelete(s: SessionRow): void
  onAddFolder(): void
  onRemoveFolder(path: string): void
  onCollapse(): void
  onSettings(): void
}

const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p

function SessionNode({ node, depth, p }: { node: TreeNode<SessionRow>; depth: number; p: Props }) {
  const [open, setOpen] = useState(true)
  const s = node.row
  const hasKids = node.children.length > 0
  return (
    <>
      <div className={`session ${p.currentId === s.id ? 'on' : ''}`} style={{ paddingLeft: 12 + depth * 18 }} onClick={() => p.onOpen(s.id)} title={s.title}>
        {hasKids
          ? <button className="twisty" onClick={(e) => { e.stopPropagation(); setOpen(!open) }}>{open ? '▾' : '▸'}</button>
          : depth > 0 ? <span className="fork-mark">⑂</span> : <span className={`dot ${p.busyIds.has(s.id) ? 'busy' : ''}`} />}
        <span className="title">{s.title}</span>
        {hasKids && !open && <span className="count">{node.children.length}</span>}
        <button className="del" title="Delete chat" onClick={(e) => { e.stopPropagation(); p.onDelete(s) }}>×</button>
      </div>
      {open && node.children.map((c) => <SessionNode key={c.row.id} node={c} depth={depth + 1} p={p} />)}
    </>
  )
}

function FolderGroup({ folder, sessions, p }: { folder: FolderRow; sessions: SessionRow[]; p: Props }) {
  const [open, setOpen] = useState(true)
  const tree = buildTree(sessions)
  return (
    <div className="folder-group">
      <div className="folder-row" onClick={() => setOpen(!open)} title={folder.path}>
        <span className="folder-icon">{open ? '📂' : '📁'}</span>
        <span className="title">{base(folder.path)}</span>
        <button className="folder-act" title="New chat in this folder" onClick={(e) => { e.stopPropagation(); p.onNewChat(folder.path) }}>＋</button>
        <button className="folder-act" title="Remove folder from list" onClick={(e) => { e.stopPropagation(); p.onRemoveFolder(folder.path) }}>×</button>
      </div>
      {open && (tree.length
        ? tree.map((n) => <SessionNode key={n.row.id} node={n} depth={0} p={p} />)
        : <div className="session empty-hint" onClick={() => p.onNewChat(folder.path)}>Start a chat…</div>)}
    </div>
  )
}

export function Sidebar(p: Props) {
  return (
    <aside className="sidebar">
      <div className="side-top">
        <button className="icon" title="Hide sidebar" onClick={p.onCollapse}>◧</button>
      </div>
      <button className="new-chat" onClick={() => p.onNewChat('')}>✎ New chat</button>
      <div className="sessions">
        {p.folders.map((f) => <FolderGroup key={f.path} folder={f} sessions={p.sessions.filter((s) => s.cwd === f.path)} p={p} />)}
        <button className="add-folder" onClick={p.onAddFolder}>＋ Add working folder</button>
      </div>
      <div className="side-bottom">
        <span className="brand">AITM Desk</span>
        <button className="icon" title="Settings" onClick={p.onSettings}>⚙</button>
      </div>
    </aside>
  )
}
