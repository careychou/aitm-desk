import type { Delta, Message, ToolCall } from '../types'

let seq = 0

/** Accumulates streamed deltas into one assistant message. */
export class Assembler {
  private text = ''
  private reasoning = ''
  private calls = new Map<number, { id?: string; name: string; args: string }>()
  finishReason = ''

  push(d: Delta): void {
    switch (d.type) {
      case 'text': this.text += d.text; break
      case 'reasoning': this.reasoning += d.text; break
      case 'finish': this.finishReason = d.reason; break
      case 'tool_call': {
        const c = this.calls.get(d.index) ?? { name: '', args: '' }
        if (d.id) c.id = d.id
        if (d.name) c.name += c.name && c.name === d.name ? '' : d.name
        if (d.args) c.args += d.args
        this.calls.set(d.index, c)
      }
    }
  }

  message(): Extract<Message, { role: 'assistant' }> {
    const tool_calls: ToolCall[] = [...this.calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, c]) => ({ id: c.id ?? `call_${Date.now().toString(36)}_${seq++}`, type: 'function', function: { name: c.name, arguments: c.args || '{}' } }))
    const m: Extract<Message, { role: 'assistant' }> = { role: 'assistant', content: this.text || null }
    if (this.reasoning) m.reasoning = this.reasoning
    if (tool_calls.length) m.tool_calls = tool_calls
    if (!m.content && !tool_calls.length) m.content = ''
    return m
  }
}
