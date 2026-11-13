import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { ToolDef } from './types'
import { globToRegExp, head, resolvePath } from './util'
import { walk } from './fs-tools'

function rg(args: string[], cwd: string, signal: AbortSignal): Promise<string | null> {
  return new Promise((resolve) => {
    const p = spawn('rg', args, { cwd, signal })
    let out = ''
    p.stdout.on('data', (d) => { out += d; if (out.length > 200_000) p.kill() })
    p.on('error', () => resolve(null))
    p.on('close', () => resolve(out))
  })
}

export const grep: ToolDef = {
  name: 'grep',
  description: 'Search file contents with a regex. Returns path:line:text matches (max 200). Optional glob filter and case-insensitive flag.',
  parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' }, ignore_case: { type: 'boolean' } }, required: ['pattern'] },
  async run(a, ctx) {
    const root = resolvePath(ctx.cwd, a.path ?? '.')
    const args = ['-n', '--no-heading', '--max-count', '50', '-m', '50']
    if (a.ignore_case) args.push('-i')
    if (a.glob) args.push('-g', a.glob)
    args.push('-e', a.pattern, '.')
    const viaRg = await rg(args, root, ctx.signal)
    if (viaRg !== null) {
      const lines = viaRg.split('\n').filter(Boolean).slice(0, 200).map((l) => l.replace(/^\.\//, ''))
      return lines.length ? head(lines.join('\n'), 30_000) : 'no matches'
    }
    const re = new RegExp(a.pattern, a.ignore_case ? 'i' : '')
    const g = a.glob ? globToRegExp(a.glob.includes('/') ? a.glob : `**/${a.glob}`) : null
    const out: string[] = []
    for (const f of walk(root)) {
      const rel = path.relative(root, f).split(path.sep).join('/')
      if (g && !g.test(rel)) continue
      let txt: string
      try { if (fs.statSync(f).size > 2_000_000) continue; txt = fs.readFileSync(f, 'utf8') } catch { continue }
      txt.split('\n').forEach((l, i) => { if (out.length < 200 && re.test(l)) out.push(`${rel}:${i + 1}:${l}`) })
      if (out.length >= 200) break
    }
    return out.length ? head(out.join('\n'), 30_000) : 'no matches'
  }
}
