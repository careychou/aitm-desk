import type { Message, ModelAdapter, Hooks } from './types'
import type { ToolDef, ToolContext } from './tools/types'
import { Assembler } from './adapter/assemble'
import { toSchemas } from './tools'
import type { Semaphore } from './semaphore'

export interface LoopOptions {
  agentId: string
  model: string
  adapter: ModelAdapter
  sem: Semaphore
  hooks: Hooks
  tools: ToolDef[]
  ctx: Omit<ToolContext, 'agentId' | 'signal'>
  signal: AbortSignal
  maxTurns: number
  reasoning?: 'off' | 'low' | 'medium' | 'high'
  /** Returns pending notifications to inject before the next model call. */
  drainNotifications?: () => string[]
  /** Returns user prompts queued while working, injected before the next model call. */
  drainInput?: () => Message[]
}

export class AbortedError extends Error { constructor() { super('cancelled') } }

async function callModel(o: LoopOptions, messages: Message[]): Promise<Extract<Message, { role: 'assistant' }>> {
  const release = await o.sem.acquire(o.signal)
  try {
    let lastErr: any
    for (let attempt = 0; attempt < 2; attempt++) {
      const asm = new Assembler()
      let streamed = false
      try {
        for await (const d of o.adapter.stream({ model: o.model, messages, tools: toSchemas(o.tools), reasoning: o.reasoning }, o.signal)) {
          asm.push(d)
          if (d.type === 'text') { streamed = true; o.hooks.onEvent({ kind: 'text', agentId: o.agentId, text: d.text }) }
          else if (d.type === 'reasoning') { streamed = true; if (o.reasoning !== 'off') o.hooks.onEvent({ kind: 'reasoning', agentId: o.agentId, text: d.text }) }
          else if (d.type === 'usage') o.hooks.onEvent({ kind: 'usage', agentId: o.agentId, model: o.model, prompt: d.prompt, completion: d.completion, cached: d.cached, cacheWrite: d.cacheWrite })
        }
        return asm.message()
      } catch (e: any) {
        if (o.signal.aborted) throw new AbortedError()
        lastErr = e
        const retryable = !streamed && (e.status === undefined || e.status >= 500 || e.status === 429)
        if (!retryable) break
        await new Promise((r) => setTimeout(r, 1500))
      }
    }
    throw lastErr
  } finally {
    release()
  }
}

async function runTool(o: LoopOptions, call: { id: string; function: { name: string; arguments: string } }): Promise<string> {
  const { name, arguments: raw } = call.function
  o.hooks.onEvent({ kind: 'tool_start', agentId: o.agentId, callId: call.id, name, args: raw })
  let output: string
  let ok = true
  try {
    const tool = o.tools.find((t) => t.name === name)
    if (!tool) throw new Error(`unknown tool "${name}"`)
    let args: any
    try { args = raw?.trim() ? JSON.parse(raw) : {} } catch { throw new Error(`invalid JSON arguments: ${raw.slice(0, 200)}`) }
    if (tool.permission) {
      const detail = tool.summarize ? tool.summarize(args) : raw
      const allowed = await o.ctx.gate.check(o.agentId, tool.permission, detail)
      if (!allowed) throw new Error('the user denied permission for this tool call')
    }
    output = await tool.run(args, { ...o.ctx, agentId: o.agentId, signal: o.signal })
  } catch (e: any) {
    ok = false
    output = `Error: ${e?.message ?? String(e)}`
  }
  if (o.signal.aborted) { ok = false; output = 'Error: cancelled' }
  o.hooks.onEvent({ kind: 'tool_end', agentId: o.agentId, callId: call.id, name, output, ok })
  return output
}

/** Runs model/tool turns until the model answers without tool calls. Mutates `messages`. Returns final text. */
export async function runLoop(o: LoopOptions, messages: Message[]): Promise<string> {
  for (let turn = 0; turn < o.maxTurns; turn++) {
    if (o.signal.aborted) throw new AbortedError()
    const notes = o.drainNotifications?.() ?? []
    if (notes.length) messages.push({ role: 'user', content: notes.map((n) => `<system_notification>${n}</system_notification>`).join('\n') })
    messages.push(...(o.drainInput?.() ?? []))
    const msg = await callModel(o, messages)
    messages.push(msg)
    o.hooks.onEvent({ kind: 'assistant_done', agentId: o.agentId, message: msg })
    if (!msg.tool_calls?.length) return msg.content ?? ''
    const results = await Promise.all(msg.tool_calls.map((c) => runTool(o, c)))
    msg.tool_calls.forEach((c, i) => messages.push({ role: 'tool', tool_call_id: c.id, content: results[i] }))
    if (o.signal.aborted) throw new AbortedError()
  }
  throw new Error(`stopped after reaching the max of ${o.maxTurns} turns`)
}
