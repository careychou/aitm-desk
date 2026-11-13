import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Message } from '../engine/types'
import { isWithin, reorderIds } from '../shared/fork'

export interface SessionRow { id: string; title: string; cwd: string; model: string; created_at: number; updated_at: number; parent_id: string | null; fork_turn: number | null; reasoning?: string | null; mode?: string | null; memories?: string | null; sort_order?: number | null; compact_offset?: number | null; turn_map?: string | null }
export interface FolderRow { path: string; added_at: number }
/** A bookmark folder (id) or a pinned session (session_id), nested via parent_id (null = top of Bookmarks). */
export interface BookmarkRow { id: string; kind: 'folder' | 'pin'; name: string | null; session_id: string | null; parent_id: string | null; sort_order: number; collapsed: number }

/** SQLite persistence for sessions, the main-agent message history, and UI event log. */
export class Store {
  private db: DatabaseSync
  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true })
    this.db = new DatabaseSync(path.join(dir, 'aitm.db'))
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, model TEXT, created_at INTEGER, updated_at INTEGER);
      CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, seq INTEGER, content_json TEXT);
      CREATE TABLE IF NOT EXISTS ui_items (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, item_json TEXT);
      CREATE INDEX IF NOT EXISTS ix_msg ON messages(session_id, seq);
      CREATE INDEX IF NOT EXISTS ix_ui ON ui_items(session_id, id);
      CREATE TABLE IF NOT EXISTS folders (path TEXT PRIMARY KEY, added_at INTEGER);
    `)
    const cols = (this.db.prepare('PRAGMA table_info(sessions)').all() as any[]).map((c) => c.name)
    if (!cols.includes('parent_id')) this.db.exec('ALTER TABLE sessions ADD COLUMN parent_id TEXT')
    if (!cols.includes('fork_turn')) this.db.exec('ALTER TABLE sessions ADD COLUMN fork_turn INTEGER')
    if (!cols.includes('reasoning')) this.db.exec('ALTER TABLE sessions ADD COLUMN reasoning TEXT')
    if (!cols.includes('turn_map')) this.db.exec('ALTER TABLE sessions ADD COLUMN turn_map TEXT')
    if (!cols.includes('compact_offset')) this.db.exec('ALTER TABLE sessions ADD COLUMN compact_offset INTEGER')
    if (!cols.includes('sort_order')) this.db.exec('ALTER TABLE sessions ADD COLUMN sort_order INTEGER')
    this.db.exec('CREATE TABLE IF NOT EXISTS bookmarks (id TEXT PRIMARY KEY, kind TEXT, name TEXT, session_id TEXT, parent_id TEXT, sort_order INTEGER, collapsed INTEGER DEFAULT 0)')
    if (!cols.includes('mode')) this.db.exec('ALTER TABLE sessions ADD COLUMN mode TEXT')
    if (!cols.includes('memories')) this.db.exec('ALTER TABLE sessions ADD COLUMN memories TEXT')
    this.db.exec('INSERT OR IGNORE INTO folders (path, added_at) SELECT DISTINCT cwd, MIN(created_at) FROM sessions GROUP BY cwd')
  }

  listFolders(): FolderRow[] {
    return this.db.prepare('SELECT * FROM folders ORDER BY added_at').all() as unknown as FolderRow[]
  }
  addFolder(p: string) {
    this.db.prepare('INSERT OR IGNORE INTO folders (path, added_at) VALUES (?, ?)').run(p, Date.now())
  }
  removeFolder(p: string) {
    for (const s of this.listSessions().filter((x) => x.cwd === p)) this.deleteSession(s.id)
    this.db.prepare('DELETE FROM folders WHERE path = ?').run(p)
  }

  listSessions(): SessionRow[] {
    return this.db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 1000').all() as unknown as SessionRow[]
  }
  getSession(id: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as unknown as SessionRow | undefined
  }
  createSession(r: SessionRow) {
    this.db.prepare('INSERT INTO sessions (id, title, cwd, model, created_at, updated_at, parent_id, fork_turn, reasoning, mode, memories, compact_offset, turn_map) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(r.id, r.title, r.cwd, r.model, r.created_at, r.updated_at, r.parent_id, r.fork_turn, r.reasoning ?? null, r.mode ?? null, r.memories ?? null, r.compact_offset ?? null, r.turn_map ?? null)
    this.addFolder(r.cwd)
  }
  /** Persists a manual order for sibling sessions (index = position). Does not bump updated_at. */
  setOrder(ids: string[]) {
    const st = this.db.prepare('UPDATE sessions SET sort_order = ? WHERE id = ?')
    ids.forEach((id, i) => st.run(i, id))
  }

  listBookmarks(): BookmarkRow[] {
    return this.db.prepare('SELECT * FROM bookmarks ORDER BY sort_order').all() as unknown as BookmarkRow[]
  }
  private nextBookmarkOrder(parent: string | null) {
    const r = this.db.prepare('SELECT MAX(sort_order) AS m FROM bookmarks WHERE parent_id IS ?').get(parent) as any
    return (r?.m ?? -1) + 1
  }
  addBookmark(b: Omit<BookmarkRow, 'sort_order' | 'collapsed'>) {
    if (b.kind === 'pin' && this.db.prepare("SELECT 1 FROM bookmarks WHERE kind = 'pin' AND session_id = ?").get(b.session_id)) return
    this.db.prepare('INSERT INTO bookmarks (id, kind, name, session_id, parent_id, sort_order, collapsed) VALUES (?, ?, ?, ?, ?, ?, 0)')
      .run(b.id, b.kind, b.name, b.session_id, b.parent_id, this.nextBookmarkOrder(b.parent_id))
  }
  updateBookmark(id: string, patch: Partial<Pick<BookmarkRow, 'name' | 'parent_id' | 'collapsed'>>) {
    const cur = this.db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(id) as unknown as BookmarkRow | undefined
    if (!cur) return
    const n = { ...cur, ...patch }
    const order = patch.parent_id !== undefined && patch.parent_id !== cur.parent_id ? this.nextBookmarkOrder(n.parent_id) : cur.sort_order
    this.db.prepare('UPDATE bookmarks SET name = ?, parent_id = ?, collapsed = ?, sort_order = ? WHERE id = ?').run(n.name, n.parent_id, n.collapsed, order, id)
  }
  /** Moves a bookmark under `parent` (null = top), positioned before/after `targetId` or appended. Refuses folder cycles. */
  placeBookmark(id: string, parent: string | null, targetId: string | null, before: boolean) {
    const all = this.listBookmarks()
    if (!all.some((b) => b.id === id) || (parent && isWithin(all, id, parent))) return
    this.db.prepare('UPDATE bookmarks SET parent_id = ? WHERE id = ?').run(parent, id)
    const sibs = all.filter((b) => b.parent_id === parent && b.id !== id).map((b) => b.id)
    this.setBookmarkOrder(reorderIds(sibs, id, targetId, before))
  }
  pinId(sessionId: string): string | undefined {
    return (this.db.prepare("SELECT id FROM bookmarks WHERE kind = 'pin' AND session_id = ?").get(sessionId) as any)?.id
  }
  setBookmarkOrder(ids: string[]) {
    const st = this.db.prepare('UPDATE bookmarks SET sort_order = ? WHERE id = ?')
    ids.forEach((id, i) => st.run(i, id))
  }
  /** Removes a bookmark; a folder's contents move up to its parent. */
  removeBookmark(id: string) {
    const cur = this.db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(id) as unknown as BookmarkRow | undefined
    if (!cur) return
    this.db.prepare('UPDATE bookmarks SET parent_id = ? WHERE parent_id = ?').run(cur.parent_id, id)
    this.db.prepare('DELETE FROM bookmarks WHERE id = ?').run(id)
  }

  setTurnMap(id: string, map: number[]) { this.db.prepare('UPDATE sessions SET turn_map = ?, compact_offset = NULL WHERE id = ?').run(JSON.stringify(map), id) }

  updateSession(id: string, patch: Partial<Pick<SessionRow, 'title' | 'model' | 'cwd' | 'reasoning' | 'mode' | 'memories'>>) {
    const cur = this.getSession(id)
    if (!cur) return
    const n = { ...cur, ...patch }
    this.db.prepare('UPDATE sessions SET title = ?, model = ?, cwd = ?, reasoning = ?, mode = ?, memories = ?, updated_at = ? WHERE id = ?')
      .run(n.title, n.model, n.cwd, n.reasoning ?? null, n.mode ?? null, n.memories ?? null, Date.now(), id)
  }
  /** Deletes a session; its forks are re-parented to the deleted session's parent. */
  deleteSession(id: string) {
    const row = this.getSession(id)
    this.db.prepare('UPDATE sessions SET parent_id = ? WHERE parent_id = ?').run(row?.parent_id ?? null, id)
    for (const t of ['messages', 'ui_items']) this.db.prepare(`DELETE FROM ${t} WHERE session_id = ?`).run(id)
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
    this.db.prepare("DELETE FROM bookmarks WHERE kind = 'pin' AND session_id = ?").run(id)
  }

  /** Replaces the stored main-agent history (system message excluded). */
  saveMessages(sessionId: string, msgs: Message[]) {
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId)
      const ins = this.db.prepare('INSERT INTO messages (session_id, seq, content_json) VALUES (?, ?, ?)')
      msgs.forEach((m, i) => ins.run(sessionId, i, JSON.stringify(m)))
      this.db.exec('COMMIT')
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
  }
  loadMessages(sessionId: string): Message[] {
    return (this.db.prepare('SELECT content_json FROM messages WHERE session_id = ? ORDER BY seq').all(sessionId) as any[]).map((r) => JSON.parse(r.content_json))
  }

  saveUiItems(sessionId: string, items: unknown[]) {
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM ui_items WHERE session_id = ?').run(sessionId)
      const ins = this.db.prepare('INSERT INTO ui_items (session_id, item_json) VALUES (?, ?)')
      for (const it of items) ins.run(sessionId, JSON.stringify(it))
      this.db.exec('COMMIT')
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
  }
  loadUiItems(sessionId: string): unknown[] {
    return (this.db.prepare('SELECT item_json FROM ui_items WHERE session_id = ? ORDER BY id').all(sessionId) as any[]).map((r) => JSON.parse(r.item_json))
  }
}
