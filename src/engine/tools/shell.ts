import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { ToolDef } from './types'
import { tail } from './util'

export const MAX_OUTPUT = 30_000

export function runShell(command: string, cwd: string, timeoutSec: number, signal: AbortSignal): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const p = spawn('/bin/zsh', ['-lc', command], { cwd, detached: true, env: { ...process.env, PAGER: 'cat', GIT_PAGER: 'cat' } })
    let out = ''
    let timedOut = false
    const onData = (d: Buffer) => { out += d.toString(); if (out.length > MAX_OUTPUT * 4) out = out.slice(-MAX_OUTPUT * 2) }
    p.stdout.on('data', onData)
    p.stderr.on('data', onData)
    const kill = () => {
      try { process.kill(-p.pid!, 'SIGTERM') } catch { /* gone */ }
      setTimeout(() => { try { process.kill(-p.pid!, 'SIGKILL') } catch { /* gone */ } }, 3000).unref()
    }
    const timer = setTimeout(() => { timedOut = true; kill() }, timeoutSec * 1000)
    const onAbort = () => kill()
    signal.addEventListener('abort', onAbort, { once: true })
    p.on('close', (code) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve({ code, output: tail(out, MAX_OUTPUT), timedOut })
    })
    p.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, output: String(e), timedOut }) })
  })
}

interface BgShell { id: string; command: string; description: string; p: ChildProcessWithoutNullStreams; out: string; read: number; code: number | null; done: boolean; started: number }

/** Background shells started with mode "async": they keep running across turns until stopped. */
export class ShellManager {
  private shells = new Map<string, BgShell>()
  private n = 0

  start(command: string, description: string, cwd: string): BgShell {
    const id = `shell-${++this.n}`
    const p = spawn('/bin/zsh', ['-lc', command], { cwd, detached: true, env: { ...process.env, PAGER: 'cat', GIT_PAGER: 'cat' } })
    const sh: BgShell = { id, command, description, p, out: '', read: 0, code: null, done: false, started: Date.now() }
    const onData = (d: Buffer) => {
      sh.out += d.toString()
      // keep memory bounded; shift the read cursor with the dropped prefix
      if (sh.out.length > MAX_OUTPUT * 8) { const cut = sh.out.length - MAX_OUTPUT * 4; sh.out = sh.out.slice(cut); sh.read = Math.max(0, sh.read - cut) }
    }
    p.stdout.on('data', onData)
    p.stderr.on('data', onData)
    p.on('close', (code) => { sh.code = code; sh.done = true })
    p.on('error', (e) => { sh.out += String(e); sh.done = true; sh.code = -1 })
    this.shells.set(id, sh)
    return sh
  }

  get(id: string): BgShell {
    const sh = this.shells.get(id)
    if (!sh) throw new Error(`unknown shellId "${id}". Use list_shells to see running shells.`)
    return sh
  }

  /** Waits up to `seconds` (returning early when the shell exits) and returns output not yet read. */
  async readNew(id: string, seconds: number, signal?: AbortSignal): Promise<string> {
    const sh = this.get(id)
    const until = Date.now() + seconds * 1000
    while (!sh.done && Date.now() < until && !signal?.aborted) await new Promise((r) => setTimeout(r, 100))
    const chunk = sh.out.slice(sh.read)
    sh.read = sh.out.length
    const status = sh.done ? `exited with code ${sh.code}` : 'still running'
    return `${tail(chunk, MAX_OUTPUT) || '(no new output)'}\n<${sh.id} ${status}>`
  }

  write(id: string, input: string) {
    const sh = this.get(id)
    if (sh.done) throw new Error(`${id} has already exited`)
    sh.p.stdin.write(input)
  }

  stop(id: string) { const sh = this.get(id); kill(sh.p.pid); return sh }

  list() { return [...this.shells.values()] }

  /** Kills every background shell (session closed or app quitting). */
  dispose() { for (const sh of this.shells.values()) if (!sh.done) kill(sh.p.pid); this.shells.clear() }
}

function kill(pid?: number) {
  if (!pid) return
  try { process.kill(-pid, 'SIGTERM') } catch { /* gone */ }
  setTimeout(() => { try { process.kill(-pid, 'SIGKILL') } catch { /* gone */ } }, 3000).unref()
}

const DESCRIPTION = { type: 'string', description: 'A short human-readable description of what this does (max ~60 chars), e.g. "Install dependencies" or "Run unit tests". Shown to the user instead of the raw command.' }

export const shell: ToolDef = {
  name: 'shell',
  description: 'Run a shell command (zsh -lc) in the working folder: run scripts you wrote (python x.py, node y.js), install packages, inspect the system. mode "sync" (default) waits for it to finish (timeout seconds: default 120, max 600). mode "async" starts it in the background, waits initial_wait seconds (default 10) and returns its output so far plus a shellId: use it for servers, watchers, long builds or interactive programs, then read_shell / write_shell / stop_shell. Output is capped at 30KB (tail kept).',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      description: DESCRIPTION,
      mode: { type: 'string', enum: ['sync', 'async'] },
      timeout: { type: 'integer', description: 'sync only: seconds before the command is killed' },
      initial_wait: { type: 'integer', description: 'async only: seconds to wait for initial output' }
    },
    required: ['command', 'description']
  },
  permission: 'shell',
  summarize: (a) => String(a.command),
  async run(a, ctx) {
    if (a.mode === 'async') {
      if (!ctx.shells) throw new Error('async shells are not available here')
      const sh = ctx.shells.start(a.command, a.description ?? '', ctx.cwd)
      const wait = Math.min(Math.max(Number(a.initial_wait) || 10, 1), 600)
      return `shellId: ${sh.id}\n` + (await ctx.shells.readNew(sh.id, wait, ctx.signal))
    }
    const t = Math.min(Math.max(Number(a.timeout) || 120, 1), 600)
    const r = await runShell(a.command, ctx.cwd, t, ctx.signal)
    const status = r.timedOut ? `timed out after ${t}s` : `exit code ${r.code}`
    return `${r.output}\n<${status}>`
  }
}

const SHELL_ID = { type: 'string', description: 'The shellId returned by shell with mode "async"' }
const need = (ctx: { shells?: ShellManager }) => { if (!ctx.shells) throw new Error('async shells are not available here'); return ctx.shells }

export const readShell: ToolDef = {
  name: 'read_shell',
  description: 'Read new output from an async shell. Waits up to delay seconds (default 5, max 600) or until it exits.',
  parameters: { type: 'object', properties: { shellId: SHELL_ID, delay: { type: 'integer' } }, required: ['shellId'] },
  async run(a, ctx) { return need(ctx).readNew(a.shellId, Math.min(Math.max(Number(a.delay) || 5, 0), 600), ctx.signal) }
}

export const writeShell: ToolDef = {
  name: 'write_shell',
  description: 'Send input to an async shell\'s stdin (add "\\n" to press Enter), then return new output after delay seconds (default 3).',
  parameters: { type: 'object', properties: { shellId: SHELL_ID, input: { type: 'string' }, delay: { type: 'integer' } }, required: ['shellId', 'input'] },
  permission: 'shell',
  summarize: (a) => `${a.shellId} ← ${JSON.stringify(a.input)}`,
  async run(a, ctx) { const m = need(ctx); m.write(a.shellId, a.input); return m.readNew(a.shellId, Math.min(Math.max(Number(a.delay) || 3, 0), 600), ctx.signal) }
}

export const stopShell: ToolDef = {
  name: 'stop_shell',
  description: 'Stop an async shell (kills its whole process tree).',
  parameters: { type: 'object', properties: { shellId: SHELL_ID }, required: ['shellId'] },
  async run(a, ctx) { const sh = need(ctx).stop(a.shellId); return `stopped ${sh.id}` }
}

export const listShells: ToolDef = {
  name: 'list_shells',
  description: 'List async shells in this chat with their status.',
  parameters: { type: 'object', properties: {} },
  async run(_a, ctx) {
    const all = need(ctx).list()
    return all.length ? all.map((s) => `${s.id}  ${s.done ? `exited(${s.code})` : 'running'}  ${s.description || s.command}`).join('\n') : 'no shells'
  }
}
