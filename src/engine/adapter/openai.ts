import type { ChatRequest, Delta, Message, ModelAdapter } from '../types'
import { parseSSE } from './sse'

export interface AdapterConfig { baseUrl: string; apiKey: string }

/** Strips engine-only fields before sending messages upstream. */
function wireMessages(msgs: Message[]): unknown[] {
  return msgs.map((m) => {
    if (m.role === 'assistant') {
      const { reasoning: _r, ...rest } = m
      return rest
    }
    return m
  })
}

export class OpenAIAdapter implements ModelAdapter {
  constructor(private cfg: AdapterConfig) {}

  async listModels(): Promise<string[]> {
    const r = await fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}/models`, { headers: { authorization: `Bearer ${this.cfg.apiKey}` } })
    if (!r.ok) throw new Error(`models ${r.status}: ${(await r.text()).slice(0, 300)}`)
    const j: any = await r.json()
    return (j.data ?? []).map((m: any) => m.id)
  }

  async *stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<Delta> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: wireMessages(req.messages),
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: req.maxTokens ?? 16000
    }
    if (req.tools?.length) body.tools = req.tools
    const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey}` },
      body: JSON.stringify(body),
      signal
    })
    if (!res.ok || !res.body) {
      const t = await res.text().catch(() => '')
      let msg = t
      try { msg = JSON.parse(t).error?.message ?? t } catch { /* raw text */ }
      throw Object.assign(new Error(`HTTP ${res.status}: ${msg.slice(0, 500)}`), { status: res.status })
    }
    for await (const data of parseSSE(res.body as unknown as AsyncIterable<Uint8Array>)) {
      let j: any
      try { j = JSON.parse(data) } catch { continue }
      if (j.error) throw new Error(`upstream: ${j.error.message ?? JSON.stringify(j.error)}`)
      if (j.usage) yield { type: 'usage', prompt: j.usage.prompt_tokens ?? 0, completion: j.usage.completion_tokens ?? 0 }
      const ch = j.choices?.[0]
      if (!ch) continue
      const d = ch.delta ?? {}
      if (d.reasoning_content) yield { type: 'reasoning', text: d.reasoning_content }
      if (d.content) yield { type: 'text', text: d.content }
      for (const tc of d.tool_calls ?? []) {
        yield { type: 'tool_call', index: tc.index ?? 0, id: tc.id, name: tc.function?.name, args: tc.function?.arguments }
      }
      if (ch.finish_reason) yield { type: 'finish', reason: ch.finish_reason }
    }
  }
}
