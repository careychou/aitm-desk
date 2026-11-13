import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Message } from '../engine/types'

export interface SessionRow { id: string; title: string; cwd: string; model: string; created_at: number; updated_at: number; parent_id: string | null; fork_turn: number | null; reasoning?: string | null; memories?: string | null }
export interface FolderRow { path: string; added_at: number }

/** SQLite persistence for sessions, the main-agent message history, and UI event log. */
export class Store {
  private db: DatabaseSync
  constructor(dir: string) {
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
    this.db.prepare('INSERT INTO sessions (id, title, cwd, model, created_at, updated_at, parent_id, fork_turn, reasoning, memories) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(r.id, r.title, r.cwd, r.model, r.created_at, r.updated_at, r.parent_id, r.fork_turn, r.reasoning ?? null, r.memories ?? null)
    this.addFolder(r.cwd)
  }
  updateSession(id: string, patch: Partial<Pick<SessionRow, 'title' | 'model' | 'cwd' | 'reasoning' | 'memories'>>) {
    const cur = this.getSession(id)
    if (!cur) return
    const n = { ...cur, ...patch }
    this.db.prepare('UPDATE sessions SET title = ?, model = ?, cwd = ?, reasoning = ?, memories = ?, updated_at = ? WHERE id = ?')
      .run(n.title, n.model, n.cwd, n.reasoning ?? null, n.memories ?? null, Date.now(), id)
  }
  /** Deletes a session; its forks are re-parented to the deleted session's parent. */
  deleteSession(id: string) {
    const row = this.getSession(id)
    this.db.prepare('UPDATE sessions SET parent_id = ? WHERE parent_id = ?').run(row?.parent_id ?? null, id)
    for (const t of ['messages', 'ui_items']) this.db.prepare(`DELETE FROM ${t} WHERE session_id = ?`).run(id)
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
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
