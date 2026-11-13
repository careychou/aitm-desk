import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ToolDef } from './types'
import { head } from './util'

const dbs = new Map<string, DatabaseSync>()

/** Opens (once) the chat's scratch database, with a ready-made todos table. */
export function sessionDb(stateDir: string): DatabaseSync {
  let db = dbs.get(stateDir)
  if (db) return db
  fs.mkdirSync(stateDir, { recursive: true })
  db = new DatabaseSync(path.join(stateDir, 'session.db'))
  db.exec(`CREATE TABLE IF NOT EXISTS todos (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, status TEXT DEFAULT 'pending' CHECK (status IN ('pending','in_progress','done','blocked')), created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS todo_deps (todo_id TEXT, depends_on TEXT, PRIMARY KEY (todo_id, depends_on));`)
  dbs.set(stateDir, db)
  return db
}

export function closeSessionDb(stateDir: string) { dbs.get(stateDir)?.close(); dbs.delete(stateDir) }

function table(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '(0 rows)'
  const cols = Object.keys(rows[0])
  const cell = (v: unknown) => (v === null ? 'NULL' : String(v).replace(/\n/g, ' ').replace(/\|/g, '\\|'))
  return [`| ${cols.join(' | ')} |`, `| ${cols.map(() => '---').join(' | ')} |`, ...rows.slice(0, 500).map((r) => `| ${cols.map((c) => cell(r[c])).join(' | ')} |`)].join('\n') + (rows.length > 500 ? `\n(${rows.length} rows, first 500 shown)` : `\n(${rows.length} rows)`)
}

export const sql: ToolDef = {
  name: 'sql',
  description: 'Run SQLite against this chat\'s private scratch database (persists for the chat). Tables todos(id, title, description, status pending|in_progress|done|blocked) and todo_deps(todo_id, depends_on) already exist: use them to plan and track multi-step work. Create other tables to hold intermediate results. Several statements may be separated by semicolons; SELECT results come back as a table.',
  parameters: { type: 'object', properties: { query: { type: 'string' }, description: { type: 'string', description: '2-5 word summary, e.g. "Insert todos"' } }, required: ['query'] },
  async run(a, ctx) {
    if (!ctx.stateDir) throw new Error('the sql tool is not available here')
    const db = sessionDb(ctx.stateDir)
    const q = String(a.query).trim()
    if (/^\s*(select|with|pragma)\b/i.test(q) && !/;\s*\S/.test(q.replace(/;\s*$/, ''))) return head(table(db.prepare(q).all() as Record<string, unknown>[]), 30_000)
    const before = (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
    db.exec(q)
    const after = (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
    return `OK (${after - before} row(s) changed)`
  }
}
