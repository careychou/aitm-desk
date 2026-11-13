import path from 'node:path'

export function resolvePath(cwd: string, p: string): string {
  const expanded = p.startsWith('~/') ? path.join(process.env.HOME ?? '', p.slice(2)) : p
  return path.resolve(cwd, expanded)
}

/** Keeps the last `max` characters, noting how much was dropped. */
export function tail(s: string, max: number): string {
  if (s.length <= max) return s
  return `[...truncated ${s.length - max} chars...]\n` + s.slice(s.length - max)
}

export function head(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + `\n[...truncated ${s.length - max} chars...]`
}

/** Converts a glob (supports **, *, ?, {a,b}) to an anchored RegExp over posix paths. */
export function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?' } else re += '.*'
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if (c === '{') {
      const end = glob.indexOf('}', i)
      re += '(?:' + glob.slice(i + 1, end).split(',').map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|') + ')'
      i = end
    } else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&')
  }
  return new RegExp('^' + re + '$')
}
