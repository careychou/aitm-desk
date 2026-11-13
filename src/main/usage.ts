import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
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
    execFile(exe, [...pre, '--days', String(days), '--by', 'model,day', '--json'], { timeout: 120000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout.trim()) {
        const msg = (stderr || err.message).trim().split('\n').slice(-3).join('\n')
        return resolve(empty((err as any).code === 'ENOENT' ? `Command not found: ${bin}` : /403|PERMISSION|permission/i.test(msg) ? `Permission denied — needs roles/monitoring.viewer on the project.\n${msg}` : msg))
      }
      try { resolve(projectReport(JSON.parse(stdout), pricing)) } catch (e: any) { resolve(empty(`Could not parse output of ${bin}: ${e.message}`)) }
    })
  })
}
