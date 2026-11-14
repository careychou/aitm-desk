import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile, execFileSync } from 'node:child_process'
import { localReport, projectReport, type Pricing, type UsageReport } from '../shared/usage'
import type { Store } from './store'

/** First readable pricing.json: explicit setting, data home, then the HEB model proxy install. */
export function loadPricing(explicit: string, dataHome: string): { pricing: Pricing | null; path: string | null } {
  const cands = [explicit, path.join(dataHome, 'pricing.json'), path.join(os.homedir(), 'heb-model-proxy', 'pricing.json')].filter(Boolean)
  for (const p of cands) {
    try { const j = JSON.parse(fs.readFileSync(p.replace(/^~(?=\/)/, os.homedir()), 'utf8')); if (j?.models) return { pricing: j, path: p } } catch { /* next */ }
  }
  return { pricing: null, path: null }
}

/** Absolute path of `cmd` on PATH, or null. */
export function which(cmd: string): string | null {
  if (cmd.includes('/')) return fs.existsSync(cmd.replace(/^~(?=\/)/, os.homedir())) ? cmd.replace(/^~(?=\/)/, os.homedir()) : null
  for (const d of (process.env.PATH ?? '').split(':')) { const p = path.join(d, cmd); try { fs.accessSync(p, fs.constants.X_OK); return p } catch { /* next */ } }
  return null
}

/** The configured project-usage command, or `heb-llm-cost` when it is installed. */
export function usageCommand(configured: string): string | null {
  return configured.trim() ? configured.trim() : (which('heb-llm-cost') ? 'heb-llm-cost' : null)
}

export interface ProxyRuntime { python: string | null; env: Record<string, string> }
let proxyRt: ProxyRuntime | undefined

/** Runtime of the local model proxy LaunchAgent (its python + env, incl. GOOGLE_APPLICATION_CREDENTIALS) so usage tools reuse its service account. */
export function proxyRuntime(): ProxyRuntime {
  if (proxyRt) return proxyRt
  proxyRt = { python: null, env: {} }
  const dir = path.join(os.homedir(), 'Library', 'LaunchAgents')
  let files: string[] = []
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.plist')) } catch { /* none */ }
  files.sort((a, b) => Number(!/proxy/i.test(a)) - Number(!/proxy/i.test(b)))
  for (const f of files) {
    try {
      const j = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(dir, f)], { encoding: 'utf8', timeout: 5000 }))
      const args: string[] = j.ProgramArguments ?? []
      if (!args.some((a) => /proxy\.py$/.test(a))) continue
      const py = args.find((a) => /python3?(\.\d+)?$/.test(path.basename(a)))
      proxyRt = { python: py && fs.existsSync(py) ? py : null, env: j.EnvironmentVariables ?? {} }
      break
    } catch { /* next */ }
  }
  const key = proxyRt.env.GOOGLE_APPLICATION_CREDENTIALS ?? path.join(os.homedir(), 'heb-model-proxy', 'sa-key.json')
  if (fs.existsSync(key)) proxyRt.env.GOOGLE_APPLICATION_CREDENTIALS = key
  else delete proxyRt.env.GOOGLE_APPLICATION_CREDENTIALS
  return proxyRt
}

/** How to launch a usage command: python scripts run under the proxy's interpreter (GUI apps get the system python, which lacks google-auth). */
export function usageLaunch(exe: string, args: string[], rt: ProxyRuntime, base: NodeJS.ProcessEnv = process.env): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  const env: NodeJS.ProcessEnv = { ...base, ...rt.env }
  env.PATH = [rt.env.PATH, '/opt/homebrew/bin', path.join(os.homedir(), '.local/bin'), base.PATH].filter(Boolean).join(':')
  if (base.GOOGLE_APPLICATION_CREDENTIALS && !rt.env.GOOGLE_APPLICATION_CREDENTIALS) env.GOOGLE_APPLICATION_CREDENTIALS = base.GOOGLE_APPLICATION_CREDENTIALS
  let shebang = ''
  try { const fd = fs.openSync(exe, 'r'); const b = Buffer.alloc(128); fs.readSync(fd, b, 0, 128, 0); fs.closeSync(fd); shebang = b.toString('utf8').split('\n')[0] } catch { /* not a file */ }
  if (rt.python && /^#!.*python/.test(shebang)) return { file: rt.python, args: [exe, ...args], env }
  return { file: exe, args, env }
}

export function getLocalUsage(store: Store, days: number, pricingPath: string, dataHome: string): UsageReport {
  const now = Date.now()
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (days - 1))
  const { pricing } = loadPricing(pricingPath, dataHome)
  return localReport(store.usageSince(d.getTime()) as any, pricing, d.getTime(), now)
}

/** Run `<cmd> --days N --by model,day --json` (heb-llm-cost contract) and turn it into a report. */
export function getProjectUsage(configured: string, days: number, pricingPath: string, dataHome: string): Promise<UsageReport> {
  const empty = (error: string): UsageReport => ({ source: 'project', start: '', end: '', total: { key: 'total', input: 0, cached: 0, cacheWrite: 0, output: 0, requests: 0, cost: 0 }, byDay: [], byModel: [], warnings: [], error })
  const cmd = usageCommand(configured)
  if (!cmd) return Promise.resolve(empty('No project usage command configured. Install heb-llm-cost (st-eng-llm-proxy) or set one in Settings → Usage.'))
  const [bin, ...pre] = cmd.split(/\s+/)
  const exe = which(bin) ?? bin
  const { pricing } = loadPricing(pricingPath, dataHome)
  return new Promise((resolve) => {
    const run = usageLaunch(exe, [...pre, '--days', String(days), '--by', 'model,day', '--json'], proxyRuntime())
    execFile(run.file, run.args, { env: run.env, timeout: 120000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout.trim()) {
        const msg = (stderr || err.message).trim().split('\n').slice(-3).join('\n')
        return resolve(empty((err as any).code === 'ENOENT' ? `Command not found: ${bin}` : /403|PERMISSION|permission/i.test(msg) ? `Permission denied — needs roles/monitoring.viewer on the project.\n${msg}` : msg))
      }
      try { resolve(projectReport(JSON.parse(stdout), pricing)) } catch (e: any) { resolve(empty(`Could not parse output of ${bin}: ${e.message}`)) }
    })
  })
}
