import { describe, it, expect } from 'vitest'
import { localReport, pricingKey, projectReport, type Pricing } from '../src/shared/usage'

const pricing: Pricing = {
  as_of: '2026-11-01',
  models: {
    'claude-sonnet-5': { prices: [{ from: '2025-01-01', input: 3, output: 15, cache_read_input: 0.3, cache_write_input: 3.75 }, { from: '2026-12-01', input: 1, output: 5 }] },
    'glm-5.2-maas': { prices: [{ from: '2025-01-01', input: 1, output: 2 }] }
  }
}
const ts = (d: string) => new Date(`${d}T12:00:00`).getTime()

describe('usage', () => {
  it('maps provider-prefixed model ids to pricing keys', () => {
    expect(pricingKey('anthropic/claude-sonnet-5', pricing)).toBe('claude-sonnet-5')
    expect(pricingKey('zai-org/glm-5.2', pricing)).toBe('glm-5.2-maas')
  })

  it('prices local calls with cached tokens split out, by the price in effect that day', () => {
    const r = localReport([
      // 1M prompt of which 600K cached + 100K cache write -> 300K uncached input
      { ts: ts('2026-11-10'), session_id: 'a', title: 'Chat A', model: 'anthropic/claude-sonnet-5', prompt: 1_000_000, cached: 600_000, cache_write: 100_000, completion: 100_000 },
      { ts: ts('2026-12-02'), session_id: 'b', title: null, model: 'anthropic/claude-sonnet-5', prompt: 1_000_000, cached: 0, cache_write: 0, completion: 0 }
    ], pricing, 0, Date.now())
    // 0.3*3 + 0.6*0.3 + 0.1*3.75 + 0.1*15 = 2.955 ; second day uses the new $1 input price
    expect(r.byDay.map((d) => [d.key, +d.cost!.toFixed(3)])).toEqual([['2026-11-10', 2.955], ['2026-12-02', 1]])
    expect(r.total.requests).toBe(2)
    expect(r.byChat!.map((c) => c.label)).toEqual(['Chat A', '(deleted chat)'])
  })

  it('counts tokens but flags models without a price', () => {
    const r = localReport([{ ts: ts('2026-11-10'), session_id: 'a', title: 'x', model: 'mystery', prompt: 10, cached: 0, cache_write: 0, completion: 5 }], pricing, 0, Date.now())
    expect(r.total.output).toBe(5)
    expect(r.total.cost).toBe(0)
    expect(r.warnings[0]).toMatch(/mystery: no price/)
  })

  it('falls back to the command estimate when there is no local pricing file', () => {
    const r = projectReport({ project: 'p', start: 's', end: 'e', pricing_as_of: '2026-10-01', warnings: [], rows: [
      { day: '2026-11-10', model: 'claude-sonnet-5', input: 10, output: 20, cache_read_input: 0, cache_write_input: 0, est_cost_usd: 1.5 },
      { day: '2026-11-11', model: 'glm-5.2-maas', input: 10, output: 20, est_cost_usd: 0.5 }
    ] }, null)
    expect(r.total.cost).toBe(2)
    expect(r.byModel.find((m) => m.key === 'glm-5.2-maas')!.cost).toBe(0.5)
    expect(r.warnings).toEqual([])
    expect(r.pricingAsOf).toBe('2026-10-01')
  })
})

describe('usageLaunch', () => {
  it('runs python scripts under the proxy interpreter with its service-account env', async () => {
    const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path')
    const { usageLaunch } = await import('../src/main/usage')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ul-'))
    const py = path.join(dir, 'cost'); fs.writeFileSync(py, '#!/usr/bin/env python3\nprint(1)\n')
    const sh = path.join(dir, 'cost.sh'); fs.writeFileSync(sh, '#!/bin/sh\necho 1\n')
    const rt = { python: '/opt/homebrew/bin/python3', env: { GOOGLE_APPLICATION_CREDENTIALS: '/k/sa.json', PATH: '/opt/gcloud/bin' } }
    const a = usageLaunch(py, ['--json'], rt, { PATH: '/usr/bin' })
    expect(a.file).toBe('/opt/homebrew/bin/python3')
    expect(a.args).toEqual([py, '--json'])
    expect(a.env.GOOGLE_APPLICATION_CREDENTIALS).toBe('/k/sa.json')
    expect(a.env.PATH!.split(':')[0]).toBe('/opt/gcloud/bin')
    const b = usageLaunch(sh, ['--json'], rt, { PATH: '/usr/bin', GOOGLE_APPLICATION_CREDENTIALS: '/user.json' })
    expect(b.file).toBe(sh)
    expect(b.env.GOOGLE_APPLICATION_CREDENTIALS).toBe('/k/sa.json')
    const c = usageLaunch(py, [], { python: null, env: {} }, { PATH: '/usr/bin', GOOGLE_APPLICATION_CREDENTIALS: '/user.json' })
    expect(c.file).toBe(py)
    expect(c.env.GOOGLE_APPLICATION_CREDENTIALS).toBe('/user.json')
  })
})
