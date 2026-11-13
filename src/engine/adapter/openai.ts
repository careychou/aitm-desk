import type { ChatRequest, Delta, Message, ModelAdapter } from '../types'
import { parseSSE } from './sse'
import { fitRequest, type RequestBudget } from '../content'

export interface AdapterConfig {
  baseUrl: string
  apiKey: string
  /** Read on every request so settings changes apply to open chats. */
  budget?: () => RequestBudget
}

/** Strips engine-only fields before sending messages upstream. */
function wireMessages(msgs: Message[], budget?: RequestBudget): unknown[] {
  return (budget ? fitRequest(msgs, budget) : msgs).map((m) => {
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
      messages: wireMessages(req.messages, this.cfg.budget?.()),
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: req.maxTokens ?? 16000
    }
    if (req.tools?.length) body.tools = req.tools
    if (req.reasoning && req.reasoning !== 'off') { body.include_reasoning = true; body.reasoning_effort = req.reasoning }
    const think = new ThinkSplitter()
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
      if (d.reasoning && typeof d.reasoning === 'string') yield { type: 'reasoning', text: d.reasoning }
      if (d.content) {
        // Gemini on Vertex flags thought chunks; other models may inline <think> tags
        if (d.extra_content?.google?.thought) yield { type: 'reasoning', text: d.content + '\n\n' }
        else yield* think.push(d.content)
      }
      for (const tc of d.tool_calls ?? []) {
        yield { type: 'tool_call', index: tc.index ?? 0, id: tc.id, name: tc.function?.name, args: tc.function?.arguments }
      }
      if (ch.finish_reason) yield { type: 'finish', reason: ch.finish_reason }
    }
    yield* think.flush()
  }
}

/** Splits streamed text into reasoning (inside <think>…</think>) and visible text, across chunk boundaries. */
export class ThinkSplitter {
  private inThink = false
  private buf = ''

  push(chunk: string): Delta[] {
    const out: Delta[] = []
    this.buf += chunk
    for (;;) {
      const tag = this.inThink ? '</think>' : '<think>'
      const i = this.buf.indexOf(tag)
      if (i >= 0) {
        if (i > 0) out.push(this.emit(this.buf.slice(0, i)))
        this.buf = this.buf.slice(i + tag.length)
        this.inThink = !this.inThink
        continue
      }
      // hold back a possible partial tag at the end
      let keep = 0
      for (let k = Math.min(tag.length - 1, this.buf.length); k > 0; k--) {
        if (tag.startsWith(this.buf.slice(-k))) { keep = k; break }
      }
      const text = this.buf.slice(0, this.buf.length - keep)
      this.buf = this.buf.slice(this.buf.length - keep)
      if (text) out.push(this.emit(text))
      return out
    }
  }

  flush(): Delta[] {
    const out = this.buf ? [this.emit(this.buf)] : []
    this.buf = ''
    return out
  }

  private emit(text: string): Delta {
    return this.inThink ? { type: 'reasoning', text } : { type: 'text', text }
  }
}
