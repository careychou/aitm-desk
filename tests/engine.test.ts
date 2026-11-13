import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Session } from '../src/engine/engine'
import type { AgentEvent, ChatRequest, Delta, Hooks, ModelAdapter } from '../src/engine/types'

type Script = (req: ChatRequest) => Promise<Delta[]> | Delta[]
const call = (id: string, name: string, args: object): Delta => ({ type: 'tool_call', index: Number(id.replace(/\D/g, '')) || 0, id, name, args: JSON.stringify(args) })
const say = (t: string): Delta[] => [{ type: 'text', text: t }, { type: 'finish', reason: 'stop' }]
const lastUser = (r: ChatRequest) => [...r.messages].reverse().find((m) => m.role === 'user')!.content as string
const isSub = (r: ChatRequest) => (r.messages[0].content as string).includes('# Sub-agent rules')
const toolResults = (r: ChatRequest) => r.messages.filter((m) => m.role === 'tool').map((m: any) => m.content as string)

class FakeAdapter implements ModelAdapter {
  calls: ChatRequest[] = []
  constructor(private script: Script) {}
  async *stream(req: ChatRequest, signal: AbortSignal) {
    this.calls.push(structuredClone(req))
    const ds = await this.script(req)
    for (const d of ds) { if (signal.aborted) throw new Error('aborted'); yield d }
  }
}

function mk(script: Script, extra: Partial<ConstructorParameters<typeof Session>[0]> = {}) {
  const events: AgentEvent[] = []
  const hooks: Hooks = { onEvent: (e) => events.push(e), requestPermission: async () => 'allow', askUser: async () => 'yes' }
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-'))
  fs.mkdirSync(`${cwd}/.github/skills/demo`, { recursive: true })
  fs.writeFileSync(`${cwd}/.github/skills/demo/SKILL.md`, '---\nname: demo\ndescription: Demo skill\n---\nDEMO_BODY')
  fs.mkdirSync(`${cwd}/.github/agents`, { recursive: true })
  fs.writeFileSync(`${cwd}/.github/agents/r.agent.md`, '---\nname: reader\ndescription: reads\ntools: ["read"]\n---\nREADER_ROLE')
  const adapter = new FakeAdapter(script)
  const s = new Session({ adapter, hooks, cwd, model: 'm', home: path.join(cwd, 'nohome'), autoApprove: true, ...extra })
  return { s, events, adapter, cwd }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('Session main loop', () => {
  it('loads attached memory exports into the system prompt and can swap them', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-'))
    fs.writeFileSync(`${dir}/a.md`, 'MEMORY_A_FACT'); fs.writeFileSync(`${dir}/b.md`, 'MEMORY_B_FACT')
    const { s, adapter } = mk(() => say('ok'), { memories: [`${dir}/a.md`] })
    await s.send('go')
    expect(adapter.calls[0].messages[0].content).toContain('MEMORY_A_FACT')
    s.setMemories([`${dir}/b.md`])
    await s.send('again')
    const sys = adapter.calls[1].messages[0].content as string
    expect(sys).toContain('MEMORY_B_FACT')
    expect(sys).not.toContain('MEMORY_A_FACT')
  })

  it('emits reasoning events unless reasoning is off', async () => {
    const script = () => [{ type: 'reasoning', text: 'hmm' } as Delta, ...say('ok')]
    const on = mk(script)
    await on.s.send('go')
    expect(on.events.some((e) => e.kind === 'reasoning')).toBe(true)
    const off = mk(script, { reasoning: 'off' })
    expect(await off.s.send('go')).toEqual({ status: 'completed', text: 'ok' })
    expect(off.events.some((e) => e.kind === 'reasoning')).toBe(false)
  })

  it('lists skills in the system prompt without bodies and loads a skill via tool', async () => {
    const { s, adapter } = mk((r) => toolResults(r).length ? say('done') : [call('c0', 'skill', { name: 'demo' }), { type: 'finish', reason: 'tool_calls' }])
    const res = await s.send('go')
    expect(res).toEqual({ status: 'completed', text: 'done' })
    const sys = adapter.calls[0].messages[0].content as string
    expect(sys).toContain('- demo: Demo skill')
    expect(sys).not.toContain('DEMO_BODY')
    expect(toolResults(adapter.calls[1])[0]).toContain('DEMO_BODY')
  })

  it('runs parallel tool calls concurrently and returns bad-JSON errors to the model', async () => {
    const { s, adapter } = mk((r) => toolResults(r).length ? say('ok') : [
      call('c0', 'shell', { command: 'sleep 0.6; echo A' }),
      call('c1', 'shell', { command: 'sleep 0.6; echo B' }),
      { type: 'tool_call', index: 2, id: 'c2', name: 'glob', args: '{bad' },
      { type: 'finish', reason: 'tool_calls' }
    ])
    const t = Date.now()
    await s.send('go')
    expect(Date.now() - t).toBeLessThan(1100)
    const res = toolResults(adapter.calls[1])
    expect(res[0]).toContain('A'); expect(res[1]).toContain('B')
    expect(res[2]).toMatch(/invalid JSON/)
  })

  it('stops at max turns', async () => {
    const { s } = mk(() => [call('c0', 'list_agents', {}), { type: 'finish', reason: 'tool_calls' }], { maxTurnsMain: 3 })
    const r = await s.send('go')
    expect(r.status).toBe('failed')
    expect(r.text).toMatch(/max of 3 turns/)
  })

  it('keeps conversation history across sends', async () => {
    const { s, adapter } = mk(() => say('hi'))
    await s.send('one'); await s.send('two')
    expect(adapter.calls[1].messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
  })
})

describe('sub-agents', () => {
  it('sync task returns final text; named agent gets its role and restricted tools', async () => {
    const { s, adapter } = mk((r) => {
      if (isSub(r)) return say('sub answer')
      return toolResults(r).length ? say('main: ' + toolResults(r)[0]) : [call('c0', 'task', { prompt: 'look', agent: 'reader' }), { type: 'finish', reason: 'tool_calls' }]
    })
    const res = await s.send('go')
    expect(res.text).toBe('main: sub answer')
    const sub = adapter.calls.find(isSub)!
    expect(sub.messages[0].content).toContain('READER_ROLE')
    expect(sub.tools!.map((t) => t.function.name).sort()).toEqual(['ask_user', 'glob', 'grep', 'read_file', 'skill'])
  })

  it('runs parallel sync sub-agents concurrently', async () => {
    const { s, events } = mk(async (r) => {
      if (isSub(r)) { await sleep(500); return say('sub:' + lastUser(r)) }
      return toolResults(r).length ? say(toolResults(r).join('|')) : [
        call('c0', 'task', { prompt: 'p1' }), call('c1', 'task', { prompt: 'p2' }), call('c2', 'task', { prompt: 'p3' }),
        { type: 'finish', reason: 'tool_calls' }]
    })
    const t = Date.now()
    const res = await s.send('go')
    expect(Date.now() - t).toBeLessThan(1200)
    expect(res.text).toBe('sub:p1|sub:p2|sub:p3')
    expect(events.filter((e) => e.kind === 'agent_start').length).toBe(3)
  })

  it('respects max concurrency', async () => {
    let active = 0, peak = 0
    const { s } = mk(async (r) => {
      if (isSub(r)) { active++; peak = Math.max(peak, active); await sleep(100); active--; return say('x') }
      return toolResults(r).length ? say('done') : [0, 1, 2, 3, 4].map((i) => call(`c${i}`, 'task', { prompt: `p${i}` })).concat([{ type: 'finish', reason: 'tool_calls' }])
    }, { maxConcurrency: 2 })
    await s.send('go')
    expect(peak).toBeLessThanOrEqual(2)
  })

  it('background task returns id, read_agent waits for the result', async () => {
    let bgId = ''
    const { s } = mk(async (r) => {
      if (isSub(r)) { await sleep(300); return say('bg result') }
      const tr = toolResults(r)
      if (tr.length === 0) return [call('c0', 'task', { prompt: 'long', mode: 'background' }), { type: 'finish', reason: 'tool_calls' }]
      if (tr.length === 1) { bgId = /agent_id: (\S+)/.exec(tr[0])![1]; return [call('c1', 'read_agent', { agent_id: bgId, wait: true }), { type: 'finish', reason: 'tool_calls' }] }
      return say(tr[1])
    })
    const res = await s.send('go')
    expect(res.text).toContain('status: completed')
    expect(res.text).toContain('bg result')
  })

  it('notifies an idle main agent when a background agent completes', async () => {
    const { s, adapter } = mk(async (r) => {
      if (isSub(r)) { await sleep(200); return say('bg') }
      if (lastUser(r).includes('system_notification')) return say('noted')
      return toolResults(r).length ? say('started') : [call('c0', 'task', { prompt: 'x', mode: 'background' }), { type: 'finish', reason: 'tool_calls' }]
    })
    const woke = new Promise<void>((resolve) => { s.onIdleNotification = () => { s.send().then(() => resolve()) } })
    expect((await s.send('go')).text).toBe('started')
    await woke
    const last = adapter.calls[adapter.calls.length - 1]
    expect(lastUser(last)).toMatch(/Background agent .* completed/)
  })

  it('stop cancels main and running sub-agents', async () => {
    const { s, events } = mk(async (r) => {
      if (isSub(r)) return [call('c9', 'shell', { command: 'sleep 20' }), { type: 'finish', reason: 'tool_calls' }]
      return toolResults(r).length ? say('x') : [call('c0', 'task', { prompt: 'a' }), call('c1', 'task', { prompt: 'b', mode: 'background' }), { type: 'finish', reason: 'tool_calls' }]
    })
    const p = s.send('go')
    await sleep(500)
    s.stop()
    const t = Date.now()
    const r = await p
    expect(r.status).toBe('cancelled')
    expect(Date.now() - t).toBeLessThan(4000)
    await sleep(100)
    const ends = events.filter((e) => e.kind === 'agent_end' && e.agentId !== 'main') as any[]
    expect(ends.length).toBe(2)
    expect(ends.every((e) => e.status === 'cancelled')).toBe(true)
  })

  it('denies delegation beyond max depth', async () => {
    const { s, adapter } = mk((r) => {
      const depth = (r.messages[0].content as string).includes('cannot launch') ? 2 : isSub(r) ? 1 : 0
      if (toolResults(r).length) return say(`d${depth}:` + toolResults(r)[0])
      return depth < 2 ? [call('c0', 'task', { prompt: 'deeper' }), { type: 'finish', reason: 'tool_calls' }] : say('leaf')
    })
    const res = await s.send('go')
    expect(res.text).toBe('d0:d1:leaf')
    const leaf = adapter.calls.find((c) => (c.messages[0].content as string).includes('cannot launch'))!
    expect(leaf.tools!.map((t) => t.function.name)).not.toContain('task')
  })
})
