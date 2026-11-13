import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { shell, MAX_OUTPUT } from '../src/engine/tools/shell'
import { readFile, writeFile, editFile, glob } from '../src/engine/tools/fs-tools'
import { grep } from '../src/engine/tools/grep'
import type { ToolContext } from '../src/engine/tools/types'

let ctx: ToolContext
beforeAll(() => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-'))
  fs.mkdirSync(`${cwd}/src/a`, { recursive: true })
  fs.writeFileSync(`${cwd}/src/a/x.py`, 'print("hi")\nfoo = 1\n')
  fs.writeFileSync(`${cwd}/src/y.ts`, 'const foo = 2\n')
  fs.writeFileSync(`${cwd}/dup.txt`, 'aa bb aa')
  ctx = { cwd, agentId: 'a', depth: 0, signal: new AbortController().signal } as any
})

describe('shell', () => {
  it('runs code and reports exit code', async () => {
    const r = await shell.run({ command: 'python3 src/a/x.py; exit 3' }, ctx)
    expect(r).toContain('hi')
    expect(r).toContain('<exit code 3>')
  })
  it('times out', async () => {
    const r = await shell.run({ command: 'sleep 5', timeout: 1 }, ctx)
    expect(r).toContain('timed out after 1s')
  })
  it('truncates long output keeping the tail', async () => {
    const r = await shell.run({ command: `python3 -c "print('x'*${MAX_OUTPUT * 2}); print('END')"` }, ctx)
    expect(r).toContain('truncated')
    expect(r).toContain('END')
    expect(r.length).toBeLessThan(MAX_OUTPUT + 200)
  })
  it('aborts', async () => {
    const ac = new AbortController()
    const p = shell.run({ command: 'sleep 10' }, { ...ctx, signal: ac.signal })
    setTimeout(() => ac.abort(), 200)
    const t = Date.now()
    await p
    expect(Date.now() - t).toBeLessThan(4000)
  })
})

describe('fs tools', () => {
  it('reads a line range', async () => {
    expect(await readFile.run({ path: 'src/a/x.py', start: 2, end: 2 }, ctx)).toBe('2. foo = 1')
  })
  it('writes then edits uniquely', async () => {
    await writeFile.run({ path: 'new/f.txt', content: 'hello world' }, ctx)
    await editFile.run({ path: 'new/f.txt', old_str: 'world', new_str: 'there' }, ctx)
    expect(fs.readFileSync(`${ctx.cwd}/new/f.txt`, 'utf8')).toBe('hello there')
  })
  it('rejects non-unique edits', async () => {
    await expect(editFile.run({ path: 'dup.txt', old_str: 'aa', new_str: 'z' }, ctx)).rejects.toThrow(/not unique/)
  })
  it('globs', async () => {
    expect(await glob.run({ pattern: '*.py' }, ctx)).toBe('src/a/x.py')
    expect(await glob.run({ pattern: 'src/**/*.{py,ts}' }, ctx)).toBe('src/a/x.py\nsrc/y.ts')
  })
  it('greps', async () => {
    const r = await grep.run({ pattern: 'foo', glob: '*.ts' }, ctx)
    expect(r).toBe('src/y.ts:1:const foo = 2')
  })
})

describe('async shells', () => {
  it('starts, reads, writes and stops a background shell', async () => {
    const { ShellManager, shell: sh, readShell, writeShell, stopShell, listShells } = await import('../src/engine/tools/shell')
    const shells = new ShellManager()
    const c = { ...ctx, shells }
    const first = await sh.run({ command: 'echo ready; while read l; do echo "got $l"; done', description: 'Echo loop', mode: 'async', initial_wait: 1 }, c)
    expect(first).toContain('shellId: shell-1')
    expect(first).toContain('ready')
    expect(first).toContain('still running')
    expect(await writeShell.run({ shellId: 'shell-1', input: 'ping\n', delay: 1 }, c)).toContain('got ping')
    expect(await listShells.run({}, c)).toContain('running  Echo loop')
    await stopShell.run({ shellId: 'shell-1' }, c)
    expect(await readShell.run({ shellId: 'shell-1', delay: 3 }, c)).toMatch(/exited/)
    shells.dispose()
  })
})

describe('web_fetch', () => {
  it('converts html to markdown', async () => {
    const { htmlToMarkdown } = await import('../src/engine/tools/web')
    const md = htmlToMarkdown('<html><head><title>T</title><script>x()</script></head><body><h2>Hi &amp; bye</h2><p>See <a href="/a">link</a></p><ul><li>one</li></ul></body></html>', 'https://e.com/x')
    expect(md).toContain('# T')
    expect(md).toContain('## Hi & bye')
    expect(md).toContain('[link](https://e.com/a)')
    expect(md).toContain('- one')
    expect(md).not.toContain('x()')
  })
})

describe('sql', () => {
  it('uses a per-chat db with a todos table', async () => {
    const { sql, closeSessionDb } = await import('../src/engine/tools/sql')
    const stateDir = path.join(ctx.cwd, '.state')
    const c = { ...ctx, stateDir }
    expect(await sql.run({ query: "INSERT INTO todos (id, title) VALUES ('a', 'First'), ('b', 'Second')" }, c)).toContain('2 row(s)')
    const out = await sql.run({ query: "SELECT id, status FROM todos ORDER BY id" }, c)
    expect(out).toContain('| a | pending |')
    expect(out).toContain('(2 rows)')
    closeSessionDb(stateDir)
    expect(fs.existsSync(path.join(stateDir, 'session.db'))).toBe(true)
  })
})
