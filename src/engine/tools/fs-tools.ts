import fs from 'node:fs'
import path from 'node:path'
import type { ToolDef } from './types'
import { globToRegExp, head, resolvePath } from './util'

const SKIP = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'out', 'dist', '.DS_Store'])

export function* walk(root: string, limit = 20000): Generator<string> {
  const stack = [root]
  let n = 0
  while (stack.length) {
    const d = stack.pop()!
    let ents: fs.Dirent[]
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { continue }
    for (const e of ents) {
      if (SKIP.has(e.name)) continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.isFile()) { yield p; if (++n >= limit) return }
    }
  }
}

export const readFile: ToolDef = {
  name: 'read_file',
  description: 'Read a text file. Optionally pass a 1-based inclusive line range [start, end] (end -1 = EOF). Output is capped at 50KB.',
  parameters: { type: 'object', properties: { path: { type: 'string' }, start: { type: 'integer' }, end: { type: 'integer' } }, required: ['path'] },
  async run(a, ctx) {
    const p = resolvePath(ctx.cwd, a.path)
    const st = fs.statSync(p)
    if (st.isDirectory()) return fs.readdirSync(p).sort().join('\n')
    let txt = fs.readFileSync(p, 'utf8')
    if (a.start) {
      const lines = txt.split('\n')
      const end = !a.end || a.end < 0 ? lines.length : a.end
      txt = lines.slice(a.start - 1, end).map((l, i) => `${a.start + i}. ${l}`).join('\n')
    }
    return head(txt, 50_000)
  }
}

export const writeFile: ToolDef = {
  name: 'write_file',
  description: 'Create or overwrite a file with the given content. Parent directories are created.',
  parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  permission: 'write',
  summarize: (a) => `write ${a.path} (${String(a.content ?? '').length} chars)`,
  async run(a, ctx) {
    const p = resolvePath(ctx.cwd, a.path)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, a.content ?? '')
    return `wrote ${p}`
  }
}

export const editFile: ToolDef = {
  name: 'edit_file',
  description: 'Replace exactly one occurrence of old_str with new_str in a file. Fails if old_str is missing or not unique.',
  parameters: { type: 'object', properties: { path: { type: 'string' }, old_str: { type: 'string' }, new_str: { type: 'string' } }, required: ['path', 'old_str', 'new_str'] },
  permission: 'write',
  summarize: (a) => `edit ${a.path}`,
  async run(a, ctx) {
    const p = resolvePath(ctx.cwd, a.path)
    const src = fs.readFileSync(p, 'utf8')
    const count = src.split(a.old_str).length - 1
    if (count === 0) throw new Error('old_str not found')
    if (count > 1) throw new Error(`old_str is not unique (${count} matches); include more context`)
    fs.writeFileSync(p, src.replace(a.old_str, () => a.new_str))
    return `edited ${p}`
  }
}

export const glob: ToolDef = {
  name: 'glob',
  description: 'Find files by glob pattern (e.g. "**/*.py") relative to path (default: working folder). Returns up to 200 paths.',
  parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] },
  async run(a, ctx) {
    const root = resolvePath(ctx.cwd, a.path ?? '.')
    const re = globToRegExp(a.pattern.includes('/') ? a.pattern : `**/${a.pattern}`)
    const out: string[] = []
    for (const f of walk(root)) {
      const rel = path.relative(root, f).split(path.sep).join('/')
      if (re.test(rel)) { out.push(rel); if (out.length >= 200) break }
    }
    return out.length ? out.sort().join('\n') : 'no matches'
  }
}
