import { UsageRing, fmtUsd } from './UsageModal'
import { useRef, useState } from 'react'
import type { BookmarkRow, FolderRow, SessionRow } from '../../../shared/api'
import { buildTree, isWithin, type TreeNode } from '../../../shared/fork'
import { Menu, at, type MenuEntry, type MenuState } from './Menu'
import { BRAND } from '../../../shared/brand'

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
  onUsage(): void
  usage: { today: number | null; budget: number }
  onShare(s: SessionRow): void
  onCompact(s: SessionRow): void
}

const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p

type Drag = { kind: 'session'; id: string } | { kind: 'bookmark'; id: string }
type Zone = 'before' | 'after' | 'into'
type Ctx = Props & {
  setMenu(m: MenuState | null): void
  editing: string | null
  setEditing(key: string | null): void
  drag: React.MutableRefObject<Drag | null>
  over: { key: string; zone: Zone } | null
  setOver(o: { key: string; zone: Zone } | null): void
}

/** Where on a row the pointer is: top/bottom half, or (for containers) top quarter / middle / bottom quarter. */
function zoneOf(e: React.DragEvent, container: boolean): Zone {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const y = (e.clientY - r.top) / r.height
  if (!container) return y < 0.5 ? 'before' : 'after'
  return y < 0.25 ? 'before' : y > 0.75 ? 'after' : 'into'
}

/** Drag/drop props for a row. `accept` returns the allowed zone (or null) for the current drag; `drop` performs it. */
function dnd(c: Ctx, key: string, start: Drag, accept: (d: Drag, z: Zone) => Zone | null, drop: (d: Drag, z: Zone) => void, container = false) {
  const cls = c.over?.key === key ? ` drop-${c.over.zone}` : ''
  return {
    cls,
    props: {
      draggable: c.editing === null,
      onDragStart: (e: React.DragEvent) => { c.drag.current = start; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', key); e.stopPropagation() },
      onDragEnd: () => { c.drag.current = null; c.setOver(null) },
      onDragOver: (e: React.DragEvent) => {
        const d = c.drag.current
        if (!d) return
        const z = accept(d, zoneOf(e, container))
        if (!z) { if (c.over?.key === key) c.setOver(null); return }
        e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'
        if (c.over?.key !== key || c.over.zone !== z) c.setOver({ key, zone: z })
      },
      onDragLeave: (e: React.DragEvent) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node) && c.over?.key === key) c.setOver(null) },
      onDrop: (e: React.DragEvent) => {
        const d = c.drag.current, z = c.over?.key === key ? c.over.zone : null
        c.drag.current = null; c.setOver(null)
        if (!d || !z) return
        e.preventDefault(); e.stopPropagation(); drop(d, z)
      }
    }
  }
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
  const menu = (e: React.MouseEvent) => c.setMenu(at(e, sessionMenu(s, c)))
  const d = dnd(c, `s:${s.id}`, { kind: 'session', id: s.id },
    (dr, z) => {
      if (dr.kind !== 'session' || dr.id === s.id) return null
      const o = c.sessions.find((x) => x.id === dr.id)
      return o && o.cwd === s.cwd && (o.parent_id ?? null) === (s.parent_id ?? null) ? z : null
    },
    (dr, z) => window.desk.reorderSession(dr.id, s.id, z === 'before'))
  return (
    <>
      <div className={`session ${c.currentId === s.id ? 'on' : ''}${d.cls}`} {...d.props} style={{ paddingLeft: 12 + depth * 18 }} onClick={() => c.onOpen(s.id)}
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
    ...folderTargets(c.bookmarks, b.kind === 'folder' ? b.id : undefined).filter((f) => f.id !== b.parent_id)
      .map((f) => ({ label: `→ Move to ${f.label.trim()}`, onClick: () => window.desk.updateBookmark(b.id, { parent_id: f.id }) }))
  ]
  const isFolder = b.kind === 'folder'
  const d = dnd(c, `b:${b.id}`, { kind: 'bookmark', id: b.id },
    (dr, z) => {
      if (dr.kind === 'bookmark') {
        if (dr.id === b.id) return null
        const target = z === 'into' ? b.id : b.parent_id
        if (target && isWithin(c.bookmarks, dr.id, target)) return null
      }
      return z
    },
    (dr, z) => {
      const parent = z === 'into' ? b.id : b.parent_id
      const targetId = z === 'into' ? null : b.id
      if (dr.kind === 'session') void window.desk.pinSession(dr.id, parent, targetId, z === 'before')
      else void window.desk.placeBookmark(dr.id, parent, targetId, z === 'before')
      if (z === 'into' && b.collapsed) void window.desk.updateBookmark(b.id, { collapsed: 0 })
    }, isFolder)
  if (b.kind === 'pin') {
    const s = c.sessions.find((x) => x.id === b.session_id)
    if (!s) return null
    const menu = (e: React.MouseEvent) => c.setMenu(at(e, [
      { label: '✎ Rename', onClick: () => c.setEditing(`b:${b.id}`) },
      { label: '★ Unpin', onClick: () => window.desk.removeBookmark(b.id) },
      ...(move.length ? ['sep' as const, ...move] : []), 'sep',
      { label: '⇪ Share / export…', onClick: () => c.onShare(s) },
      { label: '⇲ Compact history…', onClick: () => c.onCompact(s) }
    ]))
    return (
      <div className={`session pin ${c.currentId === s.id ? 'on' : ''}${d.cls}`} {...d.props} style={pad} onClick={() => c.onOpen(s.id)}
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
    ...(move.length ? ['sep' as const, ...move] : []), 'sep',
    { label: '🗑 Delete folder (keeps pins)', danger: true, onClick: () => window.desk.removeBookmark(b.id) }
  ]))
  return (
    <>
      <div className={`session bm-folder${d.cls}`} {...d.props} style={pad} onClick={() => window.desk.updateBookmark(b.id, { collapsed: open ? 1 : 0 })}
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
        : <div className="session empty-hint" style={{ paddingLeft: 30 + (depth + 1) * 18 }}>Empty, drag chats here</div>)}
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
  const drag = useRef<Drag | null>(null)
  const [over, setOver] = useState<{ key: string; zone: Zone } | null>(null)
  const c: Ctx = { ...p, setMenu, editing, setEditing, drag, over, setOver }
  const bmRoot = dnd(c, 'bm-root', { kind: 'bookmark', id: '' }, () => 'into', (dr) => {
    setBmOpen(true)
    if (dr.kind === 'session') void window.desk.pinSession(dr.id, null, null, false)
    else void window.desk.placeBookmark(dr.id, null, null, false)
  }, true)
  const top = p.bookmarks.filter((b) => b.parent_id === null)
  return (
    <aside className="sidebar">
      <div className="side-top">
        <button className="icon" title="Hide sidebar (⌘B)" onClick={p.onCollapse}>◧</button>
      </div>
      <button className="new-chat" onClick={() => p.onNewChat('')}>✎ New chat</button>
      <div className="sessions">
        <div className="folder-group bookmarks">
          <div className={`folder-row section${bmRoot.cls}`} onDragOver={bmRoot.props.onDragOver} onDragLeave={bmRoot.props.onDragLeave} onDrop={bmRoot.props.onDrop}
            onClick={() => setBmOpen(!bmOpen)} title="Drop a chat here to pin it">
            <span className="folder-icon">★</span>
            <span className="title">Bookmarks</span>
            <button className="folder-act" title="New bookmark folder" onClick={(e) => { e.stopPropagation(); setBmOpen(true); void window.desk.addBookmarkFolder('New folder', null) }}>＋</button>
          </div>
          {bmOpen && (top.length
            ? top.map((b) => <BookmarkNode key={b.id} b={b} depth={0} c={c} />)
            : <div className={`session empty-hint${bmRoot.cls}`} onDragOver={bmRoot.props.onDragOver} onDragLeave={bmRoot.props.onDragLeave} onDrop={bmRoot.props.onDrop}>Drag a chat here, or pin it from its ⋯ menu</div>)}
        </div>
        <div className="side-divider" />
        {p.folders.map((f) => <FolderGroup key={f.path} folder={f} sessions={p.sessions.filter((s) => s.cwd === f.path)} c={c} />)}
        <button className="add-folder" onClick={p.onAddFolder}>＋ Add working folder</button>
      </div>
      <div className="side-bottom">
        <span className="brand">{BRAND.logo && <img src={BRAND.logo} alt="" />}{BRAND.short}</span>
        <button className="usage-btn" onClick={p.onUsage}
          title={`AI usage (⌘⇧U)${p.usage.today !== null ? ` · today ${fmtUsd(p.usage.today)}${p.usage.budget ? ` of ${fmtUsd(p.usage.budget)}` : ''}` : ''}`}>
          <UsageRing frac={p.usage.budget && p.usage.today !== null ? p.usage.today / p.usage.budget : null} />
          {p.usage.today !== null && p.usage.today > 0 && <span>{fmtUsd(p.usage.today)}</span>}
        </button>
        <button className="icon" title="Settings" onClick={p.onSettings}>⚙</button>
      </div>
      {menu && <Menu menu={menu} onClose={() => setMenu(null)} />}
    </aside>
  )
}
