import { useState } from 'react'
import type { BookmarkRow, FolderRow, SessionRow } from '../../../shared/api'
import { buildTree, type TreeNode } from '../../../shared/fork'
import { Menu, at, type MenuEntry, type MenuState } from './Menu'

interface Props {
  folders: FolderRow[]
  sessions: SessionRow[]
  bookmarks: BookmarkRow[]
  currentId: string | null
  busyIds: Set<string>
  onOpen(id: string): void
  onNewChat(cwd: string): void
  onDelete(s: SessionRow): void
  onAddFolder(): void
  onRemoveFolder(path: string): void
  onCollapse(): void
  onSettings(): void
  onShare(s: SessionRow): void
  onCompact(s: SessionRow): void
}

const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p

type Ctx = Props & {
  setMenu(m: MenuState | null): void
  editing: string | null
  setEditing(key: string | null): void
}

function InlineEdit({ value, onDone }: { value: string; onDone(v: string | null): void }) {
  const [v, setV] = useState(value)
  return (
    <input className="inline-edit" autoFocus value={v} onChange={(e) => setV(e.target.value)} onClick={(e) => e.stopPropagation()}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => { if (e.key === 'Enter') onDone(v.trim() || null); if (e.key === 'Escape') onDone(null) }}
      onBlur={() => onDone(v.trim() && v.trim() !== value ? v.trim() : null)} />
  )
}

/** Bookmark folders a pin/folder can be moved into (excluding a folder's own subtree). */
function folderTargets(bms: BookmarkRow[], exclude?: string): Array<{ id: string | null; label: string }> {
  const folders = bms.filter((b) => b.kind === 'folder')
  const out: Array<{ id: string | null; label: string }> = [{ id: null, label: 'Bookmarks (top level)' }]
  const walk = (parent: string | null, depth: number) => {
    for (const f of folders.filter((x) => x.parent_id === parent)) {
      if (f.id === exclude) continue
      out.push({ id: f.id, label: `${'  '.repeat(depth)}📁 ${f.name}` })
      walk(f.id, depth + 1)
    }
  }
  walk(null, 1)
  return out
}

function sessionMenu(s: SessionRow, c: Ctx, extra: MenuEntry[] = []): MenuEntry[] {
  const pinned = c.bookmarks.some((b) => b.kind === 'pin' && b.session_id === s.id)
  return [
    { label: '✎ Rename', onClick: () => c.setEditing(`s:${s.id}`) },
    pinned ? { label: '★ Pinned', onClick: () => {}, disabled: true } : { label: '☆ Pin to Bookmarks', onClick: () => window.desk.pinSession(s.id, null) },
    ...folderTargets(c.bookmarks).slice(1).filter(() => !pinned).map((f) => ({ label: `☆ Pin to ${f.label.trim()}`, onClick: () => window.desk.pinSession(s.id, f.id) })),
    ...extra,
    'sep',
    { label: '⇪ Share / export…', onClick: () => c.onShare(s) },
    { label: '⇲ Compact history…', onClick: () => c.onCompact(s) },
    'sep',
    { label: '🗑 Delete', danger: true, onClick: () => c.onDelete(s) }
  ]
}

function SessionNode({ node, depth, c }: { node: TreeNode<SessionRow>; depth: number; c: Ctx }) {
  const [open, setOpen] = useState(true)
  const s = node.row
  const hasKids = node.children.length > 0
  const menu = (e: React.MouseEvent) => c.setMenu(at(e, sessionMenu(s, c, [
    'sep',
    { label: '↑ Move up', onClick: () => window.desk.moveSession(s.id, -1) },
    { label: '↓ Move down', onClick: () => window.desk.moveSession(s.id, 1) }
  ])))
  return (
    <>
      <div className={`session ${c.currentId === s.id ? 'on' : ''}`} style={{ paddingLeft: 12 + depth * 18 }} onClick={() => c.onOpen(s.id)}
        onDoubleClick={() => c.setEditing(`s:${s.id}`)} onContextMenu={menu} title={s.title}>
        {hasKids
          ? <button className="twisty" onClick={(e) => { e.stopPropagation(); setOpen(!open) }}>{open ? '▾' : '▸'}</button>
          : depth > 0 ? <span className="fork-mark">⑂</span> : <span className={`dot ${c.busyIds.has(s.id) ? 'busy' : ''}`} />}
        {c.editing === `s:${s.id}`
          ? <InlineEdit value={s.title} onDone={(v) => { c.setEditing(null); if (v) void window.desk.renameSession(s.id, v) }} />
          : <span className="title">{s.title}</span>}
        {hasKids && !open && <span className="count">{node.children.length}</span>}
        <button className="more" title="More actions" onClick={menu}>⋯</button>
      </div>
      {open && node.children.map((ch) => <SessionNode key={ch.row.id} node={ch} depth={depth + 1} c={c} />)}
    </>
  )
}

function BookmarkNode({ b, depth, c }: { b: BookmarkRow; depth: number; c: Ctx }) {
  const pad = { paddingLeft: 12 + depth * 18 }
  const move: MenuEntry[] = [
    { label: '↑ Move up', onClick: () => window.desk.moveBookmark(b.id, -1) },
    { label: '↓ Move down', onClick: () => window.desk.moveBookmark(b.id, 1) },
    ...folderTargets(c.bookmarks, b.kind === 'folder' ? b.id : undefined).filter((f) => f.id !== b.parent_id)
      .map((f) => ({ label: `→ Move to ${f.label.trim()}`, onClick: () => window.desk.updateBookmark(b.id, { parent_id: f.id }) }))
  ]
  if (b.kind === 'pin') {
    const s = c.sessions.find((x) => x.id === b.session_id)
    if (!s) return null
    const menu = (e: React.MouseEvent) => c.setMenu(at(e, [
      { label: '✎ Rename', onClick: () => c.setEditing(`b:${b.id}`) },
      { label: '★ Unpin', onClick: () => window.desk.removeBookmark(b.id) },
      'sep', ...move, 'sep',
      { label: '⇪ Share / export…', onClick: () => c.onShare(s) },
      { label: '⇲ Compact history…', onClick: () => c.onCompact(s) }
    ]))
    return (
      <div className={`session pin ${c.currentId === s.id ? 'on' : ''}`} style={pad} onClick={() => c.onOpen(s.id)}
        onDoubleClick={() => c.setEditing(`b:${b.id}`)} onContextMenu={menu} title={`${s.title}\n${s.cwd}`}>
        <span className="pin-mark">★</span>
        {c.editing === `b:${b.id}`
          ? <InlineEdit value={s.title} onDone={(v) => { c.setEditing(null); if (v) void window.desk.renameSession(s.id, v) }} />
          : <span className="title">{s.title}</span>}
        <span className="pin-folder">{base(s.cwd)}</span>
        <button className="more" title="More actions" onClick={menu}>⋯</button>
      </div>
    )
  }
  const kids = c.bookmarks.filter((x) => x.parent_id === b.id)
  const open = !b.collapsed
  const menu = (e: React.MouseEvent) => c.setMenu(at(e, [
    { label: '✎ Rename folder', onClick: () => c.setEditing(`b:${b.id}`) },
    { label: '＋ New subfolder', onClick: () => window.desk.addBookmarkFolder('New folder', b.id) },
    'sep', ...move, 'sep',
    { label: '🗑 Delete folder (keeps pins)', danger: true, onClick: () => window.desk.removeBookmark(b.id) }
  ]))
  return (
    <>
      <div className="session bm-folder" style={pad} onClick={() => window.desk.updateBookmark(b.id, { collapsed: open ? 1 : 0 })}
        onDoubleClick={(e) => { e.stopPropagation(); c.setEditing(`b:${b.id}`) }} onContextMenu={menu}>
        <span className="twisty">{open ? '▾' : '▸'}</span>
        <span className="folder-icon">{open ? '📂' : '📁'}</span>
        {c.editing === `b:${b.id}`
          ? <InlineEdit value={b.name ?? ''} onDone={(v) => { c.setEditing(null); if (v) void window.desk.updateBookmark(b.id, { name: v }) }} />
          : <span className="title">{b.name}</span>}
        {!open && kids.length > 0 && <span className="count">{kids.length}</span>}
        <button className="more" title="More actions" onClick={menu}>⋯</button>
      </div>
      {open && (kids.length
        ? kids.map((k) => <BookmarkNode key={k.id} b={k} depth={depth + 1} c={c} />)
        : <div className="session empty-hint" style={{ paddingLeft: 30 + (depth + 1) * 18 }}>Empty, pin a chat here from its ⋯ menu</div>)}
    </>
  )
}

function FolderGroup({ folder, sessions, c }: { folder: FolderRow; sessions: SessionRow[]; c: Ctx }) {
  const [open, setOpen] = useState(true)
  const tree = buildTree(sessions)
  return (
    <div className="folder-group">
      <div className="folder-row" onClick={() => setOpen(!open)} title={folder.path}>
        <span className="folder-icon">{open ? '📂' : '📁'}</span>
        <span className="title">{base(folder.path)}</span>
        <button className="folder-act" title="New chat in this folder" onClick={(e) => { e.stopPropagation(); c.onNewChat(folder.path) }}>＋</button>
        <button className="folder-act" title="Remove folder from list" onClick={(e) => { e.stopPropagation(); c.onRemoveFolder(folder.path) }}>×</button>
      </div>
      {open && (tree.length
        ? tree.map((n) => <SessionNode key={n.row.id} node={n} depth={0} c={c} />)
        : <div className="session empty-hint" onClick={() => c.onNewChat(folder.path)}>Start a chat…</div>)}
    </div>
  )
}

export function Sidebar(p: Props) {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [bmOpen, setBmOpen] = useState(true)
  const c: Ctx = { ...p, setMenu, editing, setEditing }
  const top = p.bookmarks.filter((b) => b.parent_id === null)
  return (
    <aside className="sidebar">
      <div className="side-top">
        <button className="icon" title="Hide sidebar" onClick={p.onCollapse}>◧</button>
      </div>
      <button className="new-chat" onClick={() => p.onNewChat('')}>✎ New chat</button>
      <div className="sessions">
        <div className="folder-group bookmarks">
          <div className="folder-row section" onClick={() => setBmOpen(!bmOpen)}>
            <span className="folder-icon">★</span>
            <span className="title">Bookmarks</span>
            <button className="folder-act" title="New bookmark folder" onClick={(e) => { e.stopPropagation(); setBmOpen(true); void window.desk.addBookmarkFolder('New folder', null) }}>＋</button>
          </div>
          {bmOpen && (top.length
            ? top.map((b) => <BookmarkNode key={b.id} b={b} depth={0} c={c} />)
            : <div className="session empty-hint">Pin chats from their ⋯ menu</div>)}
        </div>
        <div className="side-divider" />
        {p.folders.map((f) => <FolderGroup key={f.path} folder={f} sessions={p.sessions.filter((s) => s.cwd === f.path)} c={c} />)}
        <button className="add-folder" onClick={p.onAddFolder}>＋ Add working folder</button>
      </div>
      <div className="side-bottom">
        <span className="brand">AITM Desk</span>
        <button className="icon" title="Settings" onClick={p.onSettings}>⚙</button>
      </div>
      {menu && <Menu menu={menu} onClose={() => setMenu(null)} />}
    </aside>
  )
}
