import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** Where chats and settings live: $AITM_HOME, else an explicit --user-data-dir profile, else ~/.aitm-desk. */
export function resolveDataHome(o: { env: Record<string, string | undefined>; home: string; profileDir?: string }): string {
  return o.env.AITM_HOME || o.profileDir || path.join(o.home, '.aitm-desk')
}

/**
 * One-time move from the old Electron userData folder. Copies (never moves) so the
 * old files remain as a backup; skipped once the new folder already has a database.
 */
export function migrateDataHome(from: string, to: string): string[] {
  if (path.resolve(from) === path.resolve(to)) return []
  const oldDb = path.join(from, 'aitm.db')
  const newDb = path.join(to, 'aitm.db')
  if (!fs.existsSync(oldDb) || fs.existsSync(newDb)) return []
  fs.mkdirSync(to, { recursive: true })
  const copied: string[] = []
  const src = new DatabaseSync(oldDb)
  try {
    // VACUUM INTO folds pending WAL pages into one consistent file.
    src.exec(`VACUUM INTO '${newDb.replace(/'/g, "''")}'`)
    copied.push('aitm.db')
  } finally {
    src.close()
  }
  const oldSettings = path.join(from, 'settings.json')
  if (fs.existsSync(oldSettings)) {
    fs.copyFileSync(oldSettings, path.join(to, 'settings.json'))
    copied.push('settings.json')
  }
  return copied
}
