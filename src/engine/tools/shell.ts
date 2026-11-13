import { spawn } from 'node:child_process'
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

export const shell: ToolDef = {
  name: 'shell',
  description: 'Run a shell command (zsh -lc) in the working folder. Use it to run scripts you wrote (python x.py, node y.js), install packages, inspect the system. timeout seconds: default 120, max 600. Output is capped at 30KB (tail kept).',
  parameters: { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'integer' } }, required: ['command'] },
  permission: 'shell',
  summarize: (a) => String(a.command),
  async run(a, ctx) {
    const t = Math.min(Math.max(Number(a.timeout) || 120, 1), 600)
    const r = await runShell(a.command, ctx.cwd, t, ctx.signal)
    const status = r.timedOut ? `timed out after ${t}s` : `exit code ${r.code}`
    return `${r.output}\n<${status}>`
  }
}
