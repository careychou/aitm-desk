import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { autoCompactDecision, applyCompaction, clusterLexical, keepLastPlan, normalizeClusters, planTurns, priorSummary, splitHistoryTurns, clusterTurns } from '../src/engine/compact'
import { Session } from '../src/engine/engine'
import { COMPACT_TAG, sliceMessagesAtTurn } from '../src/shared/fork'
import type { ChatRequest, Delta, Message, ModelAdapter } from '../src/engine/types'

const turn = (q: string, a: string): Message[] => [{ role: 'user', content: q }, { role: 'assistant', content: a }]
const hist: Message[] = [
  ...turn('analyze beef pricing elasticity for ground beef', 'beef elasticity is -1.2'),
  ...turn('write a poem about the ocean', 'waves...'),
  { role: 'user', content: '<system_notification>bg done</system_notification>' }, { role: 'assistant', content: 'noted' },
  ...turn('compare ground beef pricing elasticity with chicken', 'chicken -0.8'),
  ...turn('what is next', 'next steps')
]

class Fake implements ModelAdapter {
  calls: ChatRequest[] = []
  constructor(private reply: (r: ChatRequest) => string) {}
  async *stream(req: ChatRequest): AsyncIterable<Delta> { this.calls.push(req); yield { type: 'text', text: this.reply(req) }; yield { type: 'finish', reason: 'stop' } }
}

describe('compaction', () => {
  it('splits turns, ignoring notifications as turn starts', () => {
    const t = splitHistoryTurns(hist)
    expect(t.map((x) => x.user.slice(0, 7))).toEqual(['analyze', 'write a', 'compare', 'what is'])
    expect(t[1].messages).toHaveLength(4)
  })

  it('lexical clustering groups non-adjacent turns on the same topic', () => {
    const c = normalizeClusters(clusterLexical(splitHistoryTurns(hist)), [0, 1, 2, 3])
    expect(c.find((x) => x.turns.includes(0))!.turns).toEqual([0, 2])
    expect(c.flatMap((x) => x.turns).sort()).toEqual([0, 1, 2, 3])
  })

  it('normalizes model clusters: dedupes, drops bad indexes, adds missing turns', () => {
    const c = normalizeClusters([{ label: 'a', turns: [0, 2, 9] }, { label: 'b', turns: [2] }], [0, 1, 2])
    expect(c).toEqual([{ label: 'a', turns: [0, 2] }, { label: 'Turn 2', turns: [1] }])
  })

  it('uses model clusters when the reply is valid JSON, else falls back', async () => {
    const t = splitHistoryTurns(hist)
    const ok = await clusterTurns(new Fake(() => 'Sure: {"clusters":[{"label":"Beef","turns":[1,3]},{"label":"Misc","turns":[2,4]}]}'), 'm', t)
    expect(ok.method).toBe('model')
    expect(ok.clusters.map((c) => c.turns)).toEqual([[0, 2], [1, 3]])
    const bad = await clusterTurns(new Fake(() => 'nope'), 'm', t)
    expect(bad.method).toBe('lexical')
  })

  it('applies a plan: summary head, recent turns verbatim, chained summaries, forks count real turns', () => {
    const t = splitHistoryTurns(hist)
    expect(keepLastPlan(4, 1)).toEqual({ keep: [3], summarize: [0, 1, 2] })
    const p = planTurns(t, { keep: [3], summarize: [0, 2, 3] })
    expect(p.summarized.map((x) => x.index)).toEqual([0, 2])
    expect(p.dropped.map((x) => x.index)).toEqual([1])
    const next = applyCompaction(hist, 'SUMMARY', [3])
    expect((next[0].content as string).startsWith(COMPACT_TAG)).toBe(true)
    expect(next.slice(2)).toEqual(turn('what is next', 'next steps'))
    expect(priorSummary(next)).toContain('SUMMARY')
    expect(splitHistoryTurns(next)).toHaveLength(1)
    expect(sliceMessagesAtTurn(next, 0)).toHaveLength(4)
  })

  it('Session.compact summarizes only chosen turns and rewrites history', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-'))
    const fake = new Fake((r) => `SUM(${(r.messages[1].content as string).includes('poem') ? 'poem' : 'nopoem'})`)
    const s = new Session({ adapter: fake, cwd, model: 'm', home: path.join(cwd, 'h'), history: hist, hooks: { onEvent() {}, requestPermission: async () => 'allow', askUser: async () => '' } })
    const r = await s.compact({ keep: [3], summarize: [0, 2] })
    expect(r).toMatchObject({ summarized: 2, dropped: 1, summary: 'SUM(nopoem)', kept: [3], compacted: [0, 2, 1] })
    expect(r.after).toBeLessThan(r.before)
    expect(s.history).toHaveLength(4)
    expect(s.messages[0].role).toBe('system')
  })

  it('keeps arbitrary (non-recent) turns verbatim in original order', async () => {
    const next = applyCompaction(hist, 'S', [0, 2])
    expect(splitHistoryTurns(next).map((t) => t.user.slice(0, 7))).toEqual(['analyze', 'compare'])
    expect(next[0].role).toBe('user')
  })
})

describe('compaction model', () => {
  const hooks = (events: any[]) => ({ onEvent: (e: any) => events.push(e), requestPermission: async () => 'allow' as const, askUser: async () => '' })

  it('summarizes with the compaction model and reports its usage under the compact agent', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-'))
    const calls: string[] = []
    const ad: ModelAdapter = { async *stream(r) { calls.push(r.model); yield { type: 'text', text: 'SUM' }; yield { type: 'usage', prompt: 900, completion: 40 }; yield { type: 'finish', reason: 'stop' } } }
    const events: any[] = []
    const s = new Session({ adapter: ad, cwd, model: 'big', compactModel: () => 'cheap', home: path.join(cwd, 'h'), history: hist, hooks: hooks(events) })
    const r = await s.compact({ keep: [3], summarize: [0, 1, 2] })
    expect(calls).toEqual(['cheap'])
    expect(r.model).toBe('cheap')
    expect(events).toContainEqual(expect.objectContaining({ kind: 'usage', agentId: 'compact', model: 'cheap', prompt: 900 }))
  })

  it("falls back to the chat's model when the compaction model fails", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-'))
    const calls: string[] = []
    const ad: ModelAdapter = { async *stream(r) { calls.push(r.model); if (r.model === 'gone') throw new Error('404 model not found'); yield { type: 'text', text: 'SUM' }; yield { type: 'finish', reason: 'stop' } } }
    const s = new Session({ adapter: ad, cwd, model: 'big', compactModel: () => 'gone', home: path.join(cwd, 'h'), history: hist, hooks: hooks([]) })
    const r = await s.compact({ keep: [3], summarize: [0, 1, 2] })
    expect(calls).toEqual(['gone', 'big'])
    expect(r).toMatchObject({ model: 'big', summary: 'SUM' })
  })

  it("groups turns with the chat's model when the compaction model fails", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-'))
    const calls: string[] = []
    const ad: ModelAdapter = { async *stream(r) { calls.push(r.model); if (r.model === 'gone') throw new Error('404'); yield { type: 'text', text: '{"clusters":[{"label":"Beef","turns":[1,3]},{"label":"Misc","turns":[2,4]}]}' }; yield { type: 'finish', reason: 'stop' } } }
    const s = new Session({ adapter: ad, cwd, model: 'big', compactModel: () => 'gone', home: path.join(cwd, 'h'), history: hist, hooks: hooks([]) })
    const r = await s.analyzeTurns()
    expect(calls).toEqual(['gone', 'big'])
    expect(r).toMatchObject({ method: 'model', model: 'big' })
  })
})

describe('autoCompactDecision (cache-aware)', () => {
  const big = (n: number, chars: number) => Array.from({ length: n }, (_, i) => ({ index: i, messages: [{ role: 'user' as const, content: 'x'.repeat(chars) }], user: '', answer: '', tools: [] }))
  const base = { mode: 'auto' as const, tokens: 100_000, threshold: 80_000, hardLimit: 120_000, idleMinutes: 5, idleMs: 0, turns: big(10, 40_000), keepRecent: 2, minGain: 20_000 }

  it('waits while the prompt cache is warm, compacts once idle', () => {
    expect(autoCompactDecision(base)).toMatchObject({ compact: false, reason: 'cache-warm' })
    expect(autoCompactDecision({ ...base, idleMs: 6 * 60_000 })).toMatchObject({ compact: true, reason: 'idle' })
  })
  it('compacts at the hard limit even when the cache is warm', () => {
    expect(autoCompactDecision({ ...base, tokens: 130_000 })).toMatchObject({ compact: true, reason: 'hard-limit' })
  })
  it('skips small gains, short chats, under-threshold, and non-auto modes', () => {
    expect(autoCompactDecision({ ...base, idleMs: 1e9, turns: big(10, 400) })).toMatchObject({ compact: false, reason: 'small-gain' })
    expect(autoCompactDecision({ ...base, idleMs: 1e9, turns: big(2, 400_000) })).toMatchObject({ compact: false, reason: 'too-few-turns' })
    expect(autoCompactDecision({ ...base, idleMs: 1e9, tokens: 50_000 })).toMatchObject({ compact: false, reason: 'under-threshold' })
    expect(autoCompactDecision({ ...base, idleMs: 1e9, mode: 'suggest' })).toMatchObject({ compact: false, reason: 'off' })
  })
  it('idle wait 0 compacts immediately', () => {
    expect(autoCompactDecision({ ...base, idleMinutes: 0 })).toMatchObject({ compact: true, reason: 'no-wait' })
  })
})
